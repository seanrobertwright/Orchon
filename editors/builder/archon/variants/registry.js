import { VARIANT_CAPABILITIES } from "./capabilities.js";
import { defaultLoopData, loopFromDag, loopToDag } from "./loop.js";
import { approvalFromDag, approvalToDag, defaultApprovalData } from "./approval.js";
import { cancelFromDag, cancelToDag, defaultCancelData } from "./cancel.js";
import { defaultScriptData, scriptFromDag, scriptToDag } from "./script.js";
import { commandFromDag, commandToDag, defaultCommandData } from "./command.js";
import { defaultPromptData, promptFromDag, promptToDag } from "./prompt.js";
import { bashFromDag, bashToDag, defaultBashData } from "./bash.js";
import { defaultWaitData, waitFromDag, waitToDag } from "./wait.js";
/** Canonical palette and registry order. */
export const VARIANTS = [
    'prompt',
    'command',
    'bash',
    'script',
    'loop',
    'approval',
    'wait',
    'cancel',
];
const VARIANT_SET = new Set(VARIANTS);
/** Narrow an untrusted string to a `VariantId` (e.g. a drag-and-drop payload). */
export function isVariantId(value) {
    return VARIANT_SET.has(value);
}
/** Per-variant registry. Strongly typed per key. */
export const VARIANT_REGISTRY = {
    prompt: {
        label: 'Prompt',
        defaultData: defaultPromptData,
        fromDag: promptFromDag,
        toDag: promptToDag,
        wireKeys: ['prompt'],
        capabilities: VARIANT_CAPABILITIES.prompt,
    },
    command: {
        label: 'Command',
        defaultData: defaultCommandData,
        fromDag: commandFromDag,
        toDag: commandToDag,
        wireKeys: ['command', 'with'],
        capabilities: VARIANT_CAPABILITIES.command,
    },
    bash: {
        label: 'Bash',
        defaultData: defaultBashData,
        fromDag: bashFromDag,
        toDag: bashToDag,
        wireKeys: ['bash', 'timeout', 'on_timeout'],
        capabilities: VARIANT_CAPABILITIES.bash,
    },
    script: {
        label: 'Script',
        defaultData: defaultScriptData,
        fromDag: scriptFromDag,
        toDag: scriptToDag,
        wireKeys: ['script', 'runtime', 'deps', 'timeout', 'on_timeout', 'with'],
        capabilities: VARIANT_CAPABILITIES.script,
    },
    loop: {
        label: 'Loop',
        defaultData: defaultLoopData,
        fromDag: loopFromDag,
        toDag: loopToDag,
        wireKeys: ['loop', 'timeout'],
        capabilities: VARIANT_CAPABILITIES.loop,
    },
    approval: {
        label: 'Approval',
        defaultData: defaultApprovalData,
        fromDag: approvalFromDag,
        toDag: approvalToDag,
        wireKeys: ['approval'],
        capabilities: VARIANT_CAPABILITIES.approval,
    },
    wait: {
        label: 'Wait',
        defaultData: defaultWaitData,
        fromDag: waitFromDag,
        toDag: waitToDag,
        wireKeys: ['wait'],
        capabilities: VARIANT_CAPABILITIES.wait,
    },
    cancel: {
        label: 'Cancel',
        defaultData: defaultCancelData,
        fromDag: cancelFromDag,
        toDag: cancelToDag,
        wireKeys: ['cancel'],
        capabilities: VARIANT_CAPABILITIES.cancel,
    },
};
const OPAQUE_LABELS = {
    loop_group: 'Loop group',
    workflow: 'Workflow',
    include: 'Include',
    unrecognised: 'Unrecognised node',
    script_without_runtime: 'Script with no runtime',
    loop_with_prompt_and_command: 'Loop with prompt and command',
};
const OPAQUE_CAPABILITIES = { honorsAiFields: false };
/** Badge label for any builder node, read-only ones included. */
export function nodeLabel(node) {
    return node.variant === 'opaque'
        ? OPAQUE_LABELS[node.data.kind]
        : VARIANT_REGISTRY[node.variant].label;
}
/** Capability flags for any builder node, read-only ones included. */
export function nodeCapabilities(node) {
    return node.variant === 'opaque'
        ? OPAQUE_CAPABILITIES
        : VARIANT_REGISTRY[node.variant].capabilities;
}
/**
 * Build the variant-specific data for a given variant from a partitioned wire
 * node. Safe through the registry index: every `fromDag` has the same parameter
 * type, so the union call resolves cleanly.
 */
export function variantDataFromDag(variant, variantSpecific) {
    return VARIANT_REGISTRY[variant].fromDag(variantSpecific);
}
/**
 * Serialize a builder node's variant data to its sparse wire fragment. A switch
 * on the discriminant lets `node.data` narrow to the matching `toDag` parameter
 * type — no casts, no `any`.
 */
export function nodeDataToDag(node) {
    switch (node.variant) {
        case 'opaque':
            return node.data.fields;
        case 'loop':
            return loopToDag(node.data);
        case 'approval':
            return approvalToDag(node.data);
        case 'wait':
            return waitToDag(node.data);
        case 'cancel':
            return cancelToDag(node.data);
        case 'script':
            return scriptToDag(node.data);
        case 'command':
            return commandToDag(node.data);
        case 'prompt':
            return promptToDag(node.data);
        case 'bash':
            return bashToDag(node.data);
    }
}
