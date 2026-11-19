// The frame seam for answering a question: src/panel.tsx mounted on a scripted worker that answers
// the runs table, run detail and `run.answer`. These tests cover the answer block of a gate and of
// an attention wait, what each press sends, the draft kept per question, and what the panel shows
// once an answer returns.
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { connected, searching } from '../scripts/connection-samples.ts'
import { answeringRun, busyRuns, sampleDetail } from '../scripts/runs-samples.ts'
import * as panelModule from './panel'
import type { Question, RunAnswerRequest } from './run-answer-view'
import type { RunControlOutcome } from './run-control-view'
import type { RunDetail, RunDetailRequest, RunDetailView } from './run-detail-view'
import type { RunsRequest, RunsView } from './runs-view'

let panel: TestPanel | undefined
afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

const busy = (request: RunsRequest): RunsView => busyRuns(40, request)

type Answer = (request: RunAnswerRequest) => RunControlOutcome | Promise<RunControlOutcome>

/** Mounts the panel on run-1, answered by `detail` for every read. */
async function openOn(detail: (request: RunDetailRequest) => RunDetailView, answer?: Answer): Promise<TestPanel> {
  const base = answeringRun(busy, detail)
  const requests = {
    ...base.requests,
    'run.answer': async (request: RunAnswerRequest) => ({
      connection: connected,
      outcome: await (answer ?? (() => ({ kind: 'done', message: '' }) as const))(request)
    }),
    'run.control': () => ({ connection: connected, outcome: { kind: 'done', message: '' } as const })
  }
  panel = await mount(panelModule, { host: mockHost({ requests }), persisted: { workspace: { section: 'runs', openRun: 'run-1' } } })
  return panel
}

const paused = (question: Question, change: Partial<RunDetail> = {}): RunDetailView => ({
  kind: 'ready',
  detail: sampleDetail(1, { id: 'run-1', status: 'paused', question, ...change })
})

const GATE: Question = {
  kind: 'gate',
  nodeId: 'review-plan',
  pauseId: 'pause-1',
  message: 'Check **the plan** before it is built.',
  messageCut: false,
  decisions: [
    { id: 'approve', label: null },
    { id: 'reject', label: null }
  ],
  authored: false,
  completionSignaled: false
}

function clean(view: TestPanel): void {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
}

/** Every answer the panel sent, in order. */
const answers = (view: TestPanel): unknown[] =>
  view.host
    .callsOf('plugin.request')
    .filter((params) => (params as { name: string }).name === 'run.answer')
    .map((params) => (params as { input: unknown }).input)

const buttons = (view: TestPanel): string[] => view.findAll({ type: 'Button' }).map((button) => button.text)

describe('the answer block of a gate', () => {
  test('shows "Waiting for your decision", the step, the message as Markdown, and Continue and Reject', async () => {
    const view = await openOn(() => paused(GATE))
    assert.ok(view.find({ type: 'Text', text: 'Waiting for your decision' }))
    assert.ok(view.find({ type: 'Text', text: 'Step: review-plan' }))
    assert.equal(view.find({ type: 'Markdown' })?.props.content, 'Check **the plan** before it is built.')
    const all = buttons(view)
    assert.ok(all.includes('Continue') && all.includes('Reject'))
    assert.ok(view.find({ type: 'Textarea', label: 'Comment (optional)' }))
    clean(view)
  })
})

describe('pressing a gate decision', () => {
  test('Continue sends approve once with the comment and the guard of the gate drawn; Enter sends nothing', async () => {
    const view = await openOn(() => paused(GATE))
    const box = view.find({ type: 'Textarea', label: 'Comment (optional)' })
    assert.equal(box?.props.maxLength, 10_000)
    assert.equal(box?.props.onSubmit, undefined)
    await view.type({ type: 'Textarea', label: 'Comment (optional)' }, 'Looks good')
    assert.deepEqual(answers(view), [])
    await view.press({ type: 'Button', text: 'Continue' })
    assert.deepEqual(answers(view), [{ runId: 'run-1', kind: 'gate', nodeId: 'review-plan', pauseId: 'pause-1', decision: 'approve', text: 'Looks good' }])
    clean(view)
  })

  test('a gate with no pause id is answered with its node id alone, and no text when none was typed', async () => {
    const view = await openOn(() => paused({ ...GATE, pauseId: null }))
    await view.press({ type: 'Button', text: 'Continue' })
    assert.deepEqual(answers(view), [{ runId: 'run-1', kind: 'gate', nodeId: 'review-plan', decision: 'approve' }])
  })

  test('Reject swaps the controls for a required box, a send button named for it and Back', async () => {
    const view = await openOn(() => paused(GATE))
    await view.press({ type: 'Button', text: 'Reject' })
    assert.equal(answers(view).length, 0)
    assert.ok(view.find({ type: 'Textarea', label: 'Your reason to Reject' }))
    assert.equal(view.find({ type: 'Button', text: 'Continue' }), null)
    assert.equal(view.find({ type: 'Button', text: 'Reject' })?.props.disabled, true)
    await view.press({ type: 'Button', text: 'Back' })
    assert.ok(view.find({ type: 'Button', text: 'Continue' }))
    await view.press({ type: 'Button', text: 'Reject' })
    await view.type({ type: 'Textarea', label: 'Your reason to Reject' }, '   ')
    assert.equal(view.find({ type: 'Button', text: 'Reject' })?.props.disabled, true)
    await view.type({ type: 'Textarea', label: 'Your reason to Reject' }, 'Too big', { replace: true })
    await view.press({ type: 'Button', text: 'Reject' })
    assert.deepEqual(answers(view), [{ runId: 'run-1', kind: 'gate', nodeId: 'review-plan', pauseId: 'pause-1', decision: 'reject', text: 'Too big' }])
    clean(view)
  })

  test('authored decisions show their labels, and every one but approve needs text', async () => {
    const decisions = [
      { id: 'approve', label: 'Ship it' },
      { id: 'revise', label: 'Send back' },
      { id: 'park', label: null }
    ]
    const view = await openOn(() => paused({ ...GATE, decisions, authored: true }))
    for (const label of ['Ship it', 'Send back', 'park']) assert.ok(view.find({ type: 'Button', text: label }), label)
    await view.press({ type: 'Button', text: 'park' })
    assert.ok(view.find({ type: 'Textarea', label: 'Your reason to park' }))
  })

  test('a gate whose step signalled it finished reads "Accept & complete" until a comment is typed', async () => {
    const view = await openOn(() => paused({ ...GATE, completionSignaled: true }))
    assert.ok(view.find({ type: 'Button', text: 'Accept & complete' }))
    await view.type({ type: 'Textarea', label: 'Comment (optional)' }, 'One more pass')
    assert.ok(view.find({ type: 'Button', text: 'Continue' }))
  })

  test('a message past 16 KiB says it was cut and points to Archon\'s console', async () => {
    const view = await openOn(() => paused({ ...GATE, messageCut: true }))
    assert.ok(view.find({ type: 'Text', text: "The message is cut at 16 KiB. Open Archon's console to read all of it." }))
  })

  test('while Searching every decision is off', async () => {
    const base = answeringRun(busy, () => paused(GATE))
    panel = await mount(panelModule, { host: mockHost({ requests: base.requests }), persisted: { workspace: { section: 'runs', openRun: 'run-1' } } })
    await panel.post('connection.changed', { ...searching, since: connected.since + 1 })
    assert.equal(panel.find({ type: 'Button', text: 'Continue' })?.props.disabled, true)
    assert.equal(panel.find({ type: 'Button', text: 'Reject' })?.props.disabled, true)
  })
})

const WAIT: Question = {
  kind: 'wait',
  nodeId: 'ask',
  occurrence: 'occ-1',
  form: 'select',
  message: 'Which way?',
  messageCut: false,
  options: [
    { id: 'first', label: 'The first option', does: 'Builds it now' },
    { id: 'second', label: null, does: null }
  ],
  moreOptions: 0,
  recommendation: null
}

describe('the answer block of an attention wait', () => {
  test('a select shows "Waiting for your answer", a radio group with nothing chosen, and Answer off until one is', async () => {
    const view = await openOn(() => paused(WAIT))
    assert.ok(view.find({ type: 'Text', text: 'Waiting for your answer' }))
    const group = view.find({ type: 'RadioGroup', label: 'Options' })
    assert.deepEqual(group?.props.options, [
      { value: 'first', label: 'The first option', description: 'Builds it now' },
      { value: 'second', label: 'second' }
    ])
    assert.equal(group?.props.value, undefined)
    assert.equal(view.find({ type: 'Button', text: 'Answer' })?.props.disabled, true)
    assert.deepEqual(buttons(view).filter((text) => text === 'Abandon' || text === 'Resume'), ['Abandon'])
    await view.select({ type: 'RadioGroup', label: 'Options' }, 'second')
    await view.type({ type: 'Textarea', label: 'Comment (optional)' }, 'Why not')
    assert.deepEqual(answers(view), [])
    await view.press({ type: 'Button', text: 'Answer' })
    assert.deepEqual(answers(view), [{ runId: 'run-1', kind: 'wait', occurrence: 'occ-1', choose: ['second'], text: 'Why not' }])
    clean(view)
  })

  test('an approval form is a radio group too, with the recommendation on its own line and nothing preselected', async () => {
    const view = await openOn(() => paused({ ...WAIT, form: 'approval', recommendation: { option: 'first', why: 'It is smaller.' } }))
    assert.equal(view.find({ type: 'RadioGroup', label: 'Options' })?.props.value, undefined)
    assert.ok(view.find({ type: 'Text', text: 'Recommended: The first option. It is smaller.' }))
  })

  test('a multi_select is a checkbox per option, and Answer is on once one is ticked', async () => {
    const view = await openOn(() => paused({ ...WAIT, form: 'multi_select' }))
    assert.equal(view.find({ type: 'RadioGroup' }), null)
    assert.equal(view.find({ type: 'Checkbox', label: 'The first option' })?.props.description, 'Builds it now')
    assert.equal(view.find({ type: 'Button', text: 'Answer' })?.props.disabled, true)
    await view.toggle({ type: 'Checkbox', label: 'second' })
    await view.toggle({ type: 'Checkbox', label: 'The first option' })
    await view.press({ type: 'Button', text: 'Answer' })
    assert.deepEqual(answers(view), [{ runId: 'run-1', kind: 'wait', occurrence: 'occ-1', choose: ['first', 'second'] }])
    clean(view)
  })

  test('a message form is a required text box', async () => {
    const view = await openOn(() => paused({ ...WAIT, form: 'message', options: [] }))
    const box = view.find({ type: 'Textarea', label: 'Your answer' })
    assert.equal(box?.props.maxLength, 10_000)
    assert.equal(view.find({ type: 'Button', text: 'Answer' })?.props.disabled, true)
    await view.type({ type: 'Textarea', label: 'Your answer' }, 'Use the blue one')
    await view.press({ type: 'Button', text: 'Answer' })
    assert.deepEqual(answers(view), [{ runId: 'run-1', kind: 'wait', occurrence: 'occ-1', choose: [], text: 'Use the blue one' }])
  })

  test('options past 50 point to Archon\'s console', async () => {
    const view = await openOn(() => paused({ ...WAIT, moreOptions: 3 }))
    assert.ok(view.find({ type: 'Text', text: "3 more options are not shown. Open Archon's console to choose one of them." }))
  })

  test('a legacy wait shows a sentence with Resume and Abandon, and no form', async () => {
    const view = await openOn(() => paused({ ...WAIT, form: 'legacy', occurrence: 'legacy:1', options: [] }))
    assert.ok(view.find({ type: 'Text', text: 'This wait was paused before Archon took answers, so it has no form. Resume continues the run.' }))
    assert.equal(view.find({ type: 'Button', text: 'Answer' }), null)
    assert.deepEqual(buttons(view).filter((text) => text === 'Abandon' || text === 'Resume'), ['Resume', 'Abandon'])
  })

  test('a form this version does not know points to Archon\'s console, with Abandon', async () => {
    const view = await openOn(() => paused({ ...WAIT, form: 'unknown', options: [] }))
    assert.ok(view.find({ type: 'Text', text: "This wait asks in a way this version of Orchon does not know. Open Archon's console to answer it." }))
    assert.equal(view.find({ type: 'Button', text: 'Answer' }), null)
    assert.deepEqual(buttons(view).filter((text) => text === 'Abandon' || text === 'Resume'), ['Abandon'])
  })
})
