/**
 * Validates where a scope declaration sits in a generated schema, so a slot an
 * author marked `PerUser`/`PerSession` cannot reach storage as shared
 * space-scoped data.
 *
 * The runtime reads a slot's scope from that slot's own schema — its top
 * level, or the definition a `$ref` there names
 * (`ContextualFlowControl.getSchemaScopeCap`). A declaration inside one of its
 * compound branches is not a weaker declaration, it is no declaration: no
 * narrowing redirect is written, the value lands on the space row, and every
 * principal reads one instance. Refusing the schema at generation time is what keeps
 * that from being a silent outcome.
 *
 * One declaration in a branch is not hidden: a cell's `asCell` entry naming the
 * scope the slot declares at its own top level, as a scoped cell beside `null`
 * or `undefined` carries. The slot's scope is read at the top, and the entry's,
 * the cap on following the handle, wherever the handle is reached
 * (`ContextualFlowControl.getAsCellFollowScopeCap`).
 *
 * The subject here is PLACEMENT. Which scope a slot should carry, and which
 * instance the runtime addresses once it has one, are the write path's
 * questions.
 */

import { isObjectOrArray } from "@commonfabric/utils/types";
import type { MutableJSONSchema } from "@commonfabric/api";

/**
 * Keywords whose values are schemas for a DIFFERENT slot than the one being
 * walked. A scope declared at the top level of one of these is that slot's own
 * declaration, and the write path reads it there.
 */
const CHILD_SLOT_KEYWORDS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
] as const;

/**
 * Keywords whose values are a single schema for a different slot.
 */
const CHILD_SLOT_SINGLE_KEYWORDS = [
  "additionalProperties",
  "items",
  "contains",
  "propertyNames",
] as const;

/**
 * Keywords that compose alternatives for the SAME slot. A scope declared at the
 * top level of one of these branches is invisible to the write path, which
 * reads a slot's own schema and not its compound branches.
 */
const SAME_SLOT_COMPOUND_KEYWORDS = ["anyOf", "oneOf", "allOf"] as const;

/**
 * The scope a slot declares at its own top level: the outermost `asCell`
 * entry's scope if present, otherwise the top-level `scope`. This is the
 * precedence `ContextualFlowControl.getSchemaScopeCap` applies at one level;
 * that reader also follows a `$ref` to its definition, which this one does not,
 * since the walk visits each definition in `$defs` itself.
 */
const topLevelScope = (schema: MutableJSONSchema): string | undefined => {
  if (!isObjectOrArray(schema)) return undefined;
  // A string entry (`asCell: ["cell"]`) carries no scope of its own and does
  // not stand in for one: `Cell<PerSession<T>>` puts the scope on the sibling
  // key, so the fallback below is the only thing that finds it.
  return asCellEntryScope(schema) ??
    (typeof schema.scope === "string" ? schema.scope : undefined);
};

/** The scope the outermost `asCell` entry of `schema` declares, if any. */
const asCellEntryScope = (schema: MutableJSONSchema): string | undefined => {
  if (!isObjectOrArray(schema)) return undefined;
  const entry = Array.isArray(schema.asCell) ? schema.asCell[0] : undefined;
  return isObjectOrArray(entry) && typeof entry.scope === "string"
    ? entry.scope
    : undefined;
};

/**
 * The error raised when a scope wrapper lands inside a union. Shared with the
 * formatter so the two detection points speak with one voice.
 */
export const scopeInsideUnionError = (scope: string): Error =>
  new Error(
    `A scope wrapper cannot be a member of a union. ` +
      `\`PerUser<T> | number\` puts \`scope: "${scope}"\` inside an ` +
      `\`anyOf\` branch, where the write path does not look for it, so the ` +
      `slot stores one shared space-scoped value instead of one per ` +
      `principal. Put the union inside the wrapper ` +
      `(\`PerUser<T | number>\`). Beside \`null\` or \`undefined\` alone, ` +
      `a wrapper scopes the whole slot.`,
  );

/**
 * The error raised when a scope wrapper holds a cell beside a value other than
 * `null` or `undefined`. The one scope would then have to be the slot's own
 * for the value and the cell's cap on its handle both.
 */
export const scopeAroundCellUnionError = (scope: string): Error =>
  new Error(
    `A scope wrapper around a cell cannot hold a value beside the cell ` +
      `other than \`null\` or \`undefined\`: \`PerUser<Cell<T> | string>\` ` +
      `would need \`scope: "${scope}"\` to scope the slot and cap the ` +
      `cell's handle both. Put the value inside the cell ` +
      `(\`PerUser<Cell<T | string>>\`).`,
  );

const walkSlot = (schema: MutableJSONSchema): void => {
  if (!isObjectOrArray(schema)) return;

  const slotScope = typeof schema.scope === "string" ? schema.scope : undefined;
  for (const keyword of SAME_SLOT_COMPOUND_KEYWORDS) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      checkBranch(branch as MutableJSONSchema, slotScope);
    }
  }

  descendIntoChildSlots(schema);
};

/**
 * A branch of the slot currently being walked, which declares `slotScope` at
 * its own top level, if any. A scope at the branch's top level belongs to the
 * containing slot, so declaring one here is the defect, except the cap a
 * cell's `asCell` entry declares where it names `slotScope`. Beside that cap,
 * a `scope` is the scope of the value inside the cell.
 */
const checkBranch = (
  schema: MutableJSONSchema,
  slotScope: string | undefined,
): void => {
  if (!isObjectOrArray(schema)) return;

  const scope = topLevelScope(schema);
  if (
    scope !== undefined &&
    (asCellEntryScope(schema) !== scope || scope !== slotScope)
  ) {
    throw scopeInsideUnionError(scope);
  }

  // A nested compound is still the same slot's alternatives.
  for (const keyword of SAME_SLOT_COMPOUND_KEYWORDS) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      checkBranch(branch as MutableJSONSchema, slotScope);
    }
  }

  descendIntoChildSlots(schema);
};

const descendIntoChildSlots = (schema: MutableJSONSchema): void => {
  if (!isObjectOrArray(schema)) return;

  for (const keyword of CHILD_SLOT_KEYWORDS) {
    const group = schema[keyword];
    if (!isObjectOrArray(group) || Array.isArray(group)) continue;
    // `Object.keys`, not `for...in`: these are the schema's own declared
    // names, and the prototype chain holds none of them.
    for (const key of Object.keys(group)) {
      walkSlot((group as Record<string, MutableJSONSchema>)[key]!);
    }
  }

  for (const keyword of CHILD_SLOT_SINGLE_KEYWORDS) {
    const child = schema[keyword];
    if (child === undefined) continue;
    if (Array.isArray(child)) {
      for (const entry of child) walkSlot(entry as MutableJSONSchema);
    } else {
      walkSlot(child as MutableJSONSchema);
    }
  }

  const prefixItems = schema.prefixItems;
  if (Array.isArray(prefixItems)) {
    for (const entry of prefixItems) walkSlot(entry as MutableJSONSchema);
  }
};

/**
 * Throws when a generated schema declares a scope somewhere the runtime's write
 * path cannot see it.
 *
 * A slot's scope is read from that slot's own schema — its top level, or the
 * definition a `$ref` there names (`ContextualFlowControl.getSchemaScopeCap`). A declaration buried in an
 * `anyOf`/`oneOf`/`allOf` branch is therefore inert on the write side: no
 * narrowing redirect is written, the value lands on the shared space row, and
 * every principal reads the same instance. Failing at generation time is what
 * keeps that from reaching storage.
 */
export const assertScopeDeclarationsAreReachable = (
  schema: MutableJSONSchema,
): void => {
  walkSlot(schema);
};
