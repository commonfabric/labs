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
 * the input's own schema, on the `$defs` entry its `$ref` names, or in the
 * object's own `default`. A required input declared in any other way, such as
 * inside an `allOf`, counts as having no default. An input a host fills in,
 * such as the browser's loom id, is declared optional by its author; nothing
 * in the schema says who fills an input in.
 */

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
  const defaults = typeof root.default === "object" && root.default !== null &&
      !Array.isArray(root.default)
    ? root.default as Record<string, unknown>
    : {};
  return (root.required ?? []).filter((name) => {
    if (Object.hasOwn(defaults, name)) return false;
    const property = resolved(properties[name], argumentSchema);
    return typeof property !== "object" || property === null ||
      !("default" in property);
  });
}

/**
 * `schema` with a `$ref` into the root's `$defs` replaced by what it names,
 * keeping what sits beside the `$ref`, so a default on either side counts. A
 * `$ref` that names nothing in the root is left as it is.
 */
function resolved(
  schema: JSONSchema | undefined,
  root: JSONSchema,
): JSONSchema | undefined {
  if (typeof schema !== "object" || schema === null) return schema;
  const ref = schema.$ref;
  const prefix = "#/$defs/";
  if (typeof ref !== "string" || !ref.startsWith(prefix)) return schema;
  const defs = typeof root === "object" && root !== null
    ? root.$defs
    : undefined;
  const target = defs?.[ref.slice(prefix.length)];
  if (typeof target !== "object" || target === null) return schema;
  const { $ref: _ref, ...beside } = schema;
  return { ...target, ...beside };
}
