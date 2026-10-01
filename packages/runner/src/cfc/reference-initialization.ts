import {
  type FabricValue,
  isFabricPlainObject,
} from "@commonfabric/data-model";
import {
  isCellLink,
  isPrimitiveCellLink,
  isWriteRedirectLink,
  type NormalizedFullLink,
  type PrimitiveCellLink,
} from "../link-utils.ts";
import { ignoreReadForScheduling } from "../scheduler.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { runtimeWritePolicyAuthorization } from "./types.ts";

/**
 * Records the references a collection builtin staged into the argument of a
 * sub-pattern it is instantiating. Each of `fields` whose staged value is a
 * link to a cell is recorded, and a field holding anything else is not: a link
 * hands the new piece a reference and writes nothing of what it points at,
 * which is what makes the staging an initialization of the argument and no
 * modification of the cell. The commit verifier independently checks that the
 * slot was absent before the transaction or already held the link, and that
 * the final bytes are the link recorded.
 */
export function recordReferencedArgumentFields(
  tx: IExtendedStorageTransaction,
  argument: NormalizedFullLink,
  fields: readonly string[],
): void {
  for (const field of fields) {
    const path = [...argument.path, field];
    const staged = tx.readValueOrThrow({ ...argument, path }, {
      meta: ignoreReadForScheduling,
    });
    // A redirect sends writes on to its target, so it is no plain reference.
    if (!isPrimitiveCellLink(staged) || isWriteRedirectLink(staged)) continue;
    recordStagedLink(tx, argument, path, "reference", staged);
  }
}

/**
 * Records the bindings a collection builtin staged into the argument of a
 * sub-pattern from the closure of its callback. Each of `fields` holds those
 * captures as a record, and every link found in it, at any depth of records
 * and lists, is recorded at its own path; a captured cell arrives as a write
 * redirect to it. Values in the record are not recorded. The commit verifier
 * independently checks that each slot was absent before the transaction or
 * held a link to the same cell, and that it ends holding a link to the cell
 * recorded. It covers the slot alone: a write through a staged redirect lands
 * at the cell it names, under that cell's own policy.
 */
export function recordCapturedArgumentFields(
  tx: IExtendedStorageTransaction,
  argument: NormalizedFullLink,
  fields: readonly string[],
): void {
  for (const field of fields) {
    const path = [...argument.path, field];
    recordCapturedLinks(
      tx,
      argument,
      path,
      tx.readValueOrThrow({ ...argument, path }, {
        meta: ignoreReadForScheduling,
      }),
    );
  }
}

/**
 * Helper for `recordCapturedArgumentFields()`, which records every link in
 * `staged`, the value staged at `path` of `argument`.
 */
function recordCapturedLinks(
  tx: IExtendedStorageTransaction,
  argument: NormalizedFullLink,
  path: readonly string[],
  staged: FabricValue,
): void {
  if (isPrimitiveCellLink(staged)) {
    recordStagedLink(tx, argument, path, "capture", staged);
  } else if (Array.isArray(staged)) {
    staged.forEach((child, index) =>
      recordCapturedLinks(tx, argument, [...path, String(index)], child)
    );
  } else if (isFabricPlainObject(staged)) {
    for (const [key, child] of Object.entries(staged)) {
      recordCapturedLinks(tx, argument, [...path, key], child);
    }
  }
}

/**
 * Helper for the recorders above, which records `link`, staged at `path` of
 * `argument`, as an initialization of the given `mode`.
 */
function recordStagedLink(
  tx: IExtendedStorageTransaction,
  argument: NormalizedFullLink,
  path: readonly string[],
  mode: "reference" | "capture",
  link: PrimitiveCellLink,
): void {
  tx.recordCfcWritePolicyInput({
    kind: "initialization",
    mode,
    target: {
      space: argument.space,
      id: argument.id,
      scope: argument.scope,
      path: [...path],
    },
    value: link,
  }, runtimeWritePolicyAuthorization);
}

/**
 * Records the slots a runtime replaying a piece's setup carries over from the
 * stored argument document: every slot `stored` holds that `supplied` does not
 * name, with the bytes it holds. The replay stages the whole document again,
 * so these slots are staged with what they already hold. The commit verifier
 * independently checks that the transaction leaves each one unchanged, and a
 * slot it changes receives nothing from this record.
 */
export function recordReplayedArgumentSlots(
  tx: IExtendedStorageTransaction,
  argument: NormalizedFullLink,
  supplied: unknown,
  stored: unknown,
): void {
  if (!isFabricPlainObject(stored as FabricValue) || isCellLink(stored)) return;
  const named = isFabricPlainObject(supplied as FabricValue) &&
      !isCellLink(supplied)
    ? supplied as Record<string, unknown>
    : {};
  for (const [slot, value] of Object.entries(stored as object)) {
    if (Object.hasOwn(named, slot)) continue;
    tx.recordCfcWritePolicyInput({
      kind: "initialization",
      mode: "replay",
      target: {
        space: argument.space,
        id: argument.id,
        scope: argument.scope,
        path: [...argument.path, slot],
      },
      value: value as FabricValue,
    }, runtimeWritePolicyAuthorization);
  }
}
