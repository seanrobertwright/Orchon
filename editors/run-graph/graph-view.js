// The run graph tab's contract with the worker: the request the tab sends and the view model the
// worker answers. It is types only. It lives beside the tab because the editors compile on their
// own and can import nothing from src/; the worker imports these types from here.
export {};
