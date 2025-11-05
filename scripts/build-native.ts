// Run this script as `node -r sucrase/register ./scripts/build-native.ts`
//
// It will:
// - Download third-party source code.
// - Assemble Android shared libraries for each platform.
// - Assemble an iOS universal static xcframework.
//
// Here is where each puzzle piece comes from:
//
// | lib        | android           | ios                   |
// |------------|-------------------|-----------------------|
// | Boost      | custom            | ?                     |
// | libexpat   | autotools/CMake   | autotools/CMake       |
// | libsodium  | autotools         | autotools             |
// | libunbound | autotools         | autotools             |
// | libzmq     | CMake             | CMake                 |
// | monero     | CMake             | CMake                 |
// | OpenSSL    | custom            | custom                |
//

import { asValue } from 'cleaners'
import { mkdir, rm } from 'fs/promises'
import { basename, join } from 'path'

import { boost } from './libraries/boost'
import { libexpat } from './libraries/libexpat'
import { libsodium } from './libraries/libsodium'
import { libunbound } from './libraries/libunbound'
import { libzmq } from './libraries/libzmq'
import { lwsf } from './libraries/lwsf'
import { openssl } from './libraries/openssl'
import { loudExec, lsr, tmpPath } from './utils/common'
import { defineLib } from './utils/lib'
import { type IosPlatform, makePlatforms } from './utils/platforms'
import { addTask, startBuild } from './utils/tasks'

const ffi = defineLib({
  name: 'ffi',
  hash: '1',
  nonce: 1,
  deps: ['lwsf'],

  async build(build, platform, prefixPath) {
    // Source list (from src/):
    const srcPath = join(__dirname, '../src')
    const sources: string[] = ['monero-wrapper/monero-methods.cpp']

    // LWSF builds a *ton* of libraries,
    // but doesn't install them in the normal place:
    const lwsLibs = []
    const lwsfPath = join(build.basePath, 'build', `lwsf-${platform.name}`)
    for await (const path of lsr(join(lwsfPath, 'cmake'))) {
      if (path.endsWith('.a')) lwsLibs.push(path)
    }

    // Compile flags:
    const includePaths = [
      join(prefixPath, 'include'),
      join(lwsfPath, 'include'),
      join(build.basePath, 'build/monero/src')
    ]
    const libPaths = [join(prefixPath, 'lib')]
    const libs = [
      'boost_chrono',
      'boost_filesystem',
      'boost_program_options',
      'boost_serialization',
      'boost_thread',
      'crypto',
      'sodium',
      'ssl',
      'unbound'
    ]

    if (platform.type === 'android') {
      sources.push('jni/jni.cpp')
    }

    // Compile our sources:
    const objects: string[] = []
    for (const source of sources) {
      // Figure out the object file name:
      const object = join(
        build.cwd,
        basename(source).replace(/\.c$|\.cc$|\.cpp$/, '.o')
      )
      objects.push(object)

      const useCxx = /\.cpp$|\.cc$/.test(source)
      const sdkFlags: string =
        platform.type === 'ios'
          ? useCxx
            ? platform.sdkFlags.CXXFLAGS
            : platform.sdkFlags.CFLAGS
          : ''
      await build.exec(useCxx ? platform.tools.CXX : platform.tools.CC, [
        '-c',
        sdkFlags,
        ...includePaths.map(path => `-I${path}`),
        `-o${object}`,
        join(srcPath, source)
      ])
    }

    if (platform.type === 'ios') {
      // Link everything together into a single giant .o file:
      const objectPath = join(build.cwd, 'monero-module.o')
      await build.exec(platform.tools.LD, [
        '-fPIC',
        '-r',
        '-o',
        objectPath,
        ...objects,
        ...libPaths.map(path => `-L${path}`)
      ])

      // Localize all symbols except the ones we really want,
      // hiding them from future linking steps:
      await build.exec(platform.tools.OBJCOPY, [
        objectPath,
        '-w',
        '-L*',
        '-L!_lwsfMethods',
        '-L!_lwsfMethodCount'
      ])

      // Generate a static library:
      const library = join(build.cwd, `monero-module.a`)
      await rm(library, { force: true })
      await build.exec(platform.tools.AR, ['rcs', library, objectPath])
    } else {
      // Link everything together into a shared library:
      const outPath = join(
        srcPath,
        '../android/src/main/jniLibs/',
        platform.arch
      )
      await mkdir(outPath, { recursive: true })
      await build.exec(platform.tools.LD, [
        '-shared',
        `-o${join(outPath, 'librnmonero.so')}`,
        ...libPaths.map(path => `-L${path}`),
        ...libs.map(lib => `-l${lib}`),
        ...objects,

        '-Wl,--start-group',
        ...lwsLibs,
        '-Wl,--end-group',

        '-llog',
        `-Wl,--version-script=${join(srcPath, 'jni/exports.map')}`,
        '-Wl,--no-undefined',
        '-Wl,-z,max-page-size=16384'
      ])
      build.log('done')
    }
  }
})

/**
 * Creates a unified xcframework file out of the per-platform
 * static libraries that `buildIosLwsf` creates.
 */
async function packageIosLwsf(platforms: IosPlatform[]): Promise<void> {
  const sdks = new Set(platforms.map(row => row.sdk))

  // Merge the platforms into a fat library:
  const merged: string[] = []
  for (const sdk of sdks) {
    console.log(`Merging libraries for ${sdk}...`)
    const outPath = join(tmpPath, `${sdk}-lipo`)
    await mkdir(outPath, { recursive: true })
    const output = join(outPath, 'liblwsf-module.a')

    await loudExec('lipo', [
      '-create',
      '-output',
      output,
      ...platforms
        .filter(platform => platform.sdk === sdk)
        .map(({ sdk, arch }) =>
          join(tmpPath, `${sdk}-${arch}`, `liblwsf-module.a`)
        )
    ])
    merged.push('-library', output)
  }

  // Bundle those into an XCFramework:
  console.log('Creating XCFramework...')
  await rm('ios/LwsfModule.xcframework', { recursive: true, force: true })
  await loudExec('xcodebuild', [
    '-create-xcframework',
    ...merged,
    '-output',
    join(__dirname, '../ios/LwsfModule.xcframework')
  ])
}

addTask('default', asValue(1), async build => {
  await Promise.all([
    build.runTask('ffi.build.android-arm64-v8a'),
    build.runTask('ffi.build.android-armeabi-v7a')
  ])
  return 1
})

async function main(): Promise<void> {
  await mkdir(tmpPath, { recursive: true })

  // Set up build:
  const platforms = await makePlatforms()
  boost(platforms)
  ffi(platforms)
  libexpat(platforms)
  libsodium(platforms)
  libunbound(platforms)
  libzmq(platforms)
  lwsf(platforms)
  openssl(platforms)

  // await startBuild('libsodium', { basePath: tmpPath })
  await startBuild(process.argv[2] ?? 'default', { basePath: tmpPath })
}

main().catch((error: unknown) => {
  console.log(String(error))
})
