import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import type { Logger } from "@commonfabric/utils/logger";

import type { JSONSchema } from "../builder/types.ts";
import { type Cell, syncCellForIdentity } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import {
  linkResolutionProbe,
  machineryRead,
} from "../storage/reactivity-log.ts";
import type { ElementRun } from "./list-element-rollback.ts";
import { cellIdentityKey } from "./scope-policy.ts";

type ElementRuns = Map<string, ElementRun>;

/**
 * The run-context kind for a list builtin's out-of-band resume-SETTLE
 * write (map/filter/flatMap's `awaitInputThenSettle`), shared so the
 * three builtins cannot drift (review thread r3756175819):
 *
 * - SERVING posture: `bookkeeping` — the sanctioned internal kind
 *   (serving-loop.md §3d, RULED 2026-08-05), so the wave admits the
 *   recovery write instead of refusing an unstamped seal.
 * - Everything else (flag-ON clients included): `derivation` — the
 *   settle writes DERIVED content (result := f(input)), and on a
 *   client that must divert to the speculation overlay like any other
 *   derivation. Stamped `bookkeeping` it committed authored-class — a
 *   by-construction violation of the client derivation-commit removal.
 *   (On the OFF arm the stamp is a no-op either way.)
 *
 * The resume-SEED stays `bookkeeping` on both postures: materializing
 * the empty result container is setup/instantiation-class work under
 * the scheduler tell (protocol.md §1), not derived content.
 */
export const resumeSettleRunKind = (
  runtime: Runtime,
): "bookkeeping" | "derivation" =>
  runtime.servingPosture ? "bookkeeping" : "derivation";

/**
 * Decide what one element contributes to the rebuilt aggregate. `value` is the
 * element's per-element result (a predicate boolean for filter, a result value
 * or array for flatMap); `inputElement` is the corresponding input list entry.
 * Append the contribution to `out`, or return "pending" if the element's result
 * has not arrived yet. A present-but-undefined value that the builtin treats as
 * a settled exclusion contributes nothing and is not pending.
 */
export type ElementContribution = (
  value: unknown,
  inputElement: unknown,
  out: any[],
) => "pending" | void;

export interface ResumeRepublisher {
  /**
   * Whether this coordinator is still waiting for the given element result
   * document. A reconcile does not write an element's setup while its result
   * is in that state: the document has not caught up, so the transaction
   * carrying the setup is rejected as stale, and the retry that follows reads
   * the same document and is rejected the same way.
   */
  awaitingResult(cell: Cell<any>): boolean;

  /**
   * Hold the durable aggregate while the given still-pending element result
   * cells confirm their docs, then rebuild and write it. The entry point; the
   * republish it schedules re-defers any straggler and calls back in.
   */
  awaitPendingThenRepublish(cells: Cell<any>[], awaited?: Set<string>): void;
}

export interface ResumeRepublisherOptions {
  runtime: Runtime;
  logger: Logger;

  /**
   * False once the coordinator is torn down. A republish outstanding at that
   * moment has a container nothing owns any more, so it is dropped rather than
   * written.
   */
  isActive: () => boolean;

  /**
   * The result container is bound after the builtin's setup, so it is read
   * lazily on each republish rather than captured once.
   */
  getResult: () => Cell<any[]> | undefined;

  /** Resolution identity shared by this coordinator's deferred work. */
  identity?: ScopeKeyIdentity;

  inputsCell: Cell<any>;
  inputSchema: JSONSchema;
  resultSchema: JSONSchema;
  elementRuns: ElementRuns;
  contribute: ElementContribution;

  /** The aggregate's noun for logs, e.g. "filtered list" / "flatMap result". */
  aggregateNoun: string;

  /** The per-element noun for logs, e.g. "predicate" / "result". */
  elementNoun: string;

  /**
   * Re-arm the coordinator's reconcile. Only a reconcile can issue an owed
   * element setup (`needsSetup`), and it declines to while that element's
   * result is being awaited. A republish chain that ends by confirming the
   * document ABSENT writes nothing the reconcile journals — this callback is
   * the only remaining trigger, so without it the owed setup would never be
   * issued and the element would stay out of the aggregate.
   */
  rearmReconcile: () => void;
}

/**
 * Shared resume-preservation machinery for the list builtins that rebuild an
 * aggregate from per-element results (filter, flatMap). map does not use it: its
 * output is link-shaped and never holds element values to reconcile.
 *
 * On a resume reconcile the durable aggregate is held while the per-element
 * results stream in. Once their docs confirm, the aggregate is rebuilt from the
 * settled results and written. The only per-builtin variation is how each
 * element maps to its contribution, supplied as `contribute`; everything else —
 * the element-identity keying, the straggler re-defer, and the convergence
 * bookkeeping — is the same.
 *
 * `awaited` holds the ids of result cells whose sync has already resolved in
 * this republish chain. An undefined result in that set has settled (the builtin
 * excludes or skips it — convergence), while an undefined result not in it is
 * still streaming in, for example a child mid-revert that read a value at defer
 * time and so was never in the pending set. Rather than write a partial shrink,
 * those stragglers are returned to be re-awaited before republishing.
 */
export function createResumeRepublisher(
  opts: ResumeRepublisherOptions,
): ResumeRepublisher {
  const {
    runtime,
    logger,
    isActive,
    getResult,
    inputsCell,
    inputSchema,
    identity,
    resultSchema,
    elementRuns,
    contribute,
    aggregateNoun,
    elementNoun,
    rearmReconcile,
  } = opts;

  // The element results this coordinator is waiting on, by document id. An
  // entry lasts exactly as long as the sync it holds.
  const waiting = new Map<string, Promise<unknown>>();

  // Wait for one element result document, sharing a wait already in progress
  // for it. Re-syncing a document the coordinator is already waiting on would
  // leave two entries racing to clear one id.
  const waitFor = (cell: Cell<any>): Promise<unknown> => {
    const id = cell.getAsNormalizedFullLink().id;
    const inFlight = waiting.get(id);
    if (inFlight) return inFlight;
    const sync = syncCellForIdentity(cell, identity).finally(() => {
      if (waiting.get(id) === sync) waiting.delete(id);
    });
    waiting.set(id, sync);
    return sync;
  };

  const awaitingResult = (cell: Cell<any>): boolean =>
    waiting.has(cell.getAsNormalizedFullLink().id);

  const republishFromConfirmed = (awaited: Set<string>): Promise<void> =>
    runtime.editWithRetry((tx): Cell<any>[] => {
      if (identity !== undefined) tx.tx.scopeKeyIdentity = identity;
      const result = isActive() ? getResult() : undefined;
      if (!result) return [];
      // Out-of-band recovery write (serving-loop.md §3d, RULED
      // 2026-08-05): the republish runs from a raw promise chain under
      // trackUntilSettled — no scheduler run stamps it, and a SERVING
      // runtime's wave refuses unstamped seals. Same bookkeeping stamp
      // as the list builtins' resume-seed/settle writes.
      runtime.stampServerRun(tx, {
        actionId: `list-republish/${result.sourceURI}`,
        kind: "bookkeeping",
        scopeKeyIdentity: identity,
      });
      const inputs = inputsCell.asSchema(inputSchema).withTx(tx).get() as {
        list?: unknown;
      };
      const list = inputs?.list;
      if (!Array.isArray(list)) return [];
      const keyCounts = new Map<string, number>();
      const out: any[] = [];
      const stillPending: Cell<any>[] = [];
      for (let i = 0; i < list.length; i++) {
        if (!(i in list)) continue;
        const { dedupKey, linkKey } = cellIdentityKey(list[i]);
        const occurrence = keyCounts.get(dedupKey) ?? 0;
        keyCounts.set(dedupKey, occurrence + 1);
        const elementKey = JSON.stringify([...linkKey, occurrence]);
        const entry = elementRuns.get(elementKey);
        if (!entry) continue;
        const value = entry.resultCell.withTx(tx).get();
        if (
          contribute(value, list[i], out) === "pending" &&
          !awaited.has(entry.resultCell.getAsNormalizedFullLink().id)
        ) {
          stillPending.push(entry.resultCell);
        }
      }
      if (stillPending.length > 0) return stillPending;
      // The element reads above are real content reads (the aggregate genuinely
      // depends on them, so they taint J). The container write only diffs prior
      // slots for identity, so it runs under the link-resolution probe (S16) to
      // avoid re-journaling prior element content — matching map/filter/flatMap.
      tx.runWithAmbientReadMeta(
        { ...linkResolutionProbe, ...machineryRead },
        () => result.asSchema(resultSchema).withTx(tx).set(out),
      );
      return [];
    }).then(({ ok, error }) => {
      if (error) {
        logger.warn(
          "resume-republish",
          `republishing the ${aggregateNoun} failed`,
          { error },
        );
        return;
      }
      if (ok && ok.length > 0) {
        awaitPendingThenRepublish(ok, awaited);
        return;
      }
      // The chain has settled, but an element may still owe its setup: a
      // reconcile declines to issue one while that element's result is being
      // awaited, and this chain's confirmations may have written nothing the
      // reconcile journals (a document confirmed absent republishes an
      // unchanged aggregate). The waits are over now, so a reconcile CAN
      // issue it — re-arm one, or the element stays out of the aggregate
      // with no trigger left.
      if (isActive()) {
        for (const entry of elementRuns.values()) {
          if (entry.needsSetup) {
            rearmReconcile();
            break;
          }
        }
      }
    });

  // Hold the durable aggregate while the still-pending elements confirm their
  // docs, then republish. Each element's sync resolves whether its value arrives
  // or its doc is confirmed absent, so the republish runs against settled state.
  // Using sync as an async confirmation, not a read-time guess, is the
  // load-bearing distinction here. `awaited` accumulates the confirmed ids across
  // a chain of re-awaits, so a straggler found at republish time is awaited too
  // and a settled-undefined element is honored once rather than awaited forever.
  const awaitPendingThenRepublish = (
    cells: Cell<any>[],
    awaited: Set<string> = new Set<string>(),
  ): void => {
    if (!isActive()) return;
    for (const c of cells) awaited.add(c.getAsNormalizedFullLink().id);
    runtime.storageManager.trackUntilSettled(
      Promise.all(cells.map(waitFor))
        .then(() => republishFromConfirmed(awaited))
        .catch((error) =>
          logger.warn(
            "resume-republish",
            `a pending ${elementNoun} sync rejected`,
            { error },
          )
        ),
    );
  };

  return { awaitingResult, awaitPendingThenRepublish };
}
