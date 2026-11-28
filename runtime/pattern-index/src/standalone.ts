/**
 * Whether a pattern can run alone, the floor under "standalone".
 *
 * A pattern is offered to a person choosing what to place only when it does
 * something with no other piece wired in, so a pattern that requires an input
 * and gives it no default is never standalone, whatever it is named or
 * declared. A repository holds its `main.tsx` entries to this rule in CI, and
 * the index applies it at publish, so the one definition lives here.
 *
 * The rule reads only the argument schema, in the shapes the pattern compiler
 * emits: an object schema whose `required` names its inputs, with a default on
 * the input's own schema, on a `$defs` entry its `$ref` leads to, or in the
 * object's own `default`. A required input declared in any other way, such as
 * inside an `allOf`, counts as having no default. An input a host fills in,
 * such as the browser's loom id, is declared optional by its author; nothing
 * in the schema says who fills an input in.
 */

import { isObjectNotArray } from "@commonfabric/js-values/types";
import type { JSONSchema } from "@commonfabric/runner";

/**
 * The inputs `argumentSchema` requires and gives no default, in the order the
 * schema lists them; none when the pattern can run alone. A boolean schema
 * names no input, so it requires none.
 */
export function inputsNeededToRun(argumentSchema: JSONSchema): string[] {
  const root = resolved(argumentSchema, argumentSchema);
  if (typeof root !== "object" || root === null) return [];
  const properties = root.properties ?? {};
  const defaults = isObjectNotArray(root.default) ? root.default : {};
  return (root.required ?? []).filter((name) => {
    if (Object.hasOwn(defaults, name)) return false;
    const property = resolved(properties[name], argumentSchema);
    return typeof property !== "object" || property === null ||
      !("default" in property);
  });
}

/**
 * `schema` with each `$ref` into the root's `$defs` replaced by what it names,
 * following a `$ref` the named schema holds in turn, and keeping what sits
 * beside each `$ref`, so a default on any of them counts; the nearer schema
 * wins where two set the same keyword. A `$ref` that names nothing in the
 * root, or one already followed, is left as it is.
 */
function resolved(
  schema: JSONSchema | undefined,
  root: JSONSchema,
): JSONSchema | undefined {
  const defs = typeof root === "object" && root !== null
    ? root.$defs
    : undefined;
  const followed = new Set<string>();
  let current = schema;
  while (typeof current === "object" && current !== null) {
    const ref = current.$ref;
    if (typeof ref !== "string" || followed.has(ref)) return current;
    const name = definitionNamed(ref);
    const target = name === undefined ? undefined : defs?.[name];
    if (typeof target !== "object" || target === null) return current;
    followed.add(ref);
    const { $ref: _ref, ...beside } = current;
    current = { ...target, ...beside };
  }
  return current;
}

/**
 * The `$defs` name a `$ref` of the form `#/$defs/<name>` points to, with the
 * JSON Pointer escapes `~1` and `~0` decoded; undefined for any other `$ref`.
 */
function definitionNamed(ref: string): string | undefined {
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) return undefined;
  const token = ref.slice(prefix.length);
  if (token.includes("/")) return undefined;
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}
