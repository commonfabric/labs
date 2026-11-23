/**
 * The write policies that the result type of a compiled pattern declares,
 * as the schema a compiled piece records for a write of its result document.
 *
 * A piece writes its result document under no schema of a reference, so the
 * commit preparation would hold a write of it to no claim. The piece records
 * this schema for it: the result schema with every node left out that
 * declares no writer claim, no UI contract and no added integrity, and with
 * nothing else of a node's labels. The labels of the result document's
 * values stay the ones the plan's templates give.
 */
import { isObjectNotArray } from "@commonfabric/js-values/types";

import type { JSONSchema } from "../builder/types.ts";

/** The members of `ifc` that are kept. */
const POLICY_KEYS = [
  "writeAuthorizedBy",
  "writePolicyAnyOf",
  "uiContract",
  "addIntegrity",
] as const;

/** The deepest nesting of schema nodes that is followed. */
const MAX_DEPTH = 16;

/** The write policies of a result schema. */
export type ResultPolicy = {
  /** The result schema, reduced to its write policies. */
  readonly schema: JSONSchema;

  /**
   * The paths of the result, through properties alone, at which the schema
   * declares a writer claim or a UI contract.
   */
  readonly claimed: readonly (readonly string[])[];
};

/**
 * Returns the write policies that `schema`, the result schema of a plan,
 * declares, or `undefined` where it declares none. A `$ref` is followed
 * into `$defs` of `schema`. A branch of a union is kept as it is where any
 * branch declares a policy.
 */
/**
 * Whether `schema`, the schema of an array, declares a write policy for the
 * members of the array.
 */
export const declaresMemberPolicy = (schema: unknown): boolean =>
  isObjectNotArray(schema) && isObjectNotArray(schema.items) &&
  isObjectNotArray(schema.items.ifc) &&
  POLICY_KEYS.some((key) =>
    (schema.items as { ifc: Record<string, unknown> }).ifc[key] !== undefined
  );

export const writePoliciesOf = (schema: unknown): ResultPolicy | undefined => {
  const claimed: (readonly string[])[] = [];
  const defs = isObjectNotArray(schema) && isObjectNotArray(schema.$defs)
    ? schema.$defs
    : {};
  const resolved = (node: unknown): unknown => {
    for (let hops = 0; hops < MAX_DEPTH; hops++) {
      if (!isObjectNotArray(node) || typeof node.$ref !== "string") break;
      const name = node.$ref.startsWith("#/$defs/")
        ? node.$ref.slice("#/$defs/".length)
        : undefined;
      if (name === undefined || !Object.hasOwn(defs, name)) return undefined;
      node = defs[name];
    }
    return node;
  };
  // `path` is the path through properties alone, and `undefined` below an
  // array, a record or a union, where a claim holds at no one path.
  const project = (
    given: unknown,
    path: readonly string[] | undefined,
    depth: number,
  ): Record<string, unknown> | undefined => {
    const node = resolved(given);
    if (!isObjectNotArray(node) || depth > MAX_DEPTH) return undefined;
    const kept: Record<string, unknown> = {};
    if (isObjectNotArray(node.ifc)) {
      const ifc: Record<string, unknown> = {};
      for (const key of POLICY_KEYS) {
        if (node.ifc[key] !== undefined) ifc[key] = node.ifc[key];
      }
      if (Object.keys(ifc).length > 0) kept.ifc = ifc;
      if (
        path !== undefined &&
        (ifc.writeAuthorizedBy !== undefined ||
          ifc.writePolicyAnyOf !== undefined || ifc.uiContract !== undefined)
      ) claimed.push(path);
    }
    if (isObjectNotArray(node.properties)) {
      const properties: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(node.properties)) {
        const projected = project(
          member,
          path === undefined ? undefined : [...path, name],
          depth + 1,
        );
        if (projected !== undefined) properties[name] = projected;
      }
      if (Object.keys(properties).length > 0) kept.properties = properties;
    }
    for (const key of ["items", "additionalProperties"] as const) {
      const projected = project(node[key], undefined, depth + 1);
      if (projected !== undefined) kept[key] = projected;
    }
    for (const key of ["anyOf", "oneOf"] as const) {
      const branches = node[key];
      if (!Array.isArray(branches)) continue;
      const projected = branches.map((branch) =>
        project(branch, undefined, depth + 1)
      );
      if (projected.some((branch) => branch !== undefined)) {
        kept[key] = branches.map((branch) => resolved(branch));
      }
    }
    if (Object.keys(kept).length === 0) return undefined;
    if (typeof node.type === "string") kept.type = node.type;
    return kept;
  };
  const projected = project(schema, [], 0);
  return projected === undefined
    ? undefined
    : { schema: projected as JSONSchema, claimed };
};
