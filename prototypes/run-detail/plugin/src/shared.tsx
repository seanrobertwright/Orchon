// PROTOTYPE. The pieces every variant uses: state words, formatting, and the blocks that other
// decisions already fixed (the answer block, the action row) or that are a factual check rather
// than a layout choice (what a selected item or file draws).
import {
  Badge,
  Button,
  Callout,
  Code,
  CodeView,
  Markdown,
  RadioGroup,
  read,
  Row,
  Stack,
  Text,
  type IconName,
  type KeyValueItem,
  type Tone
} from 'orca'
import type { ArtifactBody, ItemKind, ItemPreview, RunDetail, StepRow, StepState, StepView } from './protocol'
import { note, setSplit, split } from './state'

/** A word and a glyph for each state, so colour never carries the meaning alone. */
export const STATE: Record<StepState, { word: string; glyph: string; tone: Tone }> = {
  completed: { word: 'Completed', glyph: '✓', tone: 'success' },
  running: { word: 'Running', glyph: '●', tone: 'accent' },
  failed: { word: 'Failed', glyph: '✕', tone: 'danger' },
  skipped: { word: 'Skipped', glyph: '−', tone: 'neutral' },
  pending: { word: 'Not reached', glyph: '○', tone: 'neutral' },
  paused: { word: 'Waiting', glyph: '‖', tone: 'warning' }
}

export const KIND: Record<ItemKind, { word: string; glyph: string; icon: IconName }> = {
  tool: { word: 'Tool call', glyph: '⚙', icon: 'wrench' },
  text: { word: 'Agent text', glyph: '¶', icon: 'bot' },
  thought: { word: 'Thinking', glyph: '…', icon: 'lightbulb' },
  subtask: { word: 'Subtask', glyph: '⧉', icon: 'layers' },
  warning: { word: 'Warning', glyph: '!', icon: 'warning' },
  hook: { word: 'Failed hook', glyph: '✕', icon: 'error' }
}

export function StateBadge(state: StepState) {
  const entry = STATE[state]
  // A badge draws its own dot in the tone's colour, so the glyph would show twice.
  return <Badge tone={entry.tone}>{entry.word}</Badge>
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The one date helper of this prototype: a wall-clock time in the machine's zone. */
export function clock(ms: number): string {
  const date = new Date(ms)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function took(step: StepRow): string {
  if (step.startedAt === null) return ''
  if (step.endedAt === null) return step.state === 'running' ? 'still going' : ''
  return duration(step.endedAt - step.startedAt)
}

/** "inner step of implement" and "ran 3 times", the two marks whose wording is open. */
export function marks(step: StepRow): string[] {
  const list: string[] = []
  if (step.parent) list.push(`inner step of ${step.parent}`)
  if (step.ran > 1) list.push(`ran ${step.ran} times`)
  return list
}

/** Fixed by the run control decision: the question and its answers sit at the top of run detail. */
export function AnswerBlock(run: RunDetail) {
  if (!run.attention) return null
  return (
    <Callout tone="warning" title="This run is waiting on you">
      <Stack gap="sm">
        <Markdown content={run.attention.question} />
        <RadioGroup
          label="Your answer"
          labelHidden
          options={run.attention.options.map((option) => ({ value: option, label: option }))}
          onChange={(value) => note(`chose "${value}"`)}
        />
        <Row>
          <Button size="sm" onPress={() => note('answer the attention wait')}>
            Answer
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

/** Fixed by the run control and launching decisions. */
export function ActionRow(run: RunDetail) {
  return (
    <Row gap="xs" wrap>
      {run.status === 'running' || run.status === 'paused' ? (
        <Button size="sm" variant="outline" tone="danger" icon="stop" onPress={() => note('cancel (asks to confirm inline)')}>
          Cancel
        </Button>
      ) : null}
      {run.status === 'failed' ? (
        <Button size="sm" variant="outline" icon="play" onPress={() => note('resume')}>
          Resume
        </Button>
      ) : null}
      {run.status === 'failed' ? (
        <Button size="sm" variant="outline" tone="danger" onPress={() => note('abandon (asks to confirm inline)')}>
          Abandon
        </Button>
      ) : null}
      {run.status === 'completed' ? (
        <Button size="sm" variant="outline" icon="refresh" onPress={() => note('open Launch filled in from this run')}>
          Re-run
        </Button>
      ) : null}
    </Row>
  )
}

export function runFacts(run: RunDetail): KeyValueItem[] {
  return [
    { label: 'Workflow', value: run.workflow },
    { label: 'State', value: `${STATE[run.status].glyph} ${run.status === 'paused' ? 'Paused' : STATE[run.status].word}` },
    { label: 'Started', value: clock(run.startedAt) },
    { label: 'Ran for', value: run.endedAt ? duration(run.endedAt - run.startedAt) : 'still going' },
    { label: 'Cost', value: `$${run.costUsd.toFixed(2)}` },
    { label: 'Project', value: run.project },
    { label: 'Run', value: run.id.slice(0, 8), code: true }
  ]
}

export function stepFacts(view: StepView): KeyValueItem[] {
  const { step } = view
  const list: KeyValueItem[] = [
    { label: 'Kind', value: step.kind },
    { label: 'State', value: `${STATE[step.state].glyph} ${STATE[step.state].word}` }
  ]
  if (step.startedAt !== null) list.push({ label: 'Started', value: clock(step.startedAt) })
  if (step.endedAt !== null) list.push({ label: 'Ended', value: clock(step.endedAt) })
  if (took(step)) list.push({ label: 'Took', value: took(step) })
  if (view.costUsd !== null) list.push({ label: 'Cost', value: `$${view.costUsd.toFixed(2)}` })
  if (view.tokensIn !== null && view.tokensOut !== null) {
    list.push({ label: 'Tokens', value: `${view.tokensIn.toLocaleString('en-US')} in, ${view.tokensOut.toLocaleString('en-US')} out` })
  }
  if (view.model) list.push({ label: 'Model', value: `${view.model} (${view.provider})` })
  if (view.turns !== null) list.push({ label: 'Turns', value: view.turns })
  if (view.stopReason) list.push({ label: 'Stopped', value: view.stopReason })
  if (view.skipReason) list.push({ label: 'Skipped', value: view.skipReason })
  return list
}

export function hiddenLine(view: StepView): string {
  return view.hidden > 0 ? `${view.hidden.toLocaleString('en-US')} hook and state events are not listed.` : ''
}

/** What a selected activity item draws. The same in every variant. */
export function ItemBody(preview: ItemPreview) {
  const kind = KIND[preview.kind]
  return (
    <Stack gap="xs">
      <Row gap="xs" align="center" wrap>
        <Badge>{kind.word}</Badge>
        {preview.state ? <Badge tone={preview.state === 'failed' ? 'danger' : preview.state === 'in progress' ? 'accent' : 'success'}>{preview.state}</Badge> : null}
        <Text muted size="xs">
          {clock(preview.at)}
        </Text>
      </Row>
      {preview.text !== null ? <Text size="sm">{preview.text}</Text> : null}
      {preview.textCut ? <Text muted size="xs">Cut here: one text shows at most 16 KiB.</Text> : null}
      {preview.input !== null ? <CodeView label="Input" code={preview.input} language="json" wrap maxHeight="sm" /> : null}
      {preview.inputCut ? <Text muted size="xs">Input cut here: one text shows at most 16 KiB.</Text> : null}
      {preview.kind === 'tool' && preview.output === null ? <Text muted size="xs">No output yet.</Text> : null}
      {preview.output !== null ? <CodeView label="Output" code={preview.output} wrap maxHeight="sm" /> : null}
      {preview.outputCut ? <Text muted size="xs">Output cut here: one text shows at most 16 KiB.</Text> : null}
      {preview.archonTruncated ? <Text muted size="xs">Archon stored only the first part of this output.</Text> : null}
    </Stack>
  )
}

/** Not part of the design being judged: flips how a long Markdown file is cut into blocks. */
function SplitSwitch(body: ArtifactBody) {
  return (
    <Row gap="xs" align="center" wrap>
      <Text size="xs" weight="semibold">
        PROTOTYPE: {body.blocks.length} blocks, cut
      </Text>
      <Button size="xs" variant={read(split) === 'lines' ? 'solid' : 'outline'} onPress={() => setSplit('lines')}>
        at any line break
      </Button>
      <Button size="xs" variant={read(split) === 'blocks' ? 'solid' : 'outline'} onPress={() => setSplit('blocks')}>
        at blank lines, re-opening fences and tables
      </Button>
    </Row>
  )
}

/** What a selected artifact draws: its blocks one after another, with nothing between them. */
export function ArtifactBodyView(body: ArtifactBody) {
  if (body.kind === 'too-large') {
    return <Text size="sm">{body.path} is {bytes(body.size)}. Files over 256 KB are not shown here.</Text>
  }
  if (body.kind === 'binary') {
    return <Text size="sm">{body.path} is {bytes(body.size)} and is not text, so it is not shown here.</Text>
  }
  return (
    <Stack gap={body.kind === 'markdown' ? 'none' : 'xs'}>
      {body.kind === 'markdown' && body.blocks.length > 1 ? SplitSwitch(body) : null}
      {body.blocks.map((block, index) =>
        body.kind === 'markdown' ? <Markdown key={`b${index}`} content={block} /> : <Code key={`b${index}`} block>{block}</Code>
      )}
    </Stack>
  )
}
