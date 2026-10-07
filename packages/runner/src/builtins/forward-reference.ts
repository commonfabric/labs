/**
 * The action shared by the builtins that select one of their inputs by the
 * truthiness of a condition and forward a reference to it: `ifElse`, `when`
 * and `unless`.
 */

import { type Cell } from "../cell.ts";
import { resolveLink } from "../link-resolution.ts";
import { parseLink } from "../link-utils.ts";
import { type RawNodeCause } from "../module.ts";
import { type Runtime } from "../runtime.ts";
import { type Action } from "../scheduler.ts";
import { readsTruthyAtRoot } from "../schema.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { ownedCell } from "./runtime-owned-store.ts";
import { ownedResultCause } from "./scope-policy.ts";

/** What a forwarding builtin's action is built from. */
export interface ForwardReferenceOptions {
  /** The builtin's name, which keys the result cell it owns. */
  name: Parameters<typeof ownedResultCause>[0];

  /**
   * The builtin's inputs. `condition` decides; the rest are the positions the
   * action selects among.
   */
  inputsCell: Cell<any>;

  /** Publishes the result cell as the node's output. */
  sendResult: (tx: IExtendedStorageTransaction, result: Cell<any>) => void;

  /** The node's cause, which the result cell's cause derives from. */
  cause: RawNodeCause;

  /** The cell the node runs under, which the result cell is owned by. */
  parentCell: Cell<any>;

  /** The runtime the node runs in, which resolves links and mints cells. */
  runtime: Runtime;

  /** The input the action forwards, given the condition's truthiness. */
  select: (truthy: boolean) => string;
}

/**
 * Builds the action of a forwarding builtin. The action reads the condition's
 * truthiness from its root alone, so nothing below the root of a condition
 * that is a record or an array is read, and writes into the result cell a
 * reference to the selected input's resolved target.
 *
 * The reference carries the schema that target resolved to. That schema is
 * what says what the position is — a stream, which holds no value, or a value
 * whose `default` the target does not hold — and a reader following the
 * reference to its document would otherwise find nothing that does. At the
 * crossing, a reader's own schema stands and inherits the nearest declared
 * default, so a default declared on the selected input reaches a reader of
 * the result without the result's schema declaring one. A schema that
 * constrains nothing is left out of the reference.
 */
export function forwardReferenceAction(
  options: ForwardReferenceOptions,
): Action {
  const { name, inputsCell, sendResult, cause, parentCell, runtime, select } =
    options;
  return (tx: IExtendedStorageTransaction) => {
    // The condition is read at the link it resolves to, which carries the
    // schema a stored link to it declares, so its truthiness is decided under
    // that schema: a default stands in for an absent value, and a stored value
    // the schema refuses at the root is `false`.
    const resolvedCondition = resolveLink(
      runtime,
      tx,
      inputsCell.key("condition").getAsNormalizedFullLink(),
    );
    // Keyed on the output spot, never on the inputs document: every runtime
    // sharing the piece must mint this one store, whatever its vintage
    // serializes the inputs as (see `ownedResultCause`).
    const result = ownedCell<any>(
      runtime,
      tx,
      parentCell,
      ownedResultCause(name, cause, parentCell),
      undefined,
      resolvedCondition.scope,
    );
    sendResult(tx, result);

    const truthy = readsTruthyAtRoot(runtime, tx, resolvedCondition);
    const ref = inputsCell.withTx(tx).key(select(truthy)).getAsLink({
      base: result,
    });
    const resolvedRef = resolveLink(runtime, tx, parseLink(ref, result));
    const serializedRef = runtime.getCellFromLink(resolvedRef).getAsLink({
      base: result,
      includeSchema: true,
    });
    // A run that selects the reference already written writes nothing, so a
    // condition changing between two truthy values does not re-trigger
    // downstream work.
    result.withTx(tx).setRawUntyped(serializedRef, true);
  };
}
