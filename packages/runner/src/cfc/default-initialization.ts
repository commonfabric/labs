import {
  type FabricValue,
  isWalkableObjectOrArray,
  valueEqual,
} from "@commonfabric/data-model";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { isWriteRedirectLink, type NormalizedFullLink } from "../link-utils.ts";
import { ignoreReadForScheduling } from "../scheduler.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { cfcSchemaEntries } from "./schema-label-view.ts";
import { runtimeWritePolicyAuthorization } from "./types.ts";

/**
 * Records exact defaults for new protected fields during verified pattern setup.
 * The caller supplies the defaults extracted from the candidate schema; the
 * commit verifier independently checks pre-transaction absence and final bytes.
 */
export function recordNewProtectedDefaults(
  tx: IExtendedStorageTransaction,
  target: NormalizedFullLink,
  previousSchema: JSONSchema | undefined,
  schema: JSONSchema,
  defaults: FabricValue,
  next: unknown,
): void {
  // Without the previous declaration, absence cannot establish a new field.
  if (previousSchema === undefined) return;
  const previous = tx.readValueOrThrow(target, {
    meta: ignoreReadForScheduling,
  });
  if (!isWalkableObjectOrArray(previous) || isWriteRedirectLink(previous)) {
    return;
  }
  recordProtectedDefaults(
    tx,
    target,
    schema,
    defaults,
    next,
    "default",
    (path) =>
      ContextualFlowControl.schemaAtPath(
        previousSchema,
        path,
        undefined,
        false,
        false,
      ) === false,
  );
}

/**
 * Records exact defaults for the protected fields of an argument document a
 * setup creates for a new piece. Every field of a new document is new, so each
 * protected field the setup fills with its schema default, because `supplied`,
 * the caller's argument before defaults were merged into it, leaves the field
 * out, is a seed, as an internal cell's default is. A field the caller supplies
 * is the caller's write, even where it equals the default. The commit verifier
 * independently checks pre-transaction absence and final bytes.
 */
export function recordNewDocumentProtectedDefaults(
  tx: IExtendedStorageTransaction,
  target: NormalizedFullLink,
  schema: JSONSchema,
  defaults: FabricValue,
  supplied: unknown,
  next: unknown,
): void {
  recordProtectedDefaults(
    tx,
    target,
    schema,
    defaults,
    next,
    "seed",
    (path) => !ownValueAtPath(supplied, path).present,
  );
}

/**
 * Records, as an initialization of `mode`, each concrete protected field of
 * `schema` at which `next` holds the field's default and `isNew` holds.
 */
function recordProtectedDefaults(
  tx: IExtendedStorageTransaction,
  target: NormalizedFullLink,
  schema: JSONSchema,
  defaults: FabricValue,
  next: unknown,
  mode: "default" | "seed",
  isNew: (path: readonly string[]) => boolean,
): void {
  // Schema-entry paths do not distinguish a literal `*` property from a
  // wildcard. Neither receives automatic initialization authority.
  for (const entry of cfcSchemaEntries(schema)) {
    if (
      !isObjectOrArray(entry.schema) ||
      (entry.schema.ifc?.writeAuthorizedBy === undefined &&
        entry.schema.ifc?.writePolicyAnyOf === undefined) ||
      entry.path.length === 0 || entry.path.includes("*") ||
      !isNew(entry.path)
    ) continue;
    const expected = ownValueAtPath(defaults, entry.path);
    const actual = ownValueAtPath(next, entry.path);
    if (
      !expected.present || !actual.present ||
      !valueEqual(expected.value, actual.value)
    ) continue;
    tx.recordCfcWritePolicyInput({
      kind: "initialization",
      mode,
      target: {
        space: target.space,
        id: target.id,
        scope: target.scope,
        path: [...target.path, ...entry.path],
      },
      value: expected.value,
    }, runtimeWritePolicyAuthorization);
  }
}

function ownValueAtPath(
  value: unknown,
  path: readonly string[],
): { present: true; value: FabricValue } | { present: false } {
  let current = value;
  for (const segment of path) {
    if (
      !isWalkableObjectOrArray(current) || isWriteRedirectLink(current) ||
      !Object.hasOwn(current, segment)
    ) {
      return { present: false };
    }
    current = (current as Record<string, FabricValue>)[segment];
  }
  return { present: true, value: current as FabricValue };
}
