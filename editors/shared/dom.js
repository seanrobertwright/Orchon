// The element factory the editors share. Outside text is set through `textContent` only.
/** The element factory for one document. */
export function elementMaker(doc) {
    return (tag, text, className) => {
        const element = doc.createElement(tag);
        if (text !== undefined)
            element.textContent = text;
        if (className !== undefined)
            element.setAttribute('class', className);
        return element;
    };
}
