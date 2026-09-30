// The SpaceServer's outbox (server-execution v2 stage G, serving-loop.md
// §4–§5): both halves of the effect channel.
//
// - The EFFECT half is PROCESS-LOCAL by design (§5; the FP1 ruling keeps
//   it that way): a queue of sealed post-commit effects — the network
//   work of `fetch*`, `generate*`, `sqlite*` — handed over by the wave
//   cycle AFTER the wave commit (never at seal: §3's "hand external
//   effects to the outbox (post-commit)"), deduped in flight per effect
//   key (`${kind}:${inputHash}@<result-cell id>` — the memo key basis
//   widened by the requesting node's target identity, see
//   effect-completion.ts `effectTargetKey`; §4's in-flight dedupe,
//   scoped per (key, target) because each effect's closure writes only
//   its OWN node's cells — the round-2 headline).
//   Crash-soundness needs no durability here: a crash re-misses the
//   effect from memo keys (§4, §6 step 3 — RULED, at-least-once
//   accepted). Per-entry run-context CARRIAGE (§4's miss rule: the
//   result-cell identity resolution + the acting identity + — carried
//   structurally — the label basis) is captured from the sealing
//   transaction's stamped context and consumed by the completion
//   committer (space-server.ts).
// - The DURABLE half (FP1, RULED 2026-08-03) is the engine-table rows
//   of cross-space event appends — written inside the emitting wave's
//   own transaction by the sink; this module DELIVERS them (an authored
//   delegated commit at the target — protocol.md §2, §2b; LT5's service
//   envelope) and deletes each row on delivery-ack. Activation calls
//   `deliverPendingAppends` to re-send undelivered rows (§6 step 5);
//   duplicates dedupe at the target's eventId horizon.
//
// FORBIDDEN and respected: no effect retry timers (failures commit
// error-shaped results; retries are input-driven — §4), no "pending
// effects" table (the effect half never touches the store), no delivery
// of a withdrawn contribution's appends (the wave folds survivors only).

import type { Server as MemoryServer } from "@commonfabric/memory/v2/server";
import type { Engine } from "@commonfabric/memory/v2/engine";
import * as EngineModule from "@commonfabric/memory/v2/engine";
import {
  deleteExecutionOutboxRow,
  selectPendingExecutionOutboxRows,
} from "@commonfabric/memory/v2/execution-outbox";
import type { PendingOutboxRow } from "@commonfabric/memory/v2/execution-outbox";
import { ProtocolError } from "@commonfabric/memory/v2";
import { getLogger } from "@commonfabric/utils/logger";
import {
  POST_COMMIT_RELEASE_REJECTED,
  type PostCommitSideEffect,
} from "../cfc/types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { WaveRunContext } from "./wave.ts";
import type { ServingLoopStats } from "./stats.ts";
import { RUNNER_ACCEPTANCE_EFFECT_KIND } from "./runner-acceptance.ts";

const logger = getLogger("space-outbox", { enabled: true, level: "warn" });

/** One sealed effect awaiting its wave's commit: the transaction it
 * sealed with (the flush contract passes it back), the effects it
 * enqueued, and the run context captured at seal — §4's identity
 * carriage, the completion commit's only annotation source. */
export interface SealedEffectBatch {
  tx: IExtendedStorageTransaction;
  effects: readonly PostCommitSideEffect[];
  context: WaveRunContext | undefined;
}

/** An accepted attachment whose release check has not run. */
interface EffectCandidate {
  effect: PostCommitSideEffect;
  tx: IExtendedStorageTransaction;
  context: WaveRunContext | undefined;
}

/** One effect key, retaining alternatives only until dispatch is decided. */
interface InflightEffect {
  retirement: Promise<void>;
  candidates: EffectCandidate[] | undefined;
  countsAsRequest: boolean;
}

/** Per-space egress budgets (Phase 6 — serving-loop.md §5's
 * "outstanding-effect caps, egress rate"; README §3.8's multi-tenancy
 * contract: a runaway pattern degrades only its own space). Applied to
 * NETWORK effect kinds only — a local kind (sqlite-query) egresses
 * nothing and throttling it would only starve local DB work. Both
 * knobs default UNBOUNDED (today's behavior); the toolshed bootstrap
 * sets production values from env. */
export type OutboxBudgetPolicy = {
  /** Cap on DISPATCHED-but-unsettled network effects. Admitted effects
   * over the cap hold their dispatch (FIFO wake order) until a slot
   * frees; the in-flight dedupe entry exists from ADMISSION either way,
   * so re-admits attach instead of double-firing. Undefined = unbounded.
   * CAUTION for direct callers: `0` is NOT "unbounded" here — it holds
   * every network dispatch forever (no slot can ever free). The env
   * path never produces it (the toolshed bootstrap maps a literal env
   * `0` to ABSENT — `serverExecutionPolicyFromEnv`). */
  maxOutstandingEffects?: number;

  /** Egress pacing: network-effect dispatches per second (token bucket
   * with burst = one second's tokens, minimum 1). */
  egressRatePerSecond?: number;

  /** Test clock (defaults to Date.now). */
  now?: () => number;
};

/** Local database work and runner acceptance callbacks consume no egress. */
const LOCAL_EFFECT_KINDS = new Set([
  "sqlite-query",
  RUNNER_ACCEPTANCE_EFFECT_KIND,
]);

export class SpaceOutbox {
  readonly #stats: ServingLoopStats;
  readonly #server: MemoryServer;
  readonly #engine: Engine;
  readonly #sessionId: string;
  readonly #space?: string;
  readonly #localSeqRef: { value: number };

  /** In-flight effect entries per effect key — §4's in-flight dedupe,
   * scoped per (memo key, result target): a second admit of a live key
   * is the SAME node's request re-issued (a wave re-run, a
   * stale-snapshot re-admit, a crash re-miss) and is served by the
   * selected attachment's completion writing that node's cells. Distinct nodes
   * never share a key (effectTargetKey widens the memo key by the
   * result-cell identity — the round-2 headline: their closures write
   * different cells, so cross-node dedupe dropped real work). The
   * entry's promise tracks RETIREMENT (work settled AND every
   * completion commit readable — see #retireBarriers), which is what
   * `settle()` awaits. */
  readonly #inflight = new Map<string, InflightEffect>();

  /** Run-context carriage per in-flight effect id (§4's miss rule),
   * consumed by the completion committer; retired with the entry
   * (every completion write of an effect happens inside its tracked
   * work, so nothing consults a retired entry — a late straggler falls
   * back to the wave-level identity, which is the same identity in
   * Phase 1). */
  readonly #carriage = new Map<string, WaveRunContext>();

  /** Read-consistency barriers per in-flight effect id (serving-loop.md
   * §4; the stage-G review's B-1): each completion commit of a served
   * effect registers a promise that resolves when its writes are
   * READABLE by the serving runtime (the replica applied the accept —
   * `ISpaceReplica.whenApplied`). Retirement awaits them, so the
   * in-flight entry keeps deduping stale re-admits across the
   * absorption window. Without this, the captured double-fire fires: a
   * completion commits engine-side and retires the key, a later wave's
   * stale-snapshot re-run re-admits it, and the re-admitted claim's
   * reads — not yet showing the completion — pass the hash guard and
   * egress a second time. */
  readonly #retireBarriers = new Map<string, Array<Promise<unknown>>>();

  /** Sync-span capture target for the runtime's async-work observer:
   * while an effect's flush runs its SYNCHRONOUS prefix, work the
   * builtin registers via trackAsyncWork lands here — that work IS the
   * effect (fetch/llm callbacks return synchronously after starting
   * it), and outbox.completed counts only when it settles. */
  #capturing: Array<Promise<unknown>> | undefined;

  /** Per-space egress budgets (`serving-loop.md` §5). */
  readonly #budget: OutboxBudgetPolicy | undefined;

  readonly #now: () => number;

  /** DISPATCHED-but-unsettled network effects (the outstanding cap's
   * subject; local kinds bypass the gate and are never counted). */
  #outstanding = 0;

  /** FIFO of admitted-but-held dispatch starters, woken one per freed
   * slot (and drained wholesale on close — the park path). */
  readonly #dispatchWaiters: Array<() => void> = [];

  /** Token bucket for the egress rate (burst = one second's tokens). */
  #egressTokens = 0;

  #egressRefilledAt = 0;
  #closed = false;

  readonly #onEffectRetired?: () => void;

  constructor(options: {
    stats: ServingLoopStats;
    server: MemoryServer;

    /** The HOME space's engine — where the durable append rows live. */
    engine: Engine;

    /** The HOME space did — the OW14 failure notice commits into it as
     * a derived-class commit, whose lease admission needs the space. */
    space?: string;

    /** The delivering service session (LT5's envelope) — the DR1
     * holder, same as the wave sink's. */
    sessionId: string;

    /** The host's process-lifetime localSeq counter, shared with the
     * wave sink (the replay-keying discipline — engine-wave-sink.ts). */
    localSeqRef: { value: number };

    /** Per-space egress budgets (Phase 6); absent = unbounded. */
    budget?: OutboxBudgetPolicy;

    /** DIAGNOSTIC (tests): called as each in-flight effect is retired,
     * once the counts that drop with it have moved. Retirement happens
     * inside the outbox's own continuations, which nothing else
     * reports. */
    onEffectRetired?: () => void;
  }) {
    this.#stats = options.stats;
    this.#server = options.server;
    this.#engine = options.engine;
    this.#space = options.space;
    this.#sessionId = options.sessionId;
    this.#localSeqRef = options.localSeqRef;
    this.#budget = options.budget;
    this.#onEffectRetired = options.onEffectRetired;
    this.#now = options.budget?.now ?? Date.now;
    this.#egressRefilledAt = this.#now();
    this.#egressTokens = this.#burstCapacity();
  }

  #burstCapacity(): number {
    const rate = this.#budget?.egressRatePerSecond;
    if (rate === undefined || rate <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(1, Math.floor(rate));
  }

  /** Continuous refill up to the burst capacity. */
  #refillEgressTokens(): void {
    const rate = this.#budget?.egressRatePerSecond;
    if (rate === undefined || rate <= 0) return;
    const now = this.#now();
    const elapsed = Math.max(0, now - this.#egressRefilledAt);
    if (elapsed <= 0) return;
    this.#egressTokens = Math.min(
      this.#burstCapacity(),
      this.#egressTokens + (elapsed / 1000) * rate,
    );
    this.#egressRefilledAt = now;
  }

  /** Ms until one egress token is available (0 when unpaced). */
  #msUntilEgressToken(): number {
    const rate = this.#budget?.egressRatePerSecond;
    if (rate === undefined || rate <= 0) return 0;
    this.#refillEgressTokens();
    if (this.#egressTokens >= 1) return 0;
    return Math.ceil(((1 - this.#egressTokens) / rate) * 1000);
  }

  /** Whether the budget gate applies to this effect (network kinds
   * only). */
  #budgeted(effect: PostCommitSideEffect): boolean {
    if (this.#budget === undefined) return false;
    if (
      this.#budget.maxOutstandingEffects === undefined &&
      (this.#budget.egressRatePerSecond === undefined ||
        this.#budget.egressRatePerSecond <= 0)
    ) {
      return false;
    }
    return !LOCAL_EFFECT_KINDS.has(effect.kind);
  }

  /**
   * Hold until a dispatch slot AND an egress token are available (FIFO
   * wake for the cap; timer wake for the rate). Returns false when the
   * outbox closed while holding — the park path: the deferred dispatch
   * is DROPPED, the sanctioned crash-equivalent posture (the effect
   * re-misses from its memo key on re-activation; firing against a
   * dying runtime would egress work for a dead space).
   */
  async #acquireDispatchSlot(): Promise<boolean> {
    while (true) {
      if (this.#closed) return false;
      const cap = this.#budget?.maxOutstandingEffects;
      if (cap !== undefined && this.#outstanding >= cap) {
        this.#stats.outbox.budgetDeferrals += 1;
        await new Promise<void>((resolve) =>
          this.#dispatchWaiters.push(resolve)
        );
        continue;
      }
      const waitMs = this.#msUntilEgressToken();
      if (waitMs > 0) {
        this.#stats.outbox.budgetDeferrals += 1;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      if (this.#egressTokens !== Number.POSITIVE_INFINITY) {
        this.#egressTokens = Math.max(0, this.#egressTokens - 1);
      }
      this.#outstanding += 1;
      return true;
    }
  }

  #releaseDispatchSlot(): void {
    this.#outstanding = Math.max(0, this.#outstanding - 1);
    this.#dispatchWaiters.shift()?.();
  }

  /** DIAGNOSTIC (tests): dispatched-but-unsettled network effects. */
  get outstandingCount(): number {
    return this.#outstanding;
  }

  /** Park/teardown (Phase 6): admitted-but-held dispatches are dropped
   * — every waiter wakes into the closed check — and nothing new
   * dispatches. In-flight work is not awaited (park never awaits the
   * network), exactly the pre-budget posture. Accounting note: a
   * dropped hold was counted `queued` at admission but is neither
   * `completed` nor `failed` (it never dispatched), so after a park
   * `outbox.queued` may exceed `completed + failed` by the drop count.
   * No gate binds that identity; the drop is the sanctioned
   * crash-equivalent posture (memo re-miss re-fires on re-activation). */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#dispatchWaiters.length > 0) {
      this.#dispatchWaiters.shift()?.();
    }
  }

  /** The runtime's async-work observer hook (installed by the
   * SpaceServer on the serving runtime): captures work started inside
   * an effect flush's synchronous prefix. */
  observeAsyncWork(work: Promise<unknown>): void {
    this.#capturing?.push(work);
  }

  /** The §4 identity carriage for an in-flight effect, captured at the
   * selected dispatch attachment's seal. */
  carriageFor(effectKey: string): WaveRunContext | undefined {
    return this.#carriage.get(effectKey);
  }

  /**
   * Defer the effect's in-flight retirement behind `barrier` — the B-1
   * read-consistency gate: the completion committer registers, per
   * completion commit, a promise resolving when that commit's writes
   * are READABLE by the serving runtime (the replica applied the
   * accept). The effect's entry retires only after its work settled
   * AND every registered barrier resolved, so a stale re-admit of the
   * key keeps deduping across the absorption window instead of
   * re-claiming against unabsorbed state (the captured double-egress).
   * A registration for a key not in flight is a no-op: a straggler
   * completion of an already-retired key has nothing to hold.
   */
  deferRetirement(effectKey: string, barrier: Promise<unknown>): void {
    if (!this.#inflight.has(effectKey)) return;
    let barriers = this.#retireBarriers.get(effectKey);
    if (barriers === undefined) {
      barriers = [];
      this.#retireBarriers.set(effectKey, barriers);
    }
    barriers.push(barrier);
  }

  get inflightCount(): number {
    return this.#inflight.size;
  }

  /**
   * Admit one wave's sealed effect batches — called by the wave cycle
   * AFTER the wave commit step returned (post-commit; §3). Deduped per
   * effect id against in-flight work (§4). Effects are invoked regardless
   * of their contribution's per-doc disposition; each effect checks any
   * required contribution acceptance before doing work. A withdrawn
   * contribution's action re-runs and re-enqueues (deduped here). Each
   * completion checks current request state, so a superseded request's
   * writeback is inert — at-least-once, the ruled posture (§4, §6 step 3).
   * Batches of an ABANDONED wave are
   * never admitted (the space parks and its runtime dies — the
   * crash-equivalent path, covered by memo re-miss).
   */
  admitSealedEffects(batches: readonly SealedEffectBatch[]): void {
    for (const batch of batches) {
      for (const effect of batch.effects) {
        const key = effect.idempotencyKey ?? effect.id;
        const candidate = { effect, tx: batch.tx, context: batch.context };
        const existing = this.#inflight.get(key);
        if (existing !== undefined) {
          // Held requests keep each attachment's release check. Once one
          // dispatches, its completion serves every same-key attachment.
          existing.candidates?.push(candidate);
          continue;
        }
        const countsAsRequest = effect.kind !== RUNNER_ACCEPTANCE_EFFECT_KIND;
        if (countsAsRequest) {
          this.#stats.outbox.queued += 1;
          this.#stats.memo.misses += 1;
        }
        const retired = Promise.withResolvers<void>();
        const entry: InflightEffect = {
          retirement: retired.promise,
          candidates: [candidate],
          countsAsRequest,
        };
        this.#inflight.set(key, entry);
        if (countsAsRequest) this.#stats.memo.inflight += 1;
        if (batch.context !== undefined) {
          this.#carriage.set(key, batch.context);
        }
        // Registration precedes the synchronous prefix too: a re-admission
        // during a release check attaches to this entry instead of firing twice.
        const work = this.#budgeted(effect)
          ? this.#acquireDispatchSlot().then((acquired) =>
            acquired
              ? this.#runEffect(key, entry)
                .finally(() => this.#releaseDispatchSlot())
              : undefined
          )
          : this.#runEffect(key, entry);
        work.catch(() => undefined)
          .then(() => {
            if (this.#inflight.get(key) === entry) {
              return this.#awaitRetireBarriers(key);
            }
          })
          .finally(() => {
            this.#retireEntry(key, entry);
            retired.resolve();
          });
      }
    }
  }

  /** Await every registered read-consistency barrier for `key`,
   * re-checking after each pass: a completion committing DURING the
   * await (a late writeback of attached work) registers into a fresh
   * list, and the entry must not retire ahead of it. Never rejects —
   * barriers resolve on apply, reset, and close (the replica side), and
   * a rejected barrier must not wedge retirement. A registration
   * landing in the ~1-microtask window between the final empty check
   * here and the caller's `.finally` cleanup is deleted unawaited —
   * the documented at-least-once straggler posture (unreachable
   * today: every production writeback runs inside tracked work). */
  async #awaitRetireBarriers(key: string): Promise<void> {
    while (true) {
      const barriers = this.#retireBarriers.get(key);
      if (barriers === undefined || barriers.length === 0) return;
      this.#retireBarriers.delete(key);
      await Promise.allSettled(barriers);
    }
  }

  /** Frees only this generation's key, carriage, and consistency barriers. */
  #retireEntry(key: string, entry: InflightEffect): void {
    if (this.#inflight.get(key) !== entry) return;
    entry.candidates = undefined;
    this.#retireBarriers.delete(key);
    this.#inflight.delete(key);
    this.#carriage.delete(key);
    if (entry.countsAsRequest) this.#stats.memo.inflight -= 1;
    try {
      this.#onEffectRetired?.();
    } catch (error) {
      // The caller resolves the entry's retirement promise after this
      // returns, and `settle()` sleeps on that promise.
      logger.warn("effect-retired-observer-failed", () => [
        `effect ${key} retirement observer threw`,
        error,
      ]);
    }
  }

  async #runEffect(key: string, entry: InflightEffect): Promise<void> {
    const countsAsRequest = entry.countsAsRequest;
    // Capture only each flush's synchronous prefix. A release refusal can
    // select another accepted attachment; any other outcome ends selection.
    const captured: Array<Promise<unknown>> = [];
    let flushResult: ReturnType<PostCommitSideEffect["flush"]> = undefined;
    let dispatched = false;
    while (entry.candidates?.length) {
      const candidate = entry.candidates.shift()!;
      if (candidate.context === undefined) this.#carriage.delete(key);
      else this.#carriage.set(key, candidate.context);
      this.#capturing = captured;
      try {
        flushResult = candidate.effect.flush(candidate.tx);
      } catch (error) {
        this.#capturing = undefined;
        entry.candidates = undefined;
        if (countsAsRequest) this.#stats.outbox.failed += 1;
        logger.warn("effect-flush-failed", () => [
          `effect ${key} flush threw`,
          error,
        ]);
        return;
      }
      this.#capturing = undefined;
      if (flushResult === POST_COMMIT_RELEASE_REJECTED) continue;
      dispatched = true;
      break;
    }
    entry.candidates = undefined;
    if (!dispatched) {
      // No request started. Free the key synchronously so an attachment
      // arriving before this call's promise retires gets its own release check.
      this.#retireEntry(key, entry);
      if (countsAsRequest) this.#stats.outbox.completed += 1;
      return;
    }
    try {
      await flushResult;
      const settled = await Promise.allSettled(captured);
      const rejected = settled.find((entry) => entry.status === "rejected");
      if (rejected !== undefined) {
        // Infrastructure failure of the effect's own work — effect-level
        // failures commit error-shaped RESULTS instead and never reject
        // (§4's failure rule), so a rejection here is the runtime path
        // breaking, not the request failing.
        if (countsAsRequest) this.#stats.outbox.failed += 1;
        logger.warn("effect-work-failed", () => [
          `effect ${key} async work rejected`,
          (rejected as PromiseRejectedResult).reason,
        ]);
        return;
      }
      if (countsAsRequest) this.#stats.outbox.completed += 1;
    } catch (error) {
      if (countsAsRequest) this.#stats.outbox.failed += 1;
      logger.warn("effect-flush-failed", () => [
        `effect ${key} flush rejected`,
        error,
      ]);
    }
  }

  /** Every in-flight effect RETIRED — work settled and every completion
   * readable (the B-1 barrier). A test/diagnostic barrier; the serving
   * loop never awaits it (the loop never awaits the network). */
  async settle(): Promise<void> {
    while (this.#inflight.size > 0) {
      await Promise.allSettled(
        [...this.#inflight.values()].map((entry) => entry.retirement),
      );
    }
  }

  /**
   * Deliver every pending durable append row (FP1; serving-loop.md §6
   * step 5's re-send on activation, and the post-wave drain): admit at
   * the target through the delegated-append path (protocol.md §2, §2b —
   * `firedAt` from the carried actor, envelope the service session),
   * then DELETE the row — admit-before-delete, so a crash between the
   * two re-sends and the target's eventId horizon dedupes (the spec
   * model's C2/FP1 closure: no schedule loses an append). Rows are
   * delivered in insertion order (FIFO per source wave → target
   * stream). A DETERMINISTIC admission rejection (LT4) is not retried:
   * the source-side failure notice (events.md §5, verification-coverage
   * OW14) is written FIRST, then the row is deleted and counted failed
   * — write-then-delete, so no crash schedule loses the notice. If
   * either the notice write or the retirement fails, the row is KEPT
   * and the drain STOPS. A TRANSPORT-class failure STOPS the drain: the
   * failed row and every later row stay for the next drain
   * (at-least-once, no timers). Continuing past a retained row would
   * deliver later rows of the same target stream ahead of it, and the
   * re-send would then violate per-stream append order — FIFO per
   * (source wave → target stream) is the §2b guarantee the insertion
   * order exists to carry. The cost is one drain cycle of latency for
   * rows behind the failure aimed at OTHER streams; correctness over
   * throughput here.
   */
  async deliverPendingAppends(): Promise<{ remaining: number }> {
    const rows = selectPendingExecutionOutboxRows(this.#engine, {
      branch: "",
    });
    for (const [index, row] of rows.entries()) {
      try {
        await this.#server.commitDelegatedAppend({
          targetSpace: row.targetSpace,
          targetStream: row.targetStream,
          ...(row.targetStreamLink === undefined
            ? {}
            : { targetStreamLink: row.targetStreamLink }),
          eventId: row.eventId,
          payload: row.payload,
          ...(row.runtimeReferenceContext === undefined ? {} : {
            runtimeReferenceContext: row.runtimeReferenceContext,
          }),
          ...(row.actingPrincipal === undefined
            ? {}
            : { actingPrincipal: row.actingPrincipal }),
          ...(row.actingSession === undefined
            ? {}
            : { actingSession: row.actingSession }),
          // The OW15 declaration passes through to the target's floor
          // carve-out (protocol.md §2): an ABSENT acting principal
          // admits iff declared, stamping firedAt = {session:"server"}.
          ...(row.sessionlessSpaceScope === true
            ? { sessionlessSpaceScope: true }
            : {}),
          capabilityRef: row.capabilityRef,
          sessionId: this.#sessionId,
          localSeq: ++this.#localSeqRef.value,
        });
        // Delivery-ack: the target processed the entry (admitted or
        // horizon-deduped) — retire the row (FP1's queue that empties).
        deleteExecutionOutboxRow(this.#engine, row.rowId);
      } catch (error) {
        if (error instanceof ProtocolError) {
          // LT4: a deterministic admission rejection does not retry. The
          // source-side failure notice writes BEFORE the row retires
          // (OW14's write-then-delete order): a crash between the two
          // re-sends the row, hits the same deterministic rejection,
          // and RE-NOTICES — deduped by the refused append's eventId —
          // so the notice is never lost. A row with no source event (a
          // derivation-emitted append) falls back to the warn log.
          // Retiring the row keeps FIFO intact (nothing is delivered
          // out of order by REMOVING a row — later rows were always
          // going to follow it), so the drain continues.
          this.#stats.outbox.failed += 1;
          const noticed = this.#writeDeliveryFailureNotice(
            row,
            error instanceof Error ? error.message : String(error),
          );
          if (!noticed) {
            // The notice could not be written durably: KEEP the row so
            // the next drain re-attempts both (write-then-delete —
            // deleting now would lose the notice forever). Stopping the
            // drain here, like the transport arm: delivering later rows
            // past a KEPT row would reorder its stream on the re-send
            // (the §2b per-stream FIFO guarantee).
            logger.warn("append-notice-failed", () => [
              `failure notice for rejected append ${row.eventId} could ` +
              "not be written; drain stopped, row kept so the next " +
              "drain re-notices",
              error,
            ]);
            return { remaining: rows.length - index };
          }
          try {
            deleteExecutionOutboxRow(this.#engine, row.rowId);
          } catch (deleteError) {
            // The row could not be retired: stop here too — leaving it
            // pending while delivering later rows would reorder its
            // stream on the re-send, the same FIFO break as the
            // transport arm. The notice already written dedupes on the
            // re-send's re-notice.
            logger.warn("append-retire-failed", () => [
              `retiring rejected append ${row.eventId} failed; row kept`,
              deleteError,
            ]);
            return { remaining: rows.length - index };
          }
          logger.warn("append-rejected", () => [
            `outbox append ${row.eventId} → ${row.targetSpace} rejected ` +
            "deterministically; not retried (LT4); the source-side " +
            "failure notice is on the source event's entry (OW14).",
            error,
          ]);
          continue;
        }
        // Transport-class failure: STOP the drain — the failed row and
        // every row behind it stay for the next drain (or the next
        // activation's §6 step 5 re-send), preserving per-stream
        // append order. No timers.
        logger.warn("append-delivery-failed", () => [
          `outbox append ${row.eventId} → ${row.targetSpace} failed; ` +
          "drain stopped, row and successors kept for re-send",
          error,
        ]);
        return { remaining: rows.length - index };
      }
    }
    return { remaining: 0 };
  }

  /**
   * OW14 (protocol.md §2b's LT4 ruling): write the deterministic
   * delivery refusal's failure notice onto the SOURCE event's stream
   * entry — "a failure notice on the source event's stream entry,
   * written by the source SpaceServer" — per events.md §5's
   * error-is-the-consequence shape. Deduped by the refused append's
   * eventId; a small derived-class engine commit of the loop's own
   * (the completion-commit precedent: post-wave, never through §3d's
   * sealing). Returns whether the notice is durably present (already
   * present counts).
   */
  #writeDeliveryFailureNotice(
    row: PendingOutboxRow,
    reason: string,
  ): boolean {
    if (row.sourceEvent === undefined) {
      logger.warn("append-rejected-unsourced", () => [
        `rejected append ${row.eventId} carries no source event; the ` +
        "failure notice has no entry to land on (a derivation-emitted " +
        "append) — log-only",
      ]);
      return true;
    }
    try {
      const doc = EngineModule.read(this.#engine, {
        id: row.sourceEvent.sidecarId,
      });
      const entries =
        ((doc?.value ?? {}) as { entries?: Array<StreamEventEntryShape> })
          .entries ?? [];
      const index = entries.findIndex((entry) =>
        entry?.eventId === row.sourceEvent!.eventId
      );
      if (index < 0) {
        // The source entry compacted away (events.md §4's allowance):
        // the notice never outlives the entry it annotates.
        return true;
      }
      const existing = entries[index]?.deliveryFailures ?? [];
      if (existing.some((failure) => failure.eventId === row.eventId)) {
        return true;
      }
      if (this.#space === undefined) {
        logger.warn("append-notice-unspaced", () => [
          `failure notice for ${row.eventId} needs the home space for ` +
          "derived admission; outbox constructed without one — log-only",
        ]);
        return true;
      }
      EngineModule.applyCommit(this.#engine, {
        sessionId: this.#sessionId,
        space: this.#space,
        commitClass: "derived",
        holder: this.#sessionId,
        commit: {
          localSeq: ++this.#localSeqRef.value,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: row.sourceEvent.sidecarId as never,
            patches: [{
              op: "replace",
              path: `/value/entries/${index}/deliveryFailures`,
              value: [
                ...existing,
                {
                  eventId: row.eventId,
                  targetSpace: row.targetSpace,
                  reason,
                },
              ] as never,
            }],
          }],
        },
      });
      return true;
    } catch (error) {
      logger.warn("append-notice-write-failed", () => [
        `failure notice write for ${row.eventId} threw`,
        error,
      ]);
      return false;
    }
  }
}

type StreamEventEntryShape = {
  eventId?: string;
  deliveryFailures?: Array<{
    eventId: string;
    targetSpace: string;
    reason: string;
  }>;
} | null;
