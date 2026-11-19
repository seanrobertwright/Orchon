/**
 * The single type-only touch point for the generated OpenAPI spec.
 *
 * Every builder module reaches the wire shapes through these two aliases so
 * that generated-spec drift is isolated to this one file. No runtime code lives
 * here. (Orchon: the spec types come from the plugin's own
 * `support/archon-api.d.ts`, in place of Archon's `@/lib/api.generated`.)
 */
import type { components } from '../../support/archon-api';

/** The wire-format DAG node as emitted by the engine's Zod transform. */
export type WireDagNode = components['schemas']['DagNode'];

/** The wire-format workflow definition (name, description, meta, nodes). */
export type WireWorkflowDefinition = components['schemas']['WorkflowDefinition'];
