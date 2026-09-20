// The wave accumulator (server-execution v2 Phase 1 stage D,
// docs/specs/server-side-execution/serving-loop.md §3c–§3d): the seal
// destination a serving runtime's action transactions close into, and the
// wave commit step that batches what sealing attached.
//
// One abstraction, two destinations: `action(tx)` keeps its object and
// interface — 1 action run = 1 IExtendedStorageTransaction — and only the
// DESTINATION differs. On a client (the OFF arm always, and ON-arm
// speculation) seal == commit exactly as today. Server-side, under
// EXPERIMENTAL_SERVER_EXECUTION, the tx seals here instead: its writes
// apply to the space replica's optimistic overlay — the accumulator's
// layered view, store snapshot at the wave's input seq + previously
// sealed writes, which later action runs read through the ordinary read
// path — and the store commit is deferred to the wave.
//
// Sealing fires everything commit fires today: the per-action-run CFC
// gates run unchanged in ExtendedStorageTransaction.commit() before the
// destination dispatch (§3c — the unit is the RUN, `action × instance`,
// never the action), the reactivity log keeps feeding the scheduler's
// dependency graph from the tx journal, and the sealed commit's read set
// feeds the wave's per-doc CAS basis and the scheduler_basis rows (§3b).
// Identity annotations attach AT SEAL TIME, when the run still knows who
// it ran as; the wave commit step only batches what sealing attached — by
// then no single "current user" exists to consult, which is the model,
// not a gap (protocol.md §1).
//
// Nothing installs this on main: the serving loop that drives waves is
// Phase 1 stage F. The machinery lands dark, exercised by tests.

import type { CellScope } from "@commonfabric/api";
import {
  type CommitPrecondition,
  type ConfirmedRead,
  type DerivedWriteAnnotation,
  type Operation,
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
  type SessionReadCeiling,
  STREAM_ENTRIES_DOC_PREFIX,
  toDirtyKey,
} from "@commonfabric/memory/v2";
import type { OutboxAppendRow } from "@commonfabric/memory/v2/execution-outbox";
import type {
  CommitError,
  IExtendedStorageTransaction,
  ISpaceReplica,
  IStorageTransaction,
  ITransactionSealSink,
  MemorySpace,
  NativeStorageCommit,
  Result,
  SealedCommitVerdict,
  SealedNativeCommit,
  StorageTransactionRejected,
  TransactionSealDestination,
  Unit,
  URI,
} from "../storage/interface.ts";
import { parsePointer, pathsOverlap } from "../../../memory/v2/path.ts";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import { normalizeCellScope, scopeRank } from "../scope.ts";
import {
  getTransactionReadActivities,
  hasPendingWriteElision,
} from "../storage/transaction-inspection.ts";

const logger = getLogger("wave-accumulator", {
  enabled: true,
  level: "warn",
});

/**
 * What kind of run a contribution came from, deciding its writes' conflict
 * class at the wave commit's per-doc CAS (serving-loop.md §3d):
 *
 * - `derivation` writes are PURE — re-derivable, so a write whose doc head
 *   advanced past the wave's basis is DROPPED; the drop re-arms nothing —
 *   recomputation arrives only through the ordinary dependency path
 *   (serving-loop.md §3d, RULED 2026-08-05);
 * - `event-handler` writes are NON-RE-DERIVABLE consequences — rebased and
 *   retried on conflict, and REQUEUED (rolled back to unconsequenced,
 *   never lost) when the rebase conflicts semantically;
 * - `bookkeeping` is the SANCTIONED INTERNAL STAMP KIND stage F names
 *   when it installs the seal destination (serving-loop.md §3d, RULED
 *   2026-08-05: unstamped seals are refused, so the loop's own writes —
 *   the watermark-doc advance today; the acked-effect retirement write
 *   when Phase 4 lands the client-effect channel, protocol.md §5 —
 *   declare this kind; stage G's outbox-ROW retirement is an unstamped
 *   engine-table delete on plane (c), never a commit). Conflict class:
 *   non-re-derivable, so a raced bookkeeping PATCH rebases when it
 *   commutes with the concurrent commit (the loop's steady-state
 *   watermark advance is a key-path patch); a write that cannot rebase
 *   — a whole-doc set (the first-ever watermark write materializing
 *   the doc), or a semantic conflict such as a whole-doc authored
 *   intrusion — DROPS the contribution whole: there is no event to
 *   requeue, and no re-advance is scheduled by the drop itself. The
 *   loop's watermark advance is INPUT-driven, so the dropped doc write
 *   is re-landed only by the next input batch's advance — on a quiet
 *   space the doc simply lags (while the wave's commit metadata and
 *   the loop's in-memory W, decided before the drop, already carry the
 *   advance — see space-server.ts's bookkeeping-write comment).
 *   Watermark forgery is an accepted authored intrusion — protocol.md
 *   §1's threat model.
 *
 * The remaining §3d non-re-derivable members — `eventWatermark` advances
 * and effect intents — are produced by Phase 3 events and the stage-G
 * effect channel; they seal as `event-handler`-class contributions when
 * their producers exist.
 */
export type WaveRunKind = "derivation" | "event-handler" | "bookkeeping";

/**
 * The run identity a seal attaches to its writes (protocol.md §1's
 * transaction identity model). Stamped onto the action's transaction by
 * whatever drives the run — the serving loop knows what it is running
 * (the demand's instance, or the event's server-stamped `firedAt` actor) —
 * and consumed here at seal time.
 */
export interface WaveRunContext {
  /** Durable action identity for basis rows (serving-loop.md §3b):
   * restart-stable, never per-process. */
  actionId: string;

  kind: WaveRunKind;

  /** ATTRIBUTION — the acting identity, one per action run, where the run
   * has one. A run with no acting identity (a space-scope derivation
   * before any narrowing) carries none (protocol.md §1). */
  acting?: { user: string; session?: string };

  /** The event this handler run consequences (`consequenceOf` carriage). */
  eventId?: string;

  /** The durable stream entry this handler run is processing (Phase 3;
   * OW14's source-event carriage): a cross-space append the run emits
   * records `{sidecarId, eventId}` on its outbox row so a
   * deterministic delivery refusal can write its failure notice onto
   * the SOURCE entry (protocol.md §2b's LT4 ruling). */
  streamEntry?: { sidecarId: string; index: number; seq: number };

  /** The same-wave parent event of a cascade-minted event: a requeued
   * parent folds this contribution into the requeue set (§3d; the
   * model's C8d rollback closure). */
  parentEventId?: string;

  /** This handler run is the LT1 same-space IN-PROCESS copy of an event
   * some contribution of this wave emitted (cell.ts's serving-arm send;
   * stage C build W3, (α3)): its durable entry rides the EMITTER's
   * sealed write and the batch marks it there — so an LT1 copy whose
   * emitter write this wave withdraws, or whose emitter never reached
   * the wave at all (a refused or failed emitter seal), has NO durable
   * entry behind it and is refused as an orphan (events.md §4's third
   * clause). Never set on a drain copy (which carries a `streamEntry`)
   * or a plain in-process event on the serving runtime. */
  lt1?: true;

  /** The scope INSTANCE this run ran as, for basis rows'
   * action_scope_key. Typed as the shared `ScopeKey` vocabulary so a
   * caller cannot hand the basis index a scope NAME or a hand-rolled
   * format (key-vocabulary.md §4). Defaults to `"space"` — the
   * pre-narrowing instance; stage F's serving loop supplies per-run
   * demanded instances. */
  actionScopeKey?: ScopeKey;

  /** M1 — the PER-RUN identity this run's scoped reads and writes
   * resolve their instance keys against (scopes.md §5, §7 M1): the
   * demand-supplied instance identity for a derivation, the event's
   * server-stamped `firedAt` pair for a handler. When absent the
   * accumulator falls back to its wave-level identity (the OFF-arm
   * cardinality-1 posture, and pre-narrowing space-scope runs, which
   * resolve no scoped addresses at all). */
  scopeKeyIdentity?: ScopeKeyIdentity;

  /** The read ceiling this run's `db.query` reads are bounded by: the
   * ceiling of the session the run acts as (`scopeKeyIdentity.sessionId`),
   * read from the memory server's session record at the stamp
   * (`Server.sessionReadCeiling`) — declared by the client in its signed
   * `session.open` descriptor, or assigned by the server. The sqlite
   * builtin meets it with the serving runtime's own option, exactly as it
   * meets a query's declared ceiling with a runtime's (06-cfc.md, "Runtime
   * read ceiling"). Absent on a run acting as no session, or as one that
   * declared none: such a run reads under the runtime's option alone. */
  readCeiling?: SessionReadCeiling;

  /** The capability grant a provisioning run's FOREIGN writes are
   * admitted under (protocol.md §2's server-produced authored row, §2b):
   * carried with the acting identity into the foreign commit's metadata
   * for the target's delegated-capability admission. */
  capabilityRef?: string;

  /** Server-execution v2 fan-out stage B (RULED 2026-08-16, design §F):
   * this DERIVATION run's `acting`/`capabilityRef` are DERIVED FROM THE
   * SCOPE IT DISCOVERS — space → none; user → the user; session → the
   * pair — settled at the seal from the transaction's read-scope
   * ratchet ({@link settleScopeAttribution}), and at a mid-run emission
   * from the ratchet so far ({@link actingForEmission}). Stamped by the
   * serving loop for a demanded derivation instead of an eager acting
   * pair. Absent on handler runs (explicit `firedAt` actor — LD1),
   * bookkeeping, and every context off the serving posture. */
  attributionFromScope?: boolean;

  /** The BROADEST scope any emission from this run was attributed at
   * (the early-emit guard's evidence): set by {@link actingForEmission};
   * a seal whose final discovered scope is NARROWER than it refuses the
   * contribution fail-closed (design risk 4 — an under-attributed event
   * never commits; the retry, at the moved ratchet, attributes it
   * right). */
  emissionAttributionScope?: CellScope;
}

/** The accept gate's authority probe result (protocol.md §2b): a bare
 * boolean (test/mechanics waves), or the memory server's full verdict —
 * whose `via` arm the wave RETAINS per (space, acting user) so the
 * commit step can force a `creation`-granted target's genesis ahead of
 * the sink (OW31 B4; INV-13's precedence on the engine-direct plane). */
export type ForeignWriteGrantResult =
  | boolean
  | { granted: true; via: "owner" | "creation" | "acl" }
  | { granted: false; reason?: string };

const waveRunContexts = new WeakMap<object, WaveRunContext>();

/** The scope name a run's stamped instance key stands at (`space`,
 * `user:…`, `session:…`) — the attribution FLOOR of a fanned-out run:
 * what the node has already learned by running (its known-scope ratchet
 * for this principal), below which no read of THIS run can be. */
const scopeOfInstanceKey = (key: ScopeKey | undefined): CellScope =>
  key === undefined
    ? "space"
    : key.startsWith("session:")
    ? "session"
    : key.startsWith("user:")
    ? "user"
    : "space";

/** The identity components a scope-attributed run ACTS AS at `scope`
 * (design §F): space → none; user → `{user}` (a user-scoped instance
 * value belongs to all of the user's sessions — the representative
 * session was resolution scaffolding); session → `{user, session}`. */
const actingAtScope = (
  identity: ScopeKeyIdentity | undefined,
  scope: CellScope,
): { user: string; session?: string } | undefined => {
  if (identity?.principal === undefined || scope === "space") {
    return undefined;
  }
  if (scope === "user" || identity.sessionId === undefined) {
    return { user: identity.principal };
  }
  return { user: identity.principal, session: String(identity.sessionId) };
};

/**
 * Settle a scope-attributed derivation run's `acting` and `capabilityRef`
 * from its FINAL discovered scope, at the seal (server-execution v2
 * fan-out stage B, RULED 2026-08-16 — design §F): from here on every
 * consumer of the context — the write annotations, the foreign-write
 * accept gate, the delegated carriage, the outbox carriage a completion
 * inherits — reads the settled pair. A run that discovered nothing scoped
 * carries none (a space node demanded by anyone acts as nobody). No-op
 * for every other context.
 */
export function settleScopeAttribution(
  context: WaveRunContext,
  discovered: CellScope,
): void {
  if (context.attributionFromScope !== true) return;
  const acting = actingAtScope(context.scopeKeyIdentity, discovered);
  if (acting === undefined) {
    delete context.acting;
    delete context.capabilityRef;
    return;
  }
  context.acting = acting;
  context.capabilityRef = `demanded-run:${acting.user}`;
}

/**
 * The actor a run's MID-RUN emission carries (the LT6 send site; design
 * §F's point of use): a scope-attributed derivation derives it from the
 * broader of the transaction's read-scope ratchet SO FAR and the run's
 * stamped instance key (the node's known-scope ratchet — what running has
 * already discovered for this principal), and RECORDS the scope used so
 * the seal can refuse the contribution if the run later narrows below it
 * (the early-emit guard, fail-closed — design risk 4). Every other
 * context returns its stamped `acting` unchanged.
 */
export function actingForEmission(
  context: WaveRunContext,
  tx: IExtendedStorageTransaction,
): { user: string; session?: string } | undefined {
  if (context.attributionFromScope !== true) return context.acting;
  const soFar = normalizeCellScope(tx.getNarrowestReadScope?.());
  const floor = scopeOfInstanceKey(context.actionScopeKey);
  const scope = scopeRank(soFar) >= scopeRank(floor) ? soFar : floor;
  if (
    context.emissionAttributionScope === undefined ||
    scopeRank(scope) < scopeRank(context.emissionAttributionScope)
  ) {
    context.emissionAttributionScope = scope;
  }
  return actingAtScope(context.scopeKeyIdentity, scope);
}

/**
 * Stamp the run context onto an action's transaction before the run
 * commits. The wave machinery that drives the scheduler owns the stamp,
 * and it is MANDATORY: `seal()` REFUSES an unstamped transaction
 * (serving-loop.md §3d, RULED 2026-08-05) — every server-side commit
 * path declares its run context, and stage F names the sanctioned
 * internal stamp kinds (e.g. a bookkeeping kind) when it installs the
 * seal destination.
 */
export function stampWaveRunContext(
  tx: IExtendedStorageTransaction,
  context: WaveRunContext,
): void {
  waveRunContexts.set(tx, context);
  // The tx→replica identity seam (server-execution v2 stage A, OW17): the
  // run's demand-supplied identity rides the STORAGE transaction too, so
  // its scoped reads resolve against ITS instance in the replica (one
  // local doc per instance) and its logged addresses name that instance
  // for the scheduler's per-instance dependency keys. Set exactly once
  // per transaction, before the run's first read (the storage tx
  // enforces both). A context without an identity — the wave-level
  // fallback, bookkeeping — leaves the manager's own in force.
  if (context.scopeKeyIdentity !== undefined) {
    tx.tx.scopeKeyIdentity = context.scopeKeyIdentity;
  }
}

export function waveRunContextOf(
  tx: IExtendedStorageTransaction,
): WaveRunContext | undefined {
  // Walk the wrapper chain (review thread r3739139477): the stamp is
  // keyed on the ORIGINAL transaction object, but scoped reads through
  // `Cell.sample()`/`Cell.sink()` arrive on a TransactionWrapper — a
  // different object — so a direct lookup missed the served run's
  // demand-supplied identity and the read resolved against the service
  // session (wrong scope instance, traversal keys recorded under the
  // service session). Duck-typed to avoid a storage-layer value import.
  let current: IExtendedStorageTransaction | undefined = tx;
  while (current !== undefined) {
    const context = waveRunContexts.get(current);
    if (context !== undefined) return context;
    current = (current as {
      wrappedTransaction?: IExtendedStorageTransaction;
    }).wrappedTransaction;
  }
  return undefined;
}

// The DURABLE-acceptance settlement of a tx sealed into a wave: the seal
// resolves the tx's commit() (acceptance into the wave), but the writes
// become durable only at the wave commit — and a conflict there can
// WITHDRAW the contribution after its commit() already resolved ok. A
// caller whose side effects must wait for durability (the pattern swap's
// teardown + reinstantiation, §3e) awaits this instead. Attached by the
// accumulator at seal, same side-table mechanism as the run context.
type WaveSettlement = Result<
  Unit,
  StorageTransactionRejected & {
    /** This run read a contribution whose optimistic state was withdrawn. */
    readDependencyWithdrawn?: true;
  }
>;

const waveSettlements = new WeakMap<
  IExtendedStorageTransaction,
  Promise<WaveSettlement>
>();

const requiresWaveAcceptance = new WeakSet<IStorageTransaction>();

/** Enrolls local state changes in wave acceptance even without storage writes. */
export function requireWaveAcceptance(tx: IExtendedStorageTransaction): void {
  requiresWaveAcceptance.add(tx.tx);
}

/** The sealed tx's wave settlement: resolves ok when every sealed space
 * promoted or its write-free publication was accepted, error when any
 * withdrew (conflict drop, requeue, abort, abandon). Undefined for a tx
 * outside a wave or with neither sealed writes, opted-in local state, nor a
 * derivation's pending-output elision obligation. */
export function waveSettlementOf(
  tx: IExtendedStorageTransaction,
): Promise<WaveSettlement> | undefined {
  return waveSettlements.get(tx);
}

/**
 * The addressing/attribution pair on one batched write is the wire-shape
 * module's `DerivedWriteAnnotation` (protocol.md §1, §7): one shared
 * shape for the runner attaching it at seal time and the engine consuming
 * the addressing half at admission — the LD3 direction of one definition,
 * imported by engine and runner alike.
 */
export type WaveWriteAnnotation = DerivedWriteAnnotation;

/**
 * One scheduler_basis row (serving-loop.md §3b): ids + seqs only, never
 * payloads. `seq: null` means "this wave's own commit seq" — in-wave reads
 * share it, and only the sink knows the number it allocates.
 */
export interface SchedulerBasisRow {
  action: string;
  actionScopeKey: ScopeKey;
  entitySpace: MemorySpace;
  entity: string;
  entityScopeKey: ScopeKey;
  seq: number | null;
}

/** One §3b overwrite unit of the wave's basis-index carriage: the LAST
 * run of (action, actionScopeKey) in the wave, whose rows replace that
 * instance's stored set. */
export interface WaveBasisInstanceRows {
  action: string;
  actionScopeKey: ScopeKey;
  rows: SchedulerBasisRow[];
}

/** The batched commit the wave hands the sink, per space. */
export interface WaveSpaceCommit {
  space: MemorySpace;

  /** Same-space emitted event entries this batch appends (LT1,
   * events.md §2): their declarations, so the engine's event-append
   * admission stamps each entry's stream `seq` (a derived append must
   * be DECLARED — seq stamping cannot be skipped by a plumbing bug). */
  eventAppends?: Array<{ id: string; scope?: CellScope; eventId: string }>;

  /** True for the home space's derived-class commit; false for a foreign
   * space's authored-class provisioning commit (protocol.md §2b). */
  home: boolean;

  /** The wave's read basis: the store seq of the wave's input snapshot.
   * The sink's re-verification compares doc heads against it. */
  basisSeq: number;

  /** Per doc-instance key (`${id} ${scopeKey}`): the head the wave's
   * REBASE decision observed (§3d's "re-CAS against the new head"). The
   * sink's re-verification MUST require these docs' heads to EQUAL the
   * recorded value — a head that moved past the decision invalidates the
   * field-level merge, and the wave re-decides against the new head. */
  rebasedHeads: ReadonlyArray<{ doc: string; head: number }>;

  /** Surviving operations, in seal order — the commit step never reorders
   * (§3's sealing-order MUST binds the loop's processing order; this step
   * preserves what it was handed). */
  operations: Operation[];

  preconditions: CommitPrecondition[];

  /** The read set the store validates as it does a client commit's — a
   * read whose document moved past its seq at its path refuses the whole
   * batch. A wave's batch carries none, its concurrency check being the
   * per-doc re-verification above; the serving loop's direct commit
   * carries its transaction's own reads. */
  confirmedReads?: ConfirmedRead[];

  /** Owning contribution index per precondition — home batch only; lets a
   * reported precondition failure resolve per write class. */
  preconditionOwners?: number[];

  /** Owning contribution index per operation — home batch only. The sink
   * returns the failed operation for a proven-no-commit row-label refusal,
   * letting the accumulator identify the one event whose deterministic write
   * was refused without terminalizing unrelated events in the same wave. */
  operationOwners?: number[];

  annotations: WaveWriteAnnotation[];

  /** Every eventId whose handler consequences ride this commit. */
  consequenceOf: string[];

  /** Basis rows to write INSIDE the same store transaction (§3b's
   * carriage rule — never own commits, never commit metadata), already
   * grouped into overwrite units: per (action, instance), the LAST
   * contributing run's set. */
  basisInstances: WaveBasisInstanceRows[];

  /** The DR1 lease holder identity the derived-class admission checks. */
  holder: string | undefined;

  /** The watermark this home commit is current through (protocol.md §4);
   * every split of one wave repeats the same value. Absent for waves
   * driven outside a serving loop (no watermark exists to carry) and on
   * foreign batches. */
  derivedThrough?: number;

  /** Foreign provisioning batches only (protocol.md §2's server-produced
   * authored row, §2b): the ORIGINATING chain actor + the capability
   * grant the target's admission validates — delegation, never
   * session-identity impersonation. */
  delegated?: {
    actingPrincipal: string;
    actingSession?: string;
    capabilityRef: string;
  };

  /** Per-op resolved scope keys for the batch's folded `sqlite` ops
   * (stage G, discharging the stage-D sqlite bound): the accumulator
   * resolves each op's db scope against its RUN's identity (M1 — the
   * wave envelope has no session to resolve scoped files from), and the
   * sink attaches the matching cell-db file(s) before its store
   * transaction. Ops whose db declares the space scope carry `"space"`
   * explicitly — every sqlite op in the batch has an entry. */
  sqliteScopeKeys?: ReadonlyArray<{ op: number; scopeKey: ScopeKey }>;

  /** The wave's outbound cross-space event appends (serving-loop.md §5,
   * FP1): durable rows the sink writes INSIDE the wave's own store
   * transaction, from surviving contributions only — a withdrawn
   * contribution's appends never ride (its event replays and re-emits).
   * Home batch only. */
  outboxAppends?: readonly OutboxAppendRow[];
}

/**
 * Why the sink refused a wave commit. `conflictedDocs` names doc-instance
 * keys whose head moved past the wave's basis after the accumulator's own
 * head query — the race window the resolve loop closes;
 * `failedPreconditions` names indexes into the batch's preconditions
 * array. A rejection naming neither is terminal for the wave.
 */
export interface WaveCommitRejection {
  name: "WaveCommitRejected" | "RowLabelCommitError";
  message: string;
  conflictedDocs?: readonly string[];
  failedPreconditions?: readonly number[];

  /** Operation index for a deterministic RowLabelCommitError. */
  failedOperation?: number;
}

/**
 * Where the wave commit step commits to. Stage F implements this on the
 * loopback plane (serving-loop.md §1 plane (a)) with the derived-class
 * admission of protocol.md §2; tests implement it directly against an
 * engine. The contract the implementations carry:
 *
 * - `commitWave` MUST apply the batch, its basis rows, and its
 *   consequence/annotation carriage in ONE store transaction;
 * - `commitWave` MUST re-verify, inside that transaction, every doc the
 *   batch writes: a doc in `rebasedHeads` must sit at EXACTLY the head
 *   the rebase decision observed, every other doc's head must not have
 *   passed `basisSeq`, and offenders are reported in `conflictedDocs` —
 *   the batch itself carries no store-level read CAS, and §3d forbids
 *   blind derived writes, so this re-verification is the load-bearing
 *   concurrency check;
 * - whole-wave CAS failure is FORBIDDEN (§3d): a rejection must name what
 *   conflicted (or which preconditions failed, by index) so the wave
 *   resolves per doc, per write class, and re-attempts. The loop
 *   converges without timers: drops and requeues are monotone, and a
 *   rebase re-decision happens only when a named doc's head actually
 *   advanced — each re-attempt observes strictly newer store state.
 */
export interface WaveCommitSink {
  /** Current head seq per doc-instance key (`${id} ${scopeKey}`),
   * 0 for a doc never written. */
  currentHeads(
    space: MemorySpace,
    docs: ReadonlyArray<{ id: string; scope?: CellScope; scopeKey: string }>,
  ): Promise<ReadonlyMap<string, number>>;

  /** The value paths written to a doc-instance by commits after `sinceSeq`
   * — the field-level merge input for the rebase of non-re-derivable
   * writes (§3d). */
  concurrentWritePaths(
    space: MemorySpace,
    doc: { id: string; scope?: CellScope; scopeKey: string },
    sinceSeq: number,
  ): Promise<ReadonlyArray<readonly string[]>>;

  /**
   * Whether a commit after `sinceSeq` wrote `doc` that `holder`'s own
   * derived commits do not account for — §3d's INTRUSION on a document
   * this tenure derives into. A sink that cannot answer omits it, and the
   * pure-derivation arm's view check below then stands down.
   */
  intrusionSince?(
    space: MemorySpace,
    doc: { id: string; scope?: CellScope; scopeKey: string },
    sinceSeq: number,
    holder: string | undefined,
  ): Promise<boolean>;

  commitWave(
    batch: WaveSpaceCommit,
  ): Promise<Result<{ seq: number }, WaveCommitRejection>>;
}

/**
 * The lease view the wave commit step checks (serving-loop.md §2, DR1):
 * work seals under the tenure it read and checks `isCurrentTenure` at its
 * commit step — a lease lost mid-wave aborts the in-flight wave commit.
 * `ExecutionLeaseCycle` satisfies this structurally.
 */
export interface WaveLease {
  readonly holder: string;
  readonly tenure: number;
  isCurrentTenure(sealedTenure: number): boolean;
}

/** One sealed action run held by the accumulator. */
interface WaveContribution {
  /** Set only by the closure that invalidates reads of withdrawn state. */
  readDependencyWithdrawn?: true;
  index: number;
  context: WaveRunContext;

  /** Per-space sealed commits, in the tx's commit order (children first,
   * home last — protocol.md §2b). */
  spaces: SealedSpaceContribution[];

  /** Doc-instance keys read in spaces this run WROTE NOTHING to (the
   * sealSpaceReads handoff — stage F, discharging the stage-D bound):
   * `${space}\0${docInstanceKey}`, folded into the withdrawn-read
   * closure by DOC IDENTITY. Conservative by design: a reader of a doc
   * some withdrawn contribution wrote folds in even when it read the
   * pre-seal state (layer provenance is replica-internal for unsealed
   * spaces) — over-dropping a derivation is sound, committing one
   * derived from withdrawn state is not (§3d). */
  readOnlyReadKeys: Set<string>;

  /** Verdict for a publication obligation with no replica writes. */
  emptySettlement?: {
    promise: Promise<Result<Unit, StorageTransactionRejected>>;
    resolve: (result: Result<Unit, StorageTransactionRejected>) => void;
  };

  /** Cross-space event appends this run emitted (serving-loop.md §5,
   * FP1): folded into the home batch's durable rows iff the
   * contribution survives — a withdrawn contribution's appends never
   * ride (its event replays and re-emits, the model's committed-only
   * `cascadesCross` fold). */
  outboundAppends: OutboxAppendRow[];

  /** The run's DISCOVERED scope at seal (scopes.md §2 S1 — the
   * transaction's read-scope ratchet, learned by running): the narrowest
   * scope of anything the run read, its diff bases and redirect slots
   * included. With the run identity it names the FULL instance address
   * the run actually served, which keys its basis rows (S4 —
   * server-execution v2 stage A). */
  discoveredScope: CellScope;

  /** Per home doc-instance key: the seq the replica's CONFIRMED view
   * stood at for that instance when this run sealed — the view its
   * writes rest on, which the wave's own basis can be ahead of
   * (#viewSeqsAtSeal). */
  viewSeqs: ReadonlyMap<string, number>;
}

interface SealedSpaceContribution {
  space: MemorySpace;
  native: NativeStorageCommit;
  sealed: SealedNativeCommit;
  resolveVerdict: (verdict: SealedCommitVerdict) => void;
}

/** How the wave commit step disposed of one contribution. */
export type ContributionDisposition =
  | { kind: "committed" }
  /** Some pure-derivation ops dropped (superseded); survivors rode the
   * wave commit. The sealed commit's local overlay rolls back whole and
   * reconverges from the wave commit arriving as confirmed state. */
  | { kind: "partially-dropped"; droppedOps: number }
  /** All ops withdrawn: a fully superseded derivation, or a derivation
   * that read a withdrawn contribution's sealed writes. */
  | { kind: "dropped" }
  /** A raced non-re-derivable consequence: rolled back to unconsequenced,
   * to be retried in a later wave — never lost, never doubled (§3d; NOT
   * events.md §5's DROP, which is for handlers that cannot run at all). */
  | { kind: "requeued" };

export interface WaveCommitOutcome {
  /** The home commit's store seq; absent when the wave had nothing to
   * commit or aborted. */
  seq?: number;

  aborted?: "lease-lost" | "abandoned" | "foreign-commit-failed" | "rejected";

  /** Superseded pure-derivation writes dropped at the per-doc CAS —
   * §7's `supersededWrites` counter feeds from this. */
  supersededWrites: number;

  /** Pure-derivation ops dropped because they read a withdrawn
   * contribution's sealed writes — re-derivable, and re-run through
   * their own reads when fresh state lands (§3d, RULED 2026-08-05).
   * Counted apart from `supersededWrites` so that counter keeps §3d's
   * exact meaning (doc head advanced past the basis). */
  dependencyDroppedWrites: number;

  /** Events rolled back to unconsequenced, in seal order — the serving
   * loop retries them in a later wave. */
  requeuedEventIds: string[];

  /** Events whose consequences committed (the commit's `consequenceOf`). */
  committedEventIds: string[];

  /** Refused handler runs for which the sink positively proved that no wave
   * commit occurred. The serving loop persists their commit-finalization
   * checkpoint in a later wave; ambiguous rejections never enter this list. */
  provenNoCommitDeliveryFailures: Array<{
    eventId: string;
    streamEntry: { sidecarId: string; index: number; seq: number };
    failureClass: "protocol";
    recoveryEpoch: string;
    permanentEvidence: true;
  }>;

  /** Event-handler contributions REFUSED as orphans (server-execution v2
   * stage C build W3, (α3); events.md §4's third clause): runs of an
   * LT1 same-wave cascade whose durable entry rode an emitter write
   * this wave withdrew — a derivation's superseded per-doc drop (re-arms
   * nothing), a dropped-whole or requeued emitter — so the entry never
   * lands and nothing re-emits it. Withdrawn, disposition `dropped`,
   * NOT reported as requeued (there is no entry to retry); the serving
   * loop's `events.orphanDeliveriesRefused` feeds from this. */
  orphanDeliveriesRefused: number;

  dispositions: ContributionDisposition[];

  /** Foreign provisioning batches this wave DURABLY COMMITTED, in commit
   * order — the serving loop's input for the EXPLICIT WARM REQUEST
   * (serving-loop.md §1's third activation trigger; RULED 2026-08-21).
   * Populated as each foreign batch lands, so an abort AFTER some
   * batches landed still reports them (§2b never rolls a landed foreign
   * commit back — its setup is durable and the target should warm
   * regardless of the home commit's fate). `writes` are the staged doc
   * instances: space-scope ops as `"space"`, scoped ops resolved
   * against the batch's carried delegated identity (an op the carried
   * identity cannot name is omitted — it could not be demanded by that
   * name either). */
  foreignCommits: Array<{
    space: MemorySpace;
    seq: number;
    writes: Array<{ id: string; scopeKey: ScopeKey }>;
  }>;
}

const docInstanceKey = (id: string, scopeKey: string): string =>
  `${id} ${scopeKey}`;

/** The staged doc instances of one foreign provisioning batch — the
 * warm request's payload (see `WaveCommitOutcome.foreignCommits`).
 * Space-scope ops key as `"space"`; scoped ops resolve against the
 * batch's carried delegated identity, exactly as the engine's
 * delegated admission keys them (scopes.md §5) — an op the carried
 * identity cannot name is omitted, since the target could not demand
 * it by that name either; sqlite ops carry no doc instance (and the
 * sink refuses them in foreign batches anyway). Deduped per
 * (id, scopeKey). Exported for its own contract tests. */
export const warmWritesOf = (
  batch: WaveSpaceCommit,
): Array<{ id: string; scopeKey: ScopeKey }> => {
  const writes = new Map<string, { id: string; scopeKey: ScopeKey }>();
  for (const op of batch.operations) {
    if (op.op === "sqlite") continue;
    let scopeKey: ScopeKey;
    const scope = normalizeCellScope(op.scope);
    if (scope === "space") {
      scopeKey = "space";
    } else if (batch.delegated !== undefined) {
      try {
        scopeKey = resolveScopeKey(scope, {
          principal: batch.delegated.actingPrincipal,
          ...(batch.delegated.actingSession !== undefined
            ? { sessionId: batch.delegated.actingSession as never }
            : {}),
        });
      } catch {
        continue;
      }
    } else {
      continue;
    }
    const key = toDirtyKey(op.id, scopeKey);
    if (!writes.has(key)) writes.set(key, { id: op.id, scopeKey });
  }
  return [...writes.values()];
};

/** The eventIds of the seq-LESS stream entries one sealed op appends —
 * the NEW events a wave carries (an engine-stamped entry carries its
 * seq; a rewrite of one needs no declaration). Mirrors the batch build's
 * entry-list walk (a `set` of the whole doc; a `patch` appending,
 * adding, or replacing `/value/entries`); read-only — it never clones
 * or marks. */
function seqLessStreamEntryEventIds(operation: Operation): string[] {
  const lists: unknown[][] = [];
  if (operation.op === "set") {
    const inner = (operation.value as { value?: { entries?: unknown[] } })
      ?.value;
    if (Array.isArray(inner?.entries)) lists.push(inner.entries);
  } else if (operation.op === "patch") {
    for (const patch of operation.patches) {
      if (
        (patch.op === "append" || patch.op === "add-unique") &&
        patch.path === "/value/entries" && Array.isArray(patch.values)
      ) {
        lists.push(patch.values as unknown[]);
      } else if (
        (patch.op === "add" || patch.op === "replace") &&
        patch.path === "/value/entries" &&
        Array.isArray((patch as unknown as { value?: unknown }).value)
      ) {
        lists.push((patch as unknown as { value: unknown[] }).value);
      }
    }
  }
  const ids: string[] = [];
  for (const list of lists) {
    for (const candidate of list) {
      const entry = candidate as { eventId?: unknown; seq?: unknown } | null;
      if (
        isObjectOrArray(entry) &&
        typeof entry.eventId === "string" && entry.seq === undefined
      ) {
        ids.push(entry.eventId);
      }
    }
  }
  return ids;
}

interface PendingAssembly {
  /** Undefined until the post-seal emptiness check: a tx with writes and
   * no context is refused; an empty tx needs none. */
  context: WaveRunContext | undefined;

  spaces: SealedSpaceContribution[];
  readOnlyReadKeys: Set<string>;
  discoveredScope: CellScope;
}

/**
 * The wave accumulator: seal destination for one wave's action
 * transactions, and the wave commit step over what they sealed.
 *
 * Actions run serially per space (serving-loop.md §3d) and their commits
 * arrive through `seal()` in the scheduler's order; the accumulator
 * preserves that order end to end. Failure isolation is per action: a tx
 * that aborts, or fails its CFC gates, never reaches `seal()`; a tx whose
 * seal fails mid-way withdraws only its own already-sealed spaces.
 */
export class WaveAccumulator
  implements TransactionSealDestination, ITransactionSealSink {
  readonly #space: MemorySpace;
  readonly #basisSeq: number;

  /**
   * The serving loop's own direct commits landed while this wave was open
   * ({@link noteOwnCommit}), each with the doc instances it wrote and the
   * number of contributions sealed before it. A contribution sealed after
   * one read the replica with that commit applied, so a doc it writes that
   * sits exactly at the commit's seq is not a conflict for it.
   */
  readonly #ownCommits: Array<{
    seq: number;
    keys: Set<string>;
    sealedBefore: number;
  }> = [];
  readonly #scopeKeyIdentity: ScopeKeyIdentity;
  readonly #replicaFor: (space: MemorySpace) => ISpaceReplica;
  readonly #lease: WaveLease | undefined;
  readonly #sealedTenure: number;
  readonly #foreignWrites: "refuse" | "accept";
  readonly #foreignWriteGrant:
    | ((
      space: MemorySpace,
      acting: { user: string; session?: string },
    ) => ForeignWriteGrantResult | Promise<ForeignWriteGrantResult>)
    | undefined;

  /** Grant verdicts per (space, acting user) for THIS wave — one probe
   * per crossing pair, not per sealed tx. A new wave re-probes (grants
   * can change between waves; a transient probe failure must not stick
   * beyond the wave that observed it). */
  readonly #foreignGrantVerdicts = new Map<string, Promise<boolean>>();

  /** The grant ARM each admitted crossing resolved through, per
   * (space, acting user) — retained for the commit step (OW31 B4,
   * protocol.md §2b): a `creation`-granted foreign target's genesis
   * ACL is forced BEFORE the sink's data batch, so INV-13's precedence
   * holds on the engine-direct plane too. Only verdicts that carry a
   * `via` are recorded (a bare-boolean probe records none — such waves
   * never force a genesis; the sink's seq-0/no-ACL refusal stays the
   * backstop). */
  readonly #foreignGrantVia = new Map<
    string,
    "owner" | "creation" | "acl"
  >();

  readonly #onForeignWriteRefusal:
    | ((info: { space: MemorySpace; actionId?: string }) => void)
    | undefined;
  #contributions: WaveContribution[] = [];
  #assembly: PendingAssembly | undefined;
  #closed = false;
  #derivedThrough: number | undefined;

  /** Events one of whose EVENT-STAMPED transactions failed its seal
   * (owner review P1-2, 2026-08-12): the served navigateTo issues its
   * intent as a SEPARATE event-handler-stamped tx (builtins.md §4),
   * and an isolated seal failure of that tx must not leave the event
   * consequenced-clean — the wave host notes the failure here
   * (noteSealFailure), and commitWave seeds these events into the
   * requeue set, so the surviving sibling contributions (the handler
   * run carrying the entry's `consequenced` mark, events.md §4)
   * withdraw with the failed consequence and the entry stays pending
   * for the re-drain. Store-owned idempotency (the engine's nonce
   * dedupe) absorbs the re-run's re-issue. */
  readonly #sealFailedEventIds = new Set<string>();

  /** Foreign spaces whose co-hosted ENGINE failed to resolve for this
   * wave's commit step (Phase 5, the F1b fix): commitWave withdraws
   * exactly the contributions that sealed into these spaces (requeue
   * for events, drop for derivations — the standard per-kind
   * withdrawal semantics) and commits the rest, instead of the
   * resolution failure throwing out of the cycle and PARKING the home
   * space — the "space outage from one misdirected materialization"
   * class the RULED 2026-08-14 (c) accumulation refusal exists to
   * prevent, re-opened at the commit step for carriage-bearing writes
   * until this isolation. Marked by the serving loop's
   * per-space-caught foreign-engine resolution (failForeignSpace). */
  readonly #failedForeignSpaces = new Map<MemorySpace, string>();

  /** Outbound appends staged per transaction before its seal
   * (enqueueOutboundAppend); folded (by copy) into the contribution at
   * seal so only surviving contributions' appends ride the wave (FP1).
   * A post-seal enqueue on the same tx is refused — it could no longer
   * ride this wave's transaction. */
  readonly #pendingAppendsByTx = new WeakMap<object, OutboxAppendRow[]>();

  /** Transactions holding staged appends no seal has taken yet: the
   * source of `hasUnsealedAppends`, which reads their status so one that
   * aborted before sealing stops counting. */
  readonly #txsWithStagedAppends = new Set<IExtendedStorageTransaction>();

  readonly #sealedTxs = new WeakSet<object>();
  readonly #onUnstampedSeal: (() => void) | undefined;
  readonly #onEarlyEmitRefusal: (() => void) | undefined;
  readonly #onUndemandedNarrowing: (() => void) | undefined;

  constructor(options: {
    /** The home space this wave derives for. */
    space: MemorySpace;

    /** Store seq of the wave's input snapshot: the per-doc CAS basis
     * (serving-loop.md §3b's snapshot discipline — mid-wave commits are
     * the NEXT wave's input). */
    basisSeq: number;

    /** The acting identity scoped writes resolve their instance keys
     * against, via the shared scope_key constructor — never a caller-
     * supplied format (key-vocabulary.md §3/§4). At OFF-arm cardinality 1
     * this is the runtime's own authenticated session; stage F's serving
     * loop supplies per-run demanded identities when it builds real
     * accumulators. */
    scopeKeyIdentity: ScopeKeyIdentity;

    replicaFor: (space: MemorySpace) => ISpaceReplica;
    lease?: WaveLease;

    /** Counted observation of §3d's unstamped-seal refusal (the
     * serving loop feeds its §7 `unstampedSealRefusals` counter):
     * called once per refused write-carrying transaction, right
     * before the refusal throws. The refusal semantics are unchanged
     * — this only makes the storm a counter fact. */
    onUnstampedSeal?: () => void;

    /** Counted observation of fan-out stage B's early-emit guard (the
     * serving loop feeds its §7 `earlyEmitRefusals` counter): called
     * once per contribution refused for an under-attributed emission. */
    onEarlyEmitRefusal?: () => void;

    /** Counted observation of design §B5's accept-and-count residual
     * (the serving loop feeds `undemandedNarrowingRuns`): a derivation
     * run under the wave-level fallback identity that discovered a
     * scope narrower than `space`. */
    onUndemandedNarrowing?: () => void;

    /** Foreign-space writes at ACCUMULATION (serving-loop.md §3d, RULED
     * 2026-08-14 (c) — the lunch-wall trigger's ruled seat): on
     * `"refuse"` (the pre-Phase-5 default), a sealing tx carrying a
     * foreign-space commit is refused ACTION-SCOPED — that tx fails
     * loudly (its already-sealed spaces withdraw per §3d's failure
     * isolation) and the wave keeps serving everything else, instead
     * of the whole wave dying later at the commit step's
     * foreign-engine guard (loop-failed → park: a space outage from
     * one misdirected wish materialization). `"accept"` is the
     * Phase-5 SERVING posture (the serving loop passes it since
     * Phase 5): a foreign write is admitted IFF the sealing run's
     * context carries the §2b delegated carriage (acting identity +
     * capabilityRef — the sanctioned `.inSpace`/provisioning shape)
     * AND the acting identity holds a structural write grant for the
     * TARGET space (`foreignWriteGrant` below — carriage alone is a
     * shape, not an authorization: #stampRun mints it for every
     * acting run). A carriage-less or UNGRANTED foreign write keeps
     * refusing action-scoped and counted. The commit-step guard stays
     * as backstop. */
    foreignWrites?: "refuse" | "accept";

    /** The authorization predicate of the accept gate (Phase 5;
     * protocol.md §2b): whether `acting` holds a structural write
     * grant for `space`. REQUIRED with `foreignWrites: "accept"` — an
     * accept-mode wave without an authority probe would admit any
     * acting run into any co-hosted space (the F1 vacuous-gate class),
     * so the constructor refuses the combination. The serving loop
     * wires the co-hosted memory server's
     * `foreignWriteAuthorityFor` (owner-by-identity / fresh-store
     * creation / the target's own ACL grant — fail-closed otherwise);
     * a probe that THROWS refuses the crossing (fail closed), scoped
     * to this wave. Probed once per (space, acting user) per wave. */
    foreignWriteGrant?: (
      space: MemorySpace,
      acting: { user: string; session?: string },
    ) => ForeignWriteGrantResult | Promise<ForeignWriteGrantResult>;

    /** Fired once per refused foreign-space write (above): the serving
     * loop counts it into §7's `foreignWriteRefusals`. */
    onForeignWriteRefusal?: (
      info: { space: MemorySpace; actionId?: string },
    ) => void;
  }) {
    this.#space = options.space;
    this.#basisSeq = options.basisSeq;
    this.#scopeKeyIdentity = options.scopeKeyIdentity;
    this.#replicaFor = options.replicaFor;
    this.#lease = options.lease;
    this.#sealedTenure = options.lease?.tenure ?? 0;
    this.#onUnstampedSeal = options.onUnstampedSeal;
    this.#onEarlyEmitRefusal = options.onEarlyEmitRefusal;
    this.#onUndemandedNarrowing = options.onUndemandedNarrowing;
    this.#foreignWrites = options.foreignWrites ?? "refuse";
    this.#foreignWriteGrant = options.foreignWriteGrant;
    if (
      this.#foreignWrites === "accept" && this.#foreignWriteGrant === undefined
    ) {
      // The gate is an AUTHORIZATION boundary, not a shape check: an
      // accept posture with no authority probe is exactly the vacuous
      // gate the F1 review found (carriage is minted for every acting
      // run). Refuse the configuration instead of admitting it.
      throw new Error(
        'foreignWrites: "accept" requires a foreignWriteGrant authority ' +
          "probe (serving-loop.md §3d's accept gate; protocol.md §2b)",
      );
    }
    this.#onForeignWriteRefusal = options.onForeignWriteRefusal;
  }

  get space(): MemorySpace {
    return this.#space;
  }

  get basisSeq(): number {
    return this.#basisSeq;
  }

  get contributionCount(): number {
    return this.#contributions.length;
  }

  /**
   * Record a direct commit of the serving loop's own that landed at `seq`
   * and is applied to the replica, while this wave is open, writing `docs`
   * (docs/features/server-pattern-lifecycle.md). The commit step then
   * treats a doc in `docs` sitting at exactly `seq` as observed, not
   * conflicting, for a contribution sealed from now on that read the doc at
   * `seq` or later and read no doc in `docs` earlier than `seq`. A
   * contribution sealed earlier, one with no read of the doc to show it
   * saw the commit, or one that read any of `docs` before the commit
   * reached the replica keeps the ordinary conflict, since its write may
   * rest on state the commit replaced.
   */
  noteOwnCommit(
    seq: number,
    docs: ReadonlyArray<{ id: string; scopeKey: ScopeKey }>,
  ): void {
    this.#ownCommits.push({
      seq,
      keys: new Set(docs.map((doc) => docInstanceKey(doc.id, doc.scopeKey))),
      sealedBefore: this.#contributions.length,
    });
  }

  /** Contributions whose run kind is anything but the loop's own
   * "bookkeeping" stamps — the wave carried real derivation/handler
   * CONTENT whose commit seq can enter a client read basis. S1 (RULED
   * 2026-08-19, protocol.md §4): only such waves owe a drain-settle
   * quiescence advance; a bookkeeping-only wave (the watermark advance
   * itself, a notice-only seal) is never chased, or every advance
   * would mint a successor covering its own commit — the
   * #coverageHead commit-storm class. */
  get contentContributionCount(): number {
    let count = 0;
    for (const contribution of this.#contributions) {
      if (contribution.context.kind !== "bookkeeping") count += 1;
    }
    return count;
  }

  /** Whether this wave has been committed or abandoned — nothing may
   * seal into it, and effects handed over for it are stragglers (the
   * SpaceServer's park-race drop). */
  get closed(): boolean {
    return this.#closed;
  }

  /** Whether any contribution staged outbound appends — the serving
   * loop's cheap gate on draining the durable outbox after this wave's
   * commit (a pre-disposition upper bound: withdrawn contributions'
   * appends never actually ride). */
  get hasOutboundAppends(): boolean {
    return this.#contributions.some((c) => c.outboundAppends.length > 0);
  }

  /** Whether an append is staged by a transaction that can still seal.
   * Such an append rides the transaction's contribution once it seals,
   * so a wave holding one is not empty even with no contribution. A
   * transaction that is done or failed without sealing no longer counts:
   * its appends can never ride. */
  get hasUnsealedAppends(): boolean {
    for (const tx of this.#txsWithStagedAppends) {
      const status = tx.tx.status().status;
      if (status === "ready" || status === "pending") return true;
      this.#txsWithStagedAppends.delete(tx);
    }
    return false;
  }

  /** The FOREIGN spaces sealed contributions target (protocol.md §2b's
   * provisioning commits). The serving loop resolves these spaces'
   * co-hosted engines BEFORE driving the commit step, so the sink's
   * synchronous engineFor lookup never misses (Phase 5). */
  get foreignSpaces(): MemorySpace[] {
    const spaces = new Set<MemorySpace>();
    for (const contribution of this.#contributions) {
      for (const sealed of contribution.spaces) {
        if (sealed.space !== this.#space) spaces.add(sealed.space);
      }
    }
    return [...spaces];
  }

  /**
   * TransactionSealDestination: an action tx closes into the wave. Runs
   * the tx's own seal machinery (validation, per-space native commits in
   * commit order) with this accumulator as the per-space sink, then
   * records the contribution under the tx's stamped run context.
   */
  async seal(
    tx: IExtendedStorageTransaction,
  ): Promise<Result<Unit, CommitError>> {
    if (this.#closed) {
      return {
        error: {
          name: "StorageTransactionAborted",
          message: "wave already committed or abandoned; nothing may seal " +
            "into it (serving-loop.md §3: mid-wave commits are the next " +
            "wave's input)",
          reason: new Error("wave-closed"),
        },
      };
    }
    const inner = tx.tx;
    if (inner.sealInto === undefined) {
      return {
        error: {
          name: "StorageTransactionAborted",
          message: "storage transaction does not support sealing",
          reason: new Error("seal-unsupported"),
        },
      };
    }
    // The seal takes the transaction's staged appends here, whatever its
    // outcome: a refused or failed seal is as terminal for them as an
    // accepted one, since the transaction seals once, so none of them can
    // keep the wave counted as holding work.
    const pendingAppends = this.#pendingAppendsByTx.get(tx) ?? [];
    this.#txsWithStagedAppends.delete(tx);
    const context = waveRunContextOf(tx);
    // seal() runs one tx at a time: sealInto hands spaces back through
    // sealSpaceCommit below, and actions run serially per space
    // (serving-loop.md §3d), so a live assembly means interleaved seals —
    // a wave-host bug, not a race to tolerate.
    if (this.#assembly !== undefined) {
      throw new Error(
        "concurrent seal() calls on one wave: actions run serially per " +
          "space (serving-loop.md §3d)",
      );
    }
    const discoveredScope = normalizeCellScope(tx.getNarrowestReadScope?.());
    if (context !== undefined) {
      // Fan-out stage B: a scope-attributed derivation's actor is
      // settled HERE — before sealInto, so the foreign-write accept gate
      // and every later consumer read the settled pair.
      settleScopeAttribution(context, discoveredScope);
      // The EARLY-EMIT GUARD (RULED 2026-08-16, fail-closed): an emission
      // this run attributed at a broader scope than it finally
      // discovered carried LESS actor than the run's true instance —
      // never commit it. The scheduler learned the discovered scope at
      // commit kickoff (before this seal), so the retry runs at the
      // moved ratchet and attributes the emission right.
      if (
        context.attributionFromScope === true &&
        context.emissionAttributionScope !== undefined &&
        scopeRank(discoveredScope) >
          scopeRank(context.emissionAttributionScope)
      ) {
        this.#onEarlyEmitRefusal?.();
        logger.warn("early-emit-refused", () => [
          `run ${context.actionId} emitted an event attributed at scope ` +
          `${context.emissionAttributionScope} and then discovered ` +
          `${discoveredScope}; the contribution is refused fail-closed ` +
          "(protocol.md §1 as amended 2026-08-16; the retry emits at the " +
          "learned scope)",
        ]);
        return {
          error: {
            name: "StorageTransactionAborted",
            message: "early emission under-attributed: the run emitted an " +
              `event at scope ${context.emissionAttributionScope} before ` +
              `discovering ${discoveredScope} (fan-out stage B's early-emit ` +
              "guard; the retry attributes it at the learned scope)",
            reason: new Error("early-emit-under-attributed"),
          },
        };
      }
      // Design §B5 (RULED 2026-08-16 accept-and-count): a derivation run
      // NOBODY demanded with an identity — the wave-level fallback —
      // that narrowed wrote the service identity's inert instance.
      if (
        context.kind === "derivation" &&
        context.scopeKeyIdentity === undefined &&
        discoveredScope !== "space"
      ) {
        this.#onUndemandedNarrowing?.();
      }
    }
    this.#assembly = {
      context,
      spaces: [],
      readOnlyReadKeys: new Set(),
      // Read BEFORE sealInto: the seal's own bookkeeping reads nothing
      // scoped, and the ratchet is complete once the action body and its
      // result write have run.
      discoveredScope,
    };
    const localAcceptance = requiresWaveAcceptance.has(inner) ||
      (context?.kind === "derivation" && hasPendingWriteElision(tx));
    try {
      // Closing releases the transaction's activity; write-free publication
      // obligations need its read identities after the storage no-op has closed.
      const localReads = localAcceptance
        ? [...getTransactionReadActivities(tx)].map(({ space, id, scope }) => ({
          space,
          id,
          scope,
        }))
        : [];
      const result = await inner.sealInto(this);
      const assembly = this.#assembly;
      if (result.error) {
        // Failure isolation is per action (§3d): withdraw only this tx's
        // already-sealed spaces; the wave keeps every other contribution.
        for (const space of assembly.spaces) {
          space.resolveVerdict({
            withdrawn: { message: `seal failed: ${result.error.message}` },
          });
        }
        return result;
      }
      // A transaction with nothing to seal (read-only, or all-no-op),
      // no staged appends, and no publication obligation contributes nothing,
      // like commit's empty-transaction fast path, and needs no run context.
      // A derivation reusing a pending output carries an acceptance obligation
      // even when the equal-value write produces no storage operation. The §3d
      // refusal below guards consequences entering the wave: writes, staged
      // appends, and write-free publication. A serving runtime's ordinary read
      // probes (piece structure loads, pattern-identity reads) commit nothing.
      // A tx that sealed NOTHING but STAGED APPENDS — the Phase-3
      // pure-forwarding handler, whose only consequence is a
      // cross-space emit — MINTS a zero-write contribution below (the
      // stage-G review's M-A): the model explicitly permits committed
      // contributions with `writes: []` carrying cross-space appends
      // (its cascadesCross/consequenceOf folds run for every committed
      // contribution), and dropping the entry here lost the appends
      // silently.
      if (
        assembly.spaces.length === 0 && pendingAppends.length === 0 &&
        !localAcceptance
      ) {
        return result;
      }
      if (context === undefined) {
        // No anonymous fallback (serving-loop.md §3d, RULED 2026-08-05):
        // an unstamped seal WITH WRITES (or staged appends) is a
        // wave-host bug — every server-side commit path stamps its run
        // context before sealing, and stage F names the sanctioned
        // internal stamp kinds ("bookkeeping", for the loop's own
        // writes) when it installs the seal destination. The
        // already-sealed overlay writes are withdrawn before the throw,
        // so nothing anonymous survives in the wave OR the overlay.
        // Unreachable from the OFF arm: without a destination
        // installed, seal == commit and this class never runs.
        for (const space of assembly.spaces) {
          space.resolveVerdict({
            withdrawn: {
              message: "unstamped transaction refused at the seal " +
                "destination (serving-loop.md §3d)",
            },
          });
        }
        this.#onUnstampedSeal?.();
        throw new Error(
          "unstamped transaction sealed into a wave: stamp the run " +
            "context (stampWaveRunContext) before sealing — every " +
            "server-side commit path declares its run context " +
            "(serving-loop.md §3d, RULED 2026-08-05)",
        );
      }
      const emptySettlement = assembly.spaces.length === 0 && localAcceptance
        ? Promise.withResolvers<Result<Unit, StorageTransactionRejected>>()
        : undefined;
      if (emptySettlement !== undefined) {
        // A storage no-op has no sealSpaceReads handoff. Its publication
        // obligation still depends on the same reads as a written contribution.
        for (const read of localReads) {
          this.sealSpaceReads(read.space, [read]);
        }
      }
      this.#sealedTxs.add(tx);
      const contribution: WaveContribution = {
        index: this.#contributions.length,
        context,
        spaces: assembly.spaces,
        readOnlyReadKeys: assembly.readOnlyReadKeys,
        ...(emptySettlement === undefined ? {} : { emptySettlement }),
        // Copied: a (refused) post-seal enqueue must not be able to
        // mutate the sealed contribution through the shared array.
        outboundAppends: [...pendingAppends],
        discoveredScope: assembly.discoveredScope,
        viewSeqs: this.#viewSeqsAtSeal(assembly.spaces, context),
      };
      this.#contributions.push(contribution);
      waveSettlements.set(
        tx,
        (emptySettlement?.promise ?? Promise.all(
          assembly.spaces.map((space) => space.sealed.settled),
        ).then((settled): Result<Unit, StorageTransactionRejected> =>
          settled.find((outcome) => outcome.error !== undefined) ?? { ok: {} }
        )).then((outcome): WaveSettlement =>
          outcome.error !== undefined && contribution.readDependencyWithdrawn
            ? { error: { ...outcome.error, readDependencyWithdrawn: true } }
            : outcome
        ),
      );
      return result;
    } finally {
      this.#assembly = undefined;
    }
  }

  /**
   * Note a seal FAILURE for an event-stamped transaction (owner review
   * P1-2): called by the wave host's seal wrapper whenever a wave-bound
   * seal resolves `{ error }`. The eventId folds into commitWave's
   * requeue set, so the event's other contributions withdraw with the
   * failed consequence — the event is never consequenced-clean while a
   * consequence of it failed to seal. Non-event transactions (and
   * unstamped ones) note nothing: derivations re-run through their own
   * reads, and bookkeeping re-derives next wave. A failure noted after
   * the wave CLOSED is unrepairable here — loud, because the event may
   * have gone consequenced-clean in the committed wave; the serving
   * loop's pre-commit seal-chain barrier is what keeps this arm
   * unreachable in production.
   */
  noteSealFailure(context: WaveRunContext | undefined): void {
    if (context?.kind !== "event-handler" || context.eventId === undefined) {
      return;
    }
    if (this.#closed) {
      logger.error("seal-failure-after-close", () => [
        `event ${context.eventId}'s failed seal was noted after its ` +
        "wave closed; the event may be consequenced-clean with a lost " +
        "consequence (the serving loop's seal-chain barrier should " +
        "make this unreachable)",
      ]);
      return;
    }
    this.#sealFailedEventIds.add(context.eventId);
  }

  /**
   * Mark a FOREIGN space's co-hosted engine as unresolvable for this
   * wave (Phase 5, the F1b fix): called by the serving loop when
   * `engineForSpace` fails during the pre-commit foreign resolution.
   * commitWave withdraws the contributions that sealed into the space
   * (requeue for events — the entry stays pending and replays; drop
   * for derivations — recompute-on-demand covers them), commits the
   * rest, and never builds a batch the sink would need the missing
   * engine for. Action-scoped, mirroring the accumulation refusal's
   * posture — the alternative was the resolution failure throwing out
   * of the cycle: loop-failed → park + backoff for the HOME space, a
   * whole-space outage from one misdirected crossing.
   */
  failForeignSpace(space: MemorySpace, reason: string): void {
    if (this.#closed) return;
    if (space === this.#space) {
      throw new Error(
        "failForeignSpace on the wave's OWN home space: the home engine " +
          "is the loop's engine — its failure is a loop failure, not a " +
          "foreign-resolution one",
      );
    }
    this.#failedForeignSpaces.set(space, reason);
  }

  /**
   * Stage a cross-space event append for the run owning `tx`
   * (serving-loop.md §5, FP1): the entry becomes a durable engine-table
   * row written INSIDE the wave's own store transaction — iff the run's
   * contribution survives the wave commit. Phase 3's handler cascades
   * are the production producer; until then tests drive it (the
   * machinery lands dark, like stage D's).
   */
  enqueueOutboundAppend(
    tx: IExtendedStorageTransaction,
    entry: OutboxAppendRow,
  ): void {
    if (this.#closed) {
      throw new Error(
        "wave already committed or abandoned; nothing may stage appends " +
          "into it (serving-loop.md §3)",
      );
    }
    if (this.#sealedTxs.has(tx)) {
      throw new Error(
        "transaction already sealed; its appends rode (or were refused " +
          "with) its contribution — stage appends before the seal " +
          "(serving-loop.md §5)",
      );
    }
    // Fail-closed at the SOURCE, mirroring the delegated admission
    // floor (protocol.md §2): an entry the target would refuse
    // deterministically (the LT4 arm) must never become a durable row.
    // The OW15 carve-out (SHAPE RULED 2026-08-05, implemented with
    // Phase 3): a USERLESS entry stages IFF it is DECLARED
    // sessionless-space-scope — a chain with no actor anywhere, whose
    // delivered entry stamps `firedAt = { session: "server" }`. The
    // floor negatives hold both ways, the declaration alongside a
    // present actor is a refused contradiction, and grant presence
    // stays mandatory throughout.
    if (entry.capabilityRef === "") {
      throw new Error(
        "outbound append refused: the delegated admission floor requires " +
          "the capability grant (protocol.md §2) — the " +
          "sessionless-space-scope carve-out never lifts it",
      );
    }
    const userless = entry.actingPrincipal === undefined ||
      entry.actingPrincipal === "";
    if (userless && entry.sessionlessSpaceScope !== true) {
      throw new Error(
        "outbound append refused: a userless emission stages only under " +
          "the declared sessionless-space-scope carve-out (protocol.md " +
          "§2, SHAPE RULED 2026-08-05; events.md §2)",
      );
    }
    if (!userless && entry.sessionlessSpaceScope === true) {
      throw new Error(
        "outbound append refused: a sessionless-space-scope declaration " +
          "alongside an acting principal is a contradiction — the " +
          "declaration names a chain with NO actor (events.md §2)",
      );
    }
    if (
      userless && entry.actingSession !== undefined &&
      entry.actingSession !== ""
    ) {
      throw new Error(
        "outbound append refused: a sessionless-space-scope declaration " +
          "alongside an acting session is a contradiction (events.md §2)",
      );
    }
    let pending = this.#pendingAppendsByTx.get(tx);
    if (pending === undefined) {
      pending = [];
      this.#pendingAppendsByTx.set(tx, pending);
    }
    pending.push(entry);
    this.#txsWithStagedAppends.add(tx);
  }

  /**
   * Resolves when every sealed commit's local settlement (promotion or
   * rollback) has completed — after commitWave/abandon resolved the
   * verdicts. The serving loop awaits this before treating the replica's
   * overlay as quiescent; tests await it before asserting on replica
   * state.
   */
  async settled(): Promise<void> {
    await Promise.all(
      this.#contributions.flatMap((contribution) =>
        [
          ...contribution.spaces.map((space) => space.sealed.settled),
          ...(contribution.emptySettlement === undefined
            ? []
            : [contribution.emptySettlement.promise]),
        ].map((settlement) => settlement.then(() => undefined, () => undefined))
      ),
    );
  }

  /**
   * ITransactionSealSink: one space of the currently-sealing tx. Applies
   * the native commit to the space replica's optimistic overlay (the
   * layered view later runs read) and holds the verdict open until the
   * wave commit step disposes of it.
   */
  async sealSpaceCommit(
    space: MemorySpace,
    native: NativeStorageCommit,
    source: IStorageTransaction,
  ): Promise<Result<Unit, CommitError>> {
    const assembly = this.#assembly;
    if (assembly === undefined) {
      return {
        error: {
          name: "StorageTransactionAborted",
          message: "sealSpaceCommit outside a seal() call",
          reason: new Error("seal-out-of-order"),
        },
      };
    }
    if (space !== this.#space) {
      // Accumulation-time gate (serving-loop.md §3d, RULED 2026-08-14
      // (c); lifted by Phase 5 for the SANCTIONED shape only):
      //
      // - "refuse" (the pre-Phase-5 default): every foreign-space write
      //   refuses HERE, action-scoped — seal() fails this tx
      //   (withdrawing its already-sealed spaces) and the wave keeps
      //   every other contribution, instead of the whole wave dying at
      //   the commit step's foreign-engine guard (the lunch-wall
      //   trigger: a wish materialization resolving against the SERVICE
      //   identity's home space).
      // - "accept" (the Phase-5 serving posture): a foreign write is
      //   admitted IFF the sealing run's context carries the §2b
      //   delegated carriage — acting identity AND capabilityRef, the
      //   provisioning shape protocol.md §2's server-produced authored
      //   row requires on EVERY foreign commit — AND the acting
      //   identity holds a structural write grant for the TARGET space
      //   (the foreignWriteGrant probe; the F1 fix). Carriage alone is
      //   a shape, not an authorization — #stampRun mints it for every
      //   acting run, so a carriage-only gate admitted any served
      //   pattern acting for any user into ANY co-hosted space through
      //   the engine-direct sink (which bypasses session ACL). A
      //   carriage-less foreign write keeps refusing exactly like
      //   "refuse": admitting it would commit authored-class under the
      //   bare service envelope with no acting identity — the
      //   silent-empty-instance trap's write-side twin. An UNGRANTED
      //   one refuses the same way, loud and counted. The commit-step
      //   sink's delegated validation stays as backstop.
      const acting = assembly.context?.acting;
      const carriage = assembly.context !== undefined &&
        this.#delegatedFor(assembly.context) !== undefined;
      let why: string | undefined;
      if (this.#foreignWrites === "refuse") {
        why = "cross-space serving is Phase 5";
      } else if (!carriage || acting === undefined) {
        why = "the run context carries no §2b delegated carriage (acting " +
          "identity + capabilityRef; protocol.md §2's server-produced " +
          "authored row)";
      } else if (!(await this.#foreignGrantFor(space, acting))) {
        why = `the acting identity ${acting.user} holds no structural ` +
          `write grant for ${space} (protocol.md §2b: owner-by-identity, ` +
          "fresh-store creation, or the target's own ACL grant; " +
          "fail-closed otherwise)";
      }
      if (why !== undefined) {
        const actionId = assembly.context?.actionId;
        logger.warn("foreign-write-refused", () => [
          `foreign-space write refused at wave accumulation: action ` +
          `${actionId ?? "<unstamped>"} attempted to write ${space} from ` +
          `the wave serving ${this.#space} (serving-loop.md §3d, RULED ` +
          `2026-08-14 (c); ${why})`,
        ]);
        this.#onForeignWriteRefusal?.({
          space,
          ...(actionId !== undefined ? { actionId } : {}),
        });
        return {
          error: {
            name: "StorageTransactionAborted",
            message: `foreign-space write refused at wave accumulation ` +
              `(serving-loop.md §3d, RULED 2026-08-14 (c)): action ` +
              `${actionId ?? "<unstamped>"} may not write ${space} from ` +
              `the wave serving ${this.#space} — ${why}`,
            reason: new Error("foreign-write-refused"),
          },
        };
      }
    }
    const replica = this.#replicaFor(space);
    if (replica.sealNative === undefined) {
      return Promise.resolve({
        error: {
          name: "StorageTransactionAborted",
          message: `space replica for ${space} does not support sealing`,
          reason: new Error("seal-unsupported"),
        },
      });
    }
    const { promise, resolve } = Promise.withResolvers<SealedCommitVerdict>();
    // The tx→replica identity seam (server-execution v2 stage A, OW17):
    // the run's ops apply to ITS identity's local instances — the
    // replica's own when the context carries none (the wave-level
    // fallback, bookkeeping), byte-identical to before.
    const identity = assembly.context?.scopeKeyIdentity;
    const sealed = replica.sealNative(
      native,
      source,
      promise,
      identity !== undefined ? { identity } : undefined,
    );
    assembly.spaces.push({
      space,
      native,
      sealed,
      resolveVerdict: resolve,
    });
    return Promise.resolve({ ok: {} });
  }

  /**
   * ITransactionSealSink (optional half): the read set of a space the
   * currently-sealing tx read but wrote nothing to. Recorded per
   * contribution and folded into the withdrawn-read closure by doc
   * identity (see WaveContribution.readOnlyReadKeys — the stage-D
   * bound's discharge).
   */
  sealSpaceReads(
    space: MemorySpace,
    reads: readonly { space: MemorySpace; id: string; scope?: CellScope }[],
  ): void {
    const assembly = this.#assembly;
    if (assembly === undefined) return;
    for (const read of reads) {
      assembly.readOnlyReadKeys.add(
        `${space}\0${
          docInstanceKey(
            read.id,
            this.#scopeKeyFor(read.scope, assembly.context ?? undefined),
          )
        }`,
      );
    }
  }

  /**
   * Abandon the wave: every sealed commit's local overlay rolls back, and
   * nothing reaches the store. The caller MUST abandon (or commit) before
   * any replica reset — a reset's local rejections would otherwise race
   * verdicts for a wave that no longer exists.
   */
  abandon(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const contribution of this.#contributions) {
      this.#withdraw(
        contribution,
        `wave abandoned: ${reason}`,
        "wave-abandoned",
      );
    }
  }

  #withdraw(
    contribution: WaveContribution,
    message: string,
    cause?: "contribution-dropped" | "wave-abandoned",
  ): void {
    contribution.emptySettlement?.resolve({
      error: {
        name: "StoreError",
        message,
        cause: new Error(message),
        ...(cause === undefined ? {} : { waveWithdrawalCause: cause }),
      },
    });
    for (const space of contribution.spaces) {
      space.resolveVerdict({
        withdrawn: { message, ...(cause !== undefined ? { cause } : {}) },
      });
    }
  }

  /** Name a DROPPED contribution out loud (profile-starvation seat,
   * 2026-08-25). A dropped contribution's writes vanish with no basis
   * rows behind them (#basisRowsFor covers survivors only), so a
   * ONE-SHOT contribution — a bookkeeping continuation, a sidecar
   * instantiation — that gets dropped has nothing to re-run it, and on
   * a space that then goes quiet the loss is permanent and previously
   * INVISIBLE (the r05/p11 profile-starvation stores each carried one
   * such cascade with a single logged symptom). Requeued events stay
   * quiet — at-least-once redelivery is that class's normal path. */
  #warnDropped(contribution: WaveContribution, message: string): void {
    logger.warn("contribution-dropped", () => [
      `wave ${this.#space} dropped contribution action=` +
      `${contribution.context.actionId ?? "<unstamped>"} kind=` +
      `${contribution.context.kind ?? "<none>"} eventId=` +
      `${contribution.context.eventId ?? "<none>"}: ${message}`,
    ]);
  }

  /**
   * The wave commit step (serving-loop.md §3d): per-doc CAS against the
   * wave's basis with per-WRITE-CLASS conflict handling, then one batched
   * commit per space through the sink — foreign provisioning commits
   * first, home derived commit after success (protocol.md §2b). Whole-wave
   * CAS failure and blind derived writes are forbidden by construction:
   * every conflicted doc is dropped (pure), rebased (non-re-derivable,
   * disjoint fields), or requeues its event (semantic conflict) before the
   * batch is handed to the sink, and the sink re-verifies the remainder
   * inside its store transaction.
   */
  async commitWave(
    sink: WaveCommitSink,
    options: {
      /** The watermark the home commit carries (protocol.md §4's
       * `derivedThrough`). The serving loop passes the post-wave W —
       * unchanged from the current W on a budget-exhausted flush
       * (serving-loop.md §3). Absent for waves driven outside a loop. */
      derivedThrough?: number;
    } = {},
  ): Promise<WaveCommitOutcome> {
    if (this.#closed) {
      throw new Error("wave already committed or abandoned");
    }
    this.#closed = true;
    this.#derivedThrough = options.derivedThrough;
    const outcome: WaveCommitOutcome = {
      supersededWrites: 0,
      dependencyDroppedWrites: 0,
      requeuedEventIds: [],
      committedEventIds: [],
      provenNoCommitDeliveryFailures: [],
      orphanDeliveriesRefused: 0,
      dispositions: this.#contributions.map(() => ({ kind: "committed" })),
      foreignCommits: [],
    };

    // The lease check (serving-loop.md §2's stop-committing MUST): work
    // sealed under a lapsed tenure never commits. Recovery: the serving
    // loop PARKS the space on this abort, and re-activation's
    // fresh-runtime recompute-on-demand is the ONLY post-abort arm —
    // the withdrawal below re-arms nothing in place (no revert
    // consumer; inputs unchanged), so a loop that continued after the
    // abort would advance W over derivations that never re-ran
    // (space-server.ts's lease-lost-abort park).
    if (
      this.#lease !== undefined &&
      !this.#lease.isCurrentTenure(this.#sealedTenure)
    ) {
      for (const contribution of this.#contributions) {
        this.#withdraw(
          contribution,
          "lease lost mid-wave; the in-flight wave aborts " +
            "(serving-loop.md §2)",
        );
        outcome.dispositions[contribution.index] =
          contribution.context.kind === "event-handler"
            ? { kind: "requeued" }
            : { kind: "dropped" };
      }
      this.#reportRequeuedEvents(outcome, () => true);
      outcome.aborted = "lease-lost";
      return outcome;
    }

    if (this.#contributions.length === 0) {
      return outcome;
    }

    // per-doc conflict resolution, per write class (§3d)

    const homeWrites = this.#contributions.map((contribution) =>
      this.#homeDocInstances(contribution)
    );

    /** Per SPACE: sealed localSeq → contribution index. LocalSeqs are
     * per-space replica counters, so the mapping must be per-space too —
     * a pending read in a FOREIGN sealed commit resolves its layers
     * against that space's seals, which is what folds a reader of a
     * withdrawn foreign write into the withdrawal (the cross-space half
     * of the closure below). */
    const byLocalSeq = new Map<MemorySpace, Map<number, number>>();

    for (const contribution of this.#contributions) {
      for (const sealed of contribution.spaces) {
        let perSpace = byLocalSeq.get(sealed.space);
        if (perSpace === undefined) {
          perSpace = new Map();
          byLocalSeq.set(sealed.space, perSpace);
        }
        perSpace.set(sealed.sealed.localSeq, contribution.index);
      }
    }
    const allDocs = new Map<
      string,
      { id: string; scope?: CellScope; scopeKey: string }
    >();
    for (const docs of homeWrites) {
      for (const [key, doc] of docs) allDocs.set(key, doc);
    }

    const conflicted = new Set<string>();
    const requeued = new Set<number>();
    const droppedWhole = new Set<number>();

    /** Event-handler contributions refused as ORPHANS (stage C build W3,
     * (α3)) — a subset of `droppedWhole`, kept apart for the
     * disposition message; the outcome COUNT is per EVENT
     * (`orphanRefusedEvents`), since an orphan-refused copy takes its
     * same-eventId siblings down with it (the sibling fold below). */
    const orphanRefused = new Set<number>();

    const orphanRefusedEvents = new Set<string>();

    /** eventId → the contribution (and its home sidecar doc-instance
     * key) whose sealed ops APPEND that event's durable entry in THIS
     * wave — the LT1 same-wave emitters (cell.ts's serving-arm send
     * writes the entry into the emitting run's own tx). The orphan arm
     * of the requeue closure keys on it: a cascade child whose emitter
     * write is withdrawn has no durable entry behind it. */
    const emitterOf = this.#lt1EmittersByEventId();

    /** per contribution: home doc-instance keys whose ops are dropped */
    const droppedDocs: Set<string>[] = this.#contributions.map(() => new Set());

    /** per contribution: conflicted docs whose non-re-derivable ops
     * rebase — the disposition is PER (contribution, doc): one handler's
     * commuting patches never absolve another contribution's writes to
     * the same doc from their own drop/rebase/requeue check. */
    const rebasedDocs: Set<string>[] = this.#contributions.map(() => new Set());

    /** per rebased doc: the head every rebase decision on it observed
     * (§3d's "re-CAS against the new head" — the sink re-verifies the
     * doc still sits exactly there inside its store transaction). */
    const rebasedHeads = new Map<string, number>();

    const heads = new Map(
      await sink.currentHeads(this.#space, [...allDocs.values()]),
    );
    for (const [key] of allDocs) {
      if ((heads.get(key) ?? 0) > this.#basisSeq) conflicted.add(key);
    }

    /** Whether `key` conflicts FOR this contribution: the doc moved past
     * the wave's basis, or — for a pure derivation — past the view its own
     * seal stood on, with an INTRUSION accounting for the difference.
     *
     * The basis and that view differ because the basis is the serverSeq
     * the wave OPENED at, while the runs sealing into it read the
     * replica's. A seal opens a wave when none is open, so a run that read
     * before a commit was admitted can seal into a wave opened after it:
     * the basis counts that commit and the view does not, and the doc's
     * head then sits AT OR BELOW the basis while the derivation that wrote
     * it never saw the value there. Committing that write is §3d's
     * forbidden blind derived write — the shape that erased a user's first
     * PerUser input under the initialization materializing their scoped
     * slots.
     *
     * The intrusion question is what separates that from this tenure's own
     * derived commits, which advance a document under runs still in flight
     * as a matter of course: a view older than the head means nothing when
     * the loop itself moved it. So a document only this tenure writes
     * never conflicts here, which is §3d's own reading of a derived
     * document — there are no other writers on one.
     *
     * Dropping costs nothing: the value is re-derivable, and a derivation
     * that read the doc carries it in its basis rows, so the arrival of
     * the commit it missed re-runs it through the ordinary dependency
     * path. Non-re-derivable consequences keep the wave's basis alone —
     * their conflict arm rebases or requeues rather than dropping, and
     * requeueing against a seq the replica has not caught up to is the
     * sustained-traffic livelock §3d forbids. */
    const conflictsFor = async (
      contribution: WaveContribution,
      key: string,
      doc: { id: string; scope?: CellScope; scopeKey: string },
    ): Promise<boolean> => {
      if (conflicted.has(key)) return true;
      if (contribution.context.kind !== "derivation") return false;
      const held = contribution.viewSeqs.get(key) ?? 0;
      if ((heads.get(key) ?? 0) <= held) return false;
      return await sink.intrusionSince?.(
        this.#space,
        doc,
        held,
        this.#lease?.holder,
      ) === true;
    };

    /** The head a contribution observed on a conflicted doc through one of
     * the loop's own direct commits, or `undefined` when the doc moved for
     * some other reason, the contribution was sealed before the commit,
     * none of its reads of the doc shows it saw the commit, or a read of
     * any doc the commit wrote predates it. */
    const observedOwnCommit = (
      key: string,
      contribution: WaveContribution,
    ): number | undefined => {
      const head = heads.get(key);
      const own = this.#ownCommits.find((candidate) =>
        candidate.seq === head && candidate.keys.has(key) &&
        contribution.index >= candidate.sealedBefore
      );
      if (own === undefined) return undefined;
      const home = this.#homeSealed(contribution);
      if (home === undefined) return undefined;
      const { confirmed, pending } = home.sealed.commit.reads;
      let observed = false;
      for (
        const { read, seq } of [
          ...confirmed.map((read) => ({ read, seq: read.seq })),
          ...pending.map((read) => ({ read, seq: read.basisSeq ?? 0 })),
        ]
      ) {
        const readKey = docInstanceKey(
          read.id,
          this.#scopeKeyFor(read.scope, contribution.context),
        );
        if (!own.keys.has(readKey)) continue;
        if (seq < own.seq) return undefined;
        if (readKey === key) observed = true;
      }
      return observed ? head : undefined;
    };

    const resolveConflicts = async (): Promise<void> => {
      for (const contribution of this.#contributions) {
        if (
          requeued.has(contribution.index) ||
          droppedWhole.has(contribution.index)
        ) {
          continue;
        }
        const docs = homeWrites[contribution.index];
        for (const [key, doc] of docs) {
          if (
            droppedDocs[contribution.index].has(key) ||
            rebasedDocs[contribution.index].has(key) ||
            !await conflictsFor(contribution, key, doc)
          ) {
            continue;
          }
          const observed = observedOwnCommit(key, contribution);
          if (observed !== undefined) {
            // The doc moved by a direct commit this contribution read at
            // or after: its write stands, and the sink re-verifies the doc
            // still sits exactly there.
            rebasedDocs[contribution.index].add(key);
            rebasedHeads.set(key, observed);
            continue;
          }
          if (contribution.context.kind === "derivation") {
            // Pure derivation write superseded: DROP, sound because
            // re-derivable. The drop re-arms nothing — recomputation
            // arrives only through the ordinary dependency path
            // (§3d, RULED 2026-08-05).
            droppedDocs[contribution.index].add(key);
            outcome.supersededWrites += this.#homeOpCountFor(
              contribution,
              doc,
            );
          } else {
            // Non-re-derivable consequence (event-handler and the loop's
            // bookkeeping alike): rebase against the new head —
            // field-level merge for writes that commute with the
            // concurrent commit. A semantic conflict requeues an EVENT
            // contribution whole; a bookkeeping contribution has no
            // event to requeue and DROPS whole instead — the loop
            // re-derives its bookkeeping next wave (WaveRunKind doc).
            const concurrent = await sink.concurrentWritePaths(
              this.#space,
              doc,
              this.#basisSeq,
            );
            if (this.#rebases(contribution, doc, concurrent)) {
              rebasedDocs[contribution.index].add(key);
              rebasedHeads.set(key, heads.get(key) ?? 0);
            } else if (contribution.context.kind === "event-handler") {
              requeued.add(contribution.index);
              break;
            } else {
              droppedWhole.add(contribution.index);
              outcome.dependencyDroppedWrites += this.#homeOpCount(
                contribution,
              );
              break;
            }
          }
        }
      }

      // Requeue closure: same-wave cascade descendants of a requeued
      // event fold in (the model's parent walk), and so does anything
      // that READ a withdrawn sealed write — whether its owner withdrew
      // whole (requeue, dependency drop) or exactly that doc's write was
      // dropped as superseded. A write derived from withdrawn state must
      // not commit. The per-doc droppedDocs clause is scoped to the HOME
      // space: superseded drops are only ever resolved for home docs,
      // and doc-instance keys carry no space component.
      const readSawWithdrawnWrite = (
        ownerIndex: number,
        readDocKey: string,
        readSpace: MemorySpace,
      ): boolean =>
        requeued.has(ownerIndex) || droppedWhole.has(ownerIndex) ||
        (readSpace === this.#space && droppedDocs[ownerIndex].has(readDocKey));
      // Sealed writers per `${space}\0${docInstanceKey}` — the doc-identity
      // index the read-only-space closure folds through (a read handed
      // over by sealSpaceReads carries no layer provenance, so the fold
      // is by doc identity — conservative and sound; see
      // WaveContribution.readOnlyReadKeys).
      const sealedWriters = new Map<string, Set<number>>();
      for (const contribution of this.#contributions) {
        for (const sealed of contribution.spaces) {
          for (const operation of sealed.sealed.commit.operations) {
            if (operation.op === "sqlite") continue;
            const key = `${sealed.space}\0${
              docInstanceKey(
                operation.id,
                this.#scopeKeyFor(operation.scope, contribution.context),
              )
            }`;
            let owners = sealedWriters.get(key);
            if (owners === undefined) {
              owners = new Set();
              sealedWriters.set(key, owners);
            }
            owners.add(contribution.index);
          }
        }
      }
      const readOnlyReadSawWithdrawal = (
        contribution: WaveContribution,
      ): boolean => {
        for (const readKey of contribution.readOnlyReadKeys) {
          const owners = sealedWriters.get(readKey);
          if (owners === undefined) continue;
          const docKey = readKey.slice(readKey.indexOf("\0") + 1);
          const readSpace = readKey.slice(
            0,
            readKey.indexOf("\0"),
          ) as MemorySpace;
          for (const owner of owners) {
            if (
              owner !== contribution.index &&
              readSawWithdrawnWrite(owner, docKey, readSpace)
            ) {
              return true;
            }
          }
        }
        return false;
      };
      let grew = true;
      while (grew) {
        grew = false;
        for (const contribution of this.#contributions) {
          const idx = contribution.index;
          if (requeued.has(idx) || droppedWhole.has(idx)) continue;
          const parent = contribution.context.parentEventId;
          const parentRequeued = parent !== undefined &&
            this.#contributions.some((c) =>
              requeued.has(c.index) && c.context.eventId === parent
            );
          // Requeue is atomic PER EVENT (events.md §4: the mark, the
          // watermark, and the consequences move together — Phase 4
          // review finding 1): an event can contribute SEVERAL
          // transactions to one wave — the handler run plus the served
          // navigateTo's intent tx (builtins.md §4) — and when ANY of
          // them requeues, every sibling with the same eventId folds
          // into the rollback. Without the fold, a requeued handler
          // beside a surviving intent marks the event consequenced
          // (survivedEventIds) while its consequences were withdrawn —
          // lost forever behind the idempotency skip; a requeued
          // intent beside a surviving handler strands the intent
          // behind the consequenced mark until an unrelated input
          // change happens to re-run the builtin (the store-owned
          // re-issue, independent review M2 — the event itself is
          // never re-drained, so the fold is what keeps intent and
          // consequences moving together).
          const sameEvent = contribution.context.eventId;
          const eventRequeued = sameEvent !== undefined &&
            this.#contributions.some((c) =>
              requeued.has(c.index) && c.context.eventId === sameEvent
            );
          const readWithdrawn = this.#readsWithdrawnContribution(
            contribution,
            byLocalSeq,
            readSawWithdrawnWrite,
          ) || readOnlyReadSawWithdrawal(contribution);
          // The ORPHAN arm (stage C build W3, (α3); events.md §4's third
          // clause, RULED 2026-08-18): an event-handler run of an LT1
          // same-wave cascade whose durable entry rode an emitter write
          // this wave WITHDRAWS — a DERIVATION emitter's superseded
          // per-doc drop (§3d: the drop re-arms nothing, so nothing ever
          // re-emits the entry), a dropped-whole emitter, or a requeued
          // emitter the parentEventId thread did not reach — has NO
          // durable entry behind it. Delivering it would commit one
          // consequence for zero entries: the invariant broken from the
          // other side. REFUSED: withdrawn whole, disposition `dropped`,
          // never reported as requeued (no entry exists to retry), and
          // its own readers, its cascade grandchildren, and its
          // same-eventId siblings (`eventOrphaned` below) fold through
          // the same closure. (A requeued EVENT-HANDLER emitter reaches its
          // children first through `parentRequeued` — C8d — and those
          // children requeue with it; this arm covers the emitters C8d
          // cannot name.)
          const lt1Copy = contribution.context.kind === "event-handler" &&
            contribution.context.lt1 === true &&
            contribution.context.eventId !== undefined;
          const emitter = lt1Copy
            ? emitterOf.get(contribution.context.eventId!)
            : undefined;
          // Orphaned when the wave holds NO contribution appending its
          // entry (the emitter's own seal was refused or failed — a late
          // copy never reaches a wave, α1b) or when the emitter's
          // contribution, or exactly its sidecar write, is withdrawn.
          const emitterWithdrawn = lt1Copy &&
            (emitter === undefined ||
              (emitter.index !== idx &&
                (requeued.has(emitter.index) ||
                  droppedWhole.has(emitter.index) ||
                  droppedDocs[emitter.index].has(emitter.docKey))));
          // The orphan fold is atomic PER EVENT too (stage C build W3
          // independent review M1, 2026-08-19): a same-eventId SIBLING
          // of an orphan-refused copy — the served navigateTo's intent
          // tx, committed inline by the refused run — is dropped whole
          // with it. Without the fold the handler half was refused while
          // the intent half LANDED: a navigation enacted for an event
          // with zero durable entries, events.md §4's FORBIDDEN
          // "handler delivery with no durable stream entry behind it",
          // half of it. `eventRequeued` above keys on `requeued` only and
          // cannot see a droppedWhole orphan, hence the separate fold.
          const eventOrphaned = sameEvent !== undefined &&
            orphanRefusedEvents.has(sameEvent);
          if (
            !parentRequeued && !eventRequeued && !readWithdrawn &&
            !emitterWithdrawn && !eventOrphaned
          ) {
            continue;
          }
          if (contribution.context.kind === "event-handler") {
            if (
              (emitterWithdrawn || eventOrphaned) && !parentRequeued &&
              !eventRequeued && !readWithdrawn
            ) {
              droppedWhole.add(idx);
              orphanRefused.add(idx);
              // Counted once per EVENT: the copy and its folded siblings
              // are one refused delivery. (`sameEvent` is defined here —
              // both arms that reach this branch require an eventId.)
              if (
                sameEvent !== undefined && !orphanRefusedEvents.has(sameEvent)
              ) {
                orphanRefusedEvents.add(sameEvent);
                outcome.orphanDeliveriesRefused += 1;
              }
            } else {
              requeued.add(idx);
            }
          } else {
            if (readWithdrawn && contribution.context.kind === "derivation") {
              contribution.readDependencyWithdrawn = true;
            }
            droppedWhole.add(idx);
            outcome.dependencyDroppedWrites += this.#homeOpCount(
              contribution,
            );
          }
          grew = true;
        }
      }
    };

    // Seed the requeue set with events whose SEPARATE event-stamped
    // seal FAILED (noteSealFailure — owner review P1-2): every sealed
    // contribution of such an event requeues, so the handler run's
    // `consequenced` mark withdraws with the failed consequence and
    // the entry stays pending. resolveConflicts' per-event fold and
    // cascade closure take it from here (a cascade child's failed
    // intent rolls its own contributions back; the parent-fold rules
    // are the same ones every requeue obeys).
    if (this.#sealFailedEventIds.size > 0) {
      for (const contribution of this.#contributions) {
        if (
          contribution.context.kind === "event-handler" &&
          contribution.context.eventId !== undefined &&
          this.#sealFailedEventIds.has(contribution.context.eventId)
        ) {
          requeued.add(contribution.index);
        }
      }
    }

    // Seed withdrawals for contributions that sealed into a foreign
    // space whose co-hosted engine failed to resolve (failForeignSpace
    // — the F1b fix): action-scoped, per the standard kind semantics
    // (an event requeues and its entry replays; a derivation drops and
    // recompute-on-demand covers it). resolveConflicts' closures fold
    // in readers and same-event siblings; #buildForeignBatches only
    // iterates survivors, so no batch targeting the failed space ever
    // reaches the sink's engine lookup.
    if (this.#failedForeignSpaces.size > 0) {
      for (const contribution of this.#contributions) {
        if (
          requeued.has(contribution.index) ||
          droppedWhole.has(contribution.index)
        ) {
          continue;
        }
        const failed = contribution.spaces.some((sealed) =>
          sealed.space !== this.#space &&
          this.#failedForeignSpaces.has(sealed.space)
        );
        if (!failed) continue;
        if (contribution.context.kind === "event-handler") {
          requeued.add(contribution.index);
        } else {
          droppedWhole.add(contribution.index);
          outcome.dependencyDroppedWrites += this.#homeOpCount(contribution);
        }
      }
    }

    await resolveConflicts();

    // foreign provisioning commits FIRST (protocol.md §2b)
    //
    // Committed exactly once, before the home commit loop below: a home
    // re-attempt never re-sends them. A contribution that requeues AFTER
    // its foreign commit landed is the §2b replay-convergence case — its
    // event replays, deterministic destination ids make the
    // re-provisioning a CAS no-op, and the home links land with the
    // replayed consequence.
    // Accepted seq PER BATCH (space + delegated identity), not per
    // space: one wave may commit several batches into one foreign space
    // (one per acting identity), and each contribution must settle with
    // the seq of the batch ITS ops rode — a space-keyed map would
    // promote every contribution with the LAST batch's seq, skewing
    // replica heads and later conflict decisions.
    const foreignSeqs = new Map<string, number>();
    for (
      const { key, batch } of this.#buildForeignBatches(requeued, droppedWhole)
    ) {
      // Tenure re-check per sink call (defense-in-depth over the entry
      // check): the entry check plus the engine's live-lease row cover
      // today's synchronous sink, but an ASYNC sink would re-open the
      // same-process C7b window between entry and this call.
      if (
        this.#lease !== undefined &&
        !this.#lease.isCurrentTenure(this.#sealedTenure)
      ) {
        this.#abortAfterForeignFailure(outcome);
        outcome.aborted = "lease-lost";
        return outcome;
      }
      const result = await sink.commitWave(batch);
      if (result.error) {
        logger.warn("wave-foreign-commit-failed", () => [
          `foreign provisioning commit to ${batch.space} failed; ` +
          "home commit withheld (protocol.md §2b)",
          result.error,
        ]);
        this.#abortAfterForeignFailure(outcome);
        outcome.aborted = "foreign-commit-failed";
        return outcome;
      }
      foreignSeqs.set(key, result.ok.seq);
      // The warm request's payload (serving-loop.md §1; RULED
      // 2026-08-21): this batch durably STAGED SETUP into another
      // space. Recorded immediately — before the home commit's fate is
      // known — because §2b never rolls a landed foreign commit back:
      // whatever the wave does next, this setup is durable and its
      // target should warm.
      outcome.foreignCommits.push({
        space: batch.space,
        seq: result.ok.seq,
        writes: warmWritesOf(batch),
      });
    }

    // the home commit, re-resolving on sink-reported races
    while (true) {
      const batch = this.#buildHomeBatch(
        requeued,
        droppedWhole,
        droppedDocs,
        rebasedHeads,
      );

      // Empty-wave short-circuit — ONLY when there is truly nothing for
      // the store to see. A batch with preconditions still goes to the
      // sink even with zero ops: preconditions are commit GATES, and
      // short-circuiting them would resolve their contributions
      // committed without the engine ever validating the gate. A batch
      // with outbound appends goes too: the durable rows land inside
      // the wave's own transaction (FP1) — short-circuiting would lose
      // them.
      if (
        batch.operations.length === 0 && batch.consequenceOf.length === 0 &&
        batch.preconditions.length === 0 &&
        (batch.outboxAppends?.length ?? 0) === 0
      ) {
        this.#settleVerdicts(
          outcome,
          requeued,
          droppedWhole,
          droppedDocs,
          homeWrites,
          0,
          foreignSeqs,
          orphanRefused,
        );
        return outcome;
      }

      // Tenure re-check before every home attempt (see the foreign-loop
      // note): the resolve loop may have awaited the sink several times.
      if (
        this.#lease !== undefined &&
        !this.#lease.isCurrentTenure(this.#sealedTenure)
      ) {
        for (const contribution of this.#contributions) {
          this.#withdraw(
            contribution,
            "lease lost mid-wave; the in-flight wave aborts " +
              "(serving-loop.md §2)",
          );
          outcome.dispositions[contribution.index] =
            contribution.context.kind === "event-handler"
              ? { kind: "requeued" }
              : { kind: "dropped" };
        }
        this.#reportRequeuedEvents(outcome, () => true);
        outcome.aborted = "lease-lost";
        return outcome;
      }
      const result = await sink.commitWave(batch);
      if (!result.error) {
        this.#settleVerdicts(
          outcome,
          requeued,
          droppedWhole,
          droppedDocs,
          homeWrites,
          result.ok.seq,
          foreignSeqs,
          orphanRefused,
        );
        outcome.seq = result.ok.seq;
        return outcome;
      }

      // The sink re-verified inside its transaction and something moved
      // after our head query (or a precondition failed). Fold the news
      // in and resolve again; a rejection naming nothing is terminal.
      // This converges without timers: drops and requeues are monotone,
      // and a rebase re-decision runs only for a doc whose head actually
      // advanced — each pass observes strictly newer store state.
      const rejection = result.error;
      let progressed = false;
      const renamed: string[] = [];
      for (const key of rejection.conflictedDocs ?? []) {
        const wasRebased = rebasedHeads.has(key);
        if (!conflicted.has(key) || wasRebased) {
          conflicted.add(key);
          renamed.push(key);
          progressed = true;
        }
        if (wasRebased) {
          // The head moved past the rebase decision: the field-level
          // merge is void. Reset every contribution's rebase state for
          // this doc so the next resolve pass re-decides against the
          // new head (§3d's re-CAS).
          rebasedHeads.delete(key);
          for (const perContribution of rebasedDocs) {
            perContribution.delete(key);
          }
        }
      }
      for (const index of rejection.failedPreconditions ?? []) {
        const owner = batch.preconditionOwners?.[index];
        if (
          owner !== undefined && !requeued.has(owner) &&
          !droppedWhole.has(owner)
        ) {
          // A violated precondition (e.g. a create-only doc that appeared
          // mid-wave) is a semantic conflict for its contribution.
          if (this.#contributions[owner].context.kind === "event-handler") {
            requeued.add(owner);
          } else {
            droppedWhole.add(owner);
            outcome.dependencyDroppedWrites += this.#homeOpCount(
              this.#contributions[owner],
            );
          }
          progressed = true;
        }
      }
      if (!progressed) {
        logger.warn("wave-commit-rejected", () => [
          "wave commit rejected without resolvable conflicts",
          rejection.message,
        ]);
        for (const contribution of this.#contributions) {
          this.#withdraw(
            contribution,
            `wave commit rejected: ${rejection.message}`,
          );
          outcome.dispositions[contribution.index] =
            contribution.context.kind === "event-handler"
              ? { kind: "requeued" }
              : { kind: "dropped" };
        }
        this.#reportRequeuedEvents(outcome, () => true);
        if (
          rejection.name === "RowLabelCommitError" &&
          Number.isInteger(rejection.failedOperation)
        ) {
          const owner = batch.operationOwners?.[rejection.failedOperation!];
          const context = owner === undefined
            ? undefined
            : this.#contributions[owner]?.context;
          const streamEntry = context?.streamEntry ??
            (context?.eventId === undefined
              ? undefined
              : this.#contributions.find((contribution) =>
                contribution.context.eventId === context.eventId &&
                contribution.context.streamEntry !== undefined
              )?.context.streamEntry);
          if (
            context?.kind === "event-handler" &&
            context.eventId !== undefined &&
            streamEntry !== undefined &&
            !outcome.provenNoCommitDeliveryFailures.some((failure) =>
              failure.eventId === context.eventId
            )
          ) {
            outcome.provenNoCommitDeliveryFailures.push({
              eventId: context.eventId,
              streamEntry,
              failureClass: "protocol",
              recoveryEpoch: "row-label-verdict",
              permanentEvidence: true,
            });
          }
        }
        outcome.aborted = "rejected";
        return outcome;
      }
      if (renamed.length > 0) {
        const fresh = await sink.currentHeads(
          this.#space,
          renamed.map((key) => allDocs.get(key)!).filter((doc) =>
            doc !== undefined
          ),
        );
        for (const [key, head] of fresh) heads.set(key, head);
      }
      await resolveConflicts();
    }
  }

  //
  // helpers
  //

  #homeSealed(
    contribution: WaveContribution,
  ): SealedSpaceContribution | undefined {
    return contribution.spaces.find((s) => s.space === this.#space);
  }

  #foreignSealed(contribution: WaveContribution): SealedSpaceContribution[] {
    return contribution.spaces.filter((s) => s.space !== this.#space);
  }

  #homeDocInstances(
    contribution: WaveContribution,
  ): Map<string, { id: string; scope?: CellScope; scopeKey: string }> {
    const docs = new Map<
      string,
      { id: string; scope?: CellScope; scopeKey: string }
    >();
    const home = this.#homeSealed(contribution);
    if (home === undefined) return docs;
    for (const operation of home.sealed.commit.operations) {
      if (operation.op === "sqlite") continue;
      const scopeKey = this.#scopeKeyFor(operation.scope, contribution.context);
      docs.set(docInstanceKey(operation.id, scopeKey), {
        id: operation.id,
        scope: operation.scope,
        scopeKey,
      });
    }
    return docs;
  }

  /**
   * Where the replica's CONFIRMED view stands on each home doc a sealing
   * run writes — pending writes excluded, so what it reports is the state
   * the run's own layer sits on.
   *
   * Taken AT SEAL because that is the moment the contribution's writes
   * are fixed against a view. The wave's basis is the serverSeq it opened
   * at, which a seal can open after a commit this replica has not taken,
   * and the commit step runs later still, by which time the frame may
   * have landed and the replica no longer says what the run derived from.
   */
  #viewSeqsAtSeal(
    spaces: readonly SealedSpaceContribution[],
    context: WaveRunContext,
  ): ReadonlyMap<string, number> {
    const replica = this.#replicaFor(this.#space);
    const identity = context.scopeKeyIdentity ?? this.#scopeKeyIdentity;
    const home = spaces.find((space) => space.space === this.#space);
    const writes = (home?.sealed.commit.operations ?? []).filter((operation) =>
      operation.op !== "sqlite"
    );
    const seqs = new Map<string, number>();
    for (const operation of writes) {
      // Two operations on one instance read the same seq, so the second
      // overwrites the first with what it already held.
      seqs.set(
        docInstanceKey(
          operation.id,
          this.#scopeKeyFor(operation.scope, context),
        ),
        replica.confirmedDocumentSeq(
          operation.id as URI,
          operation.scope,
          identity,
        ),
      );
    }
    return seqs;
  }

  /** M1 (scopes.md §5, §7): a run's scoped addresses resolve against the
   * PER-RUN identity its context carries — the demand's instance identity
   * for derivations, the stamped `firedAt` pair for handlers — falling
   * back to the wave-level identity (OFF-arm cardinality 1, and runs
   * with no scoped addresses). */
  #scopeKeyFor(
    scope: CellScope | undefined,
    context?: WaveRunContext,
  ): ScopeKey {
    return resolveScopeKey(
      scope,
      context?.scopeKeyIdentity ?? this.#scopeKeyIdentity,
    );
  }

  #homeOpCount(contribution: WaveContribution): number {
    const home = this.#homeSealed(contribution);
    if (home === undefined) return 0;
    return home.sealed.commit.operations.filter((op) => op.op !== "sqlite")
      .length;
  }

  #homeOpCountFor(
    contribution: WaveContribution,
    doc: { id: string; scope?: CellScope; scopeKey: string },
  ): number {
    const home = this.#homeSealed(contribution);
    if (home === undefined) return 0;
    return home.sealed.commit.operations.filter((op) =>
      op.op !== "sqlite" && op.id === doc.id &&
      this.#scopeKeyFor(op.scope, contribution.context) === doc.scopeKey
    ).length;
  }

  /** Field-level merge check (§3d): every op this contribution holds on
   * the conflicted doc must be a patch whose value paths are disjoint
   * from the concurrent commits' written paths. A whole-doc set or delete
   * never commutes; overlapping paths are a semantic conflict. */
  #rebases(
    contribution: WaveContribution,
    doc: { id: string; scope?: CellScope; scopeKey: string },
    concurrentPaths: ReadonlyArray<readonly string[]>,
  ): boolean {
    const home = this.#homeSealed(contribution);
    if (home === undefined) return true;
    for (const operation of home.sealed.commit.operations) {
      if (operation.op === "sqlite") continue;
      if (
        operation.id !== doc.id ||
        this.#scopeKeyFor(operation.scope, contribution.context) !==
          doc.scopeKey
      ) {
        continue;
      }
      if (operation.op !== "patch") return false;
      for (const patch of operation.patches) {
        const patchPath = parsePointer(patch.path);
        for (const concurrent of concurrentPaths) {
          if (!pathsOverlap(patchPath, concurrent)) continue;
          // Stream-sidecar refinement (Phase 3; events.md §4): the ONLY
          // concurrent writers a sidecar doc admits at `/value/entries`
          // are tail APPENDS — the authored shape guard refuses deeper
          // authored writes, whole-array rewrites, and deletes
          // (engine.ts validateEventAppends), and the loop's own derived
          // commits are self-echo-skipped. A tail append creates only
          // NEW indices, so an index-addressed consequence mark
          // (`/value/entries/<i>/...` for an entry that existed at the
          // wave basis) commutes with it — the general prefix-overlap
          // rule would requeue every event whose stream took a
          // concurrent fire, which the field-level merge exists to
          // avoid (serving-loop.md §3d).
          if (
            doc.id.startsWith(STREAM_ENTRIES_DOC_PREFIX) &&
            concurrent.length === 2 &&
            concurrent[0] === "value" &&
            concurrent[1] === "entries" &&
            patchPath.length > 2 &&
            String(Number(patchPath[2])) === String(patchPath[2])
          ) {
            continue;
          }
          return false;
        }
      }
    }
    return true;
  }

  /** eventId → the contribution whose sealed HOME ops append that
   * event's durable entry in this wave (a seq-LESS entry in a stream
   * sidecar — the LT1 same-space emission, cell.ts's serving arm), with
   * the sidecar's doc-instance key (the per-doc drop set's key). The
   * same seq-less-entry detection the batch build uses to declare
   * `eventAppends`; first writer wins (one entry, one emitter). Stage C
   * build W3, (α3). */
  #lt1EmittersByEventId(): Map<string, { index: number; docKey: string }> {
    const emitters = new Map<string, { index: number; docKey: string }>();
    for (const contribution of this.#contributions) {
      const home = this.#homeSealed(contribution);
      if (home === undefined) continue;
      for (const operation of home.sealed.commit.operations) {
        if (operation.op === "sqlite" || operation.op === "delete") continue;
        if (!operation.id.startsWith(STREAM_ENTRIES_DOC_PREFIX)) continue;
        const docKey = docInstanceKey(
          operation.id,
          this.#scopeKeyFor(operation.scope, contribution.context),
        );
        for (const eventId of seqLessStreamEntryEventIds(operation)) {
          if (!emitters.has(eventId)) {
            emitters.set(eventId, { index: contribution.index, docKey });
          }
        }
      }
    }
    return emitters;
  }

  /** Whether this contribution READ a sealed write that is being
   * withdrawn — in ANY space it sealed into, resolving each space's
   * pending-read layers against that space's own seals (localSeqs are
   * per-space counters). A withdrawn writer's foreign write never lands
   * (#buildForeignBatches excludes it), so a reader deriving from it
   * must fold in exactly like a home reader (§3d: no blind derived
   * writes). Bounded by what SEALS: the tx seals only spaces it wrote
   * (or gated), so a read in a space the run wrote nothing to never
   * reaches the accumulator — the third stage-D bound, documented at
   * the sink (engine-wave-sink.ts). */
  #readsWithdrawnContribution(
    contribution: WaveContribution,
    byLocalSeq: ReadonlyMap<MemorySpace, ReadonlyMap<number, number>>,
    sawWithdrawnWrite: (
      ownerIndex: number,
      readDocKey: string,
      readSpace: MemorySpace,
    ) => boolean,
  ): boolean {
    for (const spaceContribution of contribution.spaces) {
      const perSpace = byLocalSeq.get(spaceContribution.space);
      if (perSpace === undefined) continue;
      for (const read of spaceContribution.sealed.commit.reads.pending) {
        const layers = Array.isArray(read.localSeq)
          ? read.localSeq
          : [read.localSeq];
        const readDocKey = docInstanceKey(
          read.id,
          this.#scopeKeyFor(read.scope, contribution.context),
        );
        for (const layer of layers) {
          const owner = perSpace.get(layer);
          if (
            owner !== undefined &&
            sawWithdrawnWrite(owner, readDocKey, spaceContribution.space)
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  #survivors(
    requeued: ReadonlySet<number>,
    droppedWhole: ReadonlySet<number>,
  ): WaveContribution[] {
    return this.#contributions.filter((c) =>
      !requeued.has(c.index) && !droppedWhole.has(c.index)
    );
  }

  #buildHomeBatch(
    requeued: ReadonlySet<number>,
    droppedWhole: ReadonlySet<number>,
    droppedDocs: ReadonlyArray<ReadonlySet<string>>,
    rebasedHeads: ReadonlyMap<string, number>,
  ): WaveSpaceCommit {
    const operations: Operation[] = [];
    const annotations: WaveWriteAnnotation[] = [];
    const preconditions: CommitPrecondition[] = [];
    const preconditionOwners: number[] = [];
    const operationOwners: number[] = [];
    const consequenceOf: string[] = [];
    const sqliteScopeKeys: Array<{ op: number; scopeKey: ScopeKey }> = [];
    const outboxAppends: OutboxAppendRow[] = [];
    // §3b's overwrite unit: when one wave holds several runs of the same
    // (action, instance) — a later contribution re-ran the action against
    // earlier sealed writes — the LAST run's rows replace the earlier
    // run's as a set, exactly as they would across waves.
    const basisInstances = new Map<string, WaveBasisInstanceRows>();
    for (const contribution of this.#survivors(requeued, droppedWhole)) {
      const context = contribution.context;
      // FP1's fold completeness (the stage-G review's M-A): appends and
      // consequence coverage ride EVERY survivor — one that sealed only
      // FOREIGN spaces, or sealed nothing at all (the zero-seal emitter
      // minted in seal()), still lands its cross-space appends as
      // durable rows in THIS home transaction and its eventId in the
      // commit's consequenceOf. The model is explicit: its
      // cascadesCross and consequenceOf folds run for every COMMITTED
      // contribution, writes or not — gating them on a home seal lost
      // both silently for the foreign-only and zero-seal shapes. A
      // withdrawn contribution's appends still never ride (the
      // survivors filter above): its event replays and re-emits.
      if (
        context.kind === "event-handler" && context.eventId !== undefined &&
        // One entry per EVENT (protocol.md §7: `consequenceOf` scales
        // with the wave's INPUT — the events drained — never with how
        // many transactions an event contributed; Phase 4's intent tx
        // is the second contribution an event can make).
        !consequenceOf.includes(context.eventId)
      ) {
        consequenceOf.push(context.eventId);
      }
      outboxAppends.push(...contribution.outboundAppends);
      const home = this.#homeSealed(contribution);
      if (home === undefined) continue;
      for (const operation of home.sealed.commit.operations) {
        if (operation.op !== "sqlite") {
          const key = docInstanceKey(
            operation.id,
            this.#scopeKeyFor(operation.scope, context),
          );
          if (droppedDocs[contribution.index].has(key)) continue;
        }
        const opIndex = operations.length;
        operations.push(operation);
        operationOwners.push(contribution.index);
        if (operation.op === "sqlite") {
          // The sqlite bound's discharge (stage G): the db file a folded
          // op targets is keyed per scope INSTANCE, resolved against the
          // RUN's identity exactly like the run's scoped cell writes (M1
          // — the wave envelope has no session to resolve it from). The
          // sink attaches the matching file(s) before its transaction.
          sqliteScopeKeys.push({
            op: opIndex,
            scopeKey: this.#scopeKeyFor(operation.db.scope, context),
          });
        }
        if (operation.op !== "sqlite") {
          const scoped = operation.scope !== undefined &&
            operation.scope !== "space";
          if (scoped || context.acting !== undefined) {
            annotations.push({
              op: opIndex,
              ...(scoped
                ? { scopeKey: this.#scopeKeyFor(operation.scope, context) }
                : {}),
              ...(context.acting !== undefined
                ? {
                  actingUser: context.acting.user,
                  ...(context.acting.session !== undefined
                    ? { actingSession: context.acting.session }
                    : {}),
                }
                : {}),
            });
          }
        }
      }
      for (const precondition of home.sealed.commit.preconditions ?? []) {
        preconditions.push(precondition);
        preconditionOwners.push(contribution.index);
      }
      // Every survivor lands its basis rows — including one whose writes
      // were dropped per-doc as superseded: its reads are true, and no
      // recompute-owed mark exists (§3d, RULED 2026-08-05).
      //
      // S4 (serving-loop.md §3b; server-execution v2 stage A — basis
      // rows keyed by the FULL instance address the run served): the
      // rows land under the run's DISCOVERED scope resolved against its
      // identity — the instance address the run actually computed —
      // rather than under the demand's stamp. A user-scoped watch stamps
      // `user:<p>` on a node that discovered `space` (over-keyed rows,
      // F10), and a session-scoped watch stamps `session:<p>:<s>` on a
      // node that discovered `user` — the RAGGED case (narrowing below
      // the space→user hop is per principal, scopes.md §2 as amended
      // 2026-08-16): a departed session then leaves rows no run can ever
      // overwrite, a zombie the re-mark re-dirties at every activation.
      // The stamped key and every BROADER key on the run's own chain
      // (`space`, and `user:<p>` under a session instance) that differ
      // from the true key are cleared with an EMPTY replacement in the
      // SAME wave transaction — the "narrowing DELETES the rows it
      // stranded" rule, sound in both directions by monotonicity at the
      // top hop and within one principal (an instance narrower than
      // `space` for anyone is narrower for everyone; a principal's
      // sessions narrow together). A real row set already recorded in
      // this wave under a key is never overwritten by a clearance (map
      // insertion below is guarded), so in-wave order cannot lose rows.
      const trueKey = this.#trueBasisKey(contribution);
      basisInstances.set(`${context.actionId} ${trueKey}`, {
        action: context.actionId,
        actionScopeKey: trueKey,
        rows: this.#basisRowsFor(contribution),
      });
      for (const stranded of this.#strandedBasisKeys(contribution, trueKey)) {
        const clearanceKey = `${context.actionId} ${stranded}`;
        if (!basisInstances.has(clearanceKey)) {
          basisInstances.set(clearanceKey, {
            action: context.actionId,
            actionScopeKey: stranded,
            rows: [],
          });
        }
      }
    }
    // Same-space emitted entries (LT1): every surviving op that appends
    // a seq-LESS entry into a stream sidecar carries a NEW event — the
    // engine's admission requires its declaration to stamp the stream
    // seq (a rewrite — an already-stamped entry — needs none). An
    // entry whose event was PROCESSED IN THIS WAVE — the surviving
    // contribution of the LT1 in-process copy's OWN handler run
    // (`context.lt1 === true`; stamped by the SpaceServer from
    // `served.lt1`, cell.ts's serving arm) carries its eventId — is
    // marked `consequenced` in the batch op (a CLONE; the sealed arrays
    // are caller-shared), so the entry and its consequences commit
    // together (events.md §2's "an entry processed in its own wave
    // commits together with its consequences"; the engine admits
    // derived new appends already consequenced). A run that REQUEUED
    // is not a survivor: its entry lands unmarked and the next wave's
    // drain re-runs it (C8b); an emitter that requeued withdrew the
    // entry with its contribution (C8d).
    //
    // ONLY the copy's own run marks (stage C build W3 independent review
    // B1, 2026-08-19): an event can contribute SEVERAL transactions to
    // one wave — the handler run plus a separate event-handler-stamped
    // sibling carrying the same eventId (the served navigateTo's intent
    // tx, committed inline mid-run). When the sibling seals into the
    // appending wave and the handler's own tx does not (an async handler
    // still running when the flush deadline closed the wave — the copy is
    // then refused at its late seal, α1b), marking the entry on the
    // sibling's survival alone declared the event processed while its
    // consequences never landed: the drain saw a consequenced entry and
    // never re-delivered — a LOST delivery (zero completed runs), the
    // RULED sentence broken from the other side. A sibling-only survival
    // now leaves the entry UNMARKED; the drain re-runs the handler with a
    // streamEntry (its re-issued intent dedupes on navigateTo's
    // deterministic nonce at apply), and the effect lands exactly once.
    const survivedEventIds = new Set<string>();
    for (const contribution of this.#survivors(requeued, droppedWhole)) {
      if (
        contribution.context.kind === "event-handler" &&
        contribution.context.eventId !== undefined &&
        contribution.context.lt1 === true
      ) {
        survivedEventIds.add(contribution.context.eventId);
      }
    }
    const eventAppends: Array<{ id: string; eventId: string }> = [];
    // A fresh entry list whose OBJECT entries are shallow-copied: the
    // consequenced mark below lands on the copies while every deeper
    // value (payload included) stays SHARED by reference.
    const spineCloneEntryList = (entries: readonly unknown[]): unknown[] =>
      entries.map((entry) =>
        isObjectNotArray(entry)
          ? { ...(entry as Record<string, unknown>) }
          : entry
      );
    for (const [opIndex, original] of operations.entries()) {
      if (original.op === "sqlite" || original.op === "delete") continue;
      if (!original.id.startsWith(STREAM_ENTRIES_DOC_PREFIX)) continue;
      // Clone before any possible mark: the batch holds the SEALED
      // commits' own op objects (shared with replica overlays). Only
      // the SPINE is cloned — the op object, the containers down to
      // `/value/entries`, and the entry objects — NEVER
      // `structuredClone` (verdict blocker, 2026-08-12): event payloads
      // are FabricValues that can carry registry symbols, which
      // `structuredClone` refuses with `DataCloneError`, aborting wave
      // assembly for a valid event; cells it can copy get demoted.
      const entryLists: unknown[][] = [];
      let operation = original;
      if (original.op === "set") {
        const outer = original.value as
          | { value?: { entries?: unknown[] } }
          | undefined;
        const inner = outer?.value;
        if (Array.isArray(inner?.entries)) {
          const entries = spineCloneEntryList(inner.entries);
          operation = {
            ...original,
            value: { ...outer, value: { ...inner, entries } } as never,
          };
          entryLists.push(entries);
        }
      } else if (original.op === "patch") {
        const patches = original.patches.map((patch) => {
          if (
            (patch.op === "append" || patch.op === "add-unique") &&
            patch.path === "/value/entries"
          ) {
            const values = spineCloneEntryList(patch.values as unknown[]);
            entryLists.push(values);
            return { ...patch, values: values as never };
          }
          if (
            (patch.op === "add" || patch.op === "replace") &&
            patch.path === "/value/entries" &&
            Array.isArray((patch as unknown as { value?: unknown }).value)
          ) {
            const values = spineCloneEntryList(
              (patch as unknown as { value: unknown[] }).value,
            );
            entryLists.push(values);
            return { ...patch, value: values as never };
          }
          return patch;
        });
        operation = { ...original, patches };
      }
      operations[opIndex] = operation;
      for (const list of entryLists) {
        for (const [entryIndex, candidate] of list.entries()) {
          const entry = candidate as {
            eventId?: string;
            seq?: number;
            consequenced?: boolean;
          } | null;
          if (
            !isObjectOrArray(entry) ||
            typeof entry.eventId !== "string" || entry.seq !== undefined
          ) {
            continue;
          }
          if (
            !eventAppends.some((decl) =>
              decl.id === operation.id && decl.eventId === entry.eventId
            )
          ) {
            eventAppends.push({
              id: operation.id,
              eventId: entry.eventId,
            });
          }
          if (
            entry.consequenced !== true &&
            survivedEventIds.has(entry.eventId)
          ) {
            // Same-wave processing: mark the CLONE in place. `list` is
            // the spine clone's own array (spineCloneEntryList above),
            // so the sealed originals stay pristine.
            (list[entryIndex] as { consequenced?: boolean })
              .consequenced = true;
          }
        }
      }
    }
    // The rebased ops stay in the batch; the sink re-verifies each
    // rebased doc still sits at the head the merge decision observed.
    return {
      space: this.#space,
      home: true,
      ...(eventAppends.length === 0 ? {} : { eventAppends }),
      basisSeq: this.#basisSeq,
      rebasedHeads: [...rebasedHeads.entries()].map(([doc, head]) => ({
        doc,
        head,
      })),
      operations,
      preconditions,
      preconditionOwners,
      operationOwners,
      annotations,
      consequenceOf,
      basisInstances: [...basisInstances.values()],
      holder: this.#lease?.holder,
      ...(this.#derivedThrough === undefined
        ? {}
        : { derivedThrough: this.#derivedThrough }),
      ...(sqliteScopeKeys.length === 0 ? {} : { sqliteScopeKeys }),
      ...(outboxAppends.length === 0 ? {} : { outboxAppends }),
    };
  }

  /** The accept gate's authority verdict for one (space, acting user)
   * crossing (the F1 fix): probes `foreignWriteGrant` once per pair
   * per wave and caches the verdict promise. A probe that THROWS
   * refuses the crossing — fail closed, never an unhandled crash out
   * of the seal path — and the refusal is scoped to this wave (the
   * next wave's fresh accumulator re-probes). */
  #foreignGrantFor(
    space: MemorySpace,
    acting: { user: string; session?: string },
  ): Promise<boolean> {
    const key = `${space}\0${acting.user}`;
    let verdict = this.#foreignGrantVerdicts.get(key);
    if (verdict === undefined) {
      verdict = (async () => await this.#foreignWriteGrant!(space, acting))()
        .then(
          (result) => {
            if (typeof result === "boolean") return result;
            if (result.granted) {
              // Retain the grant arm for the commit step (OW31 B4): a
              // `creation`-granted target's genesis is forced before
              // the sink applies its data batch.
              this.#foreignGrantVia.set(key, result.via);
            }
            return result.granted;
          },
          (error) => {
            logger.warn("foreign-write-grant-probe-failed", () => [
              `the foreign-write authority probe for ${space} (acting ` +
              `${acting.user}) failed; refusing the crossing fail-closed ` +
              "for this wave (protocol.md §2b)",
              error,
            ]);
            return false;
          },
        );
      this.#foreignGrantVerdicts.set(key, verdict);
    }
    return verdict;
  }

  /** The foreign spaces some admitted crossing of this wave was granted
   * via the `creation` arm (protocol.md §2b's sanctioned provisioning) —
   * the targets whose genesis ACL the commit step must force BEFORE the
   * sink's data batch (OW31 B4; the session-plane precedence clause,
   * INV-13, mirrored onto the engine-direct plane). Resolved by the time
   * the wave closes: every admitted crossing awaited its probe at
   * accumulation. */
  creationGrantedForeignSpaces(): MemorySpace[] {
    const spaces = new Set<MemorySpace>();
    for (const [key, via] of this.#foreignGrantVia) {
      if (via !== "creation") continue;
      spaces.add(key.slice(0, key.indexOf("\0")) as MemorySpace);
    }
    return [...spaces];
  }

  /** The delegated-identity carriage a contribution's foreign batch
   * carries (protocol.md §2's server-produced authored row): ONE
   * originating chain actor + ONE grant, or none. */
  #delegatedFor(context: WaveRunContext): {
    actingPrincipal: string;
    actingSession?: string;
    capabilityRef: string;
  } | undefined {
    return context.acting !== undefined && context.capabilityRef !== undefined
      ? {
        actingPrincipal: context.acting.user,
        ...(context.acting.session !== undefined
          ? { actingSession: context.acting.session }
          : {}),
        capabilityRef: context.capabilityRef,
      }
      : undefined;
  }

  /** The foreign-batch grouping key — (space, acting identity, grant).
   * ONE construction, shared by the batch builder and the verdict
   * settlement, so a contribution always resolves with the seq of the
   * batch its ops actually rode. */
  #foreignBatchKeyFor(space: MemorySpace, context: WaveRunContext): string {
    const delegated = this.#delegatedFor(context);
    return `${space}\0${
      delegated === undefined ? "" : JSON.stringify(delegated)
    }`;
  }

  #buildForeignBatches(
    requeued: ReadonlySet<number>,
    droppedWhole: ReadonlySet<number>,
  ): Array<{ key: string; batch: WaveSpaceCommit }> {
    // One batch per (space, acting identity, capability grant): a foreign
    // provisioning commit carries ONE originating chain actor + ONE
    // grant in its metadata (protocol.md §2's server-produced authored
    // row, §2b), so contributions acting as different principals never
    // share a commit.
    const batches = new Map<string, WaveSpaceCommit>();
    for (const contribution of this.#survivors(requeued, droppedWhole)) {
      for (const sealed of this.#foreignSealed(contribution)) {
        const context = contribution.context;
        const delegated = this.#delegatedFor(context);
        const batchKey = this.#foreignBatchKeyFor(sealed.space, context);
        let batch = batches.get(batchKey);
        if (batch === undefined) {
          batch = {
            space: sealed.space,
            home: false,
            basisSeq: this.#basisSeq,
            rebasedHeads: [],
            operations: [],
            preconditions: [],
            annotations: [],
            consequenceOf: [],
            basisInstances: [],
            holder: this.#lease?.holder,
            ...(delegated === undefined ? {} : { delegated }),
          };
          batches.set(batchKey, batch);
        }
        // No per-op annotations on a foreign batch: the annotation pair
        // is DERIVED-only carriage (protocol.md §7's closed list). The
        // delegated identity rides ONCE in the batch's commit metadata,
        // and the engine's delegated admission keys scoped writes from
        // that validated CARRIED identity (scopes.md §5: consequences
        // land in the actor's instances) — which is why batches group
        // per (space, actor, grant) above.
        for (const operation of sealed.sealed.commit.operations) {
          batch.operations.push(operation);
        }
        batch.preconditions.push(...sealed.sealed.commit.preconditions ?? []);
      }
    }
    return [...batches.entries()].map(([key, batch]) => ({ key, batch }));
  }

  /**
   * The basis-row instance key of a contribution (S4, stage A): the run's
   * DISCOVERED scope resolved against its identity — the full instance
   * address it served. `space` for a run that read nothing scoped; the
   * stamped identity's user or session instance otherwise. A discovered
   * scope the identity cannot resolve (a session-scoped read under a
   * sessionless actor — events.md §2's sessionless-actor shape) falls
   * back to the stamped key: the run could not have served an instance
   * it cannot name.
   */
  #trueBasisKey(contribution: WaveContribution): ScopeKey {
    const context = contribution.context;
    const stamped = context.actionScopeKey ?? "space";
    const identity = context.scopeKeyIdentity ?? this.#scopeKeyIdentity;
    try {
      return resolveScopeKey(contribution.discoveredScope, identity);
    } catch {
      return stamped;
    }
  }

  /** The keys S4 clears for a contribution whose true key differs from
   * what the demand stamped (see commitWave): the stamp itself, and every
   * strictly-broader key on the run's own chain. */
  #strandedBasisKeys(
    contribution: WaveContribution,
    trueKey: ScopeKey,
  ): ScopeKey[] {
    const context = contribution.context;
    const stranded = new Set<ScopeKey>();
    const stamped = context.actionScopeKey ?? "space";
    if (stamped !== trueKey) stranded.add(stamped);
    const identity = context.scopeKeyIdentity ?? this.#scopeKeyIdentity;
    const discovered = contribution.discoveredScope;
    if (scopeRank(discovered) > scopeRank("space")) stranded.add("space");
    if (scopeRank(discovered) > scopeRank("user")) {
      try {
        stranded.add(resolveScopeKey("user", identity));
      } catch {
        // an unresolvable user instance has no rows to strand
      }
    }
    stranded.delete(trueKey);
    return [...stranded];
  }

  /** Basis rows (§3b) for one surviving contribution: doc-granular
   * ids + seqs from the sealed commit's read set — confirmed reads carry
   * their store version; in-wave pending reads share the wave's own
   * commit seq (`seq: null`, filled by the sink). Keyed by the run's
   * TRUE instance key (S4, stage A — see #trueBasisKey). */
  #basisRowsFor(contribution: WaveContribution): SchedulerBasisRow[] {
    const context = contribution.context;
    const actionScopeKey = this.#trueBasisKey(contribution);
    const rows = new Map<string, SchedulerBasisRow>();
    for (const spaceContribution of contribution.spaces) {
      const reads = spaceContribution.sealed.commit.reads;
      for (const read of reads.confirmed) {
        const entityScopeKey = this.#scopeKeyFor(
          read.scope,
          contribution.context,
        );
        rows.set(`${spaceContribution.space} ${read.id} ${entityScopeKey}`, {
          action: context.actionId,
          actionScopeKey,
          entitySpace: spaceContribution.space,
          entity: read.id,
          entityScopeKey,
          seq: read.seq,
        });
      }
      for (const read of reads.pending) {
        const entityScopeKey = this.#scopeKeyFor(
          read.scope,
          contribution.context,
        );
        rows.set(`${spaceContribution.space} ${read.id} ${entityScopeKey}`, {
          action: context.actionId,
          actionScopeKey,
          entitySpace: spaceContribution.space,
          entity: read.id,
          entityScopeKey,
          seq: null,
        });
      }
    }
    return [...rows.values()];
  }

  #settleVerdicts(
    outcome: WaveCommitOutcome,
    requeued: ReadonlySet<number>,
    droppedWhole: ReadonlySet<number>,
    droppedDocs: ReadonlyArray<ReadonlySet<string>>,
    homeWrites: ReadonlyArray<
      ReadonlyMap<string, { id: string; scope?: CellScope; scopeKey: string }>
    >,
    homeSeq: number,
    foreignSeqs: ReadonlyMap<string, number>,
    orphanRefused: ReadonlySet<number> = new Set(),
  ): void {
    this.#reportRequeuedEvents(outcome, (idx) => requeued.has(idx));
    const acceptedBySpace = new Map<
      MemorySpace,
      Array<{ contribution: SealedSpaceContribution; seq: number }>
    >();
    for (const contribution of this.#contributions) {
      const idx = contribution.index;
      const context = contribution.context;
      if (requeued.has(idx)) {
        outcome.dispositions[idx] = { kind: "requeued" };
        // The withdraw rolls back every space's local overlay, foreign
        // included — a foreign provisioning commit that already landed
        // stays durable, and the requeued event's replay converges on
        // the same deterministic ids (protocol.md §2b).
        this.#withdraw(
          contribution,
          "raced consequence requeued: rolled back to unconsequenced, " +
            "retried in a later wave (serving-loop.md §3d)",
        );
        continue;
      }
      if (droppedWhole.has(idx)) {
        outcome.dispositions[idx] = { kind: "dropped" };
        const message = orphanRefused.has(idx)
          ? "orphan delivery refused: the event's durable entry rode an " +
            "emitter write this wave withdrew, so no entry exists behind " +
            "this run and nothing re-emits it (events.md §4 — one " +
            "durable entry, one completed run; stage C build W3, (α3))"
          : contribution.readDependencyWithdrawn
          ? "pure derivation dropped: a read depended on a withdrawn " +
            "contribution; the current scheduled instance re-arms after " +
            "rollback (serving-loop.md §3d)"
          : "contribution dropped from the wave commit " +
            "(serving-loop.md §3d)";
        this.#warnDropped(contribution, message);
        this.#withdraw(contribution, message, "contribution-dropped");
        continue;
      }
      if (droppedDocs[idx].size > 0) {
        let droppedOps = 0;
        for (const key of droppedDocs[idx]) {
          const doc = homeWrites[idx].get(key);
          if (doc !== undefined) {
            droppedOps += this.#homeOpCountFor(contribution, doc);
          }
        }
        const allDropped = droppedDocs[idx].size === homeWrites[idx].size &&
          contribution.spaces.length === 1;
        outcome.dispositions[idx] = allDropped
          ? { kind: "dropped" }
          : { kind: "partially-dropped", droppedOps };
        // No #warnDropped here: a superseded pure derivation is the
        // EXPECTED recovery path — the superseding authored commit is the
        // fresh state its readers reconverge from — not the one-shot loss
        // class the warn exists for.
        // Any surviving ops rode the wave commit; the sealed commit's own
        // overlay rolls back whole and reconverges from the wave commit
        // (or, all-dropped, from the superseding authored commit) arriving
        // as confirmed state.
        this.#withdraw(
          contribution,
          "superseded pure derivation writes dropped from the wave commit " +
            "(serving-loop.md §3d)",
          allDropped ? "contribution-dropped" : undefined,
        );
        continue;
      }
      outcome.dispositions[idx] = { kind: "committed" };
      contribution.emptySettlement?.resolve({ ok: {} });
      if (
        context.kind === "event-handler" && context.eventId !== undefined &&
        // One entry per EVENT: Phase 4's served navigateTo makes an
        // event contribute several transactions to one wave (the
        // handler run + the intent tx), and consumers count events,
        // not contributions.
        !outcome.committedEventIds.includes(context.eventId)
      ) {
        outcome.committedEventIds.push(context.eventId);
      }
      for (const space of contribution.spaces) {
        const seq = space.space === this.#space ? homeSeq : foreignSeqs.get(
          this.#foreignBatchKeyFor(space.space, context),
        ) ?? homeSeq;
        const accepted = acceptedBySpace.get(space.space) ?? [];
        accepted.push({ contribution: space, seq });
        acceptedBySpace.set(space.space, accepted);
      }
    }
    // Foreign batches group by actor and grant, so their server order can
    // differ from contribution order. Each replica promotes accepted
    // batches in server order, preserving seal order within one batch.
    for (const accepted of acceptedBySpace.values()) {
      accepted.sort((a, b) => a.seq - b.seq);
      for (const { contribution, seq } of accepted) {
        contribution.resolveVerdict({ committed: { seq } });
      }
    }
  }

  #abortAfterForeignFailure(outcome: WaveCommitOutcome): void {
    for (const contribution of this.#contributions) {
      const idx = contribution.index;
      const message =
        "foreign provisioning commit failed; home commit withheld — the " +
        "event stays unconsequenced and replays (protocol.md §2b)";
      if (contribution.context.kind !== "event-handler") {
        // The event-handler arm requeues (at-least-once); everything else
        // drops with nothing to re-run it — say so (see #warnDropped).
        this.#warnDropped(contribution, message);
      }
      this.#withdraw(contribution, message);
      outcome.dispositions[idx] = contribution.context.kind === "event-handler"
        ? { kind: "requeued" }
        : { kind: "dropped" };
    }
    this.#reportRequeuedEvents(outcome, () => true);
  }

  /**
   * Report requeued events for the serving loop to retry — SURVIVING
   * requeues only, matching the model's C8d rollback closure: a
   * same-wave cascade child of a requeued parent never got a durable
   * stream entry, so it has nothing to retry — the parent's re-run
   * re-mints it with a fresh id. Reporting it would make the loop retry
   * an event that does not exist.
   */
  #reportRequeuedEvents(
    outcome: WaveCommitOutcome,
    isRequeued: (index: number) => boolean,
  ): void {
    for (const contribution of this.#contributions) {
      const context = contribution.context;
      if (
        context.kind !== "event-handler" || context.eventId === undefined ||
        !isRequeued(contribution.index)
      ) {
        continue;
      }
      const parentAlsoRequeued = context.parentEventId !== undefined &&
        this.#contributions.some((c) =>
          c.context.eventId === context.parentEventId &&
          isRequeued(c.index)
        );
      if (
        !parentAlsoRequeued &&
        // One entry per EVENT: an event can requeue through several
        // contributions (the handler run + the served navigateTo's
        // intent tx — the per-event fold in resolveConflicts), and the
        // loop's re-arm keys on the event, not the contribution.
        !outcome.requeuedEventIds.includes(context.eventId)
      ) {
        outcome.requeuedEventIds.push(context.eventId);
      }
    }
  }
}
