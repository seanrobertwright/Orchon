export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 80;
const RANK_GAP = 80;
const NODE_GAP = 40;
/**
 * The top-left corner of every node. An edge naming an id outside `nodeIds` is skipped, and an
 * edge that closes a cycle is ignored when ranking, so every node gets a position.
 */
export function layoutGraph(nodeIds, edges) {
    const known = new Set(nodeIds);
    const dependencies = new Map(nodeIds.map((id) => [id, []]));
    for (const edge of edges) {
        if (known.has(edge.source) && known.has(edge.target))
            dependencies.get(edge.target)?.push(edge.source);
    }
    const ranks = new Map();
    const visiting = new Set();
    const rankOf = (id) => {
        const ranked = ranks.get(id);
        if (ranked !== undefined)
            return ranked;
        visiting.add(id);
        let rank = 0;
        for (const dependency of dependencies.get(id) ?? []) {
            if (!visiting.has(dependency))
                rank = Math.max(rank, rankOf(dependency) + 1);
        }
        visiting.delete(id);
        ranks.set(id, rank);
        return rank;
    };
    const columns = new Map();
    const positions = new Map();
    for (const id of nodeIds) {
        if (positions.has(id))
            continue;
        const rank = rankOf(id);
        const column = columns.get(rank) ?? 0;
        columns.set(rank, column + 1);
        positions.set(id, { x: column * (NODE_WIDTH + NODE_GAP), y: rank * (NODE_HEIGHT + RANK_GAP) });
    }
    return positions;
}
