// Ctrl+C during a recording. The first Ctrl+C, or a termination signal, aborts the recording's
// signal so that every wait ends and the cleanup runs. The watcher keeps listening until it is
// let go: Node ends a process on SIGINT only when nothing listens, so a second Ctrl+C cannot end
// the recorder while the release still runs or its throwaway folder is still on disk.

/** The recording was ended early by Ctrl+C or a termination signal. */
export class Interrupted extends Error {
  override name = 'Interrupted'
}

/** What the watcher listens on: the process, or a stand-in in a test. */
export interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

export interface InterruptWatch {
  /** Aborted at the first interruption, with an `Interrupted` reason. */
  signal: AbortSignal
  /** Stops listening. Called once the release is stopped and the throwaway folder deleted. */
  dispose(): void
}

const SIGNALS = ['SIGINT', 'SIGTERM'] as const

export function watchInterrupts(target: SignalSource, say: (line: string) => void): InterruptWatch {
  const controller = new AbortController()
  const listener = (): void => {
    if (!controller.signal.aborted) {
      say('Interrupted. Stopping the release and deleting the throwaway folder.')
      controller.abort(new Interrupted('Interrupted before the recording was complete.'))
      return
    }
    say('Still stopping the release and deleting the throwaway folder. The recorder ends when they are gone.')
  }
  for (const name of SIGNALS) target.on(name, listener)
  return {
    signal: controller.signal,
    dispose() {
      for (const name of SIGNALS) target.off(name, listener)
    }
  }
}

/** Rejects with the signal's reason once it is aborted, and never settles before that. */
export function untilInterrupted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}
