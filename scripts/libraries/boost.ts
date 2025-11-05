import { writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'

import { defineLib } from '../utils/lib'

const version = '1.85.0'
const underVersion = version.replace(/[.]/g, '_')

const boostLibs = [
  'chrono',
  'date_time',
  'filesystem',
  'program_options',
  'serialization',
  'thread'

  // 'regex',
  // 'system',
  // 'timer'
]

export const boost = defineLib({
  name: 'boost',
  nonce: 2,
  // recycle: true,

  url: `https://archives.boost.io/release/${version}/source/boost_${underVersion}.tar.bz2`,
  hash: 'todo',

  build: async (build, platform, prefixPath) => {
    build.cd(join(build.cwd, `boost_${underVersion}`))

    // build.exportEnv({ ...platform.tools })
    // if (platform.type === 'ios') build.exportEnv({ ...platform.sdkFlags })

    await build.exec('./bootstrap.sh')

    const toolsPath = dirname(platform.tools.CXX)
    build.exportEnv({
      PATH: `${toolsPath}:${build.env.PATH}`
    })

    // Set up a custom toolchain:
    const userConfigPath = join(build.cwd, 'user-config.jam')
    let userConfig = `using clang : nat1ve : ${basename(platform.tools.CXX)} :
<archiver>${platform.tools.AR}
<ranlib>${platform.tools.RANLIB}
<compileflags>-fPIC
<compileflags>-ffunction-sections
<compileflags>-fdata-sections
<compileflags>-funwind-tables
<compileflags>-fstack-protector-strong
<compileflags>-no-canonical-prefixes
<compileflags>-Wformat
<compileflags>-Werror=format-security
<compileflags>-frtti
<compileflags>-fexceptions
<compileflags>-DNDEBUG
<compileflags>-g
<compileflags>-Oz
`
    if (platform.type === 'ios') {
      for (const arg of platform.sdkFlags.CXXFLAGS.split(' '))
        userConfig = userConfig + `<compileflags>${arg}\n`
      for (const arg of platform.sdkFlags.LDFLAGS.split(' '))
        userConfig = userConfig + `<linkflags>${arg}\n`
    }
    await writeFile(userConfigPath, userConfig + ';\n')

    // Do the build:
    await build.exec('./b2', [
      '-d+2', // Verbose logs
      '-j2',
      '-q',
      '--build-dir=./build',
      '--ignore-site-config',
      '--layout=system',
      `--prefix=${prefixPath}`,
      `--user-config=${userConfigPath}`,
      ...boostLibs.map(lib => `--with-${lib}`),
      'install',
      'link=static',
      `target-os=${platform.type === 'ios' ? 'iphone' : platform.type}`,
      'threading=multi',
      `toolset=clang-nat1ve` // The tag needs to include a number
    ])
  }
})
