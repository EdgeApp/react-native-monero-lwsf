import { spawn } from 'node:child_process'
import type { WriteStream } from 'node:fs'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'

import {
  asArray,
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
export interface Task<R> {
  name: string
  asResult: Cleaner<R>
  run: (build: Build) => Promise<R>
}

interface ExecOptions {
  cwd?: string
  capture?: true
  env?: NodeJS.ProcessEnv
}

/**
 * Context about the current build.
 */
export interface Build {
  /** The top-level working directory. All output should go under here. */
  readonly basePath: string

  /** Changes the default directory used for exec */
  readonly cwd: string
  cd: (path: string) => void

  /** Defines variables in the environment for `exec`. */
  readonly env: NodeJS.ProcessEnv
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
  readonly logStream: WriteStream
  log: (message: string) => void

  /**
   * Launches another task, and returns its result.
   */
  runTask: <T extends string | Task<unknown>>(
    nameOrTask: T
  ) => Promise<T extends Task<infer R> ? R : unknown>
}

export class TaskError extends Error {
  readonly taskName: string
  readonly reason: unknown // The actual error

  constructor(taskName: string, reason: unknown) {
    super(`Task failed: ${taskName}`)
    this.taskName = taskName
    this.reason = reason
  }
}

/**
 * Adds a task to the global registry, so it can be called by name.
 */
export function addTask<R>(
  name: string,
  asResult: Cleaner<R>,
  run: (build: Build) => Promise<R>
): Task<R> {
  if (allTasks.has(name)) {
    throw new Error(`Task "${name}" already exists`)
  }
  const task: Task<R> = { name, asResult, run }
  allTasks.set(name, task)
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

  // Used to guard against recursion
  interface Stack {
    task: Task<unknown>
    parent: Stack | undefined
  }

  // If we are already working on a task, don't work on it again:
  type TaskState = Promise<{ clean: boolean; result: unknown }>
  const states = new Map<Task<unknown>, TaskState>()

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  function runTaskOnce(
    task: Task<unknown>,
    parent: Stack | undefined
  ): TaskState {
    const running = states.get(task)
    if (running != null) return running
    const state = runTaskInner(task, parent)
    states.set(task, state)
    return state
  }

  const rateLimiter = makeRateLimiter(maxExec)

  /**
   * Tries to run a task, but checks disk first to see if we can skip.
   */
  async function runTaskInner(
    task: Task<unknown>,
    parent: Stack | undefined
  ): TaskState {
    const stack: Stack = { task, parent }
    const statusFile = join(statusPath, `${task.name}.json`)
    const asOurStatusFile = asStatusFile(task.asResult)
    const wasOurStatusFile = uncleaner(asOurStatusFile)

    // First, load the status file and recurse into any saved dependencies:
    try {
      const text = await readFile(statusFile, { encoding: 'utf8' })
      const file = asOurStatusFile(text)
      const childStates = await Promise.all(
        file.deps.map(
          async name => await runTaskOnce(getTaskByName(name), stack)
        )
      )

      // If everybody is clean, we can just use the cached result:
      if (childStates.every(state => state.clean)) {
        console.log(`${task.name} up-to-date`)
        return { clean: true, result: file.result }
      }
    } catch (error) {
      // Stop if the task ran but failed:
      if (error instanceof TaskError) throw error
    }

    // Otherwise, run the task for real:
    const logFile = join(logPath, `${task.name}.log`)
    const fd = await open(logFile, 'w')
    const logStream = fd.createWriteStream({ encoding: 'utf8' })

    let workPath = basePath
    const baseEnv = { ...process.env }
    const deps = new Set<string>()
    const build: Build = {
      basePath,

      get cwd() {
        return workPath
      },

      cd(path) {
        workPath = path
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
        const { capture = false, cwd = workPath, env = baseEnv } = opts ?? {}
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
      log(message: string): void {
        logStream.write(message + '\n')
      },

      async runTask(nameOrTask) {
        const task: Task<unknown> =
          typeof nameOrTask === 'string'
            ? getTaskByName(nameOrTask)
            : nameOrTask

        // Check for recursion before we start:
        const steps: string[] = [task.name]
        for (let i: Stack | undefined = stack; i != null; i = i.parent) {
          steps.push(i.task.name)
          if (i.task === task) {
            const trace = steps.reverse().join(' > ')
            throw new Error(`Build recursion detected: ${trace}`)
          }
        }

        // No recursion, so it's a valid dependency:
        deps.add(task.name)
        const { result } = await runTaskOnce(task, stack)
        return result as any
      }
    }

    console.log(`${task.name} started`)
    return await task
      .run(build)
      .then(async result => {
        // Save and return the result:
        const text = wasOurStatusFile({
          deps: [...deps],
          result
        })
        await writeFile(statusFile, text, { encoding: 'utf8' })
        console.log(`${task.name} completed`)
        return { clean: false, result }
      })
      .catch((error: unknown) => {
        if (!(error instanceof TaskError))
          console.log(`${task.name} failed: ${String(error)}\n  See ${logFile}`)
        throw new TaskError(task.name, error)
      })
      .finally(async () => {
        // Close the log stream:
        await new Promise<void>(resolve => logStream.end(resolve))
      })
  }

  await runTaskOnce(getTaskByName(name), undefined)
}

// The global task registry:
const allTasks = new Map<string, Task<unknown>>()

function getTaskByName(name: string): Task<unknown> {
  const task = allTasks.get(name)
  if (task == null) throw new Error(`Cannot find task "${name}"`)
  return task
}

interface StatusFile<R> {
  deps: string[]
  result: R
}

const asStatusFile = <R>(asResult: Cleaner<R>): Cleaner<StatusFile<R>> =>
  asJSON(
    asObject({
      deps: asArray(asString),
      result: asResult
    })
  )
