import { internSchema } from "@commonfabric/data-model-schema";
import {
  type FabricPlainObject,
  type FabricValue,
  hashStringOf,
  isFabricPlainObject,
} from "@commonfabric/data-model";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import { stripUndefinedProps } from "@commonfabric/utils/strip-undefined-props";

import type { Schema } from "../builder/types.ts";
import { type Cell } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
} from "../storage/interface.ts";
import { markEffectCompletion } from "../executor/effect-completion.ts";

/**
 * How long a claimed request mutex is believed before another replica may take
 * it over.
 *
 * This is not a bound on the request. A request issued here ends when its
 * promise settles or its AbortSignal fires, and `fetch.ts` decides from its own
 * state, not from the clock, whether it already has one in flight. The only
 * reader is a replica that finds a claim it did not make and has to decide
 * whether the replica that made it is still there. Nothing in the runner
 * reports another replica's presence, so that question has no event to wait on
 * and a staleness bound is the only answer available.
 *
 * The value is left where it was. Once an early takeover no longer costs a
 * result, the size is a trade with a cost on both sides: too low sends a second
 * copy of the request to the remote peer whenever another replica looks in
 * while one is running, too high leaves a replica that arrives before the bound
 * elapses looking at a claim it will not take over and has no reason to
 * re-examine, so the piece keeps showing a spinner. A duplicate request is
 * wasted work; a spinner that never resolves is a dead end, so the trade goes
 * to the lower value. A caller whose endpoint is slow enough that duplicates
 * matter raises its own bound with `options.mutexTimeoutMs`.
 *
 * `docs/features/fetch-request-deadlines.md` records why this bound stays
 * and what an early takeover costs.
 */
export const MUTEX_STALE_AFTER = 1000 * 5;

export const internalSchema = internSchema(
  {
    type: "object",
    properties: {
      requestId: { type: "string", default: "" },
      lastActivity: { type: "number", default: 0 },
      inputHash: { type: "string", default: "" },
    },
    default: {},
    required: ["requestId", "lastActivity", "inputHash"],
  },
);

/**
 * Computes a stable string hash of fetch-style inputs, suitable for use as
 * a comparison key (e.g. an idempotency key or mutex identifier).
 *
 * Two normalizations are applied before hashing:
 *
 * (1) The top-level `result` property and `options.mutexTimeoutMs` property
 *     are dropped. `result` exists only as a TypeScript type hint at call
 *     sites, and `mutexTimeoutMs` is a local scheduling knob. Neither is a
 *     real fetch parameter, so neither must influence the hash.
 *
 * (2) `undefined`-valued object properties are dropped, recursively.
 *     Callers commonly materialize snapshots via unconditional object
 *     construction (e.g. `{ url, mode, options }`, or one level deeper
 *     `{ method, body }`), and the resulting hash needs to be the same
 *     regardless of whether an absent field is omitted entirely or
 *     present-but-`undefined`. The `FabricValue` layer preserves
 *     `undefined`-valued properties, so this function must do the
 *     JSON-style normalization itself.
 *
 * `hashStringOf()` itself is happy to hash `undefined` values; no
 * normalization for hashability per se is needed.
 */
export function computeInputHashFromValue(
  inputs: FabricPlainObject | undefined,
): string {
  const { result: _result, ...rest } = inputs ?? {};
  const inputsOnly: Record<string, FabricValue> = { ...rest };
  const options = inputsOnly.options;
  if (isFabricPlainObject(options)) {
    const { mutexTimeoutMs: _mutexTimeoutMs, ...requestOptions } = options;
    const normalizedOptions = stripUndefinedProps(requestOptions);
    if (Object.keys(normalizedOptions).length > 0) {
      inputsOnly.options = normalizedOptions;
    } else {
      delete inputsOnly.options;
    }
  }
  return hashStringOf(stripUndefinedProps(inputsOnly));
}

/**
 * Attempts to claim the mutex for a request. Only claims if no other request
 * is active, or if the standing claim was made longer than `timeout` ago and is
 * therefore treated as abandoned (see {@link MUTEX_STALE_AFTER}). Claiming sets
 * pending=true and records the claim in `internal`; the caller clears
 * result/error to maintain the invariant that result/error are undefined while
 * pending.
 */
export async function tryClaimMutex<T extends FabricPlainObject>(
  runtime: Runtime,
  inputsCell: Cell<T>,
  pending: Cell<boolean>,
  result: Cell<any>,
  error: Cell<any>,
  internal: Cell<Schema<typeof internalSchema>>,
  requestId: string,
  snapshotInputs: (cell: Cell<T>) => T,
  expectedInputHash?: string,
  timeout: number = MUTEX_STALE_AFTER,
  /** The served-effect key this claim belongs to (the PER-TARGET
   * outbox key — executor/effect-completion.ts `effectTargetKey`,
   * `${kind}:${hash}@<result-cell id>`). Marks the write as an
   * effect-completion-class transaction under the serving posture
   * (server-execution v2 stage G, serving-loop.md §4); inert
   * everywhere else. */
  effectKey?: string,
  /** Identity captured by the requesting served run. */
  identity?: ScopeKeyIdentity,
): Promise<{
  claimed: boolean;
  inputs: T;
  inputHash: string;
}> {
  let claimed = false;
  let inputHash = "";
  let inputs = {} as T;

  // Wait for all pending computeds to settle before reading inputs.
  // Without this, computed inputs (e.g. options) may still be undefined
  // on the first run because the scheduler hasn't evaluated them yet.
  await runtime.idle();

  await runtime.editWithRetry((tx) => {
    if (identity !== undefined) tx.tx.scopeKeyIdentity = identity;
    const currentInternal = internal.withTx(tx).get();
    const isPending = pending.withTx(tx).get();
    const now = Date.now();
    // A completed request needs no claim: when the stored hash already
    // matches the expected inputs AND a result (or error-shaped result)
    // landed, the memo hit rule makes the stored value THE value
    // (server-execution v2 stage G, serving-loop.md §4). This closes
    // the deferred-flush window the serving posture opens: effects fire
    // POST-wave-commit there, so an action re-run reading a stale
    // snapshot can re-enqueue a key whose first effect has ALREADY
    // completed and retired from the outbox's in-flight set — without
    // this check the late claim would clear the result and re-fetch.
    // Client-side the same check only skips a redundant cross-tab
    // refetch in a race corner (inline flushing makes the in-process
    // ordering already safe there).
    if (
      expectedInputHash !== undefined &&
      currentInternal.inputHash === expectedInputHash &&
      (result.withTx(tx).get() !== undefined ||
        error.withTx(tx).get() !== undefined)
    ) {
      claimed = false;
      inputs = snapshotInputs(inputsCell.withTx(tx));
      inputHash = computeInputHashFromValue(inputs);
      return;
    }

    // The caller-provided snapshotInputs receives the cell with the active
    // transaction attached. It uses cell.asSchema(...).get() to materialize
    // a plain snapshot via the schema system, then does any additional
    // preprocessing (e.g. stringifying request bodies).
    inputs = snapshotInputs(inputsCell.withTx(tx));
    // Hash the snapshot (plain object) to avoid proxy/undefined issues
    // from partially-initialized reactive inputs.
    inputHash = computeInputHashFromValue(inputs);
    if (expectedInputHash !== undefined && inputHash !== expectedInputHash) {
      claimed = false;
      return;
    }
    // Can claim if:
    // 1. Nothing is pending, OR
    // 2. The standing claim has gone stale and is treated as abandoned
    const canClaim = !isPending ||
      (currentInternal.lastActivity < now - timeout);

    if (canClaim) {
      // Marked HERE, on the arm that writes — not at the callback top:
      // the no-write arms (completed-request short-circuit, hash
      // mismatch, claim held elsewhere) would otherwise commit as
      // spurious all-no-op effect-completion transactions under
      // serving (stage-G round 2, the thread-6/-12 shape). The marker
      // still precedes every write of this arm, which is the
      // markEffectCompletion contract.
      if (effectKey !== undefined) markEffectCompletion(tx, effectKey);
      pending.withTx(tx).set(true);
      // The served claim is authoritative. Its request hash must travel with
      // the claim even when an optimistic derivation already shows that hash.
      internal.withTx(tx).update({
        requestId,
        lastActivity: now,
        ...(identity !== undefined ? { inputHash } : {}),
      });
      claimed = true;
    } else {
      claimed = false;
    }
  });

  return { claimed, inputs, inputHash };
}

/**
 * Performs a mutation if the inputs haven't changed. This allows any tab
 * to write the result as long as the inputs are still the same.
 *
 * The two "did not write" shapes are DISTINCT for the caller (stage-G
 * round 2, thread 4): `written: false` with no `commitError` means the
 * inputs moved — the request was SUPERSEDED and the new inputs' own
 * request owns the cells, nothing to do. `commitError` present means
 * the writeback's COMMIT failed after retries — the claim is still
 * durably pending and this call was its only completion, so the caller
 * must not treat the effect as fulfilled (fetch.ts converts it into an
 * error-shaped result, or propagates when even that cannot commit).
 */
export async function tryWriteResult<T extends FabricPlainObject>(
  runtime: Runtime,
  internal: Cell<Schema<typeof internalSchema>>,
  inputsCell: Cell<T>,
  expectedHash: string,
  action: (tx: IExtendedStorageTransaction) => void,
  snapshotInputs?: (cell: Cell<T>) => T,
  /** See {@link tryClaimMutex}'s `effectKey`. */
  effectKey?: string,
  /** Identity captured by the requesting served run. */
  identity?: ScopeKeyIdentity,
): Promise<{ written: boolean; commitError?: CommitError }> {
  let success = false;
  const committed = await runtime.editWithRetry((tx) => {
    if (identity !== undefined) tx.tx.scopeKeyIdentity = identity;
    if (effectKey !== undefined) markEffectCompletion(tx, effectKey);
    const inputs = snapshotInputs
      ? snapshotInputs(inputsCell.withTx(tx))
      : inputsCell.getAsQueryResult([], tx);
    const currentHash = computeInputHashFromValue(inputs);

    // Only write if inputs haven't changed since we started the request
    if (currentHash === expectedHash) {
      action(tx);
      internal.withTx(tx).update({ inputHash: currentHash });
      success = true;
    }
  });
  if (committed.error !== undefined) {
    return { written: false, commitError: committed.error };
  }
  return { written: success };
}
