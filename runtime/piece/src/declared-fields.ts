/**
 * What a schema position declares, read the way the runtime reads it.
 *
 * Two doors ask this question of two different schemas. The call door asks a
 * verb's event schema which fields a payload may carry; the read door asks a
 * source cell's schema which fields a `--select` path may name. A name neither
 * declares is the same mistake either way, so both are settled here rather
 * than twice — the vocabulary a refusal prints, and the rule deciding whether
 * a position judges undeclared names at all, are one implementation.
 *
 * Every reading here fails open: where the schema stops proving what sits
 * under a position, the position declares nothing and judges nothing. A refusal
 * spends nothing and can be retried, while a wrongly refused call cannot be
 * made and a wrongly refused read cannot be taken.
 */

import type { JSONSchema } from "@commonfabric/api";
import { cfcSchemaResolvedRoot } from "@commonfabric/runner/cfc/schema-refs";
import { localRefTarget } from "@commonfabric/runner/cfc/schema-sanitization";
import {
  isObjectNotArray,
  type ReadonlyRecord,
} from "@commonfabric/utils/types";

/** Whether `schema` is a schema object rather than a boolean or absent. */
export function isSchemaObject(
  schema: JSONSchema | undefined,
): schema is ReadonlyRecord {
  return isObjectNotArray(schema);
}

/**
 * Whether a resolved schema position describes an object — directly, or as an
 * `allOf` conjunction with an object-schema branch (a conjunction that
 * includes an object schema IS an object schema, no branch choice involved).
 * `anyOf`/`oneOf` roots deliberately return false: reading one as an object
 * would pick among alternatives on the caller's behalf, and a position is
 * judged only on proof.
 */
export function schemaIsObjectShaped(
  target: JSONSchema,
  root: JSONSchema,
): boolean {
  if (!isSchemaObject(target)) return false;
  if (target.type === "object" || isSchemaObject(target.properties)) {
    return true;
  }
  if (Array.isArray(target.allOf)) {
    return target.allOf.some((branch) => {
      const resolved = localRefTarget(branch, root);
      return isSchemaObject(resolved) &&
        (resolved.type === "object" || isSchemaObject(resolved.properties));
    });
  }
  return false;
}

/**
 * Whether a position describes an array.
 *
 * The array counterpart of {@link schemaIsObjectShaped}, and it settles the
 * question the same way: a stated `type` says so, and otherwise the container
 * keyword being present does. An untyped position naming `items` is an array
 * to everything except schema traversal's own descent, which requires the
 * stated type and empties the position without it — the same asymmetry the
 * object side has, one container over.
 */
export function schemaIsArrayShaped(node: Record<string, unknown>): boolean {
  const declaredType = node.type;
  if (declaredType === "array") return true;
  if (Array.isArray(declaredType)) return declaredType.includes("array");
  if (declaredType !== undefined) return false;
  return node.items !== undefined || node.prefixItems !== undefined;
}

/** One property map an object-shaped position reaches, with the local-ref
 * scope the schemas inside it resolve against. */
export interface DeclaredFieldSource {
  properties: Record<string, JSONSchema>;
  root: JSONSchema;
}

/** What a position declares, and whether anything there honors a field none of
 * its maps name. */
export interface DeclaredFields {
  sources: DeclaredFieldSource[];
  honorsUndeclared: boolean;

  /** Every name any reached member marks required. A conjunction constrains
   * one value from all its members at once, so a name any of them requires is
   * required of the value. A DISJUNCTION contributes none — a value satisfies
   * one branch, so no branch's requirement binds it, and the walk
   * stops at one rather than reading its members. */
  required: Set<string>;
}

/**
 * Every property map an object-shaped position reaches, and whether it honors a
 * field none of them name.
 *
 * A conjunction constrains one value from several members at once, so the
 * fields it declares are the UNION across its members: a value satisfying an
 * `allOf` satisfies every member, and a field one member names is a field the
 * position names. Taking the union is also the safe direction — the cost of
 * missing a member is refusing a field that was declared, and the cost of an
 * extra member is accepting one that would have been dropped.
 *
 * A disjunction makes the whole position honor everything, whether it sits at
 * the position or inside a conjunction member: a branch the value was meant
 * for may name a field the others do not, and choosing among branches is the
 * caller's, not this reader's.
 *
 * `followed` breaks reference cycles, and it records the REFERENCE rather than
 * the schema it resolved to — the same key `localRefTarget` cycles on, and the
 * only one that works here: resolution hands back a fresh view of a definition
 * each time, so a recursive `$ref` reaches an object this walk has never seen
 * and descends forever. A member is skipped once its reference has been
 * followed in the scope it was written in; a definition contributes its fields
 * once, and a schema naming itself terminates.
 */
export function declaredFieldsAt(
  node: Record<string, unknown>,
  root: JSONSchema,
  into: DeclaredFields = {
    sources: [],
    honorsUndeclared: false,
    required: new Set<string>(),
  },
  followed: Map<JSONSchema, Set<string>> = new Map(),
): DeclaredFields {
  if (isSchemaObject(node.properties as JSONSchema)) {
    into.sources.push({
      properties: node.properties as Record<string, JSONSchema>,
      root,
    });
  }
  // `false` is the one value that does NOT honor undeclared fields — it is
  // the schema saying no extra field is permitted. Reading mere presence as
  // permission inverts the strictest spelling into the most permissive one,
  // and the name is then dropped by the runtime — a field a call never
  // delivers, a path a read never returns — which is the silent loss the
  // refusals built on this exist to prevent.
  if (
    node.additionalProperties !== undefined &&
    node.additionalProperties !== false
  ) {
    into.honorsUndeclared = true;
  }
  if (Array.isArray(node.required)) {
    for (const name of node.required as unknown[]) {
      if (typeof name === "string") into.required.add(name);
    }
  }
  // A disjunction AT the position, read here rather than left to each caller
  // to guard: a branch the value was meant for may name a field the others do
  // not, and this reader is the one that says whether a position judges.
  if (node.anyOf !== undefined || node.oneOf !== undefined) {
    into.honorsUndeclared = true;
  }
  if (!Array.isArray(node.allOf)) return into;
  for (const member of node.allOf as JSONSchema[]) {
    const memberRoot = root;
    if (isSchemaObject(member) && typeof member.$ref === "string") {
      let inScope = followed.get(memberRoot);
      if (inScope?.has(member.$ref)) continue;
      if (inScope === undefined) {
        inScope = new Set();
        followed.set(memberRoot, inScope);
      }
      inScope.add(member.$ref);
    }
    const resolved = localRefTarget(member, memberRoot);
    if (!isSchemaObject(resolved)) continue;
    if (resolved.anyOf !== undefined || resolved.oneOf !== undefined) {
      into.honorsUndeclared = true;
      continue;
    }
    declaredFieldsAt(
      resolved,
      resolved !== member
        ? cfcSchemaResolvedRoot(resolved, memberRoot)
        : memberRoot,
      into,
      followed,
    );
  }
  return into;
}

/** The vocabulary a refusal names: every field the position's maps declare, in
 * the order they were reached, each named once. */
export function declaredFieldNames(sources: DeclaredFieldSource[]): string[] {
  const names: string[] = [];
  for (const source of sources) {
    for (const key of Object.keys(source.properties)) {
      if (!names.includes(key)) names.push(key);
    }
  }
  return names;
}
