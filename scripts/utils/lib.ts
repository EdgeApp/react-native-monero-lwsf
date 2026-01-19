import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { fileExists } from './common'
import type { Platform } from './platforms'
import { addTask, type Build } from './tasks'

interface LibInfo {
  // Task & depdendencies:
  name: string
  cacheTag?: string
  deps?: string[]
  libDeps?: string[]

  // Download location:
  url?: string
  hash: string

  recycle?: boolean // Defaults to true
  build: (build: Build, platform: Platform, prefixPath: string) => Promise<void>
}

export function defineLib(lib: LibInfo): (platforms: Platform[]) => void {
  const { recycle = false } = lib
  let gitUrl: undefined | string
  let tarUrl: undefined | string
  if (lib.url != null) {
    if (lib.url.endsWith('.git')) gitUrl = lib.url
    else tarUrl = lib.url
  }

  if (gitUrl != null) addGitCloneTask(lib.name, gitUrl, lib.hash)
  if (tarUrl != null) addDownloadTask(lib.name, tarUrl, lib.hash)

  return platforms => {
    // Roll-up task depends on all platforms:
    addTask({
      name: lib.name,
      deps: platforms.map(platform => `${lib.name}.build.${platform.name}`),
      async run() {}
    })

    // Individual platform builds:
    for (const platform of platforms) {
      addTask({
        name: `${lib.name}.build.${platform.name}`,
        cacheTag: lib.cacheTag,
        deps: [
          ...(lib.libDeps ?? []).map(dep => `${dep}.build.${platform.name}`),
          ...(lib.deps ?? []),
          ...(gitUrl != null ? [`${lib.name}.clone`] : []),
          ...(tarUrl != null ? [`${lib.name}.download`] : [])
        ],
        async run(build) {
          // Create working directory:
          const workPath = join(
            build.basePath,
            'build',
            `${lib.name}-${platform.name}`
          )
          if (!recycle) await rm(workPath, { recursive: true, force: true })
          await mkdir(workPath, { recursive: true })
          build.cd(workPath)

          if (gitUrl != null) {
            const repoPath = join(
              build.basePath,
              'downloads',
              `${lib.name}.git`
            )
            await build.exec('bash', [
              '-c',
              `git --git-dir=${repoPath} archive ${lib.hash} | tar -x -C ${workPath}`
            ])
          }
          if (tarUrl != null && !recycle) {
            const filename = tarUrl.replace(/.*[/]/, '')
            const filePath = join(build.basePath, 'downloads', filename)
            await build.exec('tar', ['-xjf', filePath])
          }

          const prefixPath = join(build.basePath, 'prefix', platform.name)
          await mkdir(prefixPath, { recursive: true })
          await lib.build(build, platform, prefixPath)
        }
      })
    }
  }
}

export function addGitCloneTask(name: string, url: string, hash: string): void {
  addTask<string>({
    name: `${name}.clone`,
    cacheTag: hash,
    async run(build) {
      const downloadPath = join(build.basePath, 'downloads')
      await mkdir(downloadPath, { recursive: true })
      const repoPath = join(downloadPath, `${name}.git`)

      if (await fileExists(repoPath)) {
        await build.exec('git', [
          '-C',
          repoPath,
          'fetch',
          '--all',
          '--tags',
          '--prune'
        ])
      } else {
        await build.exec('git', ['clone', '--bare', url, repoPath])
      }

      return hash
    }
  })
}

export function addDownloadTask(name: string, url: string, hash: string): void {
  addTask<string>({
    name: `${name}.download`,
    cacheTag: hash,
    async run(build) {
      const downloadPath = join(build.basePath, 'downloads')
      await mkdir(downloadPath, { recursive: true })
      const filename = url.replace(/.*[/]/, '')
      const filePath = join(downloadPath, filename)

      if (!(await fileExists(filePath))) {
        build.log(`Getting ${filename}...`)
        await build.exec('curl', ['-L', '-o', filePath, url])
      }

      return hash
    }
  })
}
