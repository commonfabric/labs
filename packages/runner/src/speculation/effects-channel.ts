// The client half of the client-effect channel (server-execution v2
// Phase 4; docs/specs/server-side-execution/protocol.md §5): every
// flag-ON NON-serving runtime subscribes to its own session's instance
// of the well-known effects doc in each space it connects to, ENACTS
// unacked intents (navigation — the one shipped kind), and ACKS by
// nonce with an ordinary AUTHORED write into the session's own instance
// (the plan's interim-postures Phase-4 row). The instance resolves from
// the runtime's authenticated session — the client names no scope key
// (T2.Q3).
//
// Exactly-once per nonce is THIS side's duty (protocol.md §5), kept by
// the ENACTED-NONCE RECORD — process memory, deliberately reload-wiped:
// a reload between intent and ack re-reads the unacked intent on
// resubscribe and MAY re-enact it, which is ACCEPTED for reversible
// effects (LT8, RULED 2026-08-03). The record is taken BEFORE the
// enactment's callback runs, with its outcome attached, and the two
// paths that take it converge on each other in either order:
//
// - the OPTIMISTIC path — the speculation overlay hands its navigateTo
//   flush to `enactOnce` (speculation.md §2), which runs the flush and
//   records the run's deterministic nonce, so the authoritative intent
//   CONVERGES on the in-flight nonce and never re-navigates (T2.Q7);
//   the intent that arrived FIRST is the nonce `enactOnce` finds
//   already recorded, and the flush does not run at all;
// - the AUTHORITATIVE path — an intent arriving unenacted (a reload, a
//   client that never speculated the run) is begun, enacted, and — on
//   SUCCESS — acked here (record-before-invoke guards re-entrant
//   deliveries).
//
// The ACK FOLLOWS ENACTMENT SUCCESS (protocol.md §5: the client
// "enacts, then commits an authored ack write"; owner review P1-1,
// 2026-08-12): every ack chains on the enactment's outcome, and a
// FAILED enactment retracts its record instead of acking — the entry
// stays unacked in the store, so a later delivery (any commit touching
// the instance, or the LT8 reload re-read) retries. Acking a failed
// enactment would let the server retire a navigation that never
// happened — permanent loss.
//
// One refusal is acked without being enacted: a navigation the display
// ceiling withholds DEFINITIVELY (`NavigationWithheldError` with
// `definitive`), on labels this viewer is refused that nothing it can
// later learn would admit. Every delivery would withhold it again, so it
// counts as done for the session: acked, and kept in the session's
// withheld set, rather than left unacked to pile up. It is a decision,
// not a failed enactment. A withhold for want of labels, or one that a
// later access list could reverse, is a failure as above and stays
// unacked.
//
// The ack is once-per-nonce and the server-side retirement is
// idempotent, so the accepted LT8 re-enactment never doubles anything
// downstream of the client.
//
// HOW the channel watches its doc (server-execution v2 stage C design
// (e), item 13 — RULED 2026-08-18: "the effects-channel sink follows the
// same redesign, as (e)'s second step"): a NON-REACTIVE storage-
// notification listener keyed on the subscribed spaces, not a schema-less
// whole-doc `cell.sink`. The sink was a scheduler effect that re-read
// every entry on every change of the session's effects doc — following
// each intent's `args.target` link into the navigated-to doc (a demand
// leak) — and paid the CFC probe over that read set; the same shape as
// the intent watch, on a smaller doc. Now: ONE `storageManager.subscribe`
// per channel, the doc kept WATCHED through the schema-less selector
// (`sync(id, { path: [], schema: false }, "session")` — also the LT8
// resubscribe re-read), and ONE coalesced MICROTASK reconcile per
// (space) that reads the RAW replica doc: no transaction, no proxy, no
// probe, no scheduler node, no demand edge. The reconcile itself is
// unchanged.

import type { CfcJsonValue } from "@commonfabric/api/cfc";
import { isDID } from "@commonfabric/identity";
import {
  SERVER_EXECUTION_EFFECTS_DOC_ID,
  type SessionEffectsDocValue,
} from "@commonfabric/memory/v2";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import type { SinkConsumedLabel } from "../cell.ts";
import { collectConsumedLabel } from "../cfc/prepare.ts";
import { NavigationWithheldError } from "../navigation-withheld.ts";
import type { Runtime } from "../runtime.ts";
import type { MemorySpace, URI } from "../storage/interface.ts";
import { CoalescedDocListener } from "./doc-notification-listener.ts";

const logger = getLogger("effects-channel", {
  enabled: true,
  level: "warn",
});

/** `value` as a JSON value, the form a label's atom takes, or `undefined`. */
function cfcJsonOf(value: unknown): CfcJsonValue | undefined {
  if (
    value === null || typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const items: CfcJsonValue[] = [];
    for (const item of value) {
      const json = cfcJsonOf(item);
      if (json === undefined) return undefined;
      items.push(json);
    }
    return items;
  }
  if (!isObjectNotArray(value)) return undefined;
  const fields: Record<string, CfcJsonValue> = {};
  for (const [key, field] of Object.entries(value)) {
    const json = cfcJsonOf(field);
    if (json === undefined) return undefined;
    fields[key] = json;
  }
  return fields;
}

/** `value` as a list of a label's atoms or clauses, or `undefined`. */
function atomsOf(value: unknown): CfcJsonValue[] | undefined {
  const json = cfcJsonOf(value);
  return Array.isArray(json) ? [...json] : undefined;
}

/**
 * The labels an intent carries of what chose its target
 * (`EffectIntentLabels`), in the form a navigation is decided on
 * (`NavigateCallback`'s `consumed`), or `undefined` where it carries none
 * this build can read, which is decided as a navigation made with no labels.
 */
function chosenFromOf(value: unknown): (() => SinkConsumedLabel) | undefined {
  if (!isObjectNotArray(value)) return undefined;
  const confidentiality = atomsOf(value.confidentiality);
  const integrity = atomsOf(value.integrity);
  if (confidentiality === undefined || integrity === undefined) {
    return undefined;
  }
  const modulePolicySpaces = new Map<string, Set<MemorySpace>>();
  const byArtifact = value.modulePolicySpaces;
  if (!isObjectNotArray(byArtifact)) return undefined;
  for (const [key, spaces] of Object.entries(byArtifact)) {
    if (!Array.isArray(spaces)) return undefined;
    const set = new Set<MemorySpace>();
    for (const space of spaces) {
      if (!isDID(space)) return undefined;
      set.add(space);
    }
    modulePolicySpaces.set(key, set);
  }
  const read: SinkConsumedLabel = {
    confidentiality,
    integrity,
    modulePolicySpaces,
    sources: [],
  };
  return () => read;
}

/**
 * The labels an intent is decided on: what chose its target, as the intent
 * says (`chosenFrom`), joined with the labels stored where the intent sits
 * (`stored`). An entry the server wrote stores none, so the join is the
 * intent's own; one something else wrote stores the labels of what that
 * write was made from, which the intent's own claim does not lower.
 *
 * Integrity is evidence an exchange rule can discharge confidentiality on,
 * such as a `HasRole` fact. The claim is data the entry's writer chose, so
 * its integrity is taken only where nothing is stored, where it can speak
 * only to its own claim; where labels are stored, the stored integrity is
 * taken instead. Either one failing to read fails the join.
 */
function joinedLabels(
  chosenFrom: () => SinkConsumedLabel,
  stored: () => SinkConsumedLabel,
): () => SinkConsumedLabel {
  return () => {
    const claimed = chosenFrom();
    const held = stored();
    const modulePolicySpaces = new Map<string, Set<MemorySpace>>();
    for (
      const [key, spaces] of [
        ...claimed.modulePolicySpaces,
        ...held.modulePolicySpaces,
      ]
    ) {
      const set = modulePolicySpaces.get(key) ?? new Set<MemorySpace>();
      for (const space of spaces) set.add(space);
      modulePolicySpaces.set(key, set);
    }
    const holdsLabels = held.confidentiality.length > 0 ||
      held.integrity.length > 0;
    return {
      confidentiality: [...claimed.confidentiality, ...held.confidentiality],
      integrity: holdsLabels ? held.integrity : claimed.integrity,
      modulePolicySpaces,
      sources: [],
    };
  };
}

export class EffectsChannel {
  readonly #runtime: Runtime;

  /** The enacted-nonce record (LT8): reload-wiped by construction. A
   * FAILED enactment retracts its nonce (owner review P1-1), so the
   * record holds successes and in-flight attempts only. */
  readonly #enacted = new Set<string>();

  /** In-flight enactments by nonce — the outcome every ack must chain
   * on (protocol.md §5's "enacts, THEN commits an authored ack"):
   * resolves true on success (record kept, acks release), false on
   * failure (record retracted; the entry — still unacked in the store
   * — re-enacts on a later delivery). */
  readonly #enactInFlight = new Map<string, Promise<boolean>>();

  /** Spaces whose session effects instance this channel watches. */
  readonly #spaces = new Set<MemorySpace>();

  /** The ONE storage-notification listener (design (e) item 13). */
  #listener: CoalescedDocListener | undefined;

  /** DIAGNOSTIC (tests): reconciles run from notifications / re-reads. */
  #reconciles = 0;

  /** In-flight ack writes (`${space}\0${nonce}`) — one authored ack per
   * nonce at a time; a failed ack retries on the next sink delivery
   * (the entry is still unacked there). */
  readonly #acking = new Set<string>();

  #warnedNoNavigate = false;

  /** Withheld intents, by intent and outcome, each reported once. */
  readonly #reportedWithheld = new Set<string>();

  /**
   * Intents withheld definitively and acked as done for this session. Not
   * enacted, so they are kept apart from {@link #enacted}.
   */
  readonly #withheldForSession = new Set<string>();
  #closed = false;

  constructor(runtime: Runtime) {
    this.#runtime = runtime;
  }

  /** DIAGNOSTIC (tests): whether a nonce is recorded enacted. */
  hasEnacted(nonce: string): boolean {
    return this.#enacted.has(nonce);
  }

  /** DIAGNOSTIC (tests): how many distinct nonces this life recorded
   * enacted — the UNCONDITIONAL convergence witness (independent
   * review NOTE-e): one navigation journey converging by nonce records
   * exactly ONE, whether or not a store poll ever sampled the
   * transient intent; a divergent optimistic/authoritative pair
   * records two. */
  get enactedNonceCount(): number {
    return this.#enacted.size;
  }

  /** DIAGNOSTIC (tests): reconciles run (notification-driven + the
   * resubscribe re-read). */
  get reconcileCount(): number {
    return this.#reconciles;
  }

  /** DIAGNOSTIC (tests): whether the notification listener is live. */
  get listenerInstalled(): boolean {
    return this.#listener?.installed === true;
  }

  /** Enact `nonce` at most once in this life: run `work` and record
   * the nonce, or CONVERGE on the enactment already recorded for it.
   * This is the OPTIMISTIC arm's entry point — the speculation
   * overlay's navigateTo flush — and it meets this channel's own
   * authoritative delivery on the shared record in either order, so
   * one navigation results (protocol.md §5; T2.Q7). An enactment still
   * in flight is awaited rather than assumed: it FAILING retracts its
   * record, and this caller then enacts, so convergence never stands
   * on an enactment that did not happen. Resolves true when the
   * nonce's enactment succeeded, false when the work this call ran
   * failed — which leaves the durable entry unacked for a later
   * delivery to re-enact. */
  async enactOnce(
    nonce: string,
    work: () => Promise<unknown>,
  ): Promise<boolean> {
    for (;;) {
      const inFlight = this.#enactInFlight.get(nonce);
      if (inFlight === undefined) break;
      if (await inFlight) return true;
    }
    if (this.#enacted.has(nonce) || this.#withheldForSession.has(nonce)) {
      return true;
    }
    return await this.#beginEnactment(nonce, work);
  }

  /** Subscribe to this session's effects instance in `space` (idempotent
   * per space). The doc names scope "session" and NO key: the instance
   * resolves from the runtime's own authenticated session, and push
   * delivers only this session's rows (protocol.md §3's applicable
   * set). */
  ensureSubscribed(space: MemorySpace): void {
    if (this.#closed || this.#spaces.has(space)) return;
    if (this.#runtime.installedSealDestination !== undefined) {
      // A runtime with a WAVE seal destination installed is serving-side
      // machinery (or a wave test bench), never a client enact surface —
      // production non-serving runtimes never install one
      // (installSealDestination's contract). Subscribing here would
      // inject the watch's setup into the wave's serial seal order. Skip.
      return;
    }
    this.#spaces.add(space);
    try {
      this.#ensureListener();
      // The WATCH + the RESUBSCRIBE re-read (protocol.md §5's reload
      // journey; LT8): the schema-less selector keeps the session
      // instance watched (pushes arrive as notifications), and the pull
      // it issues brings the STORED instance — a fresh runtime whose
      // instance already holds unacked intents sees nothing until the
      // next commit otherwise. Reconcile when it lands (the arrival's
      // own notification reconciles too; the reconcile is idempotent by
      // nonce).
      const pulled = this.#runtime.storageManager.open(space).sync(
        SERVER_EXECUTION_EFFECTS_DOC_ID as URI,
        { path: [], schema: false },
        "session",
      );
      this.#runtime.trackAsyncWork(
        Promise.resolve(pulled).then((result) => {
          if (result?.error !== undefined) {
            logger.warn("effects-resubscribe-read-failed", () => [
              `effects-doc re-read for ${space} failed; unacked intents ` +
              "enact only on the next push",
              result.error,
            ]);
            return;
          }
          this.#reconcileFromReplica(space);
        }).catch((error) => {
          // The re-read failing means this life may never see its
          // UNACKED intents until the next commit touches the doc —
          // loud, like the subscribe-failure arm below.
          logger.warn("effects-resubscribe-read-failed", () => [
            `effects-doc re-read for ${space} failed; unacked intents ` +
            "enact only on the next push",
            error,
          ]);
        }) as Promise<unknown>,
      );
    } catch (error) {
      // Leave the space un-subscribed so a later ensureSubscribed can
      // retry (the sink-era posture).
      this.#spaces.delete(space);
      logger.warn("effects-subscribe-failed", () => [
        `effects-doc subscription for ${space} failed; intents for this ` +
        "space will not enact in this runtime",
        error,
      ]);
    }
  }

  /** Record `nonce` as enacted BEFORE `work` (the enactment itself)
   * settles — the mid-flight convergence guard: the authoritative
   * intent can arrive mid-enactment and must converge, not
   * double-navigate. The outcome rides with the record (owner review
   * P1-1; protocol.md §5's enact-then-ack ordering): SUCCESS keeps the
   * record and releases any ack chained on the returned promise;
   * FAILURE retracts the record and withholds the ack, so the durable
   * entry — still unacked in the store — re-enacts on a later
   * delivery (or the LT8 reload re-read). A definitive withhold is not a
   * failure here: the delivery's `work` resolves it as done, and it acks
   * (see the header).
   *
   * BOTH records are installed before `work` is invoked, so a callback
   * that enacts synchronously — or that re-enters a reconcile before
   * returning its promise — meets the record rather than a gap, and a
   * synchronous throw resolves as a failed enactment. `work` is still
   * called on this turn, which keeps a caller's own bookkeeping (the
   * delivery arm's `trackAsyncWork`) on the turn that started it. */
  #beginEnactment(
    nonce: string,
    work: () => Promise<unknown>,
  ): Promise<boolean> {
    this.#enacted.add(nonce);
    const started = Promise.withResolvers<unknown>();
    const settled = started.promise.then(() => true, (error) => {
      if (error instanceof NavigationWithheldError) {
        // Withheld, and not retired here: an undecidable intent waits for a
        // delivery that can be decided, and an optimistic flush leaves the
        // server's intent to decide. Reported once.
        this.#reportWithheld(
          nonce,
          error.definitive
            ? "on labels this viewer is refused; the server's intent decides " +
              "whether it retires"
            : "with nothing it can yet be decided on; left unacked",
        );
        return false;
      }
      logger.warn("enact-failed", () => [
        `navigate enactment for ${nonce} failed; left unacked — a ` +
        "later delivery retries",
        error,
      ]);
      return false;
    }).then((ok) => {
      this.#enactInFlight.delete(nonce);
      if (!ok || this.#withheldForSession.has(nonce)) {
        this.#enacted.delete(nonce);
      }
      return ok;
    });
    this.#enactInFlight.set(nonce, settled);
    try {
      started.resolve(work());
    } catch (error) {
      started.reject(error);
    }
    return settled;
  }

  /**
   * The labels stored where the intent at `index` of `space`'s session
   * instance sits, read now through a transaction that never commits, for a
   * decision made later. Labels that cannot be read are not: asking for
   * them raises the failure.
   */
  #storedLabels(space: MemorySpace, index: number): () => SinkConsumedLabel {
    let read: SinkConsumedLabel;
    try {
      const tx = this.#runtime.readTx();
      this.#runtime.getCellFromLink({
        space,
        id: SERVER_EXECUTION_EFFECTS_DOC_ID as URI,
        scope: "session",
        path: ["entries", String(index)],
      }).withTx(tx).getRaw();
      read = collectConsumedLabel(tx);
    } catch (error) {
      return () => {
        throw error;
      };
    }
    return () => read;
  }

  /**
   * Reports that an intent was withheld and how, once per intent and
   * outcome in this life.
   */
  #reportWithheld(nonce: string, how: string): void {
    const key = `${nonce}\0${how}`;
    if (this.#reportedWithheld.has(key)) return;
    this.#reportedWithheld.add(key);
    logger.warn("enact-withheld", () => [
      `navigate intent ${nonce} withheld by the display ceiling ${how}`,
    ]);
  }

  /** ONE listener per channel (design (e) item 13): wants the session
   * effects doc of every subscribed space; reconciles in a microtask. */
  #ensureListener(): void {
    if (this.#listener !== undefined) return;
    const listener = new CoalescedDocListener(this.#runtime.storageManager, {
      wants: (space, id, scope) =>
        id === SERVER_EXECUTION_EFFECTS_DOC_ID && scope === "session" &&
        this.#spaces.has(space),
      onNotify: (space) => this.#reconcileFromReplica(space),
    });
    listener.ensure();
    this.#listener = listener;
  }

  /** Read the RAW session instance from the replica (no transaction, no
   * proxy) and reconcile it. */
  #reconcileFromReplica(space: MemorySpace): void {
    if (this.#closed || !this.#spaces.has(space)) return;
    let value: SessionEffectsDocValue | undefined;
    try {
      value = this.#runtime.storageManager.open(space).replica.getDocument(
        SERVER_EXECUTION_EFFECTS_DOC_ID as URI,
        "session",
      )?.value as SessionEffectsDocValue | undefined;
    } catch (error) {
      logger.warn("effects-read-failed", () => [
        `effects-doc read for ${space} failed; reconcile skipped`,
        error,
      ]);
      return;
    }
    this.#reconciles += 1;
    logger.debug("effects-reconcile", () => [
      `effects reconcile for ${space}`,
    ]);
    this.#reconcile(space, value);
  }

  /** One delivery of the session's effects instance: enact unacked
   * intents this runtime has not enacted (recording each), converge on
   * already-enacted nonces, and ack every unacked entry by nonce. */
  #reconcile(
    space: MemorySpace,
    value: SessionEffectsDocValue | undefined,
  ): void {
    if (this.#closed) return;
    if (!isObjectOrArray(value)) return;
    const entries = Array.isArray(value.entries) ? value.entries : [];
    const acks = isObjectNotArray(value.acks) ? value.acks : {};
    for (const [index, entry] of entries.entries()) {
      if (
        !isObjectOrArray(entry) ||
        typeof entry.nonce !== "string"
      ) {
        continue;
      }
      const nonce = entry.nonce;
      if ((acks as Record<string, unknown>)[nonce] === true) continue;
      const inFlight = this.#enactInFlight.get(nonce);
      if (inFlight !== undefined) {
        // An enactment (optimistic or authoritative) is MID-FLIGHT:
        // chain the ack on its SUCCESS (protocol.md §5's enact-then-ack
        // ordering; owner review P1-1) — a failure retracts the record
        // and a later delivery retries instead of acking a navigation
        // that never happened.
        void inFlight.then((ok) => {
          if (ok && !this.#closed) this.#ack(space, nonce);
        });
        continue;
      }
      if (!this.#enacted.has(nonce) && !this.#withheldForSession.has(nonce)) {
        if (entry.kind !== "navigate") {
          // A kind this client does not ship (protocol.md §5's closed
          // set): leave it unacked — acking would claim an enactment
          // that never happened.
          logger.warn("unknown-intent-kind", () => [
            `effects intent ${nonce} carries unknown kind ` +
            `${String((entry as { kind?: unknown }).kind)}; left unacked`,
          ]);
          continue;
        }
        const navigate = this.#runtime.navigateCallback;
        if (navigate === undefined) {
          // No enactment surface on this runtime (a headless client):
          // leave the intent unacked — a capable client of the same
          // session (or a reload with a callback) enacts it.
          if (!this.#warnedNoNavigate) {
            this.#warnedNoNavigate = true;
            logger.warn("no-navigate-callback", () => [
              "effects intents arriving but navigateCallback is not " +
              "set; intents stay unacked",
            ]);
          }
          continue;
        }
        let work: () => Promise<unknown>;
        try {
          const target = entry.args?.target;
          if (!isObjectOrArray(target)) {
            throw new Error("intent carries no target");
          }
          const targetCell = this.#runtime.getCellFromLink({
            space: (target.space ?? space) as MemorySpace,
            id: target.id as never,
            scope: (target.scope ?? "space") as never,
            path: [...(target.path ?? [])],
          });
          // What chose the target, as the server measured it, joined with
          // the labels stored where the intent sits: the navigation is
          // decided on them as one this runtime's own run chose is.
          const chosenFrom = chosenFromOf(entry.args?.chosenFrom);
          const decidedOn = chosenFrom === undefined
            ? undefined
            : joinedLabels(chosenFrom, this.#storedLabels(space, index));
          work = () => {
            const enacting = Promise.resolve().then(() =>
              navigate(targetCell, decidedOn)
            ).catch((error: unknown) => {
              // Withheld on labels this viewer is refused: the intent is
              // done for this session, as it would be refused again, so it
              // is acked rather than left to pile up. Withheld for want of
              // labels, it stays pending (`#beginEnactment`).
              if (
                error instanceof NavigationWithheldError && error.definitive
              ) {
                this.#withheldForSession.add(nonce);
                this.#reportWithheld(
                  nonce,
                  "on labels this viewer is refused; acked as done for this " +
                    "session",
                );
                return;
              }
              throw error;
            });
            this.#runtime.trackAsyncWork(enacting);
            return enacting;
          };
        } catch (error) {
          // Staging failed (malformed target, a cell-construction
          // throw): nothing was recorded and nothing acks — the entry
          // stays unacked, loud on every delivery (the session-lifetime
          // GC is the eventual backstop for a permanently malformed
          // entry, protocol.md §5).
          logger.warn("enact-failed", () => [
            `navigate enactment for ${nonce} could not be staged; ` +
            "left unacked",
            error,
          ]);
          continue;
        }
        // Record BEFORE the (deferred) callback can run — a re-entrant
        // delivery converges on the in-flight record instead of
        // double-enacting — and chain the ack on SUCCESS only.
        // Tracked through its ack, so that a caller waiting for the runtime
        // to settle sees the intent acked or left pending, not in between.
        this.#runtime.trackAsyncWork(
          this.#beginEnactment(nonce, work).then((ok) => {
            if (ok && !this.#closed) this.#ack(space, nonce);
          }),
        );
        continue;
      }
      // A settled-successful record (this life enacted it, or the
      // optimistic flush completed): ack converges without re-enacting.
      this.#ack(space, nonce);
    }
  }

  /** The ack (protocol.md §5): an ordinary authored write of this
   * session's own ack mark — `acks[nonce] = true` — into the instance
   * its authenticated session resolves to. Once per nonce in flight; a
   * failed commit retries on the next delivery (the entry is still
   * unacked in the store). */
  #ack(space: MemorySpace, nonce: string): void {
    const key = `${space}\0${nonce}`;
    if (this.#acking.has(key)) return;
    this.#acking.add(key);
    try {
      const tx = this.#runtime.edit();
      this.#runtime.getCellFromLink<boolean>({
        space,
        id: SERVER_EXECUTION_EFFECTS_DOC_ID as never,
        scope: "session",
        path: ["acks", nonce],
      }).withTx(tx).set(true);
      const committed = tx.commit();
      this.#runtime.trackAsyncWork(committed as Promise<unknown>);
      committed.then(({ error }) => {
        this.#acking.delete(key);
        if (error) {
          logger.warn("ack-failed", () => [
            `effects ack for ${nonce} failed; retrying on the next ` +
            "delivery",
            error,
          ]);
        }
      }).catch((error) => {
        this.#acking.delete(key);
        logger.warn("ack-failed", () => [
          `effects ack for ${nonce} rejected; retrying on the next ` +
          "delivery",
          error,
        ]);
      });
    } catch (error) {
      this.#acking.delete(key);
      logger.warn("ack-failed", () => [
        `effects ack for ${nonce} could not be staged`,
        error,
      ]);
    }
  }

  /** Dispose: release the listener. The enacted-nonce record dies with
   * the process (LT8's accepted wipe). */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const listener = this.#listener;
    this.#listener = undefined;
    listener?.release();
    this.#spaces.clear();
  }
}
