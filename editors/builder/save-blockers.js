/** The rules whose findings block a save. The copied validation gives each the severity `error`. */
export const SAVE_BLOCKING_RULES = [
    'structural.id.empty',
    'structural.id.duplicate',
    'graph.ref.unknown',
    'graph.cycle'
];
/** The findings that block a save, in the order given. */
export function saveBlockers(issues) {
    return issues.filter((issue) => SAVE_BLOCKING_RULES.includes(issue.rule));
}
