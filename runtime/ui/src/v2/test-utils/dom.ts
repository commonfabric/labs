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
 * as before.
 *
 * happy-dom offers no `ElementInternals`, so this module also gives
 * `HTMLElement` an `attachInternals()` whose result records the form value
 * and validity an element reports; {@link internalsOf} reads it back.
 */

import { Window } from "happy-dom";

/** The window whose document components are mounted in. */
export const window = new Window({ url: "http://localhost/" });

const REPLACED =
  /^(?:[A-Z]\w*)?Event$|^(location|navigator|localStorage|sessionStorage)$/;

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
    Reflect.apply(window.addEventListener, window, args);
  },
  removeEventListener(...args: Parameters<typeof deno.removeEventListener>) {
    deno.removeEventListener(...args);
    Reflect.apply(window.removeEventListener, window, args);
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
 * Resolves once every timer, animation frame, and fetch the window has
 * pending has run.
 */
export function settle(): Promise<void> {
  return window.happyDOM.waitUntilComplete();
}
