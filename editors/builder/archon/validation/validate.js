import { validateStructural } from "./structural.js";
import { validateGraph } from "./graph.js";
import { validateContent } from "./content.js";
/** Run all client-tier validation rules and return the deduped issue list. */
export function runValidation(workflow) {
    const all = [
        ...validateStructural(workflow),
        ...validateGraph(workflow),
        ...validateContent(workflow),
    ];
    const byId = new Map();
    for (const issue of all) {
        if (!byId.has(issue.id))
            byId.set(issue.id, issue);
    }
    return [...byId.values()];
}
