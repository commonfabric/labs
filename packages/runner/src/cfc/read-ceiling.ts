/**
 * The runtime-wide read ceiling: a confidentiality ceiling every `db.query`
 * the runtime issues reads under, whether or not the query declares one of
 * its own. Declared through `RuntimeOptions.cfcReadMaxConfidentiality` and
 * `cfcReadOnExceed`, validated and frozen here at construction.
 *
 * A pattern can declare a per-query ceiling, but the only carrier a pattern
 * can read is a cell in the space, which every runtime on the space shares.
 * A ceiling that has to differ per runtime — a per-device lens, a per-run
 * clearance — therefore cannot live in a pattern's inputs. It lives on the
 * runtime, and the query builtin meets it with whatever the query declares,
 * so the query can tighten the runtime's ceiling and never widen it.
 */

import { readCeilingShapeError } from "@commonfabric/memory/v2";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { CfcConfClause } from "./clause.ts";

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
