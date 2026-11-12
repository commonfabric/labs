/**
 * Test utility: read what a Lit `render()` returns without a DOM.
 *
 * `html` returns a template whose static markup is split around its bound
 * values. These functions walk that structure, including the templates and
 * arrays nested in its values, so a unit test can check what a component
 * renders and call the handlers it binds.
 */

/** A template as Lit's `html` and `svg` tags return it. */
interface Template {
  strings: readonly string[];
  values: readonly unknown[];
}

function isTemplate(node: unknown): node is Template {
  return typeof node === "object" && node !== null &&
    "strings" in node && Array.isArray(node.strings) &&
    "values" in node && Array.isArray(node.values);
}

/**
 * The template's markup with every bound value written in place, nested
 * templates and arrays flattened. `null`, `undefined`, and Lit's `nothing`
 * and `noChange` sentinels write nothing.
 */
export function templateText(node: unknown): string {
  if (isTemplate(node)) {
    return node.strings.map((part, index) =>
      index < node.values.length
        ? part + templateText(node.values[index])
        : part
    ).join("");
  }
  if (Array.isArray(node)) return node.map(templateText).join("");
  if (node === null || node === undefined || typeof node === "symbol") {
    return "";
  }
  return String(node);
}

/**
 * Every value bound to `name` anywhere in the template tree, in document
 * order. `name` is written as in the template, prefix included: `@click`,
 * `.value`, `?disabled`, or a plain attribute such as `aria-label`.
 */
export function boundValues(node: unknown, name: string): unknown[] {
  const found: unknown[] = [];
  const binding = new RegExp(
    `(?:^|\\s)${name.replace(/[.?@]/g, "\\$&")}=["']?$`,
  );
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (isTemplate(value)) {
      value.values.forEach((inner, index) => {
        if (binding.test(value.strings[index])) found.push(inner);
        visit(inner);
      });
    }
  };
  visit(node);
  return found;
}

/** The one value bound to `name` in the template tree; throws unless one. */
export function boundValue(node: unknown, name: string): unknown {
  const found = boundValues(node, name);
  if (found.length !== 1) {
    throw new Error(`expected one binding of ${name}, found ${found.length}`);
  }
  return found[0];
}

/**
 * The one event listener bound to `name` (such as `@click`), as a function
 * that calls it the way Lit does, with `host` as `this`.
 */
export function boundHandler<E = Event>(
  node: unknown,
  name: string,
  host: object,
): (event: E) => unknown {
  const handler = boundValue(node, name);
  if (typeof handler !== "function") {
    throw new Error(`the binding of ${name} is not a function`);
  }
  return (event: E) => handler.call(host, event);
}
