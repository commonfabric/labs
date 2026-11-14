/**
 * Test utility: a document for `common-iframe-sandbox` under plain
 * `deno test`.
 *
 * Importing this module puts a happy-dom window's `document`,
 * `customElements`, and the DOM classes Lit reads on the global object, so the
 * element connects and renders as it does in a browser, while Deno's coverage
 * records the lines it runs. Lit reads these globals as its modules load, so a
 * test file imports this module ahead of anything that imports Lit.
 *
 * The global object keeps its own `addEventListener()` and `MessageEvent`, so
 * a message a test dispatches on it reaches the element's listener as a
 * message posted to the page would. The frames the element renders get
 * windows of their own that load nothing: a message the element posts to one
 * is dispatched on that window, which is where a test reads it.
 */

import { Window } from "happy-dom";

const window = new Window({
  url: "http://localhost/",
  settings: {
    disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true,
    disableIframePageLoading: true,
  },
});

for (
  const name of [
    "document",
    "customElements",
    "Node",
    "Element",
    "HTMLElement",
    "Document",
    "DocumentFragment",
    "ShadowRoot",
    "CSSStyleSheet",
    "CustomEvent",
  ]
) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: Reflect.get(window, name),
  });
}

/**
 * Resolves once every task the happy-dom window and its frames have pending
 * has run, which includes delivering each message posted to a frame.
 */
export function settle(): Promise<void> {
  return window.happyDOM.waitUntilComplete();
}
