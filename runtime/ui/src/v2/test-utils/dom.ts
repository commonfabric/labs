/**
 * Test utility: a document for components under plain `deno test`.
 *
 * Importing this module puts a happy-dom window's `document`,
 * `customElements`, and DOM classes on the global object, so a component
 * connects, renders into its shadow root, and handles events as it does in a
 * browser, while Deno's coverage records the lines it runs. Lit reads these
 * globals as its own modules load, so a test file imports this module first,
 * ahead of anything that imports Lit.
 *
 * Deno's own globals stay in place, apart from the ones a component reads with
 * a browser's meaning: the event classes, since happy-dom dispatches only its
 * own events, and `location`, `navigator`, and the two storage areas, which
 * describe the page rather than the Deno process. The global object also
 * stands for the window an event in the document bubbles to: a listener added
 * to it is added to the window as well, and a window event dispatched on it is
 * dispatched on the window. Deno's own events, such as `load`, still reach it
 * as before. An `error` listener is the exception, added to Deno alone, as
 * the window's reports of an exception are thrown again to Deno.
 *
 * An exception a listener or a window timer throws is reported as a browser
 * reports it, as an `error` event on the window, and the code that dispatched
 * the event carries on. The exception is then thrown again as an uncaught
 * error, which fails the test file: Deno reports it against the file, and
 * cancels the test that was running and every test after it.
 *
 * happy-dom offers no `ElementInternals`, so this module also gives
 * `HTMLElement` an `attachInternals()` whose result records the form value
 * and validity an element reports; {@link internalsOf} reads it back.
 */

import { Window } from "happy-dom";

/** The window whose document components are mounted in. */
export const window = new Window({
  url: "http://localhost/",
  // A test's page never leaves this URL or loads anything: following a link
  // would leave the tests after it on another page.
  settings: {
    disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true,
    disableIframePageLoading: true,
    navigation: {
      disableMainFrameNavigation: true,
      disableChildFrameNavigation: true,
      disableChildPageNavigation: true,
      disableFallbackToSetURL: true,
    },
  },
});

const REPLACED =
  /^(?:[A-Z]\w*)?Event$|^(location|navigator|localStorage|sessionStorage)$/;

window.addEventListener("error", (event) => {
  if (!(event instanceof window.ErrorEvent)) return;
  queueMicrotask(() => {
    throw event.error;
  });
});

// A browser fires `selectionchange` once after the calls that changed the
// selection have returned, however many there were; happy-dom fires it within
// each such call, which reaches an editor's listener in the middle of its own
// update.
const { document: pageDocument } = window;
const dispatchOnDocument = pageDocument.dispatchEvent.bind(pageDocument);
const deferred = new WeakSet<object>();
let selectionChangePending = false;
pageDocument.dispatchEvent = (event) => {
  // happy-dom also calls this to carry an event dispatched elsewhere through
  // the document, which it marks with the phase it is in.
  if (
    event.type !== "selectionchange" ||
    event.eventPhase !== window.Event.NONE ||
    deferred.has(event)
  ) {
    return dispatchOnDocument(event);
  }
  deferred.add(event);
  if (!selectionChangePending) {
    selectionChangePending = true;
    queueMicrotask(() => {
      selectionChangePending = false;
      dispatchOnDocument(event);
    });
  }
  return true;
};

const names = new Set<string>();
for (
  let source: object | null = window;
  source !== null && source !== Object.prototype;
  source = Object.getPrototypeOf(source)
) {
  for (const name of Object.getOwnPropertyNames(source)) names.add(name);
}
names.delete("constructor");

for (const name of names) {
  if (name in globalThis && !REPLACED.test(name)) continue;
  const value: unknown = Reflect.get(window, name);
  // A method is bound once, so it keeps its identity; anything else is read
  // through, since properties such as `innerWidth` change.
  Object.defineProperty(
    globalThis,
    name,
    typeof value === "function" && /^[a-z]/.test(name)
      ? { configurable: true, writable: true, value: value.bind(window) }
      : {
        configurable: true,
        get: () => Reflect.get(window, name),
        set: (next: unknown) => Reflect.set(window, name, next),
      },
  );
}

const deno = {
  addEventListener: globalThis.addEventListener.bind(globalThis),
  removeEventListener: globalThis.removeEventListener.bind(globalThis),
  dispatchEvent: globalThis.dispatchEvent.bind(globalThis),
};
Object.assign(globalThis, {
  addEventListener(...args: Parameters<typeof deno.addEventListener>) {
    deno.addEventListener(...args);
    if (args[0] !== "error") {
      Reflect.apply(window.addEventListener, window, args);
    }
  },
  removeEventListener(...args: Parameters<typeof deno.removeEventListener>) {
    deno.removeEventListener(...args);
    if (args[0] !== "error") {
      Reflect.apply(window.removeEventListener, window, args);
    }
  },
  dispatchEvent(event: Event): boolean {
    return event instanceof window.Event
      ? window.dispatchEvent(event)
      : deno.dispatchEvent(event);
  },
});

const VALIDITY_FLAGS = [
  "badInput",
  "customError",
  "patternMismatch",
  "rangeOverflow",
  "rangeUnderflow",
  "stepMismatch",
  "tooLong",
  "tooShort",
  "typeMismatch",
  "valueMissing",
] as const satisfies readonly (keyof ValidityStateFlags)[];

// A failed assertion prints its operands. Printed as plain objects, a node
// and the window reach the whole document and every DOM class, megabytes of
// text that take minutes to diff, so they print as markup instead.
const LONGEST_PRINTED_NODE = 200;
Object.defineProperty(window.Node.prototype, Symbol.for("Deno.customInspect"), {
  value(this: Node): string {
    const text = this instanceof Element
      ? this.outerHTML
      : `${this.nodeName} ${JSON.stringify(this.textContent)}`;
    return text.length > LONGEST_PRINTED_NODE
      ? `${text.slice(0, LONGEST_PRINTED_NODE)}…`
      : text;
  },
});
Object.defineProperty(window, Symbol.for("Deno.customInspect"), {
  value: () => "Window",
});

/**
 * What an element reported through its `ElementInternals`: the value it
 * submits with its form, and its validity.
 */
class RecordedInternals {
  /** The value last passed to `setFormValue()`. */
  formValue: unknown = null;
  /** The flags set by the last call to `setValidity()`. */
  validity: ValidityStateFlags = {};
  /** The message last passed to `setValidity()`. */
  validationMessage = "";
  /** Custom states, as `:state()` selectors would match them. */
  readonly states = new Set<string>();
  /** The form the element belongs to; this document has none. */
  readonly form = null;

  /** Records `value` as the element's form value. */
  setFormValue(value: unknown): void {
    this.formValue = value;
  }

  /** Records the element's validity flags and message. */
  setValidity(flags: ValidityStateFlags = {}, message = ""): void {
    // A browser accepts a `ValidityState`, whose `valid` is not a flag.
    this.validity = Object.fromEntries(
      VALIDITY_FLAGS.filter((flag) => flags[flag]).map((flag) => [flag, true]),
    );
    this.validationMessage = message;
  }

  /** Returns whether no validity flag is set. */
  checkValidity(): boolean {
    return Object.keys(this.validity).length === 0;
  }
}

const recorded = new WeakMap<HTMLElement, RecordedInternals>();

Object.defineProperty(HTMLElement.prototype, "attachInternals", {
  configurable: true,
  writable: true,
  value: function attachInternals(this: HTMLElement): RecordedInternals {
    if (recorded.has(this)) {
      throw new DOMException(
        "ElementInternals for the specified element was already attached.",
        "NotSupportedError",
      );
    }
    const internals = new RecordedInternals();
    recorded.set(this, internals);
    return internals;
  },
});

/**
 * What `element` has reported through `attachInternals()`, or `undefined`
 * when it never called it.
 */
export function internalsOf(
  element: HTMLElement,
): Readonly<RecordedInternals> | undefined {
  return recorded.get(element);
}

/**
 * Appends `element` to the document's body and resolves with it once its
 * first update has rendered. A test removes it with `element.remove()`.
 */
export async function mount<
  T extends HTMLElement & { readonly updateComplete: Promise<boolean> },
>(element: T): Promise<T> {
  document.body.append(element);
  await element.updateComplete;
  return element;
}

/**
 * Resolves once every task the happy-dom window has pending has run: the
 * global `requestAnimationFrame` callbacks and `XMLHttpRequest` requests, which
 * are the window's, and whatever the window schedules itself or is asked for
 * by name (`window.setTimeout`, `window.fetch`). The global `setTimeout`,
 * `setInterval`, and `fetch` stay Deno's, so their timers and requests are not
 * waited for.
 */
export function settle(): Promise<void> {
  return window.happyDOM.waitUntilComplete();
}
