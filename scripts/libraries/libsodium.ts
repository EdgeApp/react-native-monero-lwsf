import { defineLib } from '../utils/lib'

export const libsodium = defineLib({
  name: 'libsodium',
  nonce: 1,

  // v1.0.20:
  url: 'https://github.com/jedisct1/libsodium.git',
  hash: '9511c982fb1d046470a8b42aa36556cdb7da15de',

  build: async (build, platform, prefixPath) => {
    build.exportEnv({ ...platform.tools })

    build.exportEnv({ ...platform.tools })
    if (platform.type === 'ios') build.exportEnv({ ...platform.sdkFlags })

    await build.exec('./configure', [
      '--enable-static',
      '--disable-shared',
      `--host=${platform.triple}`,
      `--prefix=${prefixPath}`
    ])
    await build.exec('make', [])
    await build.exec('make', ['install'])
  }
})
