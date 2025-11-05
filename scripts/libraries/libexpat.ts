import { join } from 'path'

import { defineLib } from '../utils/lib'

export const libexpat = defineLib({
  name: 'libexpat',
  nonce: 1,

  // R_2_7_3:
  url: 'https://github.com/libexpat/libexpat.git',
  hash: '4575e52f83e0d6d7bd24939eab8952bbc7bc358f',

  build: async (build, platform, prefixPath) => {
    build.cd(join(build.cwd, 'expat'))

    build.exportEnv({ ...platform.tools })
    if (platform.type === 'ios') build.exportEnv({ ...platform.sdkFlags })

    await build.exec('./buildconf.sh')
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
