import { toCompactDebugString } from "@commonfabric/data-model";

/**
 * Flattens a Lit template result, its values included, to its markup, so
 * that a test can assert on what a render method produced without a DOM. A
 * value that is an object other than a template result, such as one bound to
 * an element property, is rendered as its compact debug string rather than
 * dropped, so that content it holds is in the markup for an assertion to
 * find.
 *
 * A function bound in the template, such as an event listener, is rendered as
 * its source, or as `[listener]` when `options.elideListeners` is set.
 */
export function templateMarkup(
  value: unknown,
  options: { elideListeners?: boolean } = {},
): string {
  return flatten(
    value,
    (_invoke, source) => options.elideListeners ? "[listener]" : source,
  );
}

/** An event listener a template binds, and the element it is bound on. */
export interface TemplateListener {
  /**
   * The opening tag of the element, as `templateMarkup()` renders it, except
   * that each function bound in it appears as `[listener]`.
   */
  tag: string;

  /** The markup after the opening tag and before the next tag, trimmed. */
  text: string;

  /**
   * Calls the listener with `event`, and with `host` as `this`, as Lit does
   * when the event fires on the element, and returns what it returns.
   */
  dispatch(event: Event): unknown;
}

/**
 * Returns the listeners a Lit template result, its values included, binds
 * with `@name=` on an element, in the order they appear, so that a test can
 * pick one by the element it is bound on and fire it. `host` is the element
 * that rendered the template.
 */
export function templateListeners(
  value: unknown,
  name: string,
  host: object,
): TemplateListener[] {
  const { markup, dispatchers } = markListeners(value, host);
  const binding = new RegExp(`@${name}="?$`);
  return dispatchers.flatMap((dispatch, index) => {
    const at = markup.indexOf(listenerMark(index));
    if (!binding.test(markup.slice(0, at))) return [];
    const end = markup.indexOf(">", at) + 1;
    const tag = markup.slice(markup.lastIndexOf("<", at), end);
    const text = markup.slice(end, markup.indexOf("<", end)).trim();
    return [{
      tag: tag.replaceAll(LISTENER_MARKS, "[listener]"),
      text,
      dispatch,
    }];
  });
}

/**
 * Returns the listener a Lit template result binds with `@name=` on the
 * `element` holding the first appearance of `text`, in its opening tag or as
 * content, so that a test can fire a control by what a person sees on it.
 * `host` is the element that rendered the template. The listener returns what
 * the bound function returns, so a test can wait for the work it starts.
 *
 * @throws Error when no `element` holding `text` binds `name`.
 */
export function templateListenerOn(
  value: unknown,
  name: string,
  host: object,
  element: string,
  text: string,
): (event: Event) => unknown {
  const { markup, dispatchers } = markListeners(value, host);
  const at = markup.indexOf(text);
  const start = at === -1 ? -1 : markup.lastIndexOf(`<${element}`, at);
  const tag = start === -1
    ? ""
    : markup.slice(start, markup.indexOf(">", start));
  const bound = new RegExp(`@${name}="?\uE000(\\d+)\uE000`).exec(tag);
  if (!bound) {
    throw new Error(
      `No <${element}> holding ${JSON.stringify(text)} binds @${name}.`,
    );
  }
  return dispatchers[Number(bound[1])];
}

/** Matches every mark `listenerMark()` makes. */
const LISTENER_MARKS = /\uE000\d+\uE000/g;

/**
 * Helper for `templateListeners()` and `templateListenerOn()`, which returns
 * the mark that stands for the function at `index` in their markup.
 */
function listenerMark(index: number): string {
  return `\uE000${index}\uE000`;
}

/**
 * Helper for `templateListeners()` and `templateListenerOn()`, which flattens
 * `value` to markup with each function bound in it replaced by its
 * `listenerMark()`, and returns that markup with a way to call each function
 * with `host` as `this`, in the order they appear.
 */
function markListeners(
  value: unknown,
  host: object,
): { markup: string; dispatchers: ((event: Event) => unknown)[] } {
  const dispatchers: ((event: Event) => unknown)[] = [];
  const markup = flatten(value, (invoke) => {
    dispatchers.push((event) => invoke(host, event));
    return listenerMark(dispatchers.length - 1);
  });
  return { markup, dispatchers };
}

/**
 * Returns every value bound to the property `name` across nested Lit template
 * results, in the order the walk reaches them, so that a test can read what a
 * render handed a child element.
 *
 * A template result carries its literal text in `strings` and its bound
 * values in `values`, in step, so the chunk before a value ends with that
 * binding's own `.name="`. Returning every match rather than the first is
 * what tells a binding holding `undefined` from a name nothing binds: the
 * first is `[undefined]` and the second is `[]`.
 */
export function templateBindings(value: unknown, name: string): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => templateBindings(entry, name));
  }
  if (value === null || typeof value !== "object") return [];
  const template = value as {
    strings?: readonly string[];
    values?: readonly unknown[];
  };
  // An object that is not a template result, such as a `Map` bound to a
  // property, binds nothing, whatever its own `values` member may be.
  const strings = template.strings;
  if (strings === undefined) return [];
  return (template.values ?? []).flatMap((bound, index) =>
    strings[index]?.endsWith(`.${name}="`)
      ? [bound]
      : templateBindings(bound, name)
  );
}

/**
 * Helper for `templateMarkup()` and `markListeners()`, which flattens `value`
 * to markup, rendering each function bound in it with `renderListener`, which
 * is handed a way to call the function with a given `this`, and the function's
 * source.
 */
function flatten(
  value: unknown,
  renderListener: (
    invoke: (host: object, event: Event) => unknown,
    source: string,
  ) => string,
): string {
  if (Array.isArray(value)) {
    return value.map((item) => flatten(item, renderListener)).join("");
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "function") {
    return renderListener(
      (host, event) => value.call(host, event),
      String(value),
    );
  }
  if (typeof value !== "object") return String(value);
  const template = value as {
    strings?: readonly string[];
    values?: readonly unknown[];
  };
  if (template.strings === undefined) return toCompactDebugString(value);
  return template.strings.map((part, index) =>
    part + flatten(template.values?.[index], renderListener)
  ).join("");
}
