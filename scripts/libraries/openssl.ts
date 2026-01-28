import { dirname } from 'path'

import { defineLib } from '../utils/lib'
import type { Platform } from '../utils/platforms'

export const openssl = defineLib({
  name: 'openssl',
  cacheTag: '0',

  // 3.6.0
  url: 'https://github.com/openssl/openssl.git',
  hash: '7b371d80d959ec9ab4139d09d78e83c090de9779',

  build: async (build, platform, prefixPath) => {
    const extraConfig = []
    if (platform.type === 'android') {
      build.exportEnv({
        ANDROID_NDK_ROOT: platform.ndkPath,
        PATH: `${dirname(platform.tools.CC)}:${build.env.PATH}`
      })
      extraConfig.push(`-D__ANDROID_API__=${platform.api}`)
      if (platform.arch === 'x86_64') extraConfig.push('no-asm')
    }

    // if (platform.type === 'ios') {
    //   build.exportEnv({
    //     CROSS_COMPILE: dirname(platform.tools.CC) + '/',
    //     CROSS_TOP: dirname(dirname(platform.sysroot)),
    //     CROSS_SDK: basename(platform.sysroot)
    //   })
    // }

    await build.exec('./Configure', [
      getTarget(platform),
      `--prefix=${prefixPath}`,
      'no-async',
      'no-shared',
      ...extraConfig
    ])
    await build.exec('make', [])
    await build.exec('make', ['install'])
  }
})

function getTarget(platform: Platform): string {
  if (platform.type === 'android') {
    switch (platform.arch) {
      case 'arm64-v8a':
        return 'android-arm64'
      case 'armeabi-v7a':
        return 'android-arm'
      case 'x86':
        return 'android-x86'
      case 'x86_64':
        return 'android-x86_64'
    }
  }

  if (platform.type === 'ios') {
    switch (platform.arch) {
      case 'x86_64':
        return 'iossimulator-x86_64-xcrun'
      case 'arm64':
        return platform.sdk === 'iphoneos'
          ? 'ios64-xcrun'
          : 'iossimulator-arm64-xcrun'
    }
  }

  return ''
}
