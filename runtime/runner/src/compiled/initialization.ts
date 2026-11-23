/**
 * What a compiled piece records with the runtime for a value it installs
 * where none was, which the commit preparation reads as an initialization
 * (CFC specification §8.15.4, `08-15-write-authority.md`, "Seeding a new
 * cell": "A cell created with a default materializes its seed value. The
 * value, its schema, and its label envelope commit together").
 *
 * The record is evidence of the runtime's own and decides nothing here: the
 * preparation honors it only with the runtime's mark, for a slot that was
 * absent before the transaction and that ends the transaction holding the
 * recorded value (`writeIsRuntimeInitialization` in `cfc/prepare.ts`).
 */
import type { FabricValue } from "@commonfabric/data-model";

import { runtimeWritePolicyAuthorization } from "../cfc/types.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { PlanWrite } from "../../../../base/pattern-compiler/exec/plan-write.ts";
import {
  canonical,
  type Schema,
} from "../../../../base/pattern-compiler/exec/store.ts";

/**
 * Whether the first write of a document of the executor is the first value
 * of a state cell: the write is of the whole document of a state cell, and
 * either a write record names the first value the plan computes for the cell
 * (`stateFirst`), or the value is the default the schema of the write
 * declares, which is the first value of a cell whose first value is a
 * constant.
 */
export const isStateCellSeed = (
  document: { kind: string; value: unknown },
  path: readonly string[],
  schema: Schema | undefined,
  writes: readonly PlanWrite[] | undefined,
): boolean => {
  if (document.kind !== "state cell" || path.length !== 0) return false;
  if (writes?.some(({ record }) => "stateFirst" in record)) return true;
  return typeof schema === "object" && schema !== null &&
    schema.default !== undefined &&
    canonical(schema.default) === canonical(document.value);
};

/**
 * Records with the runtime that `tx` installs `value`, the first value of a
 * state cell, at the root of the absent document at `target`.
 */
export const recordStateCellSeed = (
  tx: IExtendedStorageTransaction,
  target: NormalizedFullLink,
  value: FabricValue,
): void => {
  tx.recordCfcWritePolicyInput({
    kind: "initialization",
    mode: "seed",
    target: {
      space: target.space,
      id: target.id,
      scope: target.scope,
      path: [],
    },
    value,
  }, runtimeWritePolicyAuthorization);
};
