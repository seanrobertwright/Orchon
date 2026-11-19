// A question as a frame gets it, and the answer a panel sends for it. A question is an open gate
// or attention wait; its identity is what tells it from the next one, and every answer carries
// a guard taken from that identity (#14, part 6). It is types and constants only.

/** The most characters an answer's text may have, in the box and again in the worker. */
export const ANSWER_TEXT_CAP = 10_000

/** How many options of an attention wait are shown and can be chosen. Past that the block points to Archon's console. */
export const OPTIONS_CAP = 50

/** One decision a gate offers. `label` is the authored one, or null when it has none. */
export type GateDecision = { id: string; label: string | null }

/** The forms of an attention wait, a legacy wait that predates answers, and a form this version does not know. */
export type WaitForm = 'message' | 'approval' | 'select' | 'multi_select' | 'legacy' | 'unknown'

/** One option of an attention wait. `label` and `does` are null when the server sends none. */
export type WaitOption = { id: string; label: string | null; does: string | null }

export type Question =
  /**
   * A gate. Its identity is the node id and the pause id, which is null when the gate has none.
   * `decisions` are the gate's own, or approve and reject when it declares none. `message` is
   * Markdown, cut at 16 KiB, `messageCut` when it was.
   */
  | {
      kind: 'gate'
      nodeId: string
      pauseId: string | null
      message: string
      messageCut: boolean
      decisions: GateDecision[]
      /** Whether the decisions and their labels were written by the workflow's author. */
      authored: boolean
      /** Whether the step said it has finished its work, so approving completes it. */
      completionSignaled: boolean
    }
  /**
   * An attention wait. Its identity is the occurrence. At most `OPTIONS_CAP` options, and how
   * many more there are. `recommendation` names one of the options, when the server sends one.
   */
  | {
      kind: 'wait'
      nodeId: string
      occurrence: string
      form: WaitForm
      message: string
      messageCut: boolean
      options: WaitOption[]
      moreOptions: number
      recommendation: { option: string; why: string } | null
    }

/**
 * What a panel sends to answer a question: the run, the identity of the question the block was
 * drawn for, and the answer. A gate's `pauseId` is left out when the gate has none. `text` is
 * left out when nothing was typed.
 */
export type RunAnswerRequest =
  | { runId: string; kind: 'gate'; nodeId: string; pauseId?: string; decision: string; text?: string }
  | { runId: string; kind: 'wait'; occurrence: string; choose: string[]; text?: string }
