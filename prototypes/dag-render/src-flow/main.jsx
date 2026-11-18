// PROTOTYPE - throwaway. Variant B: the same dagre layout handed to React Flow. This file needs
// a build step (npm run build), which writes plugin/editor-flow/main.js and main.css.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Background,
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './flow.css'
import {
  STATUS_GLYPH,
  clipLabel,
  edgePath,
  kindLine,
  layoutGraph,
  visibleGraph
} from '../plugin/shared/layout.js'
import { afterPaint, loadContext, loadGraph, showDetail } from '../plugin/shared/chrome.js'

function StepNode({ data }) {
  const vertical = data.direction === 'TB'
  return (
    <div className={`step st-${data.status}`}>
      <Handle type="target" position={vertical ? Position.Top : Position.Left} />
      <span className="bar" />
      <span className="text">
        <span className="label">{clipLabel(data.label)}</span>
        <span className="kind">{kindLine(data)}</span>
      </span>
      <span className="glyph" aria-hidden="true">
        {STATUS_GLYPH[data.status]}
      </span>
      <Handle type="source" position={vertical ? Position.Bottom : Position.Right} />
    </div>
  )
}

function GroupNode({ data }) {
  return (
    <div className="loop-group">
      {data.label} · {data.kind}
    </div>
  )
}

// Draws the edge along dagre's routed points, as variant A does, in place of React Flow's own
// curve between handles. The points are fixed, so nodes cannot be dragged while this is on.
function RoutedEdge({ data, markerEnd, style }) {
  return <BaseEdge path={edgePath(data.points)} markerEnd={markerEnd} style={style} />
}

const nodeTypes = { step: StepNode, loopGroup: GroupNode }
const edgeTypes = { routed: RoutedEdge }

function toNodes(layout, direction) {
  const box = new Map(layout.nodes.map((n) => [n.id, n]))
  return layout.nodes.map((n) => {
    const parent = n.data.parent ? box.get(n.data.parent) : null
    return {
      id: n.id,
      type: n.group ? 'loopGroup' : 'step',
      position: { x: n.x - (parent?.x ?? 0), y: n.y - (parent?.y ?? 0) },
      width: n.w,
      height: n.h,
      parentId: parent ? parent.id : undefined,
      selectable: !n.group,
      focusable: !n.group,
      ariaLabel: `${n.data.label}, ${n.data.kind}, ${n.data.status}`,
      data: { ...n.data, direction }
    }
  })
}

function toEdges(layout, routed) {
  return layout.edges.map((e) => ({
    id: e.id,
    type: routed ? 'routed' : undefined,
    data: { points: e.points },
    source: e.from,
    target: e.to,
    className: e.conditional ? 'conditional' : undefined,
    markerEnd: { type: MarkerType.ArrowClosed },
    focusable: false
  }))
}

function App({ list, initial, pointer }) {
  const [name, setName] = useState(initial)
  const [direction, setDirection] = useState(pointer.direction === 'LR' ? 'LR' : 'TB')
  const [expand, setExpand] = useState(pointer.expand === true)
  const [cull, setCull] = useState(false)
  const [routed, setRouted] = useState(true)
  const [graph, setGraph] = useState(null)
  const [selected, setSelected] = useState(null)
  const [stats, setStats] = useState('loading…')
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const aside = useRef(null)
  const flow = useReactFlow()

  useEffect(() => {
    let stale = false
    ;(async () => {
      setStats('loading…')
      const { graph: full, fetchMs } = await loadGraph(name)
      if (stale) return
      const next = visibleGraph(full, expand)
      const t0 = performance.now()
      const layout = layoutGraph(next, direction)
      const t1 = performance.now()
      const nextEdges = toEdges(layout, routed)
      setGraph(next)
      setSelected(null)
      setNodes(toNodes(layout, direction))
      setEdges(nextEdges)
      // React Flow draws nodes, measures them, then draws edges: wait for that second pass.
      const deadline = t1 + 30000
      let t2 = await afterPaint()
      while (
        !stale &&
        nextEdges.length > 0 &&
        document.querySelectorAll('.react-flow__edge').length === 0 &&
        t2 < deadline
      ) {
        t2 = await afterPaint()
      }
      if (stale) return
      await flow.fitView({ padding: 0.05 })
      const t3 = await afterPaint()
      const text =
        `${next.nodes.length} nodes · ${nextEdges.length} edges · ` +
        `${document.querySelectorAll('.react-flow *').length} elements\n` +
        `worker ${fetchMs.toFixed(0)} ms · layout ${(t1 - t0).toFixed(0)} ms · ` +
        `draw+measure ${(t2 - t1).toFixed(0)} ms · fit+paint ${(t3 - t2).toFixed(0)} ms`
      setStats(text)
      void orca.plugin.request('stats.report', {
        line: `flow ${name}${expand ? ' expanded' : ''}${routed ? ' routed' : ''}: ${text.replace('\n', ' | ')}`
      })
    })()
    return () => {
      stale = true
    }
  }, [name, direction, expand, routed, flow, setNodes, setEdges])

  useEffect(() => {
    if (graph && aside.current) {
      showDetail(aside.current, graph, graph.nodes.find((n) => n.id === selected) ?? null)
    }
  }, [graph, selected])

  const onSelectionChange = useCallback(({ nodes: picked }) => {
    setSelected(picked[0]?.id ?? null)
  }, [])

  return (
    <>
      <header>
        <strong>B · React Flow</strong>
        <label>
          Workflow{' '}
          <select value={name} onChange={(e) => setName(e.target.value)}>
            {list.map((g) => (
              <option key={g.name} value={g.name}>
                {g.name} ({g.nodes})
              </option>
            ))}
          </select>
        </label>
        <label>
          Direction{' '}
          <select value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="TB">Top to bottom</option>
            <option value="LR">Left to right</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={expand} onChange={(e) => setExpand(e.target.checked)} />
          Expand loop groups
        </label>
        <label>
          <input type="checkbox" checked={routed} onChange={(e) => setRouted(e.target.checked)} />
          Route edges around steps
        </label>
        <label>
          <input type="checkbox" checked={cull} onChange={(e) => setCull(e.target.checked)} />
          Draw only what is in view
        </label>
        <span id="stats" role="status">
          {stats}
        </span>
      </header>
      <main>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={!routed}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onSelectionChange={onSelectionChange}
          nodesConnectable={false}
          onlyRenderVisibleElements={cull}
          minZoom={0.03}
          maxZoom={3}
          aria-label="Workflow graph"
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </main>
      <aside ref={aside} aria-label="Step detail" />
    </>
  )
}

orca.on('theme', (theme) => console.log(`[proto flow] theme event: ${JSON.stringify(theme)}`))
const { pointer, list } = await loadContext()
const initial = list.some((g) => g.name === pointer.workflow) ? pointer.workflow : list[0].name
createRoot(document.getElementById('root')).render(
  <ReactFlowProvider>
    <App list={list} initial={initial} pointer={pointer} />
  </ReactFlowProvider>
)
