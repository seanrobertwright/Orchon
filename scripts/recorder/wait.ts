// The recorder's waits: a plain one, and one that ends early when the recording is interrupted.

/** Resolves after `ms`. */
export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
