import { spawn } from 'node:child_process'
import type { WriteStream } from 'node:fs'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'

import {
  asBoolean,
  asDate,
  asJSON,
  asObject,
  asString,
  type Cleaner,
  uncleaner
} from 'cleaners'

import { makeRateLimiter } from './rateLimiter'

/**
 * A build task that can be run.
 * Use `addTask` to ensure names are unique.
 */
export interface Task<R = unknown> {
  name: string

  /**
   * Allows tasks to avoid re-running as long as the previous
   * success had the same tag.
   */
  cacheTag?: string

  /**
   * Dependencies that must run first.
   */
  deps?: string[]

  run: (build: Build) => Promise<R>
}

interface ExecOptions {
  /** True to capture stdout as a string, and return it */
  capture?: true

  /** The working directory. Defaults to `Build.cwd` */
  cwd?: string

  /** Extra environment variables to add to `Build.env` */
  env?: NodeJS.ProcessEnv
}

/**
 * Context about the current build.
 */
export interface Build {
  /** The default working directory (typically `tmp`) */
  readonly basePath: string

  /** The default directory used for `exec`. Defaults to `basePath` */
  readonly cwd: string

  /** Changes the default directory used for `exec` */
  cd: (path: string) => void

  /** Defines variables in the environment for `exec`. */
  readonly env: NodeJS.ProcessEnv

  /** Adds or removes variables in the environment for `exec`. */
  exportEnv: (keys: Record<string, string | null>) => void

  /**
   * Spawn an external tool.
   * Output automatically goes to the task log file.
   */
  exec: (
    command: string,
    args?: readonly string[],
    opts?: ExecOptions
  ) => Promise<string>

  /**
   * Log output for the task.
   * Don't use `console.log`, since parallel builds will jumble everything.
   */
  log: (message: string) => void

  /** The output stream for all log messages. */
  readonly logStream: WriteStream

  /**
   * Runs an inline task once per build without touching the disk cache.
   */
  runTask: <R>(task: Task<R>) => Promise<R>
}

/**
 * Adds a task to the global registry, so it can be called by name.
 */
export function addTask<R>(task: Task<R>): Task<R> {
  if (allTasks.has(task.name)) {
    throw new Error(`Task "${task.name}" already exists`)
  }
  allTasks.set(task.name, task)
  return task
}

/**
 * Begins a build process, using the named task as a starting point.
 */
export async function startBuild(
  name: string,
  opts: { basePath: string; maxExec?: number }
): Promise<void> {
  const { basePath, maxExec = os.cpus().length } = opts
  const logPath = join(basePath, 'logs')
  const statusPath = join(basePath, 'status')
  await mkdir(logPath, { recursive: true })
  await mkdir(statusPath, { recursive: true })

  // Tasks we are running for real:
  const outputs = new Map<Task, Promise<unknown>>()

  // Tasks we are trying to skip:
  const cleanTasks = new Map<Task, Promise<boolean>>()

  // Build.exec uses this to limit concurrency:
  const rateLimiter = makeRateLimiter(maxExec)

  // Used to guard against recursion:
  interface Stack {
    task: Task
    parent: Stack | undefined
  }

  /**
   * Throws if the given task already exists in the stack.
   */
  function checkRecursion(task: Task, parent: Stack | undefined): void {
    const steps: string[] = [task.name]
    for (let i: Stack | undefined = parent; i != null; i = i.parent) {
      steps.push(i.task.name)
      if (i.task === task) {
        const trace = steps.reverse().join(' > ')
        throw new Error(`Build recursion detected: ${trace}`)
      }
    }
  }

  /**
   * Runs a task for real, if it isn't already running.
   */
  async function runTaskOnce<R>(
    task: Task<R>,
    parent: Stack | undefined
  ): Promise<R> {
    const running = outputs.get(task)
    if (running != null) return await (running as Promise<R>)
    const output = runTaskInternal(task, parent)
    outputs.set(task, output)
    return await output
  }

  async function runTaskInternal<R>(
    task: Task<R>,
    parent: Stack | undefined
  ): Promise<R> {
    // Guard against recursion:
    checkRecursion(task, parent)

    // Run the dependencies:
    const deps = task.deps ?? []
    await Promise.all(
      deps.map(async name => await checkTaskOnce(name, { task, parent }))
    )

    // Prepare the build environment:
    const logFile = join(logPath, `${task.name}.log`)
    const fd = await open(logFile, 'w')
    const logStream = fd.createWriteStream({ encoding: 'utf8' })

    let currentPath = basePath
    const baseEnv = { ...process.env }
    const build: Build = {
      basePath,

      get cwd() {
        return currentPath
      },

      cd(path) {
        currentPath = path
      },

      get env() {
        return baseEnv
      },

      exportEnv(keys) {
        for (const key of Object.keys(keys)) {
          baseEnv[key] = keys[key] ?? undefined
        }
      },

      async exec(command, args = [], opts) {
        const { capture = false, cwd = currentPath, env = baseEnv } = opts ?? {}
        logStream.write(`$ ${command} ${args.join(' ')}\n`)

        return await rateLimiter(async () => {
          return await new Promise<string>((resolve, reject) => {
            const child = spawn(command, args, {
              cwd,
              env,
              stdio: ['inherit', 'pipe', 'pipe']
            })
            child.stderr?.pipe(logStream, { end: false })
            child.stdout?.pipe(logStream, { end: false })
            function cleanup(): void {
              child.stderr?.unpipe(logStream)
              child.stdout?.unpipe(logStream)
            }

            let stdoutBuf = ''
            if (capture) {
              child.stdout?.setEncoding('utf8')
              child.stdout?.on('data', chunk => {
                stdoutBuf += chunk
              })
            }

            child.on('error', (error: unknown) => {
              cleanup()
              reject(error)
            })
            child.on('exit', code => {
              cleanup()
              if (code === 0) {
                resolve(stdoutBuf)
              } else {
                reject(new Error(`${command} exited with code ${String(code)}`))
              }
            })
          })
        })
      },

      logStream,
      log(message: string) {
        logStream.write(message + '\n')
      },

      async runTask<R>(inlineTask: Task<R>): Promise<R> {
        return await runTaskOnce(inlineTask, { task, parent })
      }
    }

    try {
      console.log(`${task.name} started`)
      const result = await task.run(build)
      console.log(`${task.name} completed`)
      await writeStatus(task, true)
      return result
    } catch (error) {
      console.log(`${task.name} failed: ${String(error)}\n  See ${logFile}`)
      await writeStatus(task, false)
      throw error
    } finally {
      // Close the log stream:
      await new Promise<void>(resolve => logStream.end(resolve))
    }
  }

  async function writeStatus(task: Task, success: boolean): Promise<void> {
    if (task.cacheTag == null) return

    const statusFile = join(statusPath, `${task.name}.json`)
    await writeFile(
      statusFile,
      wasStatusFile({
        cacheTag: task.cacheTag,
        lastRun: new Date(),
        success
      }),
      { encoding: 'utf8' }
    )
  }

  /**
   * Tries to run a task, but checks disk first to see if we can skip.
   * @return True if the task was already clean, or false if we ran it.
   */
  async function checkTaskOnce(
    name: string,
    parent: Stack | undefined
  ): Promise<boolean> {
    const task = getTaskByName(name)
    const clean = cleanTasks.get(task)
    if (clean != null) return await clean
    const out = checkTaskInternal(task, parent)
    cleanTasks.set(task, out)
    return await out
  }

  async function checkTaskInternal(
    task: Task,
    parent: Stack | undefined
  ): Promise<boolean> {
    // Guard against recursion:
    checkRecursion(task, parent)

    // Run the dependencies:
    const deps = task.deps ?? []
    const depsClean = await Promise.all(
      deps.map(async name => await checkTaskOnce(name, { task, parent }))
    )

    // We need to run if our dependencies were dirty:
    if (task.cacheTag == null || depsClean.some(clean => !clean)) {
      await runTaskOnce(task, parent)
      return false
    }

    // Read the status file:
    const statusFile = join(statusPath, `${task.name}.json`)
    const status = await readFile(statusFile, { encoding: 'utf8' })
      .then(asStatusFile)
      .catch(() => {})

    // Run the task if the status is bad:
    if (
      status == null ||
      !status.success ||
      status.cacheTag !== task.cacheTag
    ) {
      await runTaskOnce(task, parent)
      return false
    }

    // All clean:
    return true
  }

  await checkTaskOnce(name, undefined)
}

// The global task registry:
const allTasks = new Map<string, Task>()

function getTaskByName(name: string): Task {
  const task = allTasks.get(name)
  if (task == null) throw new Error(`Cannot find task "${name}"`)
  return task
}

interface StatusFile {
  cacheTag: string
  lastRun: Date
  success: boolean
}

const asStatusFile: Cleaner<StatusFile> = asJSON(
  asObject({
    cacheTag: asString,
    lastRun: asDate,
    success: asBoolean
  })
)

const wasStatusFile = uncleaner(asStatusFile)
