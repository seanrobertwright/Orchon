export const PANEL_LINE = 'Tool calls and agent text are in the Orchon panel.';
const OUTPUT_LINES = {
    whole: null,
    cut: 'Only the first 4 KiB of the output is shown here.',
    withheld: "This graph's output was too large to send in full, so this step's is not shown here."
};
const NO_OUTPUT = 'This step has no output.';
const NOT_REPORTED = 'Not reported';
const NO_COST = 'No cost reported';
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const SHOWN = ['whole', 'cut', 'withheld'];
/** The worker's summary of a step, or null when it sent none or it is not a summary. */
export function parseSummary(value) {
    if (!isRecord(value))
        return null;
    const text = (key) => {
        const field = Object.hasOwn(value, key) ? value[key] : undefined;
        return typeof field === 'string' && field !== '' ? field : null;
    };
    const output = Object.hasOwn(value, 'output') ? value.output : undefined;
    const shown = Object.hasOwn(value, 'outputShown') ? value.outputShown : undefined;
    return {
        duration: text('duration'),
        cost: text('cost'),
        model: text('model'),
        skipReason: text('skipReason'),
        output: typeof output === 'string' ? output : '',
        outputShown: SHOWN.find((one) => one === shown) ?? 'whole'
    };
}
export function createSummaryCard(doc, id, onClose) {
    const el = (tag, text, className) => {
        const element = doc.createElement(tag);
        if (text !== undefined)
            element.textContent = text;
        if (className !== undefined)
            element.setAttribute('class', className);
        return element;
    };
    const root = el('aside', undefined, 'summary-card');
    root.id = id;
    const title = el('h2');
    const close = el('button', 'Close', 'tool');
    close.setAttribute('type', 'button');
    close.addEventListener('click', onClose);
    const head = el('div', undefined, 'card-head');
    head.append(title, close);
    const body = el('div', undefined, 'card-body');
    root.append(head, body);
    return {
        root,
        show(step) {
            root.setAttribute('aria-label', `Summary of ${step.name}`);
            title.textContent = step.name;
            const summary = step.summary;
            const facts = el('dl');
            const fact = (term, value) => {
                facts.append(el('dt', term), el('dd', value));
            };
            fact('Kind', step.kind ?? NOT_REPORTED);
            fact('State', step.stateText);
            fact('Duration', summary?.duration ?? NOT_REPORTED);
            fact('Cost', summary?.cost ?? NO_COST);
            fact('Model', summary?.model ?? NOT_REPORTED);
            if (summary?.skipReason != null)
                fact('Skipped because', summary.skipReason);
            const parts = [];
            if (step.note !== null)
                parts.push(el('p', step.note, 'card-note'));
            if (step.holds !== undefined) {
                parts.push(el('p', `Holds ${String(step.holds)} ${step.holds === 1 ? 'step' : 'steps'}. Show loop steps to draw ${step.holds === 1 ? 'it' : 'them'}.`));
            }
            parts.push(facts);
            // A worker older than the card sends no summary, and so no word on the output either way.
            if (summary !== null) {
                parts.push(el('h3', 'Output'));
                if (summary.output !== '')
                    parts.push(el('pre', summary.output, 'card-output'));
                const outputLine = OUTPUT_LINES[summary.outputShown];
                if (outputLine !== null)
                    parts.push(el('p', outputLine, 'muted'));
                else if (summary.output === '')
                    parts.push(el('p', NO_OUTPUT, 'muted'));
            }
            parts.push(el('p', PANEL_LINE, 'muted'));
            body.replaceChildren(...parts);
        }
    };
}
