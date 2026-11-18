// PROTOTYPE - throwaway. Reads the workflow list from a local Archon and writes trimmed graphs
// (ids, kinds, edges, nesting; no scripts or prompts) to plugin/fixtures/graphs.json, plus
// synthetic large graphs for the performance check. Run with: npm run fixtures
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.env.ARCHON_URL ?? 'http://127.0.0.1:3090'
const res = await fetch(`${BASE}/api/workflows`, { signal: AbortSignal.timeout(20000) })
if (!res.ok) throw new Error(`Archon answered ${res.status}`)
const { workflows } = await res.json()

const clip = (v, n) => (typeof v === 'string' && v.length > n ? `${v.slice(0, n - 1)}…` : v)

function flatten(rawNodes, parent, out) {
  for (const n of rawNodes ?? []) {
    const id = parent ? `${parent}/${n.id}` : n.id
    const children = n.loop_group?.nodes ?? []
    const kind = n.kind ?? 'agent'
    out.push({
      id,
      label: n.id,
      kind,
      parent: parent ?? null,
      dependsOn: (n.depends_on ?? []).map((d) => (parent ? `${parent}/${d}` : d)),
      when: clip(n.when ?? null, 200),
      triggerRule: n.trigger_rule ?? null,
      model: Array.isArray(n.model) ? n.model.join(' → ') : (n.model ?? null),
      maxIterations: n.loop_group?.max_iterations ?? n.loop?.max_iterations ?? null
    })
    flatten(children, id, out)
  }
  return out
}

// Fake run states so the status colours can be judged: a run that got part-way and paused.
function fakeStatuses(nodes) {
  const top = nodes.filter((n) => !n.parent)
  const cut = Math.floor(top.length * 0.4)
  const state = new Map()
  top.forEach((n, i) => {
    let s = i < cut ? 'completed' : i === cut ? 'running' : 'pending'
    if (i < cut && n.when && i % 3 === 1) s = 'skipped'
    if (i === cut + 1 && top.length > 4) s = 'failed'
    if (n.kind === 'wait' && i >= cut) s = 'paused'
    state.set(n.id, s)
  })
  for (const n of nodes) {
    n.status = state.get(n.id) ?? state.get(n.id.split('/')[0]) ?? 'pending'
  }
}

const graphs = []
for (const { workflow, source } of workflows) {
  if (source !== 'bundled') continue // installed packs carry their owner's name; keep them out
  const nodes = flatten(workflow.nodes, null, [])
  fakeStatuses(nodes)
  graphs.push({
    name: workflow.name,
    source,
    synthetic: false,
    description: clip(workflow.description ?? '', 240),
    nodes
  })
}
graphs.sort((a, b) => b.nodes.length - a.nodes.length)

// Synthetic layered DAGs, seeded so every build draws the same graph.
function synthetic(count, seed) {
  let s = seed
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const kinds = ['agent', 'exec', 'exec', 'agent', 'wait', 'loop']
  const width = Math.max(3, Math.round(Math.sqrt(count) / 1.5))
  const nodes = []
  for (let i = 0; i < count; i++) {
    const layer = Math.floor(i / width)
    const deps = new Set()
    if (layer > 0) {
      const wanted = 1 + Math.floor(rnd() * 2.2)
      for (let k = 0; k < wanted; k++) {
        const back = 1 + (rnd() < 0.2 ? 1 : 0)
        const from = Math.max(0, layer - back) * width
        deps.add(`step-${from + Math.floor(rnd() * width)}`)
      }
    }
    nodes.push({
      id: `step-${i}`,
      label: `step-${i}`,
      kind: kinds[Math.floor(rnd() * kinds.length)],
      parent: null,
      dependsOn: [...deps].filter((d) => Number(d.slice(5)) < i),
      when: rnd() < 0.25 ? `$step-${Math.max(0, i - width)}.output.ok == true` : null,
      triggerRule: null,
      model: null,
      maxIterations: null
    })
  }
  fakeStatuses(nodes)
  return {
    name: `synthetic-${count}`,
    source: 'synthetic',
    synthetic: true,
    description: `Generated layered graph of ${count} nodes, for the performance check only.`,
    nodes
  }
}
for (const n of [100, 300, 1000]) graphs.push(synthetic(n, n))

mkdirSync(new URL('../plugin/fixtures/', import.meta.url), { recursive: true })
const text = JSON.stringify({ graphs })
writeFileSync(new URL('../plugin/fixtures/graphs.json', import.meta.url), text)
console.log(`${graphs.length} graphs, ${text.length} bytes`)
for (const g of graphs) console.log(`  ${g.name}\t${g.nodes.length} nodes`)
