// PROTOTYPE: throwaway worker that emits a 3-second tick to test whether
// periodic refetches disturb scroll position, composer text, or focus.
import type { OrcaWorkerApi } from 'orca/worker'
import './protocol'

let tick = 0
let timer: ReturnType<typeof setInterval> | null = null

export default function activate(orca: OrcaWorkerApi): () => void {
  function startTimer(): void {
    if (timer) return
    timer = setInterval(() => {
      tick += 1
      orca.panels.post('chat.tick', { tick, at: Date.now() })
    }, 3000)
  }

  function stopTimer(): void {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  orca.panels.handle('chat.ping', () => ({ ok: true as const, tick }))
  orca.panels.handle('chat.togglePoll', ({ enabled }) => {
    if (enabled) startTimer()
    else stopTimer()
    return { enabled }
  })

  return () => stopTimer()
}
