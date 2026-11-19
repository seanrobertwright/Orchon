// The eight node kinds the builder can edit. Archon's builder takes this union from its console's
// graph primitives (`WorkflowNodeKind` in primitives/workflow-graph.ts at v0.14.0); the plugin
// keeps it here so the copied logic imports nothing outside the builder.
export type WorkflowNodeKind =
  | 'prompt'
  | 'command'
  | 'bash'
  | 'script'
  | 'approval'
  | 'wait'
  | 'loop'
  | 'cancel'
