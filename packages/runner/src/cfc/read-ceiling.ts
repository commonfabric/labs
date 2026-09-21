/**
 * The runtime-wide read ceiling: a confidentiality ceiling every cell payload
 * read and `db.query` uses, whether or not the query declares one of its own.
 * Declared through `RuntimeOptions.cfcReadMaxConfidentiality` and
 * `cfcReadOnExceed`, validated and frozen here at construction.
 *
 * A pattern can declare a per-query ceiling, but the only carrier a pattern
 * can read is a cell in the space, which every runtime on the space shares.
 * A ceiling that has to differ per runtime — a per-device lens, a per-run
 * clearance — therefore cannot live in a pattern's inputs. It lives on the
 * runtime. Session-scoped queries meet it with their declared ceiling; shared
 * queries materialize labeled results which the runtime measures on cell reads.
 */

import { readCeilingShapeError } from "@commonfabric/memory/v2";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IReadOptions,
} from "../storage/interface.ts";
import {
  internalVerifierRead,
  isDereferenceResolutionProbe,
  isInternalVerifierRead,
  isLinkResolutionProbe,
  isMachineryRead,
  isSchedulerDependencyRead,
  isWriteDestinationRead,
} from "../storage/reactivity-log.ts";
import type { CfcConfClause } from "./clause.ts";
import {
  cfcLabelViewFromMetadata,
  rebaseCfcLabelView,
} from "./label-view-state.ts";
import { readStoredCfcMetadata } from "./metadata.ts";
import { atomsOutsideCeiling } from "./observation.ts";
import { readConsumesEntry } from "./observation-classes.ts";

/** What a read does with a row the runtime's ceiling does not admit. */
export type CfcReadOnExceed = "fail" | "skip";

/**
 * The read ceiling's inputs, in the shape `RuntimeOptions` carries them.
 * Both absent is the owner view: no ceiling, every row returned. The mode
 * qualifies the ceiling and is refused without one.
 */
export interface CfcReadCeilingOptions {
  /** See `RuntimeOptions.cfcReadMaxConfidentiality`. */
  cfcReadMaxConfidentiality?: readonly CfcConfClause[];

  /** See `RuntimeOptions.cfcReadOnExceed`. */
  cfcReadOnExceed?: CfcReadOnExceed;
}

/** The validated, deep-frozen form a `Runtime` holds. */
export interface CfcReadCeiling {
  /** The ceiling, or `undefined` for none. */
  readonly maxConfidentiality: readonly CfcConfClause[] | undefined;

  /**
   * The mode a read falls back to when its query declares no `onExceed` of
   * its own, or `undefined` to leave the builtin's default in force.
   */
  readonly onExceed: CfcReadOnExceed | undefined;
}

/**
 * The names a refusal reports the two inputs under. A host validating the
 * same shape from another surface — a run manifest field, a command-line
 * flag — passes its own, so the refusal names the field the operator wrote.
 */
export interface CfcReadCeilingLabels {
  /** Name of the ceiling field; defaults to `cfcReadMaxConfidentiality`. */
  readonly ceiling?: string;

  /** Name of the mode field; defaults to `cfcReadOnExceed`. */
  readonly onExceed?: string;
}

// Detached and frozen to the leaves: an atom may be an object with nested
// values, and a nested alias the caller retained would otherwise mutate the
// runtime's effective ceiling after validation. `structuredClone` drops the
// aliases; the walk freezes every object and array the clone holds.
const deepFreeze = <T>(value: T): T => {
  if (isObjectOrArray(value)) {
    for (const inner of Object.values(value as Record<string, unknown>)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
};

const freezeClause = (clause: CfcConfClause): CfcConfClause =>
  typeof clause === "string" ? clause : deepFreeze(structuredClone(clause));

/**
 * Validates the read-ceiling options and returns the frozen form, or throws
 * on a malformed one so a configuration error surfaces at boot rather than
 * as a ceiling that silently admits nothing or everything.
 *
 * The shape rule is the memory package's `readCeilingShapeError`, the one
 * definition the wire's `SessionDescriptor.readCeiling` is held to as well,
 * so a ceiling this runtime accepts is one every server accepts. What this
 * adds is the frozen, detached copy a `Runtime` holds.
 *
 * @throws If either option is malformed, naming the field under `labels`.
 */
export function buildCfcReadCeiling(
  options: CfcReadCeilingOptions,
  labels: CfcReadCeilingLabels = {},
): CfcReadCeiling {
  const { cfcReadMaxConfidentiality: ceiling, cfcReadOnExceed: onExceed } =
    options;
  const error = readCeilingShapeError(ceiling, onExceed, {
    ceiling: labels.ceiling ?? "cfcReadMaxConfidentiality",
    onExceed: labels.onExceed ?? "cfcReadOnExceed",
  });
  if (error !== undefined) throw new Error(error);
  if (ceiling === undefined) {
    return Object.freeze({ maxConfidentiality: undefined, onExceed });
  }
  // Indexed rather than iterated with `forEach`/`map`: the shape check
  // refused every hole, so each index holds a clause.
  const clauses: CfcConfClause[] = [];
  for (let index = 0; index < ceiling.length; index++) {
    clauses.push(freezeClause(ceiling[index]));
  }
  return Object.freeze({
    maxConfidentiality: Object.freeze(clauses),
    onExceed,
  });
}

/**
 * A value withheld because its stored label exceeds the runtime read ceiling.
 */
export class CfcReadCeilingError extends Error {
  constructor() {
    super("the runtime read ceiling withholds this value");
    this.name = "CfcReadCeilingError";
  }
}

/**
 * Measures a payload read against its runtime ceiling before returning content.
 * Labels come from the stored envelope, including descendants of a raw object
 * read. A link-resolution probe issued inside dereference resolution or marked
 * as runtime wiring is machinery, as are write-destination and scheduler
 * dependency probes. A standalone link probe observes the pointer and is
 * measured here; the content read after resolution is measured at its target.
 */
export function assertCfcReadCeiling(
  tx: IExtendedStorageTransaction,
  address: IMemorySpaceAddress,
  ceiling: readonly CfcConfClause[] | undefined,
  options?: IReadOptions,
): void {
  const linkProbe = isLinkResolutionProbe(options?.meta);
  if (
    ceiling === undefined ||
    (address.path.length > 0 && address.path[0] !== "value") ||
    isInternalVerifierRead(options?.meta) ||
    isDereferenceResolutionProbe(options?.meta) ||
    (linkProbe && isMachineryRead(options?.meta)) ||
    isWriteDestinationRead(options?.meta) ||
    isSchedulerDependencyRead(options?.meta)
  ) return;
  const metadata = readStoredCfcMetadata(tx, address);
  let entries = cfcLabelViewFromMetadata(metadata, address.path)?.entries ?? [];
  if (linkProbe) {
    entries = entries.filter((entry) => readConsumesEntry("followRef", entry));
  } else if (address.path.at(-1) === "length") {
    const parentPath = address.path.slice(0, -1);
    // Only an array's native length observes its parent's membership. The
    // verifier probe distinguishes it from an ordinary object field without
    // exposing or consuming the parent's payload.
    const parent = tx.readOrThrow({ ...address, path: parentPath }, {
      meta: internalVerifierRead,
      nonRecursive: true,
    });
    if (Array.isArray(parent)) {
      const parentEntries = cfcLabelViewFromMetadata(metadata, parentPath)
        ?.entries ?? [];
      const membershipEntries = parentEntries.filter((entry) =>
        entry.path.length === 0 && readConsumesEntry("shape", entry)
      );
      const lengthEntries = rebaseCfcLabelView({
        version: 1,
        entries: parentEntries.filter((entry) => entry.path.length > 0),
      }, ["length"])?.entries ?? [];
      entries = [...membershipEntries, ...lengthEntries];
    }
  }
  const confidentiality = entries.flatMap((entry) =>
    entry.label.confidentiality ?? []
  );
  if (atomsOutsideCeiling(confidentiality, ceiling).length > 0) {
    throw new CfcReadCeilingError();
  }
}
