const ENTRIES = [
    {
        keys: ['u'],
        label: 'Undo',
        group: 'Edit',
        run: (a) => {
            a.undo();
        },
    },
    {
        keys: ['U'],
        label: 'Redo',
        group: 'Edit',
        run: (a) => {
            a.redo();
        },
    },
    {
        keys: ['y'],
        label: 'Copy selection',
        group: 'Edit',
        run: (a) => {
            a.copy();
        },
    },
    {
        keys: ['x'],
        label: 'Cut selection',
        group: 'Edit',
        run: (a) => {
            a.cut();
        },
    },
    {
        keys: ['P'],
        label: 'Paste',
        group: 'Edit',
        run: (a) => {
            a.paste();
        },
    },
    {
        keys: ['Delete'],
        label: 'Delete selection',
        group: 'Edit',
        run: (a) => {
            a.removeSelection();
        },
    },
    {
        keys: ['Backspace'],
        label: 'Delete selection',
        group: 'Edit',
        run: (a) => {
            a.removeSelection();
        },
    },
    {
        keys: ['a'],
        label: 'Select all nodes',
        group: 'Edit',
        run: (a) => {
            a.selectAll();
        },
    },
    {
        keys: ['A'],
        label: 'Auto-arrange',
        group: 'Arrange',
        run: (a) => {
            a.autoArrange();
        },
    },
    {
        keys: ['f'],
        label: 'Fit view',
        group: 'Arrange',
        run: (a) => {
            a.fitView();
        },
    },
    {
        keys: ['g', 'l'],
        label: 'Align left',
        group: 'Arrange',
        run: (a) => {
            a.align('left');
        },
    },
    {
        keys: ['g', 'r'],
        label: 'Align right',
        group: 'Arrange',
        run: (a) => {
            a.align('right');
        },
    },
    {
        keys: ['g', 't'],
        label: 'Align top',
        group: 'Arrange',
        run: (a) => {
            a.align('top');
        },
    },
    {
        keys: ['g', 'b'],
        label: 'Align bottom',
        group: 'Arrange',
        run: (a) => {
            a.align('bottom');
        },
    },
    // The label/mode pairing below looks inverted but is correct: align.ts names
    // each mode after the CENTERLINE AXIS, while the label names the COORDINATE
    // being equalized. "Align horizontal centers" equalizes each node's horizontal
    // center (same center x) → a vertical centerline → `centerV`; "Align vertical
    // centers" equalizes the vertical center (same center y) → `centerH`.
    {
        keys: ['g', 'c'],
        label: 'Align horizontal centers',
        group: 'Arrange',
        run: (a) => {
            a.align('centerV');
        },
    },
    {
        keys: ['g', 'm'],
        label: 'Align vertical centers',
        group: 'Arrange',
        run: (a) => {
            a.align('centerH');
        },
    },
    {
        keys: ['g', 'h'],
        label: 'Distribute horizontally',
        group: 'Arrange',
        run: (a) => {
            a.distribute('h');
        },
    },
    {
        keys: ['g', 'v'],
        label: 'Distribute vertically',
        group: 'Arrange',
        run: (a) => {
            a.distribute('v');
        },
    },
];
/** Dispatcher-side bindings for `useKeymap({ bindings })`. */
export function buildBuilderBindings(actions) {
    return ENTRIES.map(entry => ({
        keys: entry.keys,
        label: entry.label,
        run: () => {
            entry.run(actions);
        },
    }));
}
/**
 * Canvas pointer gestures — documented in the `?` overlay so they're
 * discoverable, but NOT bound here: xyflow owns Space-to-pan
 * (`panActivationKeyCode`), Shift-marquee, and middle/right-drag panning.
 */
const CANVAS_GESTURES = [
    { keys: ['Space', 'drag'], label: 'Pan the canvas' },
    { keys: ['drag'], label: 'Marquee-select nodes' },
    { keys: ['Shift', 'click'], label: 'Add to selection' },
    { keys: ['click', 'edge'], label: 'Select a connector (then Delete)' },
    { keys: ['right-click'], label: 'Open context menu' },
];
/** Docs-side groups for the `KeymapHelp` overlay (same source table). */
export function builderKeymapGroups() {
    const groups = [{ title: 'Builder · canvas', entries: CANVAS_GESTURES }];
    for (const title of ['Edit', 'Arrange']) {
        groups.push({
            title: `Builder · ${title.toLowerCase()}`,
            entries: ENTRIES.filter(e => e.group === title).map(e => ({
                keys: e.keys,
                label: e.label,
            })),
        });
    }
    return groups;
}
