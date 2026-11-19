const SVG = 'http://www.w3.org/2000/svg';
/** How far one arrow key moves the view, in screen pixels. */
export const PAN_STEP = 48;
/** How much one press of plus or minus, or one notch of the wheel, zooms. */
export const ZOOM_STEP = 1.25;
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 3;
/** The minimap's largest size, in screen pixels. */
const MINIMAP_WIDTH = 160;
const MINIMAP_HEIGHT = 120;
/** How far a pointer moves before a press becomes a drag, in screen pixels. */
const DRAG_START = 4;
/** The canvas size assumed until the frame reports one. */
const FIRST_SIZE = { width: 800, height: 500 };
export const KEYS_HELP = 'Arrow keys pan, plus and minus zoom, and zero fits the graph.';
const clampScale = (scale) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
/** The view that shows the whole graph centred, never larger than its own size. */
export function fitView(graph, canvas) {
    const scale = clampScale(Math.min(1, canvas.width / Math.max(1, graph.width), canvas.height / Math.max(1, graph.height)));
    return { x: (graph.width - canvas.width / scale) / 2, y: (graph.height - canvas.height / scale) / 2, scale };
}
/** The view zoomed by `factor` with the canvas point `about` held still. */
export function zoomView(view, factor, about) {
    const scale = clampScale(view.scale * factor);
    return { x: view.x + about.x / view.scale - about.x / scale, y: view.y + about.y / view.scale - about.y / scale, scale };
}
/** A number for an attribute, without the noise of floating point. */
const num = (value) => String(Math.round(value * 1000) / 1000);
export function createCanvas(options) {
    const { doc } = options;
    const el = (tag, className, text) => {
        const element = doc.createElement(tag);
        element.setAttribute('class', className);
        if (text !== undefined)
            element.textContent = text;
        return element;
    };
    const svgEl = (tag, attributes) => {
        const element = doc.createElementNS(SVG, tag);
        for (const [name, value] of Object.entries(attributes))
            element.setAttribute(name, String(value));
        return element;
    };
    const button = (text, name, run) => {
        const made = el('button', 'tool', text);
        made.setAttribute('type', 'button');
        if (name !== null) {
            made.setAttribute('aria-label', name);
            made.setAttribute('title', name);
        }
        made.addEventListener('click', run);
        return made;
    };
    const root = el('div', 'canvas-frame');
    const tools = el('div', 'canvas-tools');
    const viewport = el('div', 'viewport');
    const helpId = `${options.idPrefix}-keys`;
    const help = el('p', 'keys-help muted', KEYS_HELP);
    help.id = helpId;
    viewport.setAttribute('tabindex', '0');
    viewport.setAttribute('role', 'group');
    viewport.setAttribute('aria-label', options.label);
    viewport.setAttribute('aria-describedby', helpId);
    const minimap = svgEl('svg', { class: 'minimap', 'aria-hidden': 'true' });
    const frame = svgEl('rect', { class: 'minimap-frame' });
    root.append(tools, viewport, minimap, help);
    let size = FIRST_SIZE;
    let graph = { width: 1, height: 1 };
    let view = fitView(graph, size);
    /** Whether the person has moved the view since it was last fitted. */
    let moved = false;
    let drawing = null;
    let miniScale = 1;
    function place() {
        const width = size.width / view.scale;
        const height = size.height / view.scale;
        if (drawing !== null) {
            drawing.setAttribute('viewBox', `${num(view.x)} ${num(view.y)} ${num(width)} ${num(height)}`);
            drawing.setAttribute('width', num(size.width));
            drawing.setAttribute('height', num(size.height));
        }
        frame.setAttribute('x', num(view.x));
        frame.setAttribute('y', num(view.y));
        frame.setAttribute('width', num(width));
        frame.setAttribute('height', num(height));
    }
    function fit() {
        view = fitView(graph, size);
        moved = false;
        place();
    }
    function move(next) {
        view = next;
        moved = true;
        place();
    }
    const centre = () => ({ x: size.width / 2, y: size.height / 2 });
    const zoom = (factor, about = centre()) => move(zoomView(view, factor, about));
    const pan = (dx, dy) => move({ ...view, x: view.x + dx / view.scale, y: view.y + dy / view.scale });
    tools.append(button('+', 'Zoom in', () => zoom(ZOOM_STEP)), button('−', 'Zoom out', () => zoom(1 / ZOOM_STEP)), button('Fit', null, fit));
    viewport.addEventListener('keydown', (event) => {
        if (event.ctrlKey || event.metaKey || event.altKey)
            return;
        if (event.key === 'Enter' || event.key === ' ') {
            const id = stepOf(event.target);
            if (id === null)
                return;
            event.preventDefault();
            options.onStep?.(id);
            return;
        }
        const keys = {
            ArrowLeft: () => pan(-PAN_STEP, 0),
            ArrowRight: () => pan(PAN_STEP, 0),
            ArrowUp: () => pan(0, -PAN_STEP),
            ArrowDown: () => pan(0, PAN_STEP),
            '+': () => zoom(ZOOM_STEP),
            '=': () => zoom(ZOOM_STEP),
            '-': () => zoom(1 / ZOOM_STEP),
            '0': fit
        };
        if (!Object.hasOwn(keys, event.key))
            return;
        event.preventDefault();
        keys[event.key]?.();
    });
    const local = (element, event) => {
        const rect = element.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    viewport.addEventListener('wheel', (event) => {
        if (!Number.isFinite(event.deltaY) || event.deltaY === 0)
            return;
        event.preventDefault();
        const factor = Math.min(2, Math.max(0.5, ZOOM_STEP ** (-event.deltaY / 100)));
        zoom(factor, local(viewport, event));
    }, { passive: false });
    /** The press that may become a drag of the canvas. */
    let press = null;
    /** Set after a drag, so the click that ends it opens nothing. */
    let dragged = false;
    viewport.addEventListener('pointerdown', (event) => {
        if (event.button !== 0)
            return;
        press = { pointer: event.pointerId, x: event.clientX, y: event.clientY, from: view, dragging: false };
        dragged = false;
    });
    viewport.addEventListener('pointermove', (event) => {
        if (press?.pointer !== event.pointerId)
            return;
        const dx = event.clientX - press.x;
        const dy = event.clientY - press.y;
        if (!press.dragging && Math.hypot(dx, dy) < DRAG_START)
            return;
        if (!press.dragging) {
            press.dragging = true;
            if (typeof viewport.setPointerCapture === 'function')
                viewport.setPointerCapture(event.pointerId);
        }
        move({ ...press.from, x: press.from.x - dx / view.scale, y: press.from.y - dy / view.scale });
    });
    const release = (event) => {
        if (press?.pointer !== event.pointerId)
            return;
        dragged = press.dragging;
        press = null;
    };
    viewport.addEventListener('pointerup', release);
    viewport.addEventListener('pointercancel', release);
    /** The step id of the drawn step that holds an event's target, or null. */
    const stepOf = (target) => {
        for (let at = target; at !== null && at !== viewport; at = at.parentElement) {
            const id = at.getAttribute('data-step');
            if (id !== null)
                return id;
        }
        return null;
    };
    viewport.addEventListener('click', (event) => {
        // A click that ends a drag is the drag's, not a press of the step under it.
        if (dragged) {
            dragged = false;
            return;
        }
        const id = stepOf(event.target);
        if (id !== null)
            options.onStep?.(id);
    });
    /** The pointer on the minimap moves the view's centre to the graph point under it. */
    let miniPointer = null;
    const centreAt = (event) => {
        const point = local(minimap, event);
        move({ ...view, x: point.x / miniScale - size.width / view.scale / 2, y: point.y / miniScale - size.height / view.scale / 2 });
    };
    minimap.addEventListener('pointerdown', (event) => {
        if (event.button !== 0)
            return;
        miniPointer = event.pointerId;
        if (typeof minimap.setPointerCapture === 'function')
            minimap.setPointerCapture(event.pointerId);
        centreAt(event);
    });
    minimap.addEventListener('pointermove', (event) => {
        if (miniPointer === event.pointerId)
            centreAt(event);
    });
    const miniRelease = (event) => {
        if (miniPointer === event.pointerId)
            miniPointer = null;
    };
    minimap.addEventListener('pointerup', miniRelease);
    minimap.addEventListener('pointercancel', miniRelease);
    const observed = options.observeSize?.(viewport, (width, height) => {
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
            return;
        size = { width, height };
        if (moved)
            place();
        else
            fit();
    });
    return {
        root,
        tools,
        viewport,
        show(next, laid, states, { fit: refit }) {
            graph = { width: Math.max(1, laid.width), height: Math.max(1, laid.height) };
            drawing = next;
            viewport.replaceChildren(next);
            miniScale = Math.min(MINIMAP_WIDTH / graph.width, MINIMAP_HEIGHT / graph.height);
            minimap.setAttribute('viewBox', `0 0 ${num(graph.width)} ${num(graph.height)}`);
            minimap.setAttribute('width', num(graph.width * miniScale));
            minimap.setAttribute('height', num(graph.height * miniScale));
            const boxes = laid.steps.map((box) => svgEl('rect', { class: `mini-step state-${states.get(box.id) ?? 'not-reached'}`, x: box.x, y: box.y, width: box.width, height: box.height, rx: 6 }));
            const groups = laid.groups.map((box) => svgEl('rect', { class: 'mini-group', x: box.x, y: box.y, width: box.width, height: box.height, rx: 8 }));
            minimap.replaceChildren(...groups, ...boxes, frame);
            if (refit || !moved)
                fit();
            else
                place();
        },
        stop() {
            observed?.dispose();
        }
    };
}
