/**
 * Reads a console view's Lit templates without a DOM to render them into: the
 * text a page would show, and the bindings a page would wire up, so a test can
 * drive the view the way a page would (click a button, type into a field).
 */

type Template = { strings: readonly string[]; values: readonly unknown[] };

const isTemplate = (value: unknown): value is Template =>
  typeof value === "object" && value !== null && "strings" in value &&
  Array.isArray(value.strings) && "values" in value &&
  Array.isArray(value.values);

/** Flattens literal text and nested templates, ignoring non-text values. */
export const templateText = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(templateText).join("");
  if (!isTemplate(value)) return "";
  return value.strings.map((part, index) =>
    part + templateText(value.values[index])
  ).join("");
};

/** One value a template binds to an attribute, property, or event. */
export interface TemplateBinding {
  /** The name it is bound under: `@click`, `.cell`, `?disabled`, `title`. */
  name: string;

  value: unknown;

  /** The tag name of the element carrying the binding. */
  tag: string;

  /**
   * The text inside the element carrying the binding, tags stripped and
   * whitespace collapsed: a button's label, a row's cells.
   */
  text: string;
}

/** The attribute name a template part ends on, when it ends inside a tag. */
const ATTRIBUTE_TAIL = /([@.?]?[\w-]+)="?$/;

/** Elements that have no closing tag, and so no text. */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

interface Flattened {
  /** The template's markup, with every binding left out. */
  markup: string;

  /** Each binding, and where in `markup` it was left out. */
  bindings: { name: string; value: unknown; at: number }[];
}

const flatten = (value: unknown, out: Flattened): void => {
  if (typeof value === "string" || typeof value === "number") {
    out.markup += value;
  } else if (Array.isArray(value)) {
    for (const item of value) flatten(item, out);
  } else if (isTemplate(value)) {
    value.strings.forEach((part, index) => {
      out.markup += part;
      if (index >= value.values.length) return;
      const bound = value.values[index];
      const name = ATTRIBUTE_TAIL.exec(part)?.[1];
      if (name === undefined || isTemplate(bound)) {
        flatten(bound, out);
      } else {
        out.bindings.push({ name, value: bound, at: out.markup.length });
      }
    });
  }
};

/**
 * The text of an element whose opening tag `markup` starts inside, up to
 * the tag that closes it.
 */
const textOf = (tag: string, markup: string): string => {
  if (VOID_ELEMENTS.has(tag)) return "";
  const body = markup.slice(markup.indexOf(">") + 1);
  let depth = 1;
  let end = body.length;
  for (const match of body.matchAll(new RegExp(`<(/?)${tag}[\\s>]`, "g"))) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) {
      end = match.index;
      break;
    }
  }
  return body.slice(0, end).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")
    .trim();
};

/** Every non-text binding in a rendered template, in document order. */
export const templateBindings = (rendered: unknown): TemplateBinding[] => {
  const out: Flattened = { markup: "", bindings: [] };
  flatten(rendered, out);
  return out.bindings.map(({ name, value, at }) => {
    const tag = [...out.markup.slice(0, at).matchAll(/<([\w-]+)/g)].at(-1)
      ?.[1] ?? "";
    return { name, value, tag, text: textOf(tag, out.markup.slice(at)) };
  });
};

/**
 * The value of the one binding named `name` on an element whose text
 * contains `text`, and whose tag name is `tag` where one is given. Throws
 * when there is none or more than one, so a test never drives the wrong
 * element.
 */
export const bindingOn = (
  rendered: unknown,
  name: string,
  text = "",
  tag?: string,
): unknown => {
  const found = templateBindings(rendered).filter((binding) =>
    binding.name === name && binding.text.includes(text) &&
    (tag === undefined || binding.tag === tag)
  );
  if (found.length !== 1) {
    throw new Error(`expected one ${name} on "${text}", found ${found.length}`);
  }
  return found[0].value;
};

/**
 * The listener bound as `name` on the element `bindingOn` finds, to be
 * called the way Lit would call it.
 */
export const handlerOn = (
  rendered: unknown,
  name: string,
  text = "",
  tag?: string,
): (event?: unknown) => unknown => {
  const value = bindingOn(rendered, name, text, tag);
  if (typeof value !== "function") {
    throw new Error(`${name} on "${text}" is not a listener`);
  }
  return (event) => value(event);
};
