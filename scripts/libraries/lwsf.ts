import { asValue } from 'cleaners'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'

import { getRepo } from '../utils/common'
import { defineLib } from '../utils/lib'
import { addTask } from '../utils/tasks'

// addGitCloneTask(
//   'monero',
//   'https://github.com/monero-project/monero.git',
//   moneroHash
// )
const moneroHash = '38bc62741b82cca179fb8e3437a388b0e0f67842' // Nov 7, 2025
// const moneroHash = '1c9686cb45bec8cd1ca5142426b9ea9458ac4384' // Last compatible version?

addTask('monero.clone', asValue(moneroHash), async build => {
  await getRepo(
    'monero',
    'https://github.com/monero-project/monero.git',
    moneroHash
  )

  // Hack the build:
  const cmakePath = join(build.basePath, 'monero', 'CMakeLists.txt')
  const cmakeList = await readFile(cmakePath, 'utf8')
  await writeFile(
    cmakePath,
    cmakeList
      .replace(
        '  forbid_undefined_symbols()',
        '# $& # Disabled by react-native build'
      )
      .replace(
        'INCLUDE(CmakeLists_IOS.txt)',
        '# $& # Disabled by react-native build'
      ),
    'utf8'
  )

  const minerPath = join(
    build.basePath,
    'monero/src/cryptonote_basic/miner.cpp'
  )
  const minerCpp = await readFile(minerPath, 'utf8')
  await writeFile(
    minerPath,
    minerCpp
      .replace(
        '#include <IOKit/IOKitLib.h>',
        '// $& # Disabled by react-native build'
      )
      .replace(
        '#include <IOKit/ps/IOPSKeys.h>',
        '// $& # Disabled by react-native build'
      )
      .replace(
        '#include <IOKit/ps/IOPowerSources.h>',
        '// $& # Disabled by react-native build'
      ),
    'utf8'
  )

  return moneroHash
})

export const lwsf = defineLib({
  name: 'lwsf',
  nonce: 1,
  deps: ['boost', 'libsodium', 'libunbound', 'libzmq', 'openssl'],

  url: 'https://github.com/vtnerd/lwsf.git',
  hash: 'cedb2164f9ccd418b91a4e54ee8479c8d5c3cad0', // Nov 7, 2025

  async build(build, platform, prefixPath) {
    await build.runTask('monero.clone')

    build.exportEnv({
      PKG_CONFIG_PATH: join(prefixPath, '/lib/pkgconfig')
    })

    // Works for Android:
    await build.exec('cmake', [
      // Source directory:
      `-S${build.cwd}`,
      // Build directory:
      `-B${join(build.cwd, 'cmake')}`,
      // Build options:
      `-DCMAKE_BUILD_TYPE=Release`,
      `-DCMAKE_CXX_FLAGS=-DLWSF_MASTER_ENABLE`,
      `-DCMAKE_C_FLAGS=-D_DARWIN_C_SOURCE`,
      `-DCMAKE_FIND_ROOT_PATH=${prefixPath};${platform.sysroot}"`,
      `-DCMAKE_INSTALL_PREFIX=${prefixPath}`,
      `-DCMAKE_PREFIX_PATH=${prefixPath}`,
      `-DMONERO_SOURCE_DIR=${join(build.basePath, 'monero')}`,
      `-DSTATIC=true`,
      `-DUSE_DEVICE_TREZOR=OFF`,
      ...platform.cmakeFlags
    ])
    await build.exec('cmake', [
      '--build',
      join(build.cwd, 'cmake'),
      '--config',
      'Release',
      '--target',
      'lwsf-api'
    ])

    build.log('done')
  }
})
