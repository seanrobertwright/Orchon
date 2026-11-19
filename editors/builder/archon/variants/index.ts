/** Re-exports for the variants layer. */
export { partitionNode } from './base-fields.ts';
export { detectOpaqueKind, detectVariant, detectVariantOrNull } from './detect.ts';
export { VARIANT_CAPABILITIES, type VariantCapabilities } from './capabilities.ts';
export {
  VARIANTS,
  VARIANT_REGISTRY,
  isVariantId,
  nodeCapabilities,
  nodeLabel,
  variantDataFromDag,
  nodeDataToDag,
  type VariantRegistryEntry,
} from './registry.ts';
export { defaultLoopData, loopFromDag, loopToDag } from './loop.ts';
export { defaultApprovalData, approvalFromDag, approvalToDag } from './approval.ts';
export { defaultWaitData, waitFromDag, waitToDag } from './wait.ts';
export { defaultCancelData, cancelFromDag, cancelToDag } from './cancel.ts';
export { defaultScriptData, scriptFromDag, scriptToDag } from './script.ts';
export { defaultCommandData, commandFromDag, commandToDag } from './command.ts';
export { defaultPromptData, promptFromDag, promptToDag } from './prompt.ts';
export { defaultBashData, bashFromDag, bashToDag } from './bash.ts';
