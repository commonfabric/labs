import {
  isUnavailable,
  UNAVAILABLE_PENDING,
} from "@commonfabric/data-model/availability";
import { cloneIfNecessary, type FabricValue } from "@commonfabric/data-model";

import type { CellScope, JSONSchema } from "../builder/types.ts";
import { type Cell, getCellWithStatus } from "../cell.ts";
import { selectDataUnavailable } from "../data-unavailability.ts";
import { toMemorySpaceAddress } from "../link-types.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { Runtime } from "../runtime.ts";
import type { Action } from "../scheduler.ts";
import { narrowestScope } from "../scope.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { toThrowable } from "../storage/interface.ts";
import {
  ignoreReadForCommit,
  ignoreReadForScheduling,
  internalVerifierRead,
  linkResolutionProbe,
} from "../storage/reactivity-log.ts";
import { scopedCell } from "./scope-policy.ts";

type LatestCompleteInputs = {
  value: unknown;
  schema: JSONSchema;
};

const priorSnapshotReadMeta = {
  ...ignoreReadForScheduling,
  ...ignoreReadForCommit,
  ...internalVerifierRead,
};

/**
 * Retain one whole, schema-materialized snapshot while the current input is
 * unavailable. Its one scoped result cell is the persisted snapshot.
 */
export function latestComplete(
  inputsCell: Cell<LatestCompleteInputs>,
  sendResult: (
    tx: IExtendedStorageTransaction,
    result: unknown,
  ) => void,
  _addCancel: (cancel: () => void) => void,
  cause: unknown,
  parentCell: Cell<unknown>,
  runtime: Runtime,
  outputBinding?: NormalizedFullLink,
): Action {
  if (outputBinding === undefined) {
    throw new Error("latestComplete requires an output binding");
  }

  let outputInitialized: boolean | undefined;
  let result: Cell<unknown> | undefined;
  let resultScope: CellScope | undefined;

  return (tx: IExtendedStorageTransaction) => {
    tx.resetNarrowestReadScope();
    const inputs = inputsCell.withTx(tx);
    const schema = inputs.key("schema").get() as JSONSchema | undefined;
    if (schema === undefined) {
      throw new TypeError("latestComplete requires a generated schema");
    }

    const source = inputs.key("value").asSchema(schema);
    const resolvedSource = source.resolveAsCell();
    const raw = tx.runWithAmbientReadMeta(
      linkResolutionProbe,
      () => resolvedSource.getRaw(),
    );

    let complete = false;
    let snapshot: unknown;
    if (isUnavailable(raw)) {
      // The topology probe above is deliberately non-consuming. Record the
      // actual marker read so the action is subscribed to its replacement.
      resolvedSource.getRaw();
    } else {
      const status = getCellWithStatus(source);
      if (
        "ok" in status && selectDataUnavailable(status.ok) === undefined
      ) {
        complete = true;
        snapshot = cloneIfNecessary(status.ok, { frozen: false });
      }
    }

    const outputScope = narrowestScope([
      outputBinding.scope,
      tx.getNarrowestReadScope(),
    ]);
    if (result === undefined || resultScope !== outputScope) {
      const base = runtime.getCell<unknown>(
        parentCell.space,
        { latestComplete: cause },
        schema,
        tx,
      );
      result = scopedCell(runtime, tx, base, outputScope);
      result.sync();
      resultScope = outputScope;
      outputInitialized = undefined;
    }
    sendResult(tx, result);

    if (outputInitialized === undefined) {
      const prior = tx.read(
        toMemorySpaceAddress(result.getAsNormalizedFullLink()),
        {
          meta: priorSnapshotReadMeta,
        },
      );
      if (prior.error !== undefined && prior.error.name !== "NotFoundError") {
        throw toThrowable(prior.error);
      }
      outputInitialized = prior.ok !== undefined;
    }

    if (complete) {
      result.withTx(tx).setRawUntyped(snapshot as FabricValue, true);
      outputInitialized = true;
    } else if (!outputInitialized) {
      result.withTx(tx).setRawUntyped(UNAVAILABLE_PENDING, true);
      outputInitialized = true;
    }
  };
}
