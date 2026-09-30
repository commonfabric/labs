/** Determines which paths a schema can select, independently of stored values. */

import { schemaWithProperties } from "@commonfabric/data-model-schema";

import type { JSONSchema } from "./builder/types.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { cfcSchemaWithInheritedDefs } from "./cfc/schema-refs.ts";
import { combineSchema } from "./traverse.ts";

function withStructuralType(schema: JSONSchema): JSONSchema {
  if (typeof schema === "boolean" || schema.type !== undefined) return schema;
  return schema.properties !== undefined ||
      schema.additionalProperties !== undefined
    ? { ...schema, type: "object" }
    : schema.items !== undefined || schema.prefixItems !== undefined
    ? { ...schema, type: "array" }
    : schema;
}

/**
 * Whether a schema can expose a path in its materialized projection.
 *
 * Named object properties form a projection: an unnamed property is hidden
 * unless `additionalProperties` selects it. Optional fields and array slots
 * can be selected before they hold values. A path selected by any alternative
 * is admitted; validating the current value against that alternative remains
 * the reader's responsibility. An undefined schema imposes no projection.
 * `conditionalDepth` identifies the first ancestor whose alternatives need
 * the current parent value. Readers can pull that subtree to choose its
 * projection without loading unrelated ancestors or siblings.
 */
export function schemaPathSelection(
  schema: JSONSchema | undefined,
  path: readonly (string | number)[],
  options: { allowArrayLength?: boolean } = {},
): { selected: boolean; conditionalDepth?: number } {
  let conditionalDepth: number | undefined;
  const active = new Map<JSONSchema, Set<number>>();
  const selects = (schema: JSONSchema, offset: number): boolean => {
    if (schema === false) return false;
    if (offset === path.length || schema === true) return true;
    const resolved = ContextualFlowControl.resolveSchemaRefsOrThrow(schema);
    if (typeof resolved === "boolean") return resolved;
    // `unknown` exposes an opaque reference, unlike an unrestricted schema.
    if (resolved.type === "unknown") return false;
    let offsets = active.get(resolved);
    if (offsets?.has(offset)) return false;
    if (offsets === undefined) active.set(resolved, offsets = new Set());
    offsets.add(offset);
    try {
      if (Array.isArray(resolved.type)) conditionalDepth ??= offset;
      for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
        const branches = resolved[keyword];
        if (
          branches === undefined || keyword === "allOf" && branches.length === 0
        ) continue;
        conditionalDepth ??= offset;
        const { [keyword]: _branches, ...outer } = resolved;
        if (keyword === "allOf" && branches.includes(false)) return false;
        return branches.some((branch) => {
          const branchRoot = cfcSchemaWithInheritedDefs(branch, resolved.$defs);
          const child = typeof branchRoot === "object"
            ? ContextualFlowControl.resolveSchemaRefsOrThrow(branchRoot)
            : branchRoot;
          if (typeof child === "boolean") {
            return selects(child ? outer : false, offset);
          }
          // Eager readers replace branch properties; lazy readers merge them.
          // Admission must include complete paths exposed by either reader.
          return selects(schemaWithProperties(outer, child), offset) || selects(
            combineSchema(withStructuralType(outer), withStructuralType(child)),
            offset,
          );
        });
      }
      // Runtime projections also accept structural schemas without `type`.
      const shaped = withStructuralType(resolved);
      if (
        typeof shaped !== "boolean" && options.allowArrayLength &&
        path[offset] === "length" &&
        offset === path.length - 1 && (shaped.type === "array" ||
          Array.isArray(shaped.type) && shaped.type.includes("array"))
      ) return true;
      const child = ContextualFlowControl.schemaAtPath(
        shaped,
        [String(path[offset])],
        undefined,
        false,
        false,
      );
      return selects(child, offset + 1);
    } finally {
      offsets.delete(offset);
    }
  };
  const selected = schema === undefined || selects(schema, 0);
  return { selected, conditionalDepth };
}
