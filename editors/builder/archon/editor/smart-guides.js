export const GUIDE_THRESHOLD = 6;
function best(candidates) {
    let winner;
    for (const c of candidates) {
        if (winner === undefined || c.distance < winner.distance)
            winner = c;
    }
    return winner;
}
/**
 * Compute guide lines + snap position for `dragged` against `others`.
 * Edge-to-edge (left/right against left/right, top/bottom against top/bottom)
 * and center-to-center alignments are considered; the closest candidate per
 * axis wins the snap, and every guide coordinate within `threshold` is
 * returned for rendering (deduped).
 */
export function computeGuides(dragged, others, threshold = GUIDE_THRESHOLD) {
    const dLeft = dragged.x;
    const dRight = dragged.x + dragged.width;
    const dCenterX = dragged.x + dragged.width / 2;
    const dTop = dragged.y;
    const dBottom = dragged.y + dragged.height;
    const dCenterY = dragged.y + dragged.height / 2;
    const xCandidates = [];
    const yCandidates = [];
    for (const s of others) {
        if (s.id === dragged.id)
            continue;
        const sLeft = s.x;
        const sRight = s.x + s.width;
        const sCenterX = s.x + s.width / 2;
        const sTop = s.y;
        const sBottom = s.y + s.height;
        const sCenterY = s.y + s.height / 2;
        const xPairs = [
            // [dragged edge, stationary edge] — snapTo is the dragged rect's new x.
            [dLeft, sLeft],
            [dLeft, sRight],
            [dRight, sLeft],
            [dRight, sRight],
            [dCenterX, sCenterX],
        ];
        for (const [dEdge, sEdge] of xPairs) {
            const distance = Math.abs(dEdge - sEdge);
            if (distance <= threshold) {
                xCandidates.push({ guide: sEdge, snapTo: dragged.x + (sEdge - dEdge), distance });
            }
        }
        const yPairs = [
            [dTop, sTop],
            [dTop, sBottom],
            [dBottom, sTop],
            [dBottom, sBottom],
            [dCenterY, sCenterY],
        ];
        for (const [dEdge, sEdge] of yPairs) {
            const distance = Math.abs(dEdge - sEdge);
            if (distance <= threshold) {
                yCandidates.push({ guide: sEdge, snapTo: dragged.y + (sEdge - dEdge), distance });
            }
        }
    }
    const bestX = best(xCandidates);
    const bestY = best(yCandidates);
    return {
        vertical: [...new Set(xCandidates.map(c => c.guide))],
        horizontal: [...new Set(yCandidates.map(c => c.guide))],
        snap: {
            x: bestX !== undefined ? bestX.snapTo : dragged.x,
            y: bestY !== undefined ? bestY.snapTo : dragged.y,
        },
    };
}
