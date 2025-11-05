import { join } from 'path'

import { defineLib } from '../utils/lib'

export const libzmq = defineLib({
  name: 'libzmq',
  nonce: 2,

  // 4.3.5 (upstream wants 4.2.0)
  url: 'https://github.com/zeromq/libzmq.git',
  hash: '622fc6dde99ee172ebaa9c8628d85a7a1995a21d',

  build: async (build, platform, prefixPath) => {
    build.exportEnv({ ...platform.tools })

    build.exportEnv({
      ...platform.tools,
      PKG_CONFIG_PATH: join(prefixPath, 'lib/pkgconfig')
    })
    if (platform.type === 'ios') build.exportEnv({ ...platform.sdkFlags })

    await build.exec('./autogen.sh')
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
