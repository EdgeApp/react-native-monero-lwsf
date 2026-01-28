import { join } from 'path'

import { defineLib } from '../utils/lib'

export const libunbound = defineLib({
  name: 'libunbound',
  libDeps: ['libexpat', 'openssl'],
  cacheTag: '0',

  // 1.24.1 (upstream wants 1.4.16)
  url: 'https://github.com/NLnetLabs/unbound.git',
  hash: 'a33f0638e1dacf2633cf2292078a674576bca852',

  build: async (build, platform, prefixPath) => {
    build.log(JSON.stringify(platform.tools, null, 1))
    build.exportEnv({
      ...platform.tools,
      PKG_CONFIG_PATH: join(prefixPath, 'lib/pkgconfig')
    })
    if (platform.type === 'ios') build.exportEnv({ ...platform.sdkFlags })

    await build.exec('./configure', [
      '--enable-static',
      '--disable-shared',
      `--host=${platform.triple}`,
      `--prefix=${prefixPath}`,
      `--with-ssl=${prefixPath}`,
      `--with-libexpat=${prefixPath}`
    ])
    await build.exec('make', [])
    await build.exec('make', ['install'])
  }
})
