import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import type { Logger } from "@commonfabric/utils/logger";

import { type Cell, syncCellForIdentity } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import { markDurableReadTx } from "../storage/reactivity-log.ts";

/**
 * Seed a list coordinator's result container with `[]` once `pull` settles, if
 * the container is still absent at that point.
 *
 * A resume reconcile that reads an undefined container defers instead of
 * reconciling against a value that has not arrived, and pulls the container so
 * that the value's arrival re-triggers the reconcile. A container that was
 * never persisted has no value to arrive: the pull settles with the container
 * still undefined. The seed writes the empty array a fresh coordinator would
 * have written, so the next reconcile has a value to build on.
 *
 * The pull settling is what ends the deferring coordinator's wait: `rearm`
 * re-triggers its reconcile once this chain completes, whatever the container
 * turned out to hold. A seed that writes nothing — because the container's
 * durable value arrived, or was already there — leaves no notification behind,
 * and the coordinator deferred on a read that may disagree with the durable
 * view a write is decided against, so a wait that ended only on the write is a
 * wait that can never end.
 *
 * The seed belongs to the deferral that started it, so it writes to `container`
 * and to nothing else. `stillHeld` reports whether the coordinator is still
 * holding that same container: a coordinator that has been torn down holds
 * nothing, and one that has swapped in a replacement defers and seeds for the
 * replacement through its own reconcile, which is what confirms the
 * replacement's own state before anything writes to it.
 *
 * `stillHeld` is asked once before the transaction opens, so that a torn-down
 * coordinator does not reach into a runtime that is shutting down, and again
 * inside the transaction body, which `editWithRetry` re-runs per attempt after
 * awaiting a conflict's catch-up gate. A commit already in flight is beyond
 * either question, since `editWithRetry` takes no cancellation, so the window
 * that remains is the span between an attempt's writes and its commit
 * landing.
 *
 * The seed runs whether the pull resolved or rejected, because a rejected pull
 * leaves the container as absent as a resolved one does. A rejected pull and a
 * failed seed are each reported through `logger`. The returned promise resolves
 * once the pull and the seed have both settled, and rejects for neither.
 *
 * `seedActionId` names the seed's write for the server-run stamp. The seed is
 * an out-of-band recovery write (serving-loop.md §3d, RULED 2026-08-05):
 * minted outside any scheduler run, so nothing else stamps it, and a SERVING
 * runtime's wave refuses an unstamped seal — the seed would never land and
 * the demanded derivation stay wedged while `editWithRetry` burns on the
 * refusal (the lunch-gate throw storm). It is legitimate server work but
 * neither a derivation nor a handler run, so it is declared with the
 * sanctioned internal bookkeeping kind, like the pattern-swap setup write.
 * Stamped inside the transaction body so every retry's fresh transaction
 * carries it. A no-op on the OFF arm; under client speculation bookkeeping
 * commits exactly as unstamped txs do (the overlay routes only
 * derivation-kind runs).
 *
 * The seed reads the durable replica view. Its question is whether a value
 * has reached the store, and its own write is the value the deferral is
 * waiting for, so a client speculation layer standing on the container must
 * neither answer that question nor enter the commit's read basis: a basis
 * naming one of those layers is refused terminally (speculation.md §6), and
 * a refused seed strands the coordinator on a container that never arrives.
 * The mark excludes the process-local speculation layers alone, so a durable
 * in-flight layer still stands the seed down. A no-op on a serving runtime,
 * which holds no speculation overlay.
 *
 * The chain is registered with the storage manager's settle barrier, so
 * `Cell.pull()` and `storageManager.synced()` hold until the seed's write has
 * settled. The pull reaches that barrier through the replica's own sync
 * bookkeeping, and this registration carries the wait across the span between
 * the pull settling and the seed's commit being issued.
 * `Runtime.dispose({ closeStorage: false })` drains the runtime through
 * `settled(Infinity)` before it tears anything down, so the store a reader is
 * handed afterwards carries whatever the seed wrote. A caller does not register
 * the returned promise; this function registers the chain.
 *
 * `scopeKeyIdentity` carries the deferring run's viewing identity through the
 * asynchronous pull and each seed attempt, so scoped containers initialize the
 * instance whose absence caused the deferral.
 */
export function seedResultContainerWhenPullSettles(
  runtime: Runtime,
  container: Cell<any[]>,
  stillHeld: () => boolean,
  rearm: () => void,
  pull: Promise<unknown>,
  logger: Logger,
  seedActionId: string,
  identity?: ScopeKeyIdentity,
): Promise<void> {
  const seedIfStillAbsent = (): Promise<void> => {
    if (!stillHeld()) return Promise.resolve();
    return runtime.editWithRetry((seedTx) => {
      if (!stillHeld()) return;
      markDurableReadTx(seedTx);
      if (identity !== undefined) seedTx.tx.scopeKeyIdentity = identity;
      runtime.stampServerRun(seedTx, {
        actionId: seedActionId,
        kind: "bookkeeping",
        scopeKeyIdentity: identity,
      });
      const scoped = container.withTx(seedTx);
      if (scoped.getRaw() === undefined) scoped.set([]);
    }).then(({ error }) => {
      if (error) {
        logger.warn(
          "resume-seed",
          "seeding the empty result container failed",
          { error },
        );
      }
    });
  };
  const settled = pull.finally(seedIfStillAbsent).then(
    () => {},
    (error: unknown) => {
      logger.warn("resume-pull", "resume container pull rejected", { error });
    },
  ).finally(() => {
    if (stillHeld()) rearm();
  });
  runtime.storageManager.trackUntilSettled(settled);
  return settled;
}

/** One list coordinator's wait on its own result container. */
export interface ResumeContainerWait {
  /** Whether a reconcile holding `container` may wait for it. */
  mayWait(container: Cell<any[]>): boolean;

  /**
   * Wait for `container`: pull it, seed it when it is absent, and re-arm the
   * coordinator once both have settled. A call naming the container a wait is
   * already outstanding for joins that wait rather than starting a second one;
   * one naming a container whose wait has settled opens a wait of its own,
   * which is what a coordinator that let a container go and took it up again
   * takes.
   */
  begin(
    container: Cell<any[]>,
    stillHeld: () => boolean,
    rearm: () => void,
  ): void;
}

/**
 * The wait a resuming list coordinator takes on its result container, which it
 * takes once per container.
 *
 * The reconcile that reads an undefined container waits rather than reconcile
 * against a value that has not arrived, and {@link
 * seedResultContainerWhenPullSettles} re-arms the coordinator once the pull has
 * settled. The wait is over that one pull. The reconcile it re-arms reads the
 * container again, and when that read has not changed it has nothing further to
 * wait for: the pull it would start has already happened, and waiting on it
 * again is a cycle whose every turn leaves the list rendering nothing.
 *
 * A read that does not change is an ordinary state for a client running under
 * server-side execution. Such a client keeps its own writes in a process-local
 * speculation overlay, and a layer standing on the container's document that
 * carries no value for the container answers every ordinary read of it with
 * undefined while it stands. The seed reads the durable replica, so a container
 * another writer has filled stands it down, and what that container holds sits
 * beneath the layer where no read the coordinator takes reaches it. The value
 * such a coordinator can read comes from its own ordinary write, which lands
 * above the layer, so the reconcile after the wait is the one that produces it.
 *
 * `mayWait` is therefore asked before the container is read, and answers for
 * the container alone: a coordinator that swaps in a replacement waits for that
 * one as well, since a replacement's own state is what its first reconcile
 * confirms.
 */
export function resumeContainerWait(
  runtime: Runtime,
  logger: Logger,
  seedActionId: string,
  identity?: ScopeKeyIdentity,
): ResumeContainerWait {
  let outstanding: Cell<any[]> | undefined;
  let waited: Cell<any[]> | undefined;
  return {
    mayWait: (container) => waited !== container,
    begin: (container, stillHeld, rearm) => {
      if (outstanding === container) return;
      outstanding = container;
      const settled = seedResultContainerWhenPullSettles(
        runtime,
        container,
        stillHeld,
        () => {
          waited = container;
          rearm();
        },
        syncCellForIdentity(container, identity),
        logger,
        seedActionId,
        identity,
      );
      // The chain settles whether or not the coordinator was still holding the
      // container to re-arm, and a coordinator that was not is one this wait
      // told nothing. Releasing the container here is what lets it wait afresh
      // if it takes that same container up again, rather than join a wait
      // whose answer never reached it. The chain does not reject.
      settled.then(() => {
        if (outstanding === container) outstanding = undefined;
      });
    },
  };
}
