import {
  effectIntentNonce,
  SERVER_EXECUTION_EFFECTS_DOC_ID,
} from "@commonfabric/memory/v2";
import { type Cell, createCell } from "../cell.ts";
import { type Action, ignoreReadForScheduling } from "../scheduler.ts";
import { type RawBuiltinResult } from "../module.ts";
import { type Runtime } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { mergeableOpRead } from "../storage/reactivity-log.ts";
import { waveRunContextOf } from "../executor/wave.ts";
import { speculationRunContextOf } from "../speculation/overlay-destination.ts";
import { navigateEventContextOf } from "./navigate-context.ts";
import { getLogger } from "@commonfabric/utils/logger";

const logger = getLogger("navigate-to", { enabled: true, level: "warn" });

export function navigateTo(
  inputsCell: Cell<any>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): RawBuiltinResult {
  let isInitialized = false;
  let navigated = false;
  let navigationAttempt = 0;
  let resultCell: Cell<boolean>;
  let resultDocId: string | undefined;
  const targetCellSchema = {
    type: "object",
    properties: {},
    asCell: ["cell"],
  } as const;

  const action: Action = (tx: IExtendedStorageTransaction) => {
    // A SERVED run never consults the `navigated` closure state
    // (independent review M2, 2026-08-11): the running builtin instance
    // and its closure are REUSED across a wave requeue (runner.ts's
    // `Runner.#startWithTx()` cancels-guard), so closure state would suppress
    // the re-issue a requeued event's wave-2 re-run owes — the handler's
    // consequences re-landed while the intent stayed lost forever.
    // Store-derived state governs the served arm instead: the
    // result-cell read below returns a LANDED navigation early (and a
    // withdrawn intent reads false, so the re-run re-issues), and the
    // ENGINE's stored-nonce dedupe makes any re-issue idempotent
    // (protocol.md §5). The served path also never writes the result
    // cell on the wave tx — re-setting it here would ride the
    // derivation-stamped wave tx and resolve against the wave-level
    // SERVICE identity, the silent-empty-instance shape protocol.md §2
    // names; the intent tx owns the acting-instance result write.
    const servedRun = runtime.experimental.serverExecution === true &&
      waveRunContextOf(tx) !== undefined;
    // The main reason we might be called again after navigating is that the
    // transaction to update the result cell failed, so we'll just set it again.
    if (navigated && !servedRun) {
      resultCell?.withTx(tx).set(true);
      return;
    }

    // Initialize the result cell if it hasn't been initialized yet.
    if (!isInitialized) {
      const baseResultCell = runtime.getCell<any>(
        parentCell.space,
        { navigateTo: { result: cause } },
        { type: "boolean" },
        tx,
      );
      const baseLink = baseResultCell.getAsNormalizedFullLink();
      // The navigateTo INSTANCE identity (server-execution v2 Phase 4,
      // protocol.md §5): cause-derived, so the client's speculative
      // instantiation and the server's authoritative one converge on the
      // same id (speculation.md §2) — which is what makes the
      // deterministic nonce below converge too.
      resultDocId = baseLink.id;
      resultCell = createCell(
        runtime,
        {
          ...baseLink,
          scope: "session",
        },
        tx,
      );

      resultCell.sync();

      sendResult(tx, resultCell);

      isInitialized = true;
    }

    // If the result cell is already true, we've already navigated.
    if (resultCell.withTx(tx).get()) return;

    // Read with a schema that won't subscribe to the whole piece
    const inputsWithLog = inputsCell.asSchema(targetCellSchema).withTx(tx);
    const target = inputsWithLog.get();

    // Pattern creation can yield a navigable cell before every reactive
    // dependency has materialized its value. The cell identity is enough for
    // navigation; requiring a current value can block valid piece targets.
    if (!target) return;

    // Server-execution v2 Phase 4 (protocol.md §5, builtins.md §4):
    // under the flag, navigateTo is the SPLIT contract. The SERVED half
    // (a wave-stamped run) computes the target and writes the intent into
    // the firing session's effects INSTANCE; the CLIENT half of a flag-ON
    // runtime enacts OPTIMISTICALLY under the speculation overlay,
    // carrying the same deterministic nonce the authoritative intent
    // arrives with. The OFF arm falls through to today's path unchanged —
    // target RESOLUTION stays inside each arm so the OFF path keeps
    // today's exact order (navigateCallback check before resolve).
    if (runtime.experimental.serverExecution === true) {
      if (servedRun) {
        servedNavigate(tx, target);
        return;
      }
      if (speculationRunContextOf(tx) !== undefined) {
        optimisticNavigate(tx, target);
        return;
      }
      // Neither stamp: an unstamped flag-ON run (not a scheduler run —
      // defensive). Fall through to today's path.
    }

    legacyNavigate(tx, target);
  };

  /** The SERVED half (builtins.md §4): compute the target, write the §5
   * intent entry into the ACTING session's effects instance — addressed
   * by the seal-time annotations of an event-handler-stamped
   * transaction whose `scopeKeyIdentity` is the event's server-stamped
   * actor — and set the (session-scoped) result cell in the same
   * transaction. No local enactment: the session's client enacts. */
  function servedNavigate(
    _tx: IExtendedStorageTransaction,
    target: Cell<any>,
  ): void {
    const context = navigateEventContextOf(action);
    if (context === undefined) {
      // No event context: either a navigateTo computed OUTSIDE the
      // consequences of a client-fired event (pure-derivation
      // navigation has no session to address), or a RE-INSTANTIATED
      // builtin from a past fire re-running after a restart/re-demand
      // (its navigation already happened; the durable intent entry and
      // the client-side LT8 journey own any re-enactment). The two are
      // indistinguishable here — the tag lives with the instantiating
      // run — and builtins.md §4 classifies the no-context run with
      // the sessionless chain as the SAME runtime ERROR ("Enforce with
      // a runtime check"), so this arm THROWS like the sessionless and
      // LT3 arms below (owner review P1, 2026-08-12 — the earlier
      // warn-and-return was a spec deviation). The error is charged to
      // the run; the wave is not wedged; no intent is written. A
      // re-instantiated past instance surfaces the same loud error —
      // the acknowledged cost of the ruling; nothing further is lost
      // (its navigation already happened).
      throw new Error(
        "navigateTo refused: no firing-event context — navigateTo must " +
          "be reachable only from the consequences of a client-fired " +
          "event (builtins.md §4); a re-instantiated instance whose " +
          "navigation already happened re-runs into this same error " +
          "harmlessly",
      );
    }
    const acting = context.acting;
    if (acting?.session === undefined) {
      // A sessionless chain (`firedAt.session = "server"` — a
      // derivation-emitted event, a timer) has no client to enact:
      // the SAME runtime error as the sessionless session-scoped write
      // (builtins.md §4; events.md §2; scopes.md §5).
      throw new Error(
        "navigateTo requires an acting SESSION: the event chain is " +
          'sessionless (firedAt.session = "server"), so no client ' +
          "exists to enact the navigation (builtins.md §4)",
      );
    }
    if (
      runtime.connectedSessionProbe !== undefined &&
      !runtime.connectedSessionProbe(acting.user, acting.session)
    ) {
      // LT3 (RULED 2026-08-03): the intent write requires the acting
      // session to be a CONNECTED session of the COMPUTING space — a
      // space the client holds no connection to has no channel to
      // deliver the intent on. Cross-space navigateTo is DEFERRED; the
      // recorded future direction is the client-vended stream target
      // (builtins.md §4).
      throw new Error(
        `navigateTo refused: acting session ${acting.session} is not a ` +
          "connected session of the computing space — cross-space " +
          "navigateTo is deferred (builtins.md §4, LT3)",
      );
    }

    const nonce = effectIntentNonce(context.eventId, resultDocId ?? "");
    const space: MemorySpace = parentCell.space;
    // Resolve to root piece - follows links until path is empty
    const resolvedTarget = target.resolveAsCell();
    const targetLink = resolvedTarget.getAsNormalizedFullLink();

    // NO closure bookkeeping on the served arm (independent review M2):
    // `navigated` is never consulted by a served run — the store owns
    // idempotency (the engine's nonce dedupe; the result-cell read in
    // the action) — so recording or rolling back closure state here
    // would only re-create the requeue-suppression defect.

    const intentTx = runtime.edit();
    runtime.stampServerRun(intentTx, {
      actionId: `server-execution/navigate-intent:${nonce}`,
      kind: "event-handler",
      eventId: context.eventId,
      acting,
      scopeKeyIdentity: {
        principal: acting.user,
        sessionId: acting.session as never,
      },
    });

    // The intent append (protocol.md §5's entry shape): a tail-relative
    // MERGEABLE append, the LT1 stream-entry precedent (cell.ts) — the
    // op carries only the appended tail, resolved by the store against
    // the ACTING session's instance (the seal-time annotation supplies
    // the scope key), so the serving replica's scope-NAME-keyed local
    // view (which collapses instances at cardinality > 1 — the OW17
    // residual) never leaks another session's entries into this write.
    // Idempotency is the ENGINE's nonce dedupe at apply
    // (transformEffectsDocOperation): a re-run's re-append of the same
    // deterministic nonce is dropped against the stored instance.
    const entriesLink = {
      space,
      id: SERVER_EXECUTION_EFFECTS_DOC_ID,
      scope: "session",
      path: ["entries"],
    } as unknown as NormalizedFullLink;
    const currentEntries = intentTx.readValueOrThrow(entriesLink, {
      meta: { ...ignoreReadForScheduling, ...mergeableOpRead },
    });
    const intentEntry = {
      nonce,
      kind: "navigate",
      args: {
        target: {
          ...(targetLink.space !== space ? { space: targetLink.space } : {}),
          id: targetLink.id,
          path: [...targetLink.path],
          ...(targetLink.scope !== undefined
            ? { scope: targetLink.scope }
            : {}),
        },
      },
      // The engine stamps the issuing commit's seq at apply
      // (protocol.md §5's issuedIn; the stream-entry seq precedent).
      issuedIn: null,
    };
    if (intentTx.recordMergeableOp === undefined) {
      // FAIL CLOSED: without the mergeable-append record the commit
      // would carry the WHOLE local array — the serving replica's
      // scope-NAME-keyed view can hold other sessions' entries (the
      // OW17 residual), and a whole-array write would bleed them
      // into the acting session's instance.
      throw new Error(
        "navigate intent write requires mergeable-append support " +
          "(the tail-relative append is what keeps the collapsed " +
          "local view out of the acting session's instance)",
      );
    }
    // ALWAYS append (independent review MINOR-4): the ENGINE's
    // stored-nonce dedupe is the sole idempotency authority. The
    // deleted local-presence gate consulted the OW17-collapsed local
    // view to SUPPRESS the append — a store-visible derivation from a
    // view that collapses instances (cross-session suppression the day
    // foreign rows land in the serving replica) and, compounding M2,
    // a withdrawn intent's residue could suppress its own re-issue.
    // A re-appended duplicate is dropped at apply
    // (transformEffectsDocOperation), so the extra append is one
    // tail-relative op, never a doubled entry.
    intentTx.writeValueOrThrow(entriesLink, [
      ...(Array.isArray(currentEntries) ? currentEntries : []),
      intentEntry,
    ] as never);
    intentTx.recordMergeableOp(entriesLink, { op: "append", count: 1 });
    // The result cell records the navigation in the ACTING session's
    // instance (the same annotation-keyed addressing) — the client's own
    // speculative write converges on the same instance.
    resultCell.withTx(intentTx).set(true);
    // The seal outcome resolves as { error } (commit promises always
    // resolve — extended-storage-transaction.ts); handle BOTH shapes,
    // loudly, and COUNT them (serving-loop.md §7's
    // servedIntentSealFailures). Recovery on failure is STORE-derived
    // (independent review M2) and the event is NEVER consequenced-clean
    // over a failed intent (owner review P1-2): a wave-conflict requeue
    // withdraws the intent with the event's other contributions (the
    // per-event fold in wave.ts's resolveConflicts), and an ISOLATED
    // seal failure requeues the owning event through the seal
    // destination's failure note (space-server.ts's seal wrapper →
    // wave.ts's noteSealFailure — the handler's `consequenced` mark
    // withdraws with it, the entry stays pending). Either way the
    // re-drain's re-run reads the result cell FALSE and re-issues
    // under the same deterministic nonce — no closure state to roll
    // back, and the engine's nonce dedupe absorbs the re-append.
    intentTx.commit().then(({ error }) => {
      if (error !== undefined) {
        runtime.notifyServedIntentSealFailure?.();
        logger.error(
          "intent-commit-failed",
          `navigate intent ${nonce} failed to seal — the owning event ` +
            "requeues and the re-drain re-issues",
          error,
        );
      }
    }).catch((error) => {
      runtime.notifyServedIntentSealFailure?.();
      logger.error(
        "intent-commit-failed",
        `navigate intent ${nonce} seal rejected — the owning event ` +
          "requeues and the re-drain re-issues",
        error,
      );
    });
    runtime.scheduler.queueExecution();
  }

  /** The flag-ON CLIENT half (speculation.md §2's optimistic enactment):
   * navigation is reversible, so the speculative run still enacts —
   * through the post-commit effect the overlay destination allowlists —
   * carrying the deterministic NONCE the effects channel arbitrates.
   * The channel records this enactment and converges the authoritative
   * intent on it, or — when that intent arrived and enacted first —
   * stands this one down (protocol.md §5; T2.Q7). */
  function optimisticNavigate(
    tx: IExtendedStorageTransaction,
    target: Cell<any>,
  ): void {
    const context = navigateEventContextOf(action);
    if (context === undefined) {
      // Mirror the served half's refusal (builtins.md §4): a navigateTo
      // outside a client-fired event's consequences would optimistically
      // enact a navigation the server will refuse — and a re-instantiated
      // past instance's navigation already happened.
      logger.warn("optimistic-navigate-refused", () => [
        "speculative navigateTo refused: no firing-event context " +
        "(builtins.md §4) — the served half would refuse the same run",
      ]);
      return;
    }
    if (context.attemptMinted) {
      // A CASCADE-hop capture (independent review M1): the event id —
      // and, through the handler-result frame's cause, the navigateTo
      // INSTANCE id — were minted fresh for THIS client-side attempt,
      // so the deterministic nonce this run would record CANNOT match
      // the authoritative intent's (the server's attempt minted its
      // own pair). Optimistically enacting here double-navigates: the
      // channel sees the authoritative nonce unrecorded and enacts
      // again, to a DIFFERENT target. Skip optimism — like the
      // headless arm below, nothing is lost: the authoritative intent
      // arrives on the effects channel and enacts exactly once
      // (protocol.md §5). First-hop optimism (durable fire id,
      // converging cause) is unaffected.
      logger.warn("optimistic-navigate-skipped", () => [
        "speculative navigateTo skipped: cascade-hop capture is " +
        "attempt-minted — the authoritative intent enacts on the " +
        "effects channel (one navigation)",
      ]);
      return;
    }
    if (!runtime.navigateCallback) {
      // A flag-ON client with no enactment surface (headless — a CLI,
      // a test runner) skips OPTIMISTIC enactment; the authoritative
      // intent still arrives on the effects channel, and a capable
      // client of the session enacts it (protocol.md §5). Unlike the
      // OFF arm's throw, this run is a speculative ECHO — nothing is
      // lost by not enacting locally.
      logger.warn("optimistic-navigate-skipped", () => [
        "speculative navigateTo skipped: navigateCallback is not set; " +
        "the authoritative intent enacts on a capable client",
      ]);
      return;
    }
    const nonce = effectIntentNonce(context.eventId, resultDocId ?? "");
    const navigateCallback = runtime.navigateCallback;
    // Resolve to root piece - follows links until path is empty
    const resolvedTarget = target.resolveAsCell();

    const previousNavigated = navigated;
    const thisAttempt = ++navigationAttempt;
    navigated = true;
    tx.addCommitCallback((_committedTx, commitResult) => {
      if (commitResult.error && navigationAttempt === thisAttempt) {
        navigated = previousNavigated;
      }
    });
    const targetLink = resolvedTarget.getAsNormalizedFullLink();
    tx.enqueuePostCommitEffect({
      id: `navigateTo:${
        JSON.stringify([
          targetLink.space,
          targetLink.scope,
          targetLink.id,
          targetLink.path,
        ])
      }`,
      kind: "navigateTo",
      // No `abandon`: nothing waits on a result cell here, and the `navigated`
      // flag is restored by the commit callback above, so a later attempt
      // navigates. An effect whose work simply does not happen has nothing to
      // record.
      // The convergence key (protocol.md §5): the overlay destination
      // hands this flush to the effects channel, which records the
      // nonce before the flush's callback runs and acks the
      // authoritative intent without re-enacting — or, holding the
      // nonce already, runs this flush not at all.
      nonce,
      flush: async () => {
        if (navigationAttempt !== thisAttempt) return;
        const work = Promise.resolve().then(() =>
          navigateCallback(resolvedTarget)
        );
        runtime.trackAsyncWork(work, parentCell);
        // Failure PROPAGATES (owner review P1-1, unlike the OFF arm's
        // legacy swallow below): the overlay hands this flush's outcome
        // to the effects channel, which retracts the enacted-nonce
        // record on failure so the authoritative intent re-enacts on a
        // later delivery — swallowing here would let the channel ack a
        // navigation that never happened, and the server would retire
        // it (permanent loss). The overlay logs the failure
        // (speculative-enact-failed); the channel logs the retraction
        // (enact-failed).
        await work;
      },
    });
    resultCell.withTx(tx).set(true);
    runtime.scheduler.queueExecution();
  }

  /** Today's client-computed path — the OFF arm, byte-identical. */
  function legacyNavigate(
    tx: IExtendedStorageTransaction,
    target: Cell<any>,
  ): void {
    if (!runtime.navigateCallback) {
      throw new Error("navigateCallback is not set");
    }

    // Resolve to root piece - follows links until path is empty
    const resolvedTarget = target.resolveAsCell();
    const navigateCallback = runtime.navigateCallback;

    const previousNavigated = navigated;
    const thisAttempt = ++navigationAttempt;
    navigated = true;
    tx.addCommitCallback((_committedTx, commitResult) => {
      if (commitResult.error && navigationAttempt === thisAttempt) {
        navigated = previousNavigated;
      }
    });
    // Navigation is an external effect: release it only after a successful
    // commit. The outbox promise is tracked explicitly, owned by this run, so
    // neither runtime.settled() nor runtime.settledFor(parentCell) can race
    // async shell navigation.
    const targetLink = resolvedTarget.getAsNormalizedFullLink();
    tx.enqueuePostCommitEffect({
      // The outbox deduplicates by id within a transaction. Encode the full
      // normalized link as a tuple so scoped targets remain distinct and path
      // segments containing separators cannot collide.
      id: `navigateTo:${
        JSON.stringify([
          targetLink.space,
          targetLink.scope,
          targetLink.id,
          targetLink.path,
        ])
      }`,
      kind: "navigateTo",
      flush: async () => {
        if (navigationAttempt !== thisAttempt) return;
        const work = Promise.resolve().then(() =>
          navigateCallback(resolvedTarget)
        );
        runtime.trackAsyncWork(work, parentCell);
        try {
          await work;
        } catch (error) {
          console.error("navigateTo callback failed:", error);
        }
      },
    });
    resultCell.withTx(tx).set(true);
    runtime.scheduler.queueExecution();
  }

  return {
    action,
    isEffect: true,
    useDeclaredReadsAsDependencies: true,
  };
}
