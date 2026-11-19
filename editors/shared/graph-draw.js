const SVG = 'http://www.w3.org/2000/svg';
/** The most characters of a name a box shows; the whole name is in its label and title. */
export const NAME_CAP = 24;
/** How many steps a collapsed loop group holds, as "holds 3 steps", or "Holds 3 steps" to start a sentence. */
export function holdsPhrase(count, start = 'lower') {
    return `${start === 'upper' ? 'Holds' : 'holds'} ${String(count)} ${count === 1 ? 'step' : 'steps'}`;
}
const cut = (text) => (text.length > NAME_CAP ? `${text.slice(0, NAME_CAP - 1)}…` : text);
/** Draws the laid-out graph. Steps the map does not describe are drawn by their id alone. */
export function drawGraph(doc, laid, steps, options) {
    const make = (tag, attributes = {}) => {
        const element = doc.createElementNS(SVG, tag);
        for (const [name, value] of Object.entries(attributes))
            element.setAttribute(name, String(value));
        return element;
    };
    const text = (content, attributes) => {
        const element = make('text', attributes);
        element.textContent = content;
        return element;
    };
    const svg = make('svg', {
        viewBox: `0 0 ${String(laid.width)} ${String(laid.height)}`,
        width: laid.width,
        height: laid.height,
        role: 'group',
        'aria-label': options.label,
        class: 'graph'
    });
    const arrow = `${options.idPrefix}-arrow`;
    const defs = svg.appendChild(make('defs'));
    const marker = defs.appendChild(make('marker', { id: arrow, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }));
    marker.appendChild(make('path', { d: 'M0 0 L10 5 L0 10 Z', class: 'arrowhead' }));
    for (const group of laid.groups) {
        const frame = svg.appendChild(make('g', { class: 'group' }));
        frame.appendChild(make('rect', { x: group.x, y: group.y, width: group.width, height: group.height, rx: 8 }));
        frame.appendChild(text(cut(steps.get(group.id)?.name ?? group.id), { x: group.x + 10, y: group.y + 15, class: 'group-name' }));
    }
    for (const edge of laid.edges) {
        const d = edge.points.map((point, at) => `${at === 0 ? 'M' : 'L'}${String(point.x)} ${String(point.y)}`).join(' ');
        svg.appendChild(make('path', { d, class: edge.dashed ? 'edge dashed' : 'edge', 'marker-end': `url(#${arrow})` }));
    }
    for (const box of laid.steps) {
        const step = steps.get(box.id) ?? { name: box.id, kind: null, state: 'not-reached', stateText: '', note: null };
        const holds = step.holds === undefined ? null : holdsPhrase(step.holds);
        const label = [step.name, step.kind, step.stateText, holds].filter((part) => part !== null && part !== '').join(', ');
        const group = svg.appendChild(make('g', {
            class: `step state-${step.state}`,
            role: 'button',
            tabindex: 0,
            'aria-label': label,
            'data-step': box.id,
            transform: `translate(${String(box.x)} ${String(box.y)})`
        }));
        const title = group.appendChild(make('title'));
        title.textContent = step.name;
        group.appendChild(make('rect', { x: -3, y: -3, width: box.width + 6, height: box.height + 6, rx: 8, class: 'focus-ring' }));
        group.appendChild(make('rect', { width: box.width, height: box.height, rx: 6, class: 'box' }));
        group.appendChild(make('rect', { width: 4, height: box.height, rx: 2, class: 'bar' }));
        group.appendChild(text(cut(step.name), { x: 12, y: 19, class: 'name' }));
        group.appendChild(text(step.stateText, { x: 12, y: 37, class: 'state' }));
        const note = [step.holds === undefined ? null : holdsPhrase(step.holds, 'upper'), step.note].filter((part) => part !== null).join(' · ');
        if (note !== '')
            group.appendChild(text(note, { x: 12, y: box.height - 8, class: 'note' }));
    }
    return svg;
}
