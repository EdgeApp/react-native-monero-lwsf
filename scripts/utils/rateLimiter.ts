export type RateLimiter = <T>(callback: () => Promise<T>) => Promise<T>

export function makeRateLimiter(max: number): RateLimiter {
  const queue: Array<() => void> = []
  let running = 0

  return async function <R>(fn: () => Promise<R>): Promise<R> {
    if (running >= max) {
      await new Promise<void>(resolve => queue.push(resolve))
    }

    running++
    return await fn().finally(() => {
      running--
      queue.shift()?.()
    })
  }
}
