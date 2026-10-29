import { toCompactDebugString } from "@commonfabric/data-model";

/**
 * Flattens a Lit template result, its values included, to its markup, so
 * that a test can assert on what a render method produced without a DOM. A
 * value that is an object other than a template result, such as one bound to
 * an element property, is rendered as its compact debug string rather than
 * dropped, so that content it holds is in the markup for an assertion to
 * find.
 */
export function templateMarkup(value: unknown): string {
  if (Array.isArray(value)) return value.map(templateMarkup).join("");
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  const template = value as {
    strings?: readonly string[];
    values?: readonly unknown[];
  };
  if (template.strings === undefined) return toCompactDebugString(value);
  return template.strings.map((part, index) =>
    part + templateMarkup(template.values?.[index])
  ).join("");
}
