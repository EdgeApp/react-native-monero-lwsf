import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { asValue } from 'cleaners'

import { fileExists } from './common'
import type { Platform } from './platforms'
import { addTask, type Build } from './tasks'

interface LibInfo {
  // Task & depdendencies:
  name: string
  deps?: string[]
  nonce?: number

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
    addTask(`${lib.name}.build`, asValue(undefined), async build => {
      await Promise.all(
        platforms.map(
          async platform =>
            await build.runTask(`${lib.name}.build.${platform.name}`)
        )
      )
    })

    // Individual platform builds:
    for (const platform of platforms) {
      addTask(
        `${lib.name}.build.${platform.name}`,
        asValue(lib.nonce ?? 0),
        async build => {
          if (lib.deps != null) {
            await Promise.all(
              lib.deps.map(
                async dep =>
                  await build.runTask(`${dep}.build.${platform.name}`)
              )
            )
          }

          // Clone:
          if (gitUrl != null) await build.runTask(`${lib.name}.clone`)
          if (tarUrl != null) await build.runTask(`${lib.name}.download`)

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
          return lib.nonce ?? 0
        }
      )
    }
  }
}

export function addGitCloneTask(name: string, url: string, hash: string): void {
  addTask<string>(`${name}.clone`, asValue(hash), async build => {
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
  })
}

export function addDownloadTask(name: string, url: string, hash: string): void {
  addTask<string>(`${name}.download`, asValue(hash), async build => {
    const downloadPath = join(build.basePath, 'downloads')
    await mkdir(downloadPath, { recursive: true })
    const filename = url.replace(/.*[/]/, '')
    const filePath = join(downloadPath, filename)

    if (!(await fileExists(filePath))) {
      console.log(`Getting ${filename}...`)
      await build.exec('curl', ['-L', '-o', filePath, url])
    }

    return hash
  })
}
