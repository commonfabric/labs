import type {
  CellScope,
  FabricValue,
  SchemaPathSelector,
} from "@commonfabric/api";
import {
  type ACL,
  type AuthorizationError as IAuthorizationError,
  type ConflictError as IConflictError,
  type ConnectionError as IConnectionError,
  type DID,
  type MemorySpace,
  type QueryError as IQueryError,
  type Result,
  type Revision,
  type Signer,
  type State,
  type The as MediaType,
  type TransactionError,
  type Unit,
  type URI,
  type Variant,
} from "@commonfabric/memory/interface";
import type {
  ApplyOpOperation,
  ApplyOpResolution,
  ClientCommit,
  CommitClass,
  CommitPrecondition,
  DeliveryFailureClass,
  EntityDocument,
  EntityIdListOptions,
  EntityIdListResult,
  EventAttentionResolveResult,
  GenesisRoot,
  OperationFieldQuery,
  OperationFieldSnapshot,
  PatchOp,
  ReleaseOpFieldOperation,
  ScopeKey,
  ScopeKeyIdentity,
  SessionReadCeiling,
  SessionSyncUpsert,
  SqliteDbRef,
  SqliteOperation,
  SqliteParamsWire,
  SqliteQueryReader,
  SqliteQueryResult,
  SqliteRegisterDiskSourceResult,
  ViewInterest,
  ViewPlan,
} from "@commonfabric/memory/v2";
import type { OutboxAppendRow } from "@commonfabric/memory/v2/execution-outbox";
import type { Immutable } from "@commonfabric/utils/types";

import type { Cancel } from "../cancel.ts";
import { Cell } from "../cell.ts";
import type {
  CfcAddress,
  CfcContentAddressedLabels,
  CfcDeclaredMonotonicityMode,
  CfcDeclaredWideningExemption,
  CfcDecomposedEnvelopes,
  CfcDereferenceTrace,
  CfcEnforcementMode,
  CfcExternalContentObservation,
  CfcFlowLabelsMode,
  CfcGrantWriteInput,
  CfcLabelMetadataObservation,
  CfcLabelMetadataProtectionMode,
  CfcPolicyEvaluationMode,
  CfcPreparationWork,
  CfcRefusalDetail,
  CfcTriggerReadGating,
  CfcTxState,
  CfcWriteFloorMode,
  ConsultedGrant,
  ConsultedPolicyManifest,
  ImplementationIdentity,
  PostCommitSideEffect,
  RuntimeWritePolicyAuthorization,
  TrustSnapshot,
  WritePolicyInput,
} from "../cfc/mod.ts";
import type { EntityId } from "../create-ref.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { RAW_META_WRITE } from "../meta-seam.ts";
import { BaseMemoryAddress } from "../traverse.ts";
import type { MergeableOpDelta } from "./mergeable-ops.ts";
export type {
  ACL,
  DID,
  MediaType,
  MemorySpace,
  Result,
  Signer,
  State,
  Unit,
  URI,
};
export type ChangeGroup = unknown;

/**
 * Base interface for storage errors. These are lightweight objects (not Error
 * instances) used in Result types for better performance. Error instances are
 * ~500x more expensive to create due to stack trace generation.
 *
 * When throwing these errors, wrap them in a real Error at the throw site.
 */
export interface IStorageError {
  readonly name: string;
  readonly message: string;
}

/** Typed producer evidence for a required replica load that failed before an
 * at-most-once handler could dispatch. The scheduler receives typed failure
 * evidence; an error name may inform `failureClass`, but diagnostic text never
 * constitutes policy evidence or durable `permanentEvidence`. */
export type ReplicaLoadFailure = {
  failureClass: DeliveryFailureClass;
  recoveryEpoch: string;
  permanentEvidence: boolean;
};

export class ReplicaLoadFailureError extends Error {
  override readonly name = "ReplicaLoadFailureError";

  constructor(
    readonly failure: ReplicaLoadFailure,
    cause: unknown,
  ) {
    super(
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
  }
}

export const toReplicaLoadFailureError = (
  cause: unknown,
  recoveryEpoch: string,
): ReplicaLoadFailureError => {
  if (cause instanceof ReplicaLoadFailureError) return cause;
  const named = cause as {
    name?: unknown;
    message?: unknown;
    permanentEvidence?: unknown;
    aclRevision?: unknown;
  } | undefined;
  const name = typeof named?.name === "string" ? named.name : "";
  const failureClass: DeliveryFailureClass = name === "SessionRevokedError"
    ? "session-revoked"
    : name === "ConnectionError"
    ? "connection"
    : name === "AuthorizationError"
    ? "authorization"
    : name === "ProtocolError"
    ? "protocol"
    : name === "TimeoutError"
    ? "timeout"
    : "unknown";
  const aclRevision = named?.aclRevision;
  const permanentAclEvidence = failureClass === "authorization" &&
    named?.permanentEvidence === true && typeof aclRevision === "number";
  return new ReplicaLoadFailureError({
    failureClass,
    recoveryEpoch: permanentAclEvidence ? `acl:${aclRevision}` : recoveryEpoch,
    // A name is not durable evidence. Authorization becomes permanent only
    // when the memory server supplies the current ACL revision. Versioned
    // protocol validators construct ReplicaLoadFailureError directly.
    permanentEvidence: permanentAclEvidence,
  }, cause);
};

/**
 * Metadata that can be attached to read operations
 */
export interface Metadata extends Record<PropertyKey, FabricValue> {}

/**
 * Options for read operations
 */
export interface IReadOptions {
  meta?: Metadata;

  /**
   * When true, register the read in transaction activity but skip loading
   * from storage. Use when caller already has the value and only needs
   * dependency tracking.
   */
  trackReadWithoutLoad?: boolean;

  /**
   * When true, the read is tracked as non-recursive for scheduler invalidation:
   * parent/same-path writes invalidate, child writes invalidate only on key
   * add, since those modify the keys that were read from the object.
   * We also invalidate if we set the length of an array.
   */
  nonRecursive?: boolean;
}

/** Immutable storage value container. */
export interface StorageValue<T extends FabricValue = FabricValue> {
  readonly value: Immutable<T>;
  readonly source?: EntityId;
}

/** Optional `StorageValue<T>`. */
export type OptStorageValue<T extends FabricValue = FabricValue> =
  | StorageValue<T>
  | undefined;

/**
 * A synchronous read of one document instance straight from the space's
 * durable store, in the shape a session frame would deliver it: the
 * document at its current head, or a `deleted` entry at seq 0 when the
 * store holds nothing at that address. A replica with one installed
 * serves a miss from it instead of pulling over its session, and
 * `IStorageManager.integrateStoreWrites` re-reads held documents through
 * it when the store admits a commit touching them. Only a caller
 * co-hosted with the store can supply one; the store's own admission
 * rules are not consulted, so the read runs with whatever authority the
 * caller holds.
 */
export type StoreReadThrough = (
  address: { id: URI; scopeKey: ScopeKey },
) => SessionSyncUpsert | undefined;

export interface IStorageManager extends IStorageSubscriptionCapability {
  id: string;

  /**
   * The signer used for authenticating storage operations.
   * Can be used to derive the user's identity DID via `as.did()`.
   */
  as: Signer;

  /**
   * The manager's own authenticated session identity — the (principal,
   * sessionId) pair the memory server derives scope keys from for this
   * manager's commits and reads. This is what the runner's in-memory
   * identity keys resolve scoped addresses against in the OFF arm
   * (key-vocabulary.md §2: at cardinality 1 the instance dimension is
   * derivable from the runtime's own authenticated session), so the
   * client-side instance keys match the storage rows the server writes.
   * Stable for the manager's live span; `close()` ends that span.
   */
  scopeKeyIdentity(): ScopeKeyIdentity;

  /**
   * Open a new connection to the storage provider associated with the given
   * space.
   */
  open(space: MemorySpace): IStorageProvider;

  /**
   * Whether SPACE's replica holds server-confirmed verified content for
   * `cid:<hash>` — the write-side elision seam for content-addressed
   * document staging, schema and code documents alike. Confirmed only: a
   * pending local write is not evidence the
   * server holds the document. Consults an already-open replica and
   * answers false otherwise; false stages, which is always the safe
   * direction.
   */
  isContentAddressedDocPersisted?(space: MemorySpace, hash: string): boolean;

  /**
   * Install a store read-through for SPACE's replica: from then on a
   * document the replica does not hold is read synchronously from the
   * store on first access, a `sync()` of one resolves from the store
   * without registering a watch, and a `sync()` of a held document is
   * answered from the replica — `integrateStoreWrites` is what moves a
   * held record. Optional: only a manager co-hosted with the store can
   * serve one.
   */
  installStoreReadThrough?(space: MemorySpace, read: StoreReadThrough): void;

  /**
   * Re-read every listed document instance that SPACE's replica holds
   * through its installed read-through and integrate the result as an
   * inbound frame, so a store commit the replica has no watch for still
   * reaches its subscribers. Returns how many documents were refreshed;
   * zero when no read-through is installed or the replica holds none of
   * them.
   */
  integrateStoreWrites?(
    space: MemorySpace,
    writes: readonly { id: string; scopeKey: ScopeKey }[],
  ): number;

  /**
   * Observer of FIRST opens per space (server-execution v2 Phase 4): the
   * flag-ON client runtime's effects channel installs one so it can
   * subscribe to its session's effects-doc instance in every space the
   * manager connects to (protocol.md §5's effects-doc subscription duty).
   * Optional — the OFF arm and managers that never re-open pay nothing;
   * the `shadowFlipObserver` precedent on ISpaceReplica.
   */
  spaceOpenObserver?: (space: MemorySpace) => void;

  /**
   * The spaces this manager currently holds providers for — the effects
   * channel's construction-time sweep (spaces opened before the observer
   * was installed). Optional, like the observer.
   */
  openedSpaces?(): MemorySpace[];

  /**
   * Declares the read ceiling every session this manager opens carries in
   * its signed `session.open` descriptor (`SessionDescriptor.readCeiling`),
   * so a space server serving this runtime's queries bounds them by it. A
   * flag-ON client runtime configured with `cfcReadMaxConfidentiality`
   * calls this at construction; a manager without the method cannot carry
   * a ceiling, and the runtime refuses to be built with one over it.
   *
   * @throws If a session is already open: a ceiling declared after the
   * fact would leave that session reading unbounded.
   */
  setSessionReadCeiling?(ceiling: SessionReadCeiling): void;

  /**
   * Record a runtime-learned HTTP or HTTPS host hint for a space
   * (federation site table). Optional: managers without remote resolution
   * (emulated/test) simply don't implement it. Returns true when the
   * hint is accepted or confirms a configured or accepted route. The first
   * hint can replace an unseeded provider's provisional default route before
   * that route issues a stateful operation. Returns false on a conflict with a
   * seed or accepted hint, or after a stateful operation has been issued
   * through the provisional route.
   */
  registerSpaceHost?(space: MemorySpace, host: string): boolean;

  /** Changes memory-message compression for live and later remote sessions. */
  setMessageCompressionEnabled?(enabled: boolean): Promise<void>;

  /**
   * Register a derived space identity for fresh-space ACL genesis. Optional:
   * storage managers without ACL bootstrap support may ignore this capability.
   * The identity is never used as the principal for ordinary storage work.
   *
   * `options.owner` names the genesis ACL's OWNER (OW31, RULED 2026-08-18:
   * a provisioned space's first commit is signed by the space's own keys
   * and names the ACTING user OWNER — the serving identity appears nowhere
   * in the ACL). Absent, the genesis owner is the manager's own signer —
   * the active user on a client, byte-identical to the pre-OW31 shape.
   *
   * `options.genesisAcl` is the exact document a fresh space is born with
   * (its first and only commit; no intermediate default is ever written),
   * validated by the memory server's genesis admission rather than here.
   * It is a demand: the open proceeds only if the space is fresh or is
   * already owned exactly as the document says (grants below OWNER are the
   * owner's to evolve), and is refused otherwise — never silently entered
   * under someone else's ACL. It never reaches the home arm.
   * The signer that will open the space must be granted at least READ by
   * it. Supplying it together with `owner` in one registration is refused;
   * a later registration for the same space replaces an earlier one, but
   * not once the space's first mount has begun. A manager that cannot
   * bootstrap an ACL refuses it rather than accept a document it would
   * never write.
   *
   * `options.genesisRoot` requires an explicit `genesisAcl`. Its complete
   * source, cause, arguments, and attached source roots are snapshotted in
   * the genesis receipt and authenticated on every mount. Later mounts must
   * match that immutable reservation.
   */
  registerSpaceIdentity?(
    identity: Signer,
    options?: { owner?: string; genesisAcl?: ACL; genesisRoot?: GenesisRoot },
  ): void;

  /**
   * Force `space`'s provider session — and with it any fresh-space ACL
   * genesis the manager's session factory performs — to have completed
   * (OW31 B4). Optional: managers without ACL bootstrap support resolve
   * after a plain session mount; the serving loop's commit step calls it
   * for `creation`-granted foreign targets so the genesis lands before
   * the sink's data batch (protocol.md §2b's genesis clause).
   */
  ensureSpaceInitialized?(space: MemorySpace): Promise<void>;

  /**
   * The serving manager's HOME space (a serving runtime's storage
   * manager declares it; undefined on every client manager). Consumers
   * use it to decide whether a write target is FOREIGN to the serving
   * loop (OW31 seat S-A).
   */
  readonly servingHomeSpace?: MemorySpace | undefined;

  /**
   * Close all storage providers
   */
  close(): Promise<void>;

  /**
   * Creates a storage transaction that can be used to read / write data into
   * locally replicated memory spaces. Transaction allows reading from many
   * multiple spaces but writing only to one space.
   */
  edit(): IStorageTransaction;

  /**
   * Wait for all pending syncs to complete.
   *
   * @returns Promise that resolves when all pending syncs are complete.
   */
  synced(): Promise<void>;

  /** INBOUND settlement only (server-execution v2 stage F): outstanding
   * watch refreshes/pulls, EXCLUDING commit settlement AND update
   * processing — the serving loop's wave-settle barrier. Both exclusions
   * are deadlocks by construction there: a sealed commit settles only at
   * the wave commit the loop performs AFTER settling, and update
   * PROCESSING can park behind that same sealed commit (promotion
   * ordering). The residual — an inbound frame whose processing parks
   * behind a sealed commit settles after the wave commit — is accepted
   * for Phase 1 (owner, 2026-08-05) and self-heals on the next wave; see
   * SpaceReplica.inputSynced for the full statement. Novelty still
   * shadowed by a parked own commit is instead EXCLUDED from the wave's
   * W advance — see `ISpaceReplica.unappliedForeignSeqFloor` (Phase 2
   * revisit (a)). */
  inputSynced?(): Promise<void>;

  /**
   * Issue an ordered-after round trip on every open space connection, so that
   * any subscription fan-out the server has already sent has been received and
   * applied before this resolves. Unlike `synced()`, which waits only on this
   * replica's own pending syncs and commits, this waits on the delivery of a
   * peer's committed writes that the server has begun fanning out. A WebSocket
   * delivers a connection's frames in order, so a fresh round trip on that
   * connection cannot resolve ahead of fan-out the server sent earlier on it.
   * Multi-runtime test harnesses use it to make one runtime observe another's
   * committed state deterministically; a manager with no open remote
   * connection resolves immediately.
   */
  pullOpenSpacesToHead(): Promise<void>;

  /**
   * A throwable `AuthorizationError` when `space` is under a permanent
   * authorization denial (an ACL shortfall, an audience or protocol mismatch),
   * or undefined when it is authorized or was never opened. Scoped to one space
   * on purpose: `synced()` stays silent so a denied cross-space link stays a
   * silent absent read, and a caller that must reach a specific space reads this
   * after `synced()` to surface the real failure. Optional: emulated/test
   * managers may omit it.
   */
  authorizationError?(space: MemorySpace): Error | undefined;

  /** The latest authoritative access loss for a space, cleared on reopening. */
  spaceAccessError?(space: MemorySpace): Error | undefined;

  /**
   * Observes authoritative access loss synchronously. Transient connection
   * failures and normal closure do not emit; `spaceAccessError()` supplies
   * the current snapshot for subscriptions installed after a loss.
   */
  subscribeSpaceAccessLoss?(
    observer: (space: MemorySpace, error: Error) => void,
  ): Cancel;

  /**
   * Observes authoritative denial and recovery after an authorized reopen.
   * Read `spaceAccessError()` for the current verdict. Initial successful
   * opens and transient connection failures do not emit.
   */
  subscribeSpaceAccessChange?(observer: (space: MemorySpace) => void): Cancel;

  /**
   * Register an in-flight commit so the durability barrier
   * (`hasPendingCommits` / `pendingCommitsSettled`) covers it. Called by the
   * transaction layer at `commit()` entry, synchronously with the commit
   * being issued, so there is no window where a commit is in flight but
   * invisible to the barrier. The registration must tolerate rejection and
   * drop the promise once it settles.
   */
  trackPendingCommit(promise: Promise<unknown>): void;

  /**
   * Whether any registered commit is still unconfirmed. Every write flows
   * through `edit()` transactions, so this is the authoritative "are there
   * unconfirmed local writes" signal — narrower than `synced()`, which also
   * waits for pulls and cross-space read work.
   */
  hasPendingCommits(): boolean;

  /**
   * Wait for the currently pending commits to settle (server confirmation or
   * terminal failure). One round only: commits issued after the call starts
   * are not awaited — callers that need a fixpoint re-check `hasPendingCommits`
   * after each round, as the scheduler's client-facing idle does.
   */
  pendingCommitsSettled(): Promise<void>;

  /**
   * Add a promise to the list of cross-space promises.
   */
  addCrossSpacePromise(promise: Promise<void>): void;

  /**
   * Remove a promise from the list of cross-space promises.
   */
  removeCrossSpacePromise(promise: Promise<void>): void;

  /**
   * Register a deferred async chain in the cross-space promise set so
   * `Cell.pull()` and `synced()` await it, then drop it from the set once it
   * settles. Until a chain is registered it is invisible to those waiters: a
   * pull can return before the chain has settled and observe held,
   * not-yet-loaded state. The scheduler's `idle()` does not consult this set at
   * all, so registering a chain does not make `idle()` await it. This is the
   * safe composition of `addCrossSpacePromise` and `removeCrossSpacePromise` —
   * prefer it over wiring the self-removing `finally` by hand at each call site.
   *
   * `work` must eventually settle (resolve or reject). A chain that never
   * settles stays registered and keeps `Cell.pull()` and `synced()` from
   * observing convergence — `Cell.pull()` escapes only at its bounded round cap
   * — so a caller that wraps an external `sync()` should ensure it cannot hang
   * unbounded.
   */
  trackUntilSettled(work: Promise<unknown>): void;

  /**
   * Number of cross-space promises currently pending (async loads of link
   * targets in other spaces, kicked during link resolution or read
   * traversal). Zero in steady state — `Cell.pull()` uses this to decide
   * whether a convergence round is needed at all (CT-1667).
   */
  pendingCrossSpacePromiseCount?(): number;

  /**
   * Whether a link target in `space` should be background-pulled because this
   * replica has never seen the doc (fresh-replica read asymmetry): selector
   * driven syncs only deliver what a schema covered, so a link can point at a
   * same-space doc no selector ever walked — without a pull such reads mask
   * as `undefined`, indistinguishable from absence. Returns true exactly once
   * per (space, id, scope) per manager lifetime and only when the local
   * replica holds no state for the doc; the caller kicks the actual sync (see
   * the link-resolution hop loop). Optional: managers without lazy remote
   * replication (e.g. test mocks) simply don't implement it.
   */
  shouldPullDoc?(
    space: MemorySpace,
    id: URI,
    scope?: CellScope,
    /** The reading run's identity when it is not the manager's own
     * (server-execution v2 stage A): the reservation and the "has this
     * replica seen the doc" check are then per that INSTANCE. */
    identity?: ScopeKeyIdentity,
  ): boolean;

  /**
   * Undo a `shouldPullDoc` reservation after the kicked sync FAILED, so a
   * later read may retry the pull. Without this, one transient sync failure
   * would mask the doc for the manager's whole lifetime (the reservation is
   * taken before the async pull settles). No-op when the doc was never
   * reserved. Callers pair it with the failure path of the sync they kicked.
   */
  retractDocPullKick?(
    space: MemorySpace,
    id: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
  ): void;

  /**
   * Wait for the currently pending cross-space promises (and any they
   * transitively kick) to settle, WITHOUT waiting for full provider sync the
   * way `synced()` does. Used by `Cell.pull()`'s convergence loop so pulls
   * that kicked no loads keep their existing timing.
   */
  crossSpaceSettled?(): Promise<void>;

  /**
   * Documents whose load (`syncCell`) is currently in flight, as
   * `(space, scope, id)` addresses. The scheduler's event preflight parks the
   * head event while an address in the handler's read closure (or upstream of
   * it) is still loading — a load that completes with the document absent
   * counts as complete (CT-1795).
   */
  pendingLoadAddresses?(): readonly Pick<
    IMemorySpaceAddress,
    "space" | "scope" | "id"
  >[];

  /**
   * Generation of the currently in-flight load for an entity key, or
   * `undefined` when the key is not loading. A new generation is allocated
   * after a prior load settles so event preflight can distinguish a genuinely
   * new provisional snapshot from the load it already waited for.
   */
  pendingLoadGeneration?(key: string): number | undefined;

  /**
   * Resolves when none of the given documents (keyed
   * `space/scope/id`, see the scheduler's `entityKey`) has an in-flight
   * load. Resolves immediately when none do. Rejects when any of the captured
   * load generations fails, so an at-most-once event is not dispatched against
   * a replica whose required load failed.
   */
  loadsSettled?(keys: readonly string[]): Promise<void>;

  /** A new generation of the SAME required load is a causal recovery wake.
   * `failedEpoch` is stable for the document across manager recreation;
   * `recoveryEpoch` uniquely names the replacement generation. Carrying both
   * prevents an unrelated document recovery from authorizing a retry. */
  loadRecoveryObserver?:
    | ((recovery: {
      failedEpoch: string;
      recoveryEpoch: string;
    }) => void)
    | undefined;

  /** Authenticated current-session recovery for one OW54 terminal notice. */
  resolveEventAttention?(
    space: MemorySpace,
    eventId: string,
    seq: number,
    sidecarId: string,
    action: "retry" | "dismiss",
  ): Promise<EventAttentionResolveResult>;

  /**
   * THE SESSION REMOUNT's trigger: an admitted commit touched `space`'s ACL
   * document. A space session this manager holds — revoked or denied by an
   * EARLIER ACL verdict — is dropped so the next load re-opens it, because
   * the ACL is the only input that decision has. Never widens authority: a
   * genuine de-authorization is refused again at `session.open`. Implemented
   * by the v2 StorageManager; the serving loop's host is its only caller.
   */
  noteSpaceAclChanged?(space: MemorySpace): void;

  /**
   * Load cell from storage. Will also subscribe to new changes.
   *
   * @returns Promise that resolves when the cell sync is complete.
   */
  syncCell<T>(
    cell: Cell<T>,
    options?: {
      /** The reading run's identity when it is not the manager's own
       * (server-execution v2 stage A — the runner's explicit-instance
       * read): the load NAMES that instance on the wire
       * (`GraphQueryRoot.entityScopeKey`, lease-holder-only) and lands
       * it in the replica under that instance's key. Absent (every
       * client, the OFF arm), the load resolves from the manager's own
       * session exactly as before. */
      scopeKeyIdentity?: ScopeKeyIdentity;
    },
  ): Promise<Cell<T>>;

  /**
   * Load ONE scope INSTANCE of a document by address (server-execution v2
   * stage A — the runner's explicit-instance read at the transaction
   * layer): a served per-instance run's read of a scoped doc that its
   * identity's instance has never been loaded for kicks this — the load
   * names that instance on the wire (lease-holder-only at admission) and
   * lands it under that instance's key, registered as a pending load like
   * `syncCell` (so the event preflight can park on it) and tracked until
   * settled. Optional: managers without lazy remote replication (test
   * mocks) simply don't implement it; the OFF arm never calls it.
   */
  syncInstance?(
    address: { space: MemorySpace; id: URI; scope?: CellScope },
    identity: ScopeKeyIdentity,
  ): Promise<void>;
}

export interface IRemoteStorageProviderSettings {
  /**
   * EXPERIMENTAL (default off): allow more than one watch-refresh round trip
   * to be in flight per space at once, up to a bounded window
   * (`CONCURRENT_WATCH_REFRESH_WINDOW`). By default watch acquisition is strict
   * single-flight, so traversal-driven pulls discovered a tick apart — even
   * with no data dependency between them — serialize into one-RTT-each frames
   * instead of fanning out. With this on, refreshes overlap up to the window
   * and the memory client issues the watch-mutation family (set + add) in an
   * ordered issue phase so wire order is preserved. Same-tick microtask
   * coalescing is unchanged. Off preserves the exact current behavior. See
   * docs/development/EXPERIMENTAL_OPTIONS.md.
   */
  experimentalConcurrentWatchRefresh?: boolean;
}

/**
 * A document a transaction read as absent that its replica never examined,
 * addressed the way a pending load for it is keyed: `scopeKey` names a
 * foreign instance a served run read, and is absent for the replica's own.
 * See {@link IStorageProvider.unexaminedAbsences}.
 */
export type UnexaminedAbsence = Pick<
  IMemorySpaceAddress,
  "space" | "id" | "scope" | "scopeKey"
>;

export interface IStorageProvider {
  /**
   * Sync a value from storage. Use transactions to retrieve the value.
   *
   * @param uri - uri of the entity to sync.
   * @param selector - The SchemaPathSelector with the path and schema that determines what to sync.
   * @returns Promise that resolves when the value is synced.
   */
  sync(
    uri: URI,
    selector?: SchemaPathSelector,
    scope?: CellScope,
    /** The explicit scope INSTANCE to load (server-execution v2 stage A):
     * a serving runtime's per-instance read names an instance other than
     * the manager's own; the watch root then carries
     * `entityScopeKey` (lease-holder-only on the wire) and the replica
     * keys the arriving doc under that instance. Absent = the manager's
     * own instance, exactly as before. */
    instance?: ScopeKey,
  ): Promise<Result<Unit, Error>>;

  /**
   * Wait for all pending syncs to complete, that is all pending document syncs
   * and all pending commits.
   *
   * @returns Promise that resolves when all pending syncs are complete.
   */
  synced(): Promise<void>;

  /**
   * The documents `source` read as absent without this replica ever having
   * examined them: no local record, session-scoped instances excluded since
   * a fresh session instance cannot exist server-side. Each is keyed the
   * way a pending load for it is keyed, so a caller can wait for the loads
   * already in flight for them.
   *
   * An unexamined absence becomes a `seq: 0` confirmed read in the
   * transaction's commit — the claim that no such document exists — which
   * the server rejects whenever one does. `Runtime.editWithRetry` takes this
   * list before committing, waits for the loads in flight for them, and
   * re-runs the attempt locally when {@link presentCount} then reports any
   * as existing, instead of shipping a commit the server would reject.
   * Optional: a provider without it leaves that convergence to the server's
   * rejection and the retry gate.
   */
  unexaminedAbsences?(
    source: IStorageTransaction | undefined,
  ): readonly UnexaminedAbsence[];

  /**
   * How many of `absences`, addresses {@link unexaminedAbsences} returned,
   * this replica now holds with a confirmed revision. Optional alongside
   * {@link unexaminedAbsences}.
   */
  presentCount?(absences: readonly UnexaminedAbsence[]): number;

  /** INBOUND settlement only (server-execution v2 stage F): outstanding
   * watch refreshes/pulls, EXCLUDING commit settlement AND update
   * processing — the serving loop's wave-settle barrier. Both exclusions
   * are deadlocks by construction there: a sealed commit settles only at
   * the wave commit the loop performs AFTER settling, and update
   * PROCESSING can park behind that same sealed commit (promotion
   * ordering). The residual — an inbound frame whose processing parks
   * behind a sealed commit settles after the wave commit — is accepted
   * for Phase 1 (owner, 2026-08-05) and self-heals on the next wave; see
   * SpaceReplica.inputSynced for the full statement. Novelty still
   * shadowed by a parked own commit is instead EXCLUDED from the wave's
   * W advance — see `ISpaceReplica.unappliedForeignSeqFloor` (Phase 2
   * revisit (a)). */
  inputSynced?(): Promise<void>;

  /**
   * Destroy the storage provider. Used for tests only.
   *
   * @returns Promise that resolves when the storage provider is destroyed.
   */
  destroy(): Promise<void>;

  /** The replica holding this space's documents. */
  replica: ISpaceReplica;

  /** Establish the authenticated space session without reading entity values. */
  ensureSession?(): Promise<void>;

  /**
   * Wait for an ordered response after this space's published input frames.
   * Frame application completes before the response; pending local writes may
   * still shadow those inputs. This does not wait for commit durability.
   */
  pullToServerHead?(): Promise<void>;

  /** List live space-scoped entity identifiers without loading their values. */
  listEntityIds?(): Promise<string[] | undefined>;

  /** List one page from a stable live entity-identifier snapshot. */
  listEntityIdPage?(
    options?: EntityIdListOptions,
  ): Promise<EntityIdListResult | undefined>;

  /** Test one live space-scoped entity identifier without loading its value. */
  entityIdExists?(id: string): Promise<boolean | undefined>;

  /** Run a server-side read-only SQLite query against a cell-derived db. */
  sqliteQuery?(
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
    reader?: SqliteQueryReader,
  ): Promise<SqliteQueryResult>;

  // No `sqliteExecute`: SQLite writes go through the commit fold
  // (recordSqliteWrite -> a `sqlite` op in the commit), never a standalone RPC.

  /**
   * Whether the CONNECTED SERVER advertised commit-time row-label evaluation
   * for folded sqlite writes (CFC Phase 3.c,
   * `MemoryProtocolFlags.sqliteCommitRowLabelEval`). The runner's write gate
   * relaxes its non-attributable-shape rejects only when this is true; a
   * missing implementation, a not-yet-resolved session, or an old server all
   * read as `false` — fail closed.
   */
  sqliteServerCommitRowLabelEval?(): boolean;

  /**
   * Register an injected on-disk SQLite source (Phase 7, read-only v1). After
   * this, server-side reads for `id` resolve against the on-disk file at `path`
   * (attached read-only) instead of the cell-derived db; writes are rejected.
   */
  registerSqliteDiskSource?(
    id: string,
    path: string,
  ): Promise<SqliteRegisterDiskSourceResult>;
}

export interface IOperationStorageCapability {
  operationCodecs(): Promise<readonly string[]>;

  queryOperationField(
    query: Omit<OperationFieldQuery, "principal" | "sessionId">,
  ): Promise<OperationFieldSnapshot>;

  applyOperation(operation: ApplyOpOperation): Promise<ApplyOpResolution>;

  releaseOperationField(operation: ReleaseOpFieldOperation): Promise<void>;

  subscribeOperationField(
    query: Omit<OperationFieldQuery, "principal" | "sessionId">,
    callback: (snapshot: OperationFieldSnapshot) => void,
  ): Promise<Cancel>;
}

export const hasOperationStorageCapability = (
  value: unknown,
): value is IOperationStorageCapability => {
  const candidate = value as Partial<IOperationStorageCapability>;
  return typeof candidate.operationCodecs === "function" &&
    typeof candidate.queryOperationField === "function" &&
    typeof candidate.applyOperation === "function" &&
    typeof candidate.releaseOperationField === "function" &&
    typeof candidate.subscribeOperationField === "function";
};

/**
 * Extension of {@link IStorageManager} which is supposed to merge into
 * {@link IStorageManager} in the future. It provides capability to subscribe
 * to the storage notifications.
 */
export interface IStorageNotificationCapability {
  /**
   * Subscribes to the storage manager's notifications.
   *
   * @example
   * ```ts
   * storage.subscribe({
   *   next(notification) {
   *     console.log(notification);
   *     return { done: true };
   *   }
   * });
   * ```
   *
   * Although note that function takes a generalized {@link Iterator} as an
   * argument so you could subscribe with a generator.
   *
   * @example
   * ```ts
   * function* log(n) {
   *   while (n-- > 0) {
   *     const notification = yield;
   *     console.log(notification);
   *   }
   * }
   * storage.subscribe(log(5));
   * ```
   */
  subscribe(subscription: IStorageNotification): void;

  /**
   * Removes a previously registered notification subscriber.
   */
  unsubscribe?(subscription: IStorageNotification): void;
}

/**
 * Subscription that can be used to receive storage notifications.
 */
export interface IStorageNotification {
  /**
   * Called with a next notification, if returns `{ done: true }` or throws an
   * exception, subscription will be cancelled and method will not be called
   * again until re-subscribed through another `subscribe` on
   * `IStorageSubscriptionCapability`. Returning any other return value implies
   * continued subscription.
   */
  next(
    notification: StorageNotification,
  ): Omit<IteratorResult<unknown, unknown>, "value"> | undefined;
}

/**
 * Backward-compatible alias retained while the v1 naming is still used
 * throughout the runner.
 */
export interface IStorageSubscriptionCapability
  extends IStorageNotificationCapability {}

/**
 * Backward-compatible alias retained while the v1 naming is still used
 * throughout the runner.
 */
export interface IStorageSubscription extends IStorageNotification {}

/**
 * Notification produced by the underlying storage. It is a variant type
 * implying that object has only one of the fields with a cerrosponding
 * value. Property name denotes type of notification.
 */
export type StorageNotification =
  | ICommitNotification
  | IRevertNotification
  | ILoadNotification
  | IPullNotification
  | IIntegrateNotification
  | IResetNotification;

/**
 * This notification is broadcasted after commit on {@link IStorageTransaction}
 * is called and underlying changes are written to the local replica. Note that
 * this represents a local optimistic update which can be denied by remote
 * storage provider in which case they will be reverted.
 */
export interface ICommitNotification {
  type: "commit";

  /**
   * The space into which changes were made.
   */
  space: MemorySpace;

  /**
   * Set of changes merged.
   */
  changes: IMergedChanges;

  /**
   * Transaction that committed changes. If legacy API is used it will not have
   * a source transaction.
   */
  source?: IStorageTransaction;
}

/**
 * This notification is broadcasted if commited changes were denied and had to
 * be reverted.
 */
export interface IRevertNotification {
  type: "revert";

  /**
   * The space into which changes were made.
   */
  space: MemorySpace;

  /**
   * Set of changes merged. Note that this is not necessary resetting every
   * change commit made to a state it had pre-commit as things may have changed
   * since and `before` values will represent state in the replica before we
   * reverted them to the state in the `after`. Also note that set of changes
   * in the commit may be larger than set of changes here because commit may
   * have being stacked on to of the other and if first commit was denied and
   * reverted changes are some state may have already being updated by previous
   * revert.
   */
  changes: IMergedChanges;

  /**
   * Reason storage had to revert changes.
   */
  reason: StorageTransactionRejected;

  /**
   * Transaction that committed changes. If legacy API is used it will not have
   * a source transaction.
   */
  source?: IStorageTransaction;
}

/**
 * This notification is broadcasted when storage loads changes from the local
 * cache into a storage.
 */
export interface ILoadNotification {
  type: "load";
  space: MemorySpace;
  changes: IMergedChanges;
}

/**
 * This notification is broadcasted when storage pulls changes from the remote
 * storage provider and merges them into the local replica.
 */
export interface IPullNotification {
  type: "pull";
  space: MemorySpace;
  changes: IMergedChanges;
}

/**
 * This notification is broadcasted after storage receives integrates changes from
 * the remote storage provider into a local replica.
 */
export interface IIntegrateNotification {
  type: "integrate";
  space: MemorySpace;
  changes: IMergedChanges;

  /**
   * Present ONLY on the flip a SPECULATION retirement produces
   * (server-execution v2, speculation.md §4's arrival-gated retirement,
   * RULED 2026-08-16 — the "own retirement is not a trigger" rider): the
   * retiring entry's own transaction, so the scheduler treats the flip
   * of an action's OWN echo like its own commit source and does not
   * re-run the writer for it. A writer subscribed to its own output
   * (the scope-narrowing write path reads the redirect slot and its
   * diff base) would otherwise re-derive on every retirement whose
   * authoritative value differs from its echo — re-speculate, retire,
   * flip, forever. Downstream readers of the doc are unaffected (they
   * are not the source). Absent on every other integrate (foreign
   * novelty, watch refreshes) — byte-identical there.
   */
  source?: IStorageTransaction;
}

/**
 * This notification is broadcasted after storage has being reset, which can happen
 * on network errors. It implies that all in memory caches have being cleared and
 * will be populated with data from persisted cache and remote storage provider.
 */
export interface IResetNotification {
  type: "reset";
  space: MemorySpace;
}

/**
 * Set of changes that were merged into the local replica.
 */
export interface IMergedChanges extends Iterable<IMemoryChange> {
}

/**
 * Options accepted by transaction write operations.
 */
export interface IWriteOptions {
  /**
   * When true, the write removes the slot at the address path — deleting an
   * object key or punching an array hole — instead of storing a value.
   * `value` must be `undefined`. Without this flag, writing `undefined`
   * stores `undefined` as a real value: present-but-undefined is distinct
   * from absent. A root-path delete retracts the document.
   */
  delete?: boolean;

  /**
   * Marks the write as one the runtime makes on a document's meta seam. See
   * {@link RAW_META_WRITE}: the write chokepoint accepts a write that reaches
   * a meta field on this mark and refuses one that arrives without it.
   */
  readonly [RAW_META_WRITE]?: true;
}

export interface ITransactionWriteRequest {
  address: IMemorySpaceAddress;
  value: FabricValue;

  /** See {@link IWriteOptions.delete}. */
  delete?: boolean;
}

/**
 * One address's before-and-after across a change.
 *
 * A type alias rather than an `interface`, and it has to stay one: its members
 * are `FabricValue`s and it rides the IPC envelope inside a telemetry marker,
 * so it must be able to satisfy `FabricPlainObject`. An `interface` never can,
 * however plain its members -- TypeScript grants the implicit index signature
 * that requires to an anonymous object type and not to an interface.
 */
export type IMemoryChange = {
  /**
   * Memory address that was changed.
   */
  address: IMemoryAddress;

  /**
   * Value memory address had before change.
   */
  before: FabricValue;

  /**
   * Value memory address has after change.
   */
  after: FabricValue;
};

export type StorageTransactionStatus =
  | { status: "ready"; journal: ITransactionJournal }
  | { status: "pending"; journal: ITransactionJournal }
  | { status: "done"; journal: ITransactionJournal }
  | {
    status: "error";
    journal: ITransactionJournal;
    error: StorageTransactionFailed;
  };

/**
 * Options for {@link IStorageTransaction.commit}.
 */
export interface TransactionCommitOptions {
  /**
   * When the returned promise resolves.
   *
   * - `"coverage"` (default): on accept, once the caller's subscribed view
   *   reflects the committed write, its watch-set consequences, and the
   *   foreign novelty it was applied on top of (marker coverage, spec
   *   §4.11.2); on rejection, after the read-repair gate, so a retry runs
   *   against the repaired base.
   * - `"verdict"`: as soon as the commit's fate is sealed — the accept
   *   verdict or the rejection receipt — without the coverage wait, the
   *   read-repair wait, the synced() hold, or the post-commit effect run
   *   (still tracked via postCommitEffectsSettled()). For callers whose
   *   premise is "durably decided but not yet fanned out":
   *   controlled-staleness test fixtures foremost. Only the RETURNED
   *   promise changes: state application still parks, and commit
   *   callbacks and the pending-commit barrier remain on the full
   *   settlement timeline (coverage on accept, read repair on rejection).
   */
  resolveAt?: "coverage" | "verdict";
}

/**
 * Representation of a storage transaction, which can be used to query state and
 * assert / retract while maintaining consistency guarantees. Storage ensures
 * that transactions retain consistent view of the whole storage through it's
 * lifetime by notifying pending transaction of every change that is integrated
 * into the storage, if changes affect any data read through a transaction
 * lifecycle it can not be committed because it would violate consistency. If
 * no change occurs or changes do not affect any data reading it would not
 * affect transaction consistency guarantees and therefor committing transaction
 * will send it to an upstream storage provider which will either accept, if no
 * invariants have being invalidated, or reject and fail commit.
 */
export interface IStorageTransaction {
  /**
   * Optional change group used to associate commits with scheduler actions.
   */
  changeGroup?: ChangeGroup;

  /**
   * When true, the transaction bypasses batch-signing debounce and flushes
   * immediately. Set for user-interactive paths (editWithRetry, events).
   */
  immediate?: boolean;

  /**
   * The scheduler action whose run opened this transaction (spec scheduler-v2
   * P5). Change records derived from this transaction must not re-trigger this
   * action. Compared by OBJECT IDENTITY — diagnostic action ids may collide
   * across instances.
   */
  sourceAction?: object;

  /**
   * Check scheduling dependencies before accepting an empty commit or seal.
   * Set by reactive computations, whose subscriptions must cover changes since
   * their reads. Event handlers retain ordinary empty-commit behavior.
   */
  validateReactiveReads?: boolean;

  /**
   * The scope INSTANCE identity this transaction's scoped reads and writes
   * resolve against when it is NOT the storage manager's own session
   * (server-execution v2 stage A — OW17's tx→replica identity seam,
   * scopes.md §5: a served per-instance run reads and writes ITS instance
   * of every scoped doc, not the service's and not a sibling's). Set once,
   * by the wave run stamp (`stampWaveRunContext`), before the run's first
   * read; absent for every client transaction and the whole OFF arm, where
   * the manager's own identity applies as before. ONE identity per
   * transaction: the transaction's own document cache is name-keyed, so a
   * transaction may never serve two identities (the runner mints one
   * transaction per instance run — `runOnce`).
   */
  scopeKeyIdentity?: ScopeKeyIdentity;

  /**
   * Opt the transaction into writing to more than one memory space. By default
   * a transaction may write to a single space only. When enabled, commit()
   * commits each written space's changes as a separate per-space commit, in the
   * provided order (or first-write order if omitted). The per-space commits run
   * sequentially with NO cross-space atomicity, and STOP at the first per-space
   * failure: spaces committed before the failure are durable and not rolled back
   * (logged), while the failing space and every space after it are left
   * uncommitted. (Stopping preserves the requested order — e.g. a child space
   * before the parent that links to it — and avoids double-applying later writes
   * on retry.)
   *
   * `order` is a sequencing hint ONLY: it controls the order in which written
   * spaces are committed (spaces listed first commit first). It does NOT
   * restrict which spaces may be written — a written space absent from `order`
   * still commits, appended in first-write order. Authorization is unchanged:
   * each space commits through its own authenticated session exactly as a
   * single-space commit would, so this opt-in cannot grant access the caller
   * does not already hold. Calling this more than once is allowed; the last
   * non-undefined `order` wins.
   *
   * Partial-failure contract: because there is no rollback, a multi-space commit
   * error means the cross-space state is INDETERMINATE — some spaces may be
   * durably committed and others not. Callers must treat the error accordingly
   * (the first per-space error is surfaced as the overall result; all per-space
   * failures are logged).
   */
  enableMultiSpaceWrites?(order?: readonly MemorySpace[]): void;

  /**
   * Confirm that every replica supplying this transaction's read basis is
   * still the active replica for its space. Storage calls this immediately
   * before issuing a mutation so a route replacement cannot carry a result
   * computed from the old replica into another space.
   */
  validateReplicaRoutes?(): Result<Unit, IStorageTransactionInconsistent>;

  /**
   * Optional read-only mode hook used by runtime-generated fallback read
   * transactions.
   */
  setReadOnly?(reason?: string): void;

  clearReadOnly?(): void;
  isReadOnly?(): boolean;

  /**
   * The transaction journal containing all read and write activities.
   * Provides access to transaction operations and dependency tracking.
   */
  readonly journal: ITransactionJournal;

  /**
   * Optional lightweight dependency summary.
   *
   * V2 transactions can provide this directly instead of requiring callers to
   * reconstruct it from journal activity.
   */
  getReactivityLog?(): TransactionReactivityLog;

  /**
   * Optional scheduler observation payload to persist alongside the native
   * memory transaction. When there are no semantic writes, storage backends may
   * still commit this metadata as an internal no-op observation.
   */

  /**
   * Optional commit-time preconditions attached to this transaction's commit in
   * the given space. Storage backends that support v2 native commits read these
   * during commit construction.
   */
  addCommitPrecondition?(
    space: MemorySpace,
    precondition: CommitPrecondition,
  ): void;

  getCommitPreconditions?(
    space: MemorySpace,
  ): readonly CommitPrecondition[] | undefined;

  /**
   * Mark an entity this transaction creates as create-only: the commit fails
   * with PreconditionFailedError("receipt-exists") if the entity already has a
   * head (scheduler-v2 §7.6 receipts).
   */
  markCreateOnly?(
    link: { space: MemorySpace; id: string; scope?: unknown },
  ): void;

  /**
   * Make this transaction's writes AUTHORITATIVE: every value write is
   * recorded and committed even when it equals the currently-visible
   * state, instead of being elided as a no-op (deletes of absent slots
   * stay no-ops — there is nothing to assert). Implies
   * {@link markWholeDocumentWrites}, so the writes also commit as
   * whole-document set/delete and the mergeable intents they recorded are
   * abandoned. One-way; there is no un-mark.
   *
   * Exists for effect-COMPLETION writebacks under the serving posture
   * (server-execution v2 stage G, serving-loop.md §4): the ordinary
   * no-op elision diffs against the replica's OPTIMISTIC view, which
   * layers not-yet-settled sealed overlays over confirmed state. A
   * completion that diffs its `inputHash`/`pending` writes against a
   * DOOMED overlay (a sealed derivation write a later wave-commit
   * supersede-drops, §3d) elides the very write that makes its result
   * durable-consistent — leaving `result present + inputHash stale`,
   * which the next run's memo guard reads as "inputs changed" and
   * destroys the just-served value. Authoritative mode makes the
   * completion assert its full memo state unconditionally; ordinary
   * transactions keep the elision (it exists to shrink the conflict
   * surface, and for them the optimistic view is the right diff base).
   */
  markAuthoritativeWrites?(): void;

  /** Whether {@link markAuthoritativeWrites} was applied to this
   * transaction. Consulted by the value-diff write path
   * (`normalizeAndDiff`), whose equal-leaf elision sits ABOVE the
   * transaction layer and must yield for the same reason. */
  isAuthoritativeWrites?(): boolean;

  /**
   * Emit this transaction's document writes as WHOLE-DOCUMENT set/delete
   * operations rather than as patches or mergeable collection ops, while
   * leaving the no-op elision alone. Recorded mergeable intents are
   * abandoned with the ops they would have produced, so the reads
   * incidental to those ops stay in the commit's read set — the
   * whole-document write is the value the run computed from what it read.
   * One-way; there is no un-mark. {@link markAuthoritativeWrites} implies
   * this and additionally disables the elision.
   *
   * Exists for the client speculation overlay (server-execution v2 Phase 2,
   * speculation.md §1): an overlay entry's operations are layered above the
   * confirmed value and materialized over it on every read. A patch is
   * relative to the layer beneath it, and that layer moves — the space's
   * serving runtime commits the authoritative derivation for the same
   * document, and it arrives before the entry's watermark coverage retires
   * the entry. A positional array splice re-applied over an array that
   * already carries what it inserts duplicates that element; one that
   * removed elements drops one, and a mergeable append double-applies. A
   * whole-document set says what the run computed, so the entry renders
   * that value over whatever lies beneath it.
   */
  markWholeDocumentWrites?(): void;

  /**
   * Record one mergeable-write delta against the document at `address` (see
   * {@link MergeableOpDelta}): elements appended at the array's tail or set-added
   * by identity, a numeric increment, or a value removed by identity. The commit
   * emits these as the corresponding mergeable op (which the server resolves
   * against durable state) and drops the op's path from the commit's conflict
   * read set, so concurrent and stale-base writes merge rather than clobber.
   * Recording is an intent, not a guarantee: a later write that reshapes the
   * same collection, or a recorded tail that no longer describes the local value
   * at commit, falls the path back to the whole-value diff. The op catalog,
   * folding rules, and that fallback live in ./mergeable-ops.ts.
   */
  recordMergeableOp?(
    address: IMemorySpaceAddress,
    delta: MergeableOpDelta,
  ): void;

  /**
   * Abandon the mergeable fast path for the arrays covered by `address`. A
   * caller that rewrites an array in a way a recorded mergeable op cannot
   * represent — an in-place reshape such as sort/reverse/splice after a push, or
   * a whole-value overwrite — calls this so the commit emits the whole-array
   * diff (the correct local value) instead of a tail-relative op whose recorded
   * tail no longer identifies the appended elements.
   *
   * This covers every recorded op AT or BENEATH `address`, since a write to an
   * enclosing object rewrites the arrays inside it too, and nothing above it, so
   * a write beneath an array (an element edit) leaves that array's op alone. A
   * path carrying no op yet is left untouched — not because a reshape before an
   * op is harmless, but because that case is caught at commit instead, when the
   * op's recorded tail is checked against the value it claims to describe.
   */
  poisonMergeableOp?(address: IMemorySpaceAddress): void;

  /**
   * The document addresses for which this transaction recorded a mergeable op.
   * The commit's read-set builder uses these to drop reads of those paths from
   * conflict detection.
   */
  getMergeableOpAddresses?(): Iterable<IMemorySpaceAddress>;

  /**
   * Optional: record a folded SQLite write onto this transaction so it commits
   * ATOMICALLY with the cell ops targeting `space` (one commit = cell ops + a
   * `sqlite` op; on SQL failure the whole commit aborts). Claims `space` as a
   * write target (same write-isolation rules as a cell write) and throws if the
   * tx is not writable. See
   * docs/specs/sqlite-builtin/plans/sqlite-execute-commit-fold.md.
   */
  recordSqliteWrite?(space: MemorySpace, op: SqliteOperation): void;

  /**
   * Optional: whether this transaction has replaced any document root.
   *
   * Read by materialization as a fast path — before the first write every read
   * epoch describes the same state, so a reader can skip epoch handling
   * outright rather than resolve one per path it touches.
   */
  hasWrites?(): boolean;

  /**
   * Optional: the epoch a materialized read taken now should describe.
   *
   * Asking for one is also what tells later writes that the root they displace
   * is still being described, so a transaction nobody reads this way costs its
   * write path nothing.
   */
  issueReadEpoch?(): number | undefined;

  /**
   * Optional: resolve reads against `epoch` until the matching
   * {@link IStorageTransaction.exitReadEpoch}, returning the epoch that was in
   * force.
   *
   * Paired rather than callback-wrapped so a reader walking a large value
   * allocates no closure per property it touches.
   */
  enterReadEpoch?(epoch: number | undefined): number | undefined;

  exitReadEpoch?(previous: number | undefined): void;

  /**
   * Optional raw read observations recorded by this transaction.
   *
   * V2 transactions can provide these directly instead of requiring callers to
   * scan journal activity.
   */
  getReadActivities?(): Iterable<IReadActivity>;

  /**
   * Optional ordered superset of reads that can be noninternal CFC inputs.
   * Only records whose internal-verifier classification is permanently sealed
   * may be omitted. Mutable records remain here and consumers recheck their
   * metadata. Preserves duplicates, activity-clock positions and record
   * identity; the full journal remains available through getReadActivities.
   */
  getPotentiallyExternalReadActivities?(): Iterable<IReadActivity> | undefined;

  /**
   * Optional ordered log of every applied write attempt, in transaction
   * order, stamped on the same per-transaction activity clock as read
   * activities. Unlike `getWriteDetails` (per-path, last-value upserts,
   * path-sorted reconstruction) this preserves the temporal write sequence,
   * one entry per write call. The CFC write-prefix provenance gate derives
   * each protected path's last-overlapping-write bound from it
   * (docs/specs/cfc-write-prefix-provenance.md §4/§6).
   */
  getWriteAttemptLog?(): readonly IWriteAttempt[];

  /**
   * Optional write details for the given space.
   *
   * V2 transactions can provide the current and previous values directly
   * instead of materializing novelty/history attestations.
   */
  getWriteDetails?(space: MemorySpace): Iterable<TransactionWriteDetail>;

  /**
   * Optional write details narrowed to one document.
   *
   * Boundary verification reconstructs several paths for each written
   * document. Transactions that can address their document table directly
   * avoid rescanning every write in the space for each reconstruction.
   */
  getWriteDetailsForTarget?(target: {
    space: MemorySpace;
    id: URI;
    scope?: CellScope;
    path?: readonly PropertyKey[];
  }): Iterable<TransactionWriteDetail>;

  /**
   * Retains the exact-instance commit basis of an elided write when its target
   * has pending state. The dependency adds neither a scheduling subscription
   * nor CFC value taint. Transactions without optimistic pending layers may
   * omit this operation. Callers supply the resolved target that compared equal,
   * not an outer binding that may point into another document or scope.
   */
  retainPendingWriteElision?(address: IMemorySpaceAddress): void;

  /**
   * The manager's `isContentAddressedDocPersisted`, reachable from the
   * transaction (the staging scan runs inside one). Optional the same
   * way; absent means never elide.
   */
  isContentAddressedDocPersisted?(space: MemorySpace, hash: string): boolean;

  /**
   * Optional read details for the given space: the values this transaction
   * observed for its reads (its read invariants). Available after commit or
   * abort, since the underlying per-document snapshots are pinned for the
   * transaction's lifetime.
   */
  getReadDetails?(space: MemorySpace): Iterable<TransactionReadDetail>;

  /**
   * Describes current status of the transaction. Returns a union type with
   * status field indicating the current state:
   * - `"ready"`: Transaction is being built and ready for operations
   * - `"pending"`: Commit was called but promise has not resolved yet
   * - `"done"`: Commit successfully completed
   * - `"error"`: Transaction has failed or was cancelled, includes error details

   * Each status variant includes a `journal` field with transaction operations.
   */
  status(): StorageTransactionStatus;

  /**
   * The store seq `space` accepted this transaction's commit at: the position
   * in that space's commit log the writes landed at, which
   * `cf inspect value-at --seq` and `diff --from/--to` read. Known once the
   * commit's verdict arrives; undefined before it, for a commit the space
   * rejected, and for a space this transaction wrote nothing to. Optional the
   * same way as the read hooks above; absent means unknown.
   */
  committedSeq?(space: MemorySpace): number | undefined;

  /**
   * Reads a value from a (local) memory address and captures corresponding
   * `Read` in the transaction invariants. If value was written in read memory
   * address in this transaction read will return value that was written as
   * opposed to value stored.
   *
   * Read will fail with `InactiveTransactionError` if transaction is no longer
   * active.
   *
   * A slot that does not exist reads as a successful result holding
   * `undefined`. Reading *through* something that cannot hold the rest of the
   * path is an error instead: `INotFoundError` when an intermediate is absent,
   * `ITypeMismatchError` when one is a primitive. The read is recorded either
   * way, so the assumption about non-existence is upheld at commit.
   *
   * A document that does not exist at all is the one case where a first path
   * segment already counts as reading through something absent: the root
   * (`path: []`) reads as `undefined`, while any deeper path fails with
   * `INotFoundError` naming the document.
   *
   * ```ts
   *  const w = tx.write({ space, type, id, path: [] }, {
   *    title: "Hello world",
   *    content: [
   *       { text: "Beautiful day", format: "bold" }
   *    ]
   *  })
   *  assert(w.ok)
   *
   *  assert(tx.read({ space, type, id, path: ['title'] }).ok?.value === "Hello world")
   *  // A missing slot is a successful read of `undefined`
   *  assert(tx.read({ space, type, id, path: ['author'] }).ok?.value === undefined)
   *  // Reaching through the missing `author` is not
   *  assert(tx.read({ space, type, id, path: ['author', 'address'] }).error.name === 'NotFoundError')
   *  // An array's `length` reads as its length
   *  assert(tx.read({ space, type, id, path: ['content', 'length'] }).ok?.value === 1)
   * ```
   *
   * @param address - Memory address to read from.
   * @param options - Optional read options including metadata
   * @returns Result containing the read value or an error.
   */
  read(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): Result<IAttestation, ReadError>;

  /**
   * Records several already-loaded paths in one document as transaction reads
   * without loading their values. Implementations may batch document-level
   * bookkeeping; the resulting activities must match calling `read()` with
   * `trackReadWithoutLoad: true` for each path in iteration order.
   */
  trackReadPaths?(
    address: Omit<IMemorySpaceAddress, "path">,
    paths: readonly (readonly MemoryAddressPathComponent[])[],
    options?: Omit<IReadOptions, "trackReadWithoutLoad">,
  ): Result<Unit, ReadError>;

  /**
   * Writes a value into a storage at a given address & captures it in the
   * transaction invariants.
   *
   * @param address - Memory address to write to.
   * @param value - Value to write.
   * @param options - Optional write options (e.g. explicit delete intent).
   * @returns Result containing the written value or an error.
   */
  write(
    address: IMemorySpaceAddress,
    value?: FabricValue,
    options?: IWriteOptions,
  ): Result<IAttestation, WriterError | WriteError>;

  /**
   * Optional batched write hook for transactions that can apply multiple path
   * writes more efficiently than one-at-a-time.
   */
  writeBatch?(
    writes: Iterable<ITransactionWriteRequest>,
  ): Result<Unit, WriterError | WriteError>;

  /**
   * Transaction can be cancelled which causes storage provider to stop keeping
   * it up to date with incoming changes. Aborting inactive transactions will
   * produce {@link InactiveTransactionError}. Aborted transactions will produce
   * {@link IStorageTransactionAborted} error on attempt to commit.
   */
  abort(reason?: unknown): Result<Unit, InactiveTransactionError>;

  /**
   * Commits transaction. If transaction is no longer active, this will
   * produce {@link IStorageTransactionAborted}. If transaction consistency
   * gurantees have being violated by upstream changes
   * {@link IStorageTransactionInconsistent} is returned.
   *
   * If transaction is still active and no consistency guarantees have being
   * invalidated it will be send upstream and status will be updated to
   * `pending`. Transaction may still fail with {@link StorageTransactionRejected}
   * if state upstream affects values read from updated space have changed,
   * which can happen if another client concurrently updates them. Transaction
   * MAY also fail due to insufficient authorization level or due to various IO
   * problems.
   *
   * Calling commit on a transaction that has already completed (committed or
   * failed) returns the prior error or a {@link IStorageTransactionComplete}
   * error. Commit is NOT idempotent — it does not replay the original result.
   *
   * When this method returns, the changes will have been committed locally,
   * but may not be visible to another runtime. The commit is fully durable
   * and available to other processes at the VERDICT; the returned promise
   * (by default) resolves later, at coverage — once the server's first
   * subscription update after the write has been integrated, so the
   * caller's view reflects the write, any docs it made newly reachable,
   * and the foreign novelty it was applied on top of. On rejection the
   * promise resolves after the read-repair gate, so a retry runs against
   * the repaired base. {@link TransactionCommitOptions.resolveAt}
   * `"verdict"` resolves at fate-sealing instead; effects gated on
   * durability alone hook {@link IExtendedStorageTransaction.addVerdictCallback}
   * or {@link commitVerdict} rather than this promise.
   */
  commit(
    options?: TransactionCommitOptions,
  ): Promise<Result<Unit, CommitError>>;

  /**
   * Resolves with the same result as {@link commit}, but no later than the
   * moment the commit's fate is known — the server verdict or a local
   * rejection. The commit promise itself may resolve later: it additionally
   * waits for the subscribed view to reflect the committed write (or the
   * read-repair gate on rejection). Effects gated on durability alone
   * (verdict callbacks, the outbox flush) hook this instead of the commit
   * promise. Optional: backends without the split fall back to the commit
   * promise.
   */
  commitVerdict?(): Promise<Result<Unit, CommitError>>;

  /**
   * Optional native commit draft hook for storage backends that can consume a
   * more direct representation than a change archive.
   */
  getNativeCommit?(space: MemorySpace): NativeStorageCommit | undefined;

  /**
   * Close this transaction by SEALING instead of committing to the store
   * (server-execution v2, serving-loop.md §3d). Runs the same close work
   * commit() runs — validation, per-space native commit construction in
   * commit order, terminal state transition — but hands each space's native
   * commit to `sink` rather than the space replica, stopping at the first
   * failure exactly like the multi-space commit path. The sink owns what
   * "sealed" means (the wave accumulator applies the writes to the local
   * replica overlay and defers the store commit to the wave). Absent on
   * backends that cannot seal; the OFF arm never calls it.
   */
  sealInto?(sink: ITransactionSealSink): Promise<Result<Unit, CommitError>>;
}

/**
 * Receives a sealing transaction's per-space native commits
 * (serving-loop.md §3d). Implemented by the wave accumulator; called by
 * {@link IStorageTransaction.sealInto} once per written space, in commit
 * order (`.inSpace()` children first, home space last — protocol.md §2b).
 */
export interface ITransactionSealSink {
  sealSpaceCommit(
    space: MemorySpace,
    native: NativeStorageCommit,
    source: IStorageTransaction,
  ): Promise<Result<Unit, CommitError>>;

  /**
   * The read set of a space this transaction READ but wrote nothing to
   * (stage F, discharging a stage-D bound): a tx seals only spaces it
   * wrote (or gated), so without this handoff a read in a read-only
   * space never reaches the accumulator and a withdrawn writer there
   * cannot fold the reader into the withdrawal (serving-loop.md §3d: no
   * blind derived writes). Called once per read-only space, inside the
   * same `sealInto` call as the space commits. Optional: sinks that
   * predate the handoff simply keep the documented bound.
   */
  sealSpaceReads?(
    space: MemorySpace,
    reads: readonly IMemorySpaceAddress[],
  ): void;
}

/**
 * The seal destination an action transaction closes into when one is
 * installed (server-execution v2, serving-loop.md §3d): server-side, under
 * EXPERIMENTAL_SERVER_EXECUTION, an action tx SEALS into the wave
 * accumulator instead of committing to the store. One abstraction, two
 * destinations — with no destination installed (every client, and the OFF
 * arm always), commit() takes today's store path unchanged.
 */
export interface TransactionSealDestination {
  seal(tx: IExtendedStorageTransaction): Promise<Result<Unit, CommitError>>;

  /**
   * The HOME space of the wave this destination seals into (the space
   * the serving loop serves). The send site's LT1-vs-outbox decision
   * reads it: an emission targeting THIS space rides the wave's own
   * commit (LT1's same-space arm), any other space stages the outbox's
   * cross-space append (events.md §2; protocol.md §2b). The SpaceServer
   * and the wave accumulator both expose it; a destination that names
   * none (bare test doubles) leaves the send site on the sending cell's
   * own space as the proxy — a same-space-only harness shape. An
   * outbox-capable destination ({@link stageOutboundAppend} present)
   * MUST name it: the send site refuses the decision rather than
   * guessing (a wrong guess is the pre-fix cross-space raw write).
   */
  readonly space?: MemorySpace;

  /**
   * Stage a cross-space event append onto the CURRENT wave for the run
   * owning `tx` (events.md §2's cross-space arm; serving-loop.md §5):
   * the entry becomes a durable outbox row inside the wave's own store
   * transaction — iff the run's contribution survives the wave commit —
   * and the acting identity travels WITH it. The send site (cell.ts's
   * serving branch) dispatches here whenever a served run's emission
   * targets a space other than {@link space}.
   */
  stageOutboundAppend?(
    tx: IExtendedStorageTransaction,
    row: OutboxAppendRow,
  ): void;

  /**
   * Take ownership of a sealed transaction's post-commit effects
   * (server-execution v2 stage G, serving-loop.md §3/§5): the loop hands
   * external effects to the OUTBOX post-wave-commit — never at seal
   * time, where "committed" only means accepted into a wave whose
   * disposition is still open. A destination that returns `true` OWNS
   * the effects: it flushes them only after the wave commit landed the
   * contribution (and discards them when the contribution was withdrawn
   * — the action re-runs and re-enqueues; at-least-once, serving-loop.md
   * §4). When absent, or returning `false`, the transaction flushes
   * inline at seal exactly as commit does today (bare wave accumulators
   * in tests, and any destination predating the outbox).
   */
  deferSealedEffects?(
    tx: IExtendedStorageTransaction,
    effects: readonly PostCommitSideEffect[],
  ): boolean;
}

export interface IExtendedStorageTransaction extends IStorageTransaction {
  /**
   * Stages `cid:<rootHash>` and its referenced closure into this
   * transaction from the realm registry, with per-transaction dedupe and
   * the confirmed-persistence elision (see ExtendedStorageTransaction).
   * Required: every schema-document write rides this seam, so the
   * dedupe, the elision, and the closure recursion cannot be bypassed by
   * a caller writing documents itself.
   */
  stageSchemaDocClosure(space: MemorySpace, rootHash: string): void;

  /**
   * Stages the content-addressed document holding `value` into this
   * transaction and returns its id: `cid:` plus the general content hash
   * of the value. The document is the value and nothing else, so no
   * closure follows it; the write is blind and idempotent, deduped per
   * transaction, and elided when the space's server already holds the
   * document. Required for the same reason as `stageSchemaDocClosure`:
   * the dedupe and the elision cannot be bypassed by a caller writing
   * the document itself.
   */
  stageContentAddressedDocument(space: MemorySpace, value: FabricValue): URI;

  tx: IStorageTransaction;

  /**
   * The durable id of the event whose dispatch opened this transaction
   * (spec §7.5). Set by the scheduler's event dispatch; consumed by the
   * runner to derive the handler result cell's cause (spec §7.6).
   */
  dispatchedEventId?: string;

  /**
   * Payload keys the RUNTIME itself injected into the dispatched event's
   * value (e.g. the LLM tool-call path's `result` cell). Set by the
   * scheduler's event dispatch from the send's internal options; consumed by
   * the runner's closed-world gate to exempt exactly these keys from an
   * `additionalProperties: false` event schema. Provenance, not shape: the
   * marker travels out-of-band from the injection site, so payload DATA can
   * never claim it — a caller-supplied `result` field, link-valued or not,
   * arrives unmarked and is judged like any other undeclared field.
   */
  dispatchedRuntimeInjectedEventKeys?: readonly string[];

  /**
   * The durable address of this handling's result/receipt cell (spec §7.6:
   * "the receipt is the handling's result cell"). Set by the runner when a
   * handler's outcome is written; consumed by a sender's commit callback to
   * hand the caller a readable handle — on success AND on a create-only
   * receipt collision, where it addresses the winner's original outcome
   * (verb contract WS-D). Structural exposure so no caller ever reconstructs
   * the `{ $ctx, $event }` cause or parses error prose.
   */
  handlingReceiptLink?: NormalizedFullLink;

  /**
   * The wall-clock instant (ms) of the event whose dispatch opened this
   * transaction. Set by the scheduler's event dispatch; consumed by the runner
   * to freeze the handler frame's ambient clock (see Frame.eventTime). Carried
   * forward unchanged onto events the handler emits.
   */
  dispatchedEventTime?: number;

  /**
   * The dispatched handler's BODY did not run (the runner's stream-path
   * argument-did-not-resolve skip: `isValidArgument === false`, runner.ts).
   * Set by the runner on the skip; consumed by the scheduler's event
   * finalize, which withdraws the whole transaction rather than sealing
   * it and re-runs the handler (events.md §5). A SERVED dispatch's
   * transaction carries the entry's pre-stamped `consequenced` mark, so
   * sealing a skipped run would commit the mark with ZERO effects and
   * permanently consume the event (the a04 1-op shape); the entry stays
   * pending-unconsequenced and the drain re-delivers it. A client
   * dispatch is requeued by the scheduler within its retry window, parked
   * on the loads the run registered when any are in flight, and fails
   * loudly once the window is spent or once its re-runs with nothing to
   * park on reach `HANDLER_NOT_RUN_BACKOFF_LIMIT`; one that opted out of retrying is
   * not re-run, and its callback sees the aborted transaction. Under
   * events-down a client dispatch without a served carriage is the
   * speculative echo of an entry the server re-drains, and its skip seals
   * as an empty speculative commit.
   */
  dispatchedHandlerNotRun?: { reason: string };

  /**
   * Commit-time preconditions attached to this transaction's commit in
   * the given space (scheduler-v2 §7.6). Violations surface as
   * IPreconditionFailedError (permanent — never retried).
   */
  addCommitPrecondition?(
    space: MemorySpace,
    precondition: CommitPrecondition,
  ): void;

  getCommitPreconditions?(
    space: MemorySpace,
  ): readonly CommitPrecondition[] | undefined;

  /**
   * Mark an entity this transaction creates as create-only: the commit fails
   * with PreconditionFailedError("receipt-exists") if the entity already has a
   * head (scheduler-v2 §7.6 receipts).
   */
  markCreateOnly?(
    link: { space: MemorySpace; id: string; scope?: unknown },
  ): void;

  /**
   * Record one mergeable-write delta against the document addressed by `link`
   * (see {@link MergeableOpDelta}), forwarded to the underlying transaction after
   * resolving the link to a memory address.
   */
  recordMergeableOp?(link: NormalizedFullLink, delta: MergeableOpDelta): void;

  /**
   * Abandon the mergeable fast path for the array addressed by `link`, forwarded
   * to the underlying transaction after resolving the link. See
   * {@link IStorageTransaction.poisonMergeableOp}.
   */
  poisonMergeableOp?(link: NormalizedFullLink): void;

  getCfcState(): Readonly<CfcTxState>;
  setCfcEnforcementMode(mode: CfcEnforcementMode): void;
  setCfcFlowLabelsMode(mode: CfcFlowLabelsMode): void;

  /** Set the write-side `requiredIntegrity` floor dial (§8.12.4.1 / SC-18). */
  setCfcWriteFloorMode(mode: CfcWriteFloorMode): void;

  /**
   * Enable trigger-read gating on the enforcement side (§8.9.2 / SC-3).
   * Anti-downgrade pinned: once enabled, disabling throws.
   */
  setCfcTriggerReadGating(enabled: CfcTriggerReadGating): void;

  setCfcDecomposedEnvelopes(enabled: CfcDecomposedEnvelopes): void;

  /**
   * Selects the envelope version the persist path writes: version 2, which
   * holds each label above the inline limit as a reference to a
   * content-addressed label document and shorter ones inline, or version 1
   * with every label inline. A spelling dial: neither setting is pinned,
   * and the value is read when the transaction prepares.
   */
  setCfcContentAddressedLabels(enabled: CfcContentAddressedLabels): void;

  /**
   * Set the exchange-rule policy evaluation dial (Epic B5, spec §4.4.5).
   * Anti-downgrade pinned: once `enforce`, weakening throws.
   */
  setCfcPolicyEvaluationMode(mode: CfcPolicyEvaluationMode): void;

  /**
   * Set the cross-space label-metadata representation dial (inv-12 Stage 1 /
   * SC-25, spec §4.6.4.1). Anti-downgrade pinned: once `enforce`, weakening
   * throws.
   */
  setCfcLabelMetadataProtectionMode(
    mode: CfcLabelMetadataProtectionMode,
  ): void;

  /**
   * Set the declared-component monotonicity gate dial (WP5, §8.12.1).
   * Anti-downgrade pinned: once `enforce`, weakening throws.
   */
  setCfcDeclaredMonotonicityMode(mode: CfcDeclaredMonotonicityMode): void;

  /**
   * Exempt exactly one (doc, path, clauseDigest) triple from the
   * declared-monotonicity gate for this transaction — the §8.12.7 route 2b
   * declassification-event seam. Requires a trusted builtin implementation
   * identity (the writeCfcGrant discipline); fails closed on malformed or
   * over-broad markers; write-once per transaction.
   */
  setCfcDeclaredWideningExemption(
    exemption: CfcDeclaredWideningExemption,
  ): void;

  /**
   * Record the addresses whose invalidating writes scheduled this run
   * (§8.9.2 trigger reads). Their labels join the flow-label derivation
   * even when the run never re-reads them.
   */
  addCfcTriggerReads(reads: readonly IMemorySpaceAddress[]): void;

  /**
   * The flow-label relevance probe (`cfc/prepare.ts`'s
   * `flowLabelWorkExists`) evaluated ONCE per transaction activity epoch
   * (server-execution v2 stage C tuning, T1). The commit chokepoint and
   * `Runtime.prepareTxForCommit` both ask "did this tx observe or write a
   * labeled doc?" on the same unprepared, not-yet-relevant transaction, and
   * the probe is O(reads × dereference traces) — evaluated twice back to
   * back it was 65 % of a saturated client worker in the stage-C
   * attribution. A NEGATIVE verdict is memoized on the transaction and
   * stays valid until the transaction journals any further read, write,
   * dereference trace or trigger read (each bumps an activity epoch); a
   * positive verdict marks the tx relevant, after which neither caller
   * probes again. Optional so hand-built transactions keep working — a
   * caller falls back to the free function.
   */
  probeFlowLabelWork?(): boolean;

  /**
   * Run `fn` with `meta` merged into every read issued within (explicit
   * per-read meta wins). Lets scheduling machinery tag its reads without
   * threading metadata through intermediate APIs.
   */
  runWithAmbientReadMeta<T>(meta: Metadata, fn: () => T): T;

  markCfcRelevant(reason?: string): void;
  invalidateCfc(reason: string): void;

  getNarrowestReadScope(): CellScope;
  resetNarrowestReadScope(scope?: CellScope): void;

  /**
   * Turn lazy materialization on (or off) for this transaction.
   *
   * A marked transaction hands a reader views that resolve each path as it is
   * touched, rather than a value built in one pass before the reader looks at
   * any of it. A view keeps the transaction it was created with and describes
   * the instant it was taken at — containers and values alike — so a reader
   * that writes and reads back through a value it already holds still sees what
   * was there. Taking the read again fixes a later instant, which is how a
   * reader sees its own writes. Reading after the transaction finishes throws
   * rather than quietly reading from committed state.
   *
   * Unmarked, a read is built in one pass and the query-result proxy is a
   * standing handle that long-lived consumers rely on, tracking current state
   * after the transaction it was made against has finished.
   */
  markLazyMaterialize(enabled?: boolean): void;

  isLazyMaterialize(): boolean;

  /**
   * Whether this transaction has replaced any document root.
   *
   * A materialized read consults it to decide whether epoch resolution can be
   * skipped: before the first write every document still stands at its
   * `initial` attestation, so every epoch describes the same state and a read
   * taken at any of them reads alike.
   */
  hasWrites(): boolean;

  /**
   * The epoch a materialized read taken now should describe, or undefined
   * where this transaction cannot answer for an earlier one.
   */
  issueReadEpoch(): number | undefined;

  /**
   * Resolve reads against `epoch` until the matching {@link exitReadEpoch},
   * returning the epoch that was in force.
   */
  enterReadEpoch(epoch: number | undefined): number | undefined;

  exitReadEpoch(previous: number | undefined): void;

  /**
   * Record that a reader touched data its schema does not describe.
   *
   * Recorded on the transaction rather than left to the throw alone, because a
   * reader can catch a `SchemaMismatchError` and carry on. Whoever dispatched
   * the read checks `takeSchemaRefusal()` after the body returns and disposes
   * of the run the same way either way.
   */
  noteSchemaRefusal(refusal: unknown): void;

  takeSchemaRefusal(): unknown;

  /**
   * Withdraw a refusal that never reached the reader.
   *
   * A view refuses at the property it is reading and decides at the property
   * above whether that refusal escapes: one the schema does not require reads
   * as `undefined` instead, which is what an eager read leaves behind. The
   * record has to go with the throw it belonged to. Clears only if this exact
   * refusal is the one held.
   */
  clearSchemaRefusal(refusal: unknown): void;

  //
  // CFC recording / ownership-transfer API
  //
  // The methods below all hand a caller-constructed record into the CFC
  // subsystem's transaction-scoped state. Each one establishes an
  // ownership transfer at the call boundary: from the moment the call
  // returns, the supplied record is owned by the transaction. Callers
  // MUST NOT subsequently mutate it (or any object reachable from it),
  // and MUST NOT retain it for use anywhere else that depends on it
  // remaining mutable.
  //
  // The CFC subsystem treats these records as identity-stable structural
  // fingerprints — they participate in canonicalization, sorting, and
  // `hashStringOf()`-based equality. The CFC implementation is therefore
  // permitted to `deepFreeze()` the record on entry, both as a tripwire
  // for accidental mutation and to make it eligible for the
  // `hashStringOf()` WeakMap cache. The
  // `record*` methods that take a structurally-shaped record
  // (`recordCfcDereferenceTrace()` and `recordCfcWritePolicyInput()`)
  // actively do this on entry; the contract applies uniformly to every
  // method in the group.
  //
  // Callers do not need to freeze the record themselves — the CFC
  // implementation will, where it's useful. Freezing on the caller side
  // is equally welcome though, and is often a reasonable choice when
  // the same record (or sub-objects) is also handed to other consumers
  // with similar contracts; `deepFreeze()` short-circuits on input
  // that's already deeply frozen, so a redundant freeze costs almost
  // nothing.
  //

  /**
   * Records a CFC dereference trace produced by following a write
   * redirect or value reference. See ownership note above; the
   * argument is `deepFreeze()`d on entry so every CfcAddress that
   * flows into the digest input is immutable.
   */
  recordCfcDereferenceTrace(trace: CfcDereferenceTrace): void;

  /**
   * Declares a list-coordinator result container (filter/flatMap) whose
   * `structure` label must be re-derived from this transaction's flow-join J
   * (its selection criteria) — independent of whether the container value is
   * written this tx. See `CfcTxState.structureContainers`. The address is
   * `deepFreeze()`d on entry.
   */
  recordCfcStructureContainer(address: CfcAddress): void;

  /**
   * Settles whether this transaction is CFC-relevant — the flow-label
   * relevance probe, then the sink-request ceiling probe — and runs
   * `prepareCfc()` when it is.
   *
   * `commit()` runs this itself, so the enforcement ladder always decides on
   * a settled verdict. `Runtime.prepareTxForCommit` runs it earlier for
   * callers that read what prepare produces before they commit — the CFC
   * outbox, and the label-map writes a reactivity log captured before the
   * commit carries. A second pass finds the transaction prepared and does
   * nothing. `docs/specs/cfc-commit-preparation.md` covers the arrangement.
   */
  prepareForCommit(): void;

  /**
   * Runs CFC boundary verification for this transaction and records the
   * prepared digest. Takes no caller-supplied input: the commit-time digest
   * recheck only confirms the prepared input matches real activity, so an
   * external input override would let a caller skip verification while still
   * passing the recheck (audit S2).
   */
  prepareCfc(): string;

  /**
   * Sets (or clears) the CFC trust snapshot for this transaction. See
   * ownership note above.
   */
  setCfcTrustSnapshot(snapshot: TrustSnapshot | undefined): void;

  /**
   * Sets (or clears) the implementation identity that will be folded
   * into the CFC digest for this transaction. See ownership note above.
   */
  setCfcImplementationIdentity(
    identity: ImplementationIdentity | undefined,
  ): void;

  /**
   * Records a write-policy input that will participate in the CFC
   * commit-boundary digest. See ownership note above; the argument is
   * `deepFreeze()`d on entry, both to honor the ownership-transfer
   * contract and to enable the within-sort tiebreaker cache in
   * `compareWritePolicyInput`.
   */
  recordCfcWritePolicyInput(
    input: WritePolicyInput,
    authorization?: RuntimeWritePolicyAuthorization,
  ): void;

  /**
   * Returns read-only schema inputs recorded for the document across scopes.
   * Each query includes inputs appended since earlier queries, including a
   * query that found none. Path and IFC relevance remain the caller's checks.
   */
  getCfcSchemaPolicyInputs(
    space: MemorySpace,
    id: string,
  ): readonly Extract<WritePolicyInput, { kind: "schema" }>[];

  /**
   * Whether `input` was recorded by the runtime, under
   * `runtimeWritePolicyAuthorization`.
   *
   * `recordCfcWritePolicyInput` is on this interface, and pattern-authored
   * code reaches the transaction its cells are bound to, so an input's own
   * fields say only what its recorder wrote. A gate that ACTS on an input
   * asks this; a gate that measures one does not need to.
   */
  isRuntimeWritePolicyInput(input: WritePolicyInput): boolean;

  /**
   * Enroll `target` as a store this runtime owns for `owner`'s piece — a
   * document it materializes to hold that piece's machinery rather than data
   * an author named — for as long as that piece's nodes run, rather than for
   * this transaction alone.
   *
   * Enrollment is what a store written outside the transaction that minted it
   * needs: the runtime instantiates a piece's nodes, and mints a builtin's
   * state stores, before the reactive updates, event handlers and settled
   * requests that fill them run. A store minted and filled in one transaction
   * wants only the write-policy marker.
   *
   * `owner` is a `runtimeOwnedStoreOwnerKey` value — per scope instance, since
   * two scope instances of one causal piece start and stop separately, and
   * absent for a store outside the owner's own space. A store several pieces
   * enroll leaves when the last of them releases it.
   *
   * Ignored without `runtimeWritePolicyAuthorization`, and ignored for an
   * address carrying a path: ownership is a claim about a whole store.
   */
  enrollRuntimeOwnedStore(
    target: CfcAddress,
    owner: string,
    authorization?: RuntimeWritePolicyAuthorization,
  ): void;

  /**
   * Whether the runtime owns the store at `id` in `space` — named by an
   * authorized whole-document
   * `CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE` marker on this
   * transaction, or enrolled by a previous {@link enrollRuntimeOwnedStore}.
   *
   * Scope is not an argument — every scoped instance of one causal id is an
   * instance of the same cell.
   *
   * Takes the runtime's mark, like the recorders do: it answers about the
   * whole runtime rather than this transaction, and every id it knows is
   * derivable from a piece's cause, so an ungated answer would tell
   * pattern-authored code whether a given piece is running here.
   */
  isRuntimeOwnedStore(
    space: string,
    id: string,
    authorization?: RuntimeWritePolicyAuthorization,
  ): boolean;

  /**
   * Whether the store at `id` in `space` is one no schema declares a policy
   * on — named by an authorized whole-document
   * `CFC_STRUCTURAL_PROVENANCE_UNDECLARABLE_STORE` marker on this transaction.
   *
   * The §8.12.4 writer-fit measurement quantifies over the paths a schema
   * could have declared a policy at, and skips the ones it cannot ask about.
   * Two of those it reads off the id alone; this is the answer for a document
   * whose id says nothing, which the runtime names as it writes it.
   *
   * This transaction alone, with no enrollment beside it: the measurement runs
   * over documents the asking transaction wrote, so a marker recorded beside
   * the write always covers the question.
   *
   * Takes the runtime's mark for the same reason {@link isRuntimeOwnedStore}
   * does: the gate acts on the claim rather than measuring it.
   */
  isUndeclarablePolicyStore(
    space: string,
    id: string,
    authorization?: RuntimeWritePolicyAuthorization,
  ): boolean;

  /**
   * Records a grant document consulted by policyState-guarded boundary
   * evaluation (§8.12.7 route 2a) — address plus resolution-time content
   * digest — for the prepared-digest binding (`PreparedDigestInput.
   * consultedGrants`). Deduplicated by address; the argument is
   * `deepFreeze()`d on entry. Called by the runner-side grant resolver
   * (`createTxCfcGrantResolver`); recording is not itself an enforcement
   * decision, so exposure is harmless (like `noteCfcDiagnostic`).
   */
  recordCfcConsultedGrant(consulted: ConsultedGrant): void;

  /** Records a present/absent exact module-policy manifest lookup. */
  recordCfcConsultedPolicyManifest(
    consulted: ConsultedPolicyManifest,
  ): void;

  /** Runtime-verified module policy manifest lookup (read-only). */
  resolveCfcPolicyManifest(
    reference: unknown,
    destinationSpace?: MemorySpace,
    bindCommit?: boolean,
  ): unknown;

  /** Whether the exact manifest is installed for a destination space. */
  hasCfcPolicyManifest(space: MemorySpace, reference: unknown): boolean;

  /** Atomically stages a compiler-verified manifest for the destination. */
  installCfcPolicyManifest(space: MemorySpace, reference: unknown): boolean;

  /**
   * Records a label-METADATA observation (inv-12 Stage 2, spec §4.6.4.1-.2):
   * the introspection surface observed first-layer label metadata, and the
   * observation enters this transaction's consumed set with its §4.6.4.2
   * population-rule label — the SC-6 revisit's application channel, beside
   * the journal-classified payload observations. Folded into the flow
   * derivation, the egress consumed set, the per-write input gate, and the
   * prepared digest. Empty-label (public) observations are dropped — nothing
   * to derive, gate, or bind. Labeled ones mark the transaction
   * CFC-relevant. See ownership note above; the argument is `deepFreeze()`d
   * on entry. Recording taints — it never grants — so exposure is fail-safe
   * (like `addCfcTriggerReads`).
   */
  recordCfcLabelMetadataObservation(
    observation: CfcLabelMetadataObservation,
  ): void;

  /** Records one runtime-authorized external CONTENT observation. */
  recordCfcExternalContentObservation(
    observation: CfcExternalContentObservation,
    authorization?: RuntimeWritePolicyAuthorization,
  ): void;

  /**
   * Records a structured description of a refusal one of this transaction's
   * CFC gates just decided (`cfc/refusal-detail.ts`): the boundary, the atoms
   * outside it, and the reads that carried them.
   *
   * The prose reason remains the enforcement channel — a detail never decides
   * anything, and recording one neither marks the transaction relevant nor
   * invalidates a preparation. It exists so a refused caller can act: the
   * detail names the INPUT to drop, which the reason alone cannot.
   */
  recordCfcRefusalDetail(detail: CfcRefusalDetail): void;

  /** Counts a full consumed-label collection without changing CFC state. */
  noteCfcConsumedLabelWalk(): void;

  /** Counts prepare work without changing relevance or digest state. */
  noteCfcPreparationWork(kind: CfcPreparationWork, count?: number): void;

  /**
   * The trusted policy-writer path for CFC grant documents (§8.12.7 route
   * 2a; cfc/grants.ts module doc). Requires the transaction's CURRENT
   * implementation identity to be a trusted builtin (the arm
   * `writeAuthorizedBy` and the runtime-mint gate trust for runtime
   * evidence — ordinary pattern/handler code is refused); validates the
   * grant — audience entries principal-like per §3.1.8, `owner` equal to
   * this transaction's acting principal (release authority), lifecycle
   * shape — derives the content-addressed id under the reserved
   * `grant:cfc:` namespace, and writes the document inside the privileged
   * system-write scope. Throws on any violation. Any OTHER write to the
   * reserved namespace is recorded as an unprivileged system write and
   * fails closed at prepare (S18 class).
   */
  writeCfcGrant(input: CfcGrantWriteInput): { space: MemorySpace; id: string };

  /**
   * Surfaces a post-commit sink-request release rejection (the effect is fail-
   * closed and not sent) to CFC diagnostics and runtime stats, instead of only
   * logging it (audit W3.23).
   */
  noteCfcSinkReleaseReject(
    info: { sink: string; effectId: string; detail: string },
  ): void;

  /**
   * Appends a CFC diagnostic message. The sanctioned write path for the CFC
   * machinery's observe-mode notes — getCfcState() returns a read-only view.
   * Diagnostics are advisory and never feed an enforcement decision.
   */
  noteCfcDiagnostic(message: string): void;

  /**
   * Enqueues a side effect to run from the CFC outbox after a successful
   * commit. See ownership note above.
   */
  enqueuePostCommitEffect(effect: PostCommitSideEffect): void;

  /**
   * True when this transaction still carries un-flushed post-commit side
   * effects (the CFC outbox is non-empty). The scheduler uses this to decide
   * whether `commit()` does asynchronous work after the inner storage commit
   * (e.g. a sqlite query RPC + writeback) that `idle()` must wait on — a plain
   * commit with no effects keeps its existing fire-and-forget fast path.
   */
  hasPendingPostCommitEffects(): boolean;

  /**
   * Resolves once the current commit's post-commit effect layer — verdict
   * callbacks and the CFC outbox flush — has run. The effects run at the
   * verdict, so this may resolve before the commit promise itself, which
   * additionally waits for the subscribed view to reflect the write.
   * Barriers that wait for a fire-and-forget commit's effects (work
   * registration, the sqlite query RPC + writeback) wait on this rather
   * than the commit promise: the promise's extra wait is on incoming watch
   * frames, which quiescence must not depend on. Resolved when no commit
   * is in flight.
   */
  postCommitEffectsSettled(): Promise<void>;

  /**
   * Add a callback to be called when the transaction settles. The callback
   * receives the transaction as a parameter and is called regardless of
   * whether the commit succeeded or failed. `abort()` settles the transaction
   * too, and delivers a `StorageTransactionAborted` error to the callback: the
   * writes it staged are discarded either way, so a callback that compensates
   * a failed commit describes the rollback an abort performs as well.
   *
   * Internal-only hook. Callbacks may run after failed commits and therefore
   * must not perform external side effects or release external requests. Use
   * the CFC post-commit outbox for effectful work that should happen only after
   * a successful commit.
   *
   * A callback that undoes in-memory state must check that the state it is
   * about to undo is still the state this transaction established. Another
   * transaction can reach the same deterministic address and take ownership
   * before this one settles.
   *
   * Note: Callbacks are called synchronously after the transaction settles.
   * If a callback throws, the error is logged but doesn't affect other callbacks.
   *
   * @param callback - Function to call when the transaction settles
   */
  addCommitCallback(
    callback: (
      tx: IExtendedStorageTransaction,
      result: Result<Unit, CommitError>,
    ) => void,
  ): void;

  /**
   * Add a callback that fires when the commit's fate is sealed — the
   * accept verdict or the rejection receipt — BEFORE the waits the commit
   * promise (and commit callbacks) additionally sit out: view coverage on
   * accept, the read-repair gate on rejection. For work gated on
   * durability alone; a consumer that acts on the post-commit view (a
   * compensation reading the repaired base, a retry) belongs on
   * {@link addCommitCallback}. Same once-only dispatch and error isolation
   * as commit callbacks; on synchronous fates (abort, pre-storage
   * rejection) both layers fire together, verdict first.
   */
  addVerdictCallback(
    callback: (
      tx: IExtendedStorageTransaction,
      result: Result<Unit, CommitError>,
    ) => void,
  ): void;

  /**
   * Tell the post-commit effects this transaction staged and lost that no
   * further attempt at its commit is coming, by calling each one's `abandon`.
   * Exactly one of an effect's `flush` and `abandon` runs.
   *
   * Called by whoever owns the retries for this transaction, because a commit
   * rejection does not say whether another attempt would fare better and the
   * effect cannot tell. CFC enforcement refuses a commit both for a verdict on
   * the data — a shape its rules do not support — and for metadata this replica
   * has not read yet, and only the second converges when a later attempt sees
   * more. Dispatched at most once, and never after a commit of this
   * transaction succeeded.
   */
  abandonStagedWork(error: CommitError): void;

  /**
   * Reads a value from a (local) memory address and throws on error, except for
   * `NotFoundError` which is returned as undefined.
   *
   * @param address - Memory address to read from.
   * @returns The read value.
   */
  readOrThrow(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): FabricValue;

  /**
   * Reads a value from a (local) memory address and throws on error, except for
   * `NotFoundError` which is returned as undefined.
   *
   * Thin convenience wrapper over `readOrThrow()` that prepends `"value"` to
   * the supplied path.
   *
   * @param address - Memory address to read from.
   * @returns The read value.
   */
  readValueOrThrow(
    address: NormalizedFullLink,
    options?: IReadOptions,
  ): FabricValue;

  /**
   * Writes a value into a storage at a given address, including creating parent
   * entries in the document if a path is provided or throws an error.
   *
   * Internal runner API. Phase-1 CFC no-op attempted-target coverage is not
   * derived from blind direct `write*()` calls. Callers that need attempted
   * target coverage before same-value short-circuiting must first establish it
   * through a higher-level diff path such as `markReadAsAttemptedWrite`.
   * Runner-owned system metadata writes may also use this directly when they
   * are intentionally out of phase-1 value-surface CFC scope.
   * Outside UI blind-write mode, elision over pending state retains an internal
   * commit dependency; this does not add attempted-target coverage.
   *
   * @param address - Memory address to write to.
   * @param value - Value to write.
   * @param options - Optional write options (e.g. explicit delete intent).
   */
  writeOrThrow(
    address: IMemorySpaceAddress,
    value: FabricValue,
    options?: IWriteOptions,
  ): void;

  /**
   * Writes a value into a storage at a given address, including creating parent
   * entries in the document if a path is provided or throws an error.
   *
   * Thin convenience wrapper over `writeOrThrow()` that prepends `"value"` to
   * the supplied path.
   *
   * Internal runner API with the same phase-1 CFC caveat as `writeOrThrow()`:
   * blind same-value direct writes do not by themselves establish attempted
   * target coverage. Use higher-level diff paths when no-op attempted writes
   * need to appear in `attemptedWrites`.
   *
   * @param address - Memory address to write to.
   * @param value - Value to write.
   * @param options - Optional write options (e.g. explicit delete intent).
   */
  writeValueOrThrow(
    address: NormalizedFullLink,
    value: FabricValue,
    options?: IWriteOptions,
  ): void;

  /**
   * Optional batched write helper that preserves the extended transaction's
   * `["value", ...path]` helper semantics on top of `writeBatch`.
   */
  writeValuesOrThrow?(
    writes: Iterable<
      { address: NormalizedFullLink; value: FabricValue; delete?: boolean }
    >,
  ): void;

  /**
   * Per-transaction memoization for `Cell.get()` results.
   *
   * Within a single transaction, repeatedly reading the same cell recomputes the
   * full read pipeline (link resolution, schema merge, schema-guided traversal).
   * When no write has occurred since the last read, that work is redundant: the
   * value, the reactive reads it registers, and the CFC state it produces are all
   * identical. These two methods let `Cell.get()` cache its result keyed by the
   * stable value of the cell view; the implementation clears the entire cache
   * on any write, so a cached entry is only ever returned when no write has
   * intervened.
   *
   * Optional: transactions that must not cache (e.g. the non-reactive `sample()`
   * wrapper) leave these undefined and callers fall back to recomputing.
   * `key` must be a stable value key for the cell view (normalized link,
   * including schema, plus any CFC label view); `variant` distinguishes reads
   * that differ in options. A returned `{ value }` wrapper signals a hit, so a
   * cached `undefined` value is distinguishable from a miss.
   */
  getCachedReadResult?(
    key: string,
    variant: string,
  ): { value: unknown } | undefined;

  setCachedReadResult?(
    key: string,
    variant: string,
    value: unknown,
  ): void;

  /**
   * Drops memoized reads of the transaction's current instant. A caller uses
   * this after an asynchronous load fills a document that an earlier read
   * could not traverse; reads at an issued epoch retain their fixed snapshot.
   */
  resetCurrentReadMemoization(): void;

  /**
   * Optional diagnostics for the transaction-local `Cell.get()` cache.
   *
   * `entries` reports the currently retained cache entries, which drops to zero
   * after any write because writes replace the transaction-local cache map.
   * Hit/miss/set counts are cumulative for the transaction.
   */
  getReadResultCacheStats?(): {
    hits: number;
    misses: number;
    sets: number;
    entries: number;
  };

  /**
   * Answers this transaction's snapshot has already computed, or `undefined`
   * while it must not serve any.
   *
   * A transaction is a consistent snapshot, so a derivation that reads only
   * through it gives the same answer every time until something is written.
   * Link resolution and CFC label-view derivation both do exactly that, and
   * both are driven per element of a collection, so a scan recomputes them
   * once per element per pass. Each user owns its own key prefix and entry
   * shape; the transaction owns which map is handed out and when it is
   * dropped. The map for the current instant is replaced wholesale on any
   * write — same rule as the `Cell.get()` cache above — so an entry is only
   * ever served when nothing has been written since it was made. A read under
   * an epoch, or inside a `runWithAmbientReadMeta()` scope, is handed a map of
   * its own: an entry stands in only for reads journaled the way the caller's
   * would be, and a map for an epoch outlives writes, since the instant it
   * describes does.
   *
   * A user must be a derivation whose only observable effect is its result, or
   * must reproduce the rest itself: the reads a memoized derivation skips were
   * journaled by the one that filled the entry, so the transaction's read set
   * is unchanged, but anything consumed positionally (CFC dereference traces)
   * still has to be recorded on every call.
   *
   * `undefined` is returned where a derivation is not a pure function of the
   * snapshot: once CFC is prepared, where the read path's read-after-prepare
   * invalidation is load-bearing.
   *
   * Optional: transactions that must not memoize (the non-reactive `sample()`
   * wrapper, whose reads are excluded from scheduling) leave it undefined, and
   * their callers derive for real.
   */
  getSnapshotMemo?(): Map<string, unknown> | undefined;
}

/**
 * Error that is produced when transaction is being updated after it was already
 * aborted.
 */
export interface IStorageTransactionAborted extends IStorageError {
  readonly name: "StorageTransactionAborted";

  /** Positive evidence that `abort()` discarded the transaction before a
   * storage attempt. Commit-promise failures use the same error family but do
   * not carry this marker because their storage outcome may be ambiguous. */
  readonly abortedBeforeStorage?: true;

  /**
   * Reason provided when transaction was aborted.
   */
  readonly reason: unknown;
}

/**
 * Error indicates that transaction consistency guarantees have being
 * invalidated - some state has changed while transaction was in progress.
 */
export interface IStorageTransactionInconsistent extends IStorageError {
  readonly name: "StorageTransactionInconsistent";

  readonly address: IMemoryAddress;

  /** An empty reactive commit needs a fresh run; first results may bypass gates. */
  readonly emptyReactiveCommit?: true;

  from(space: MemorySpace): IStorageTransactionInconsistent;
}

/**
 * A commit-time precondition failed (spec scheduler-v2 §7.6). Unlike
 * optimistic conflicts, this class is PERMANENT: the client must not
 * retry. `origin-committed` — the transaction that caused this work
 * never committed. `receipt-exists` — another handling of the same
 * event already committed (lost race).
 */
export interface IPreconditionFailedError extends Error {
  name: "PreconditionFailedError";
  precondition: "origin-committed" | "receipt-exists";
}

/**
 * The CFC boundary refused to hand the transaction to storage: policy
 * evaluated the transaction's own reads and writes and rejected them
 * (`rejectCommitBeforeStorage` in extended-storage-transaction.ts). A
 * terminal rejection in the spec scheduler-v2 §7.6 taxonomy: the refusal is
 * deterministic — re-running the identical computation recomputes the
 * identical refused write — so the client must not retry. `reasons` carries
 * the prepare refusal reasons verbatim (writer-fit misfits and the rest of
 * what `prepareBoundaryCommit` collects); empty when the transaction reached
 * commit relevant but never prepared, which is a caller bug with the same
 * deterministic character.
 */
export interface ICfcCommitRefusalError extends IStorageError {
  readonly name: "CfcCommitRefusalError";
  readonly reasons: readonly string[];

  /**
   * Structured descriptions of the reasons whose producers could describe
   * themselves (`cfc/refusal-detail.ts`), paired to `reasons` by their
   * `reason` text. A refusal every producer left undescribed carries an
   * empty list — the reasons still stand on their own.
   */
  readonly refusals: readonly CfcRefusalDetail[];
}

/** Commit preparation crashed before any storage attempt. This is typed apart
 * from a deterministic CFC policy verdict so served delivery can apply OW54's
 * bounded recovery policy without misreporting a handler error. */
export interface ICommitPreparationError extends IStorageError {
  readonly name: "CommitPreparationError";
  readonly failureClass: "unknown";
  readonly permanentEvidence: false;
}

/**
 * Error that indicating that no change could be made to a transaction is it is
 * no longer active.
 */
export type InactiveTransactionError =
  | StorageTransactionFailed
  | IStorageTransactionComplete;

export type StorageTransactionFailed =
  | IStorageTransactionInconsistent
  | IStorageTransactionAborted
  | StorageTransactionRejected;

export type StorageTransactionRejected =
  | IStorageTransactionInconsistent
  | IConflictError
  | IPreconditionFailedError
  | ICfcCommitRefusalError
  | ICommitPreparationError
  | IStoreError
  | TransactionError
  | IConnectionError
  | IAuthorizationError;

export type CommitError =
  | InactiveTransactionError
  | StorageTransactionRejected;

/**
 * Error returned when a read or write operation fails because the intra-value
 * path does not exist.
 *
 * The `path` property behavior is consistent for both reads and writes:
 *
 * **Nested path not found** (document exists but path doesn't):
 * - `path` includes the missing key
 * - Example: Document `{ user: { name: "Alice" } }`, access `["user", "settings", "theme"]`
 * - → `path` is `["user", "settings"]` (path to the non-existent key)
 * - To get last existing parent: `path.slice(0, -1)` → `["user"]`
 *
 * **Document not found** (document itself doesn't exist):
 * - `path` is `[]` (empty array)
 * - Example: Document doesn't exist, access `["foo", "bar"]`
 * - → `path` is `[]`
 */
export interface INotFoundError extends IStorageError {
  readonly name: "NotFoundError";
  readonly source: IAttestation;
  readonly address: IMemoryAddress;

  /** Path to the non-existent key, or `[]` if the document doesn't exist. */
  readonly path: readonly MemoryAddressPathComponent[];

  from(space: MemorySpace): INotFoundError;
}

/**
 * Error returned when the media type is not supported by the storage transaction.
 */
export interface IUnsupportedMediaTypeError extends IStorageError {
  readonly name: "UnsupportedMediaTypeError";

  from(space: MemorySpace): IUnsupportedMediaTypeError;
}

/**
 * Error returned when a data URI is invalid or cannot be parsed.
 */
export interface IInvalidDataURIError extends IStorageError {
  readonly name: "InvalidDataURIError";
  readonly cause?: IStorageError;

  from(space: MemorySpace): IInvalidDataURIError;
}

export type ReadError =
  | INotFoundError
  | InactiveTransactionError
  | IInvalidDataURIError
  | IUnsupportedMediaTypeError
  | ITypeMismatchError;

export type WriteError =
  | INotFoundError
  | IUnsupportedMediaTypeError
  | InactiveTransactionError
  | IReadOnlyAddressError
  | ITypeMismatchError;

export type WriterError =
  | InactiveTransactionError
  | IStorageTransactionWriteIsolationError
  | IReadOnlyAddressError;

export interface IStorageTransactionComplete extends IStorageError {
  readonly name: "StorageTransactionCompleteError";
}

/**
 * Represents adddress within the memory space which is like pointer inside the
 * value held in the memory.
 */
export type IMemoryAddress = {
  /**
   * URI to an entity. It corresponds to `of` field in the memory protocol.
   */
  id: URI;

  /**
   * Media type of the addressed value. Document addresses omit this; storage
   * boundaries use application/json.
   */
  type?: MediaType;

  /**
   * Declared scoped cell instance. Storage defaults omitted scope to `space`.
   */
  scope?: CellScope;

  /**
   * The explicit scope INSTANCE this address names (server-execution v2
   * stage A — OW17's instance-keyed replica and wire; key-vocabulary.md
   * §5). ABSENT everywhere off the serving path: an address without one
   * resolves its instance from the ambient identity (the runtime's own
   * authenticated session in the OFF arm — key-vocabulary.md §2), exactly
   * as before the field existed, so no key, frame, or serialized
   * notification moves by a byte when it is absent. SET only where a
   * serving runtime knows the instance is not the ambient one: a
   * per-instance run's logged reads/writes (its transaction carries the
   * demand-supplied identity), the replica's notification differentials
   * for a keyed instance, and instance-named loads. Every consumer that
   * builds a key from an address PREFERS this over resolving `scope`
   * against its identity (`entityKey`, the replica's doc keys, the
   * selector tracker, the differential's address identity). It is a
   * resolved key — never a positional index or a "current user" (the §4
   * tripwires) — and it must never enter a persisted value (links carry
   * scope NAMES; instances resolve at the reader).
   */
  scopeKey?: ScopeKey;

  /**
   * Intra-value path to the {@link FabricValue} being referenced by this
   * address. It is a path within the `is` field of the state in the memory
   * protocol.
   */
  path: readonly MemoryAddressPathComponent[];
};

export type IMemorySpaceAddress = IMemoryAddress & {
  space: MemorySpace;
};

export type MemoryAddressPathComponent = string;

export interface Assert {
  the: MediaType;
  of: URI;
  is: FabricValue;

  claim?: void;
}

export interface Retract {
  the: MediaType;
  of: URI;
  is?: void;

  claim?: void;
}

export interface Claim {
  the: MediaType;
  of: URI;
  is?: void;
  claim: true;
}

export interface ISpace {
  did(): MemorySpace;
}

/** One event append handed to {@link ISpaceReplica.enqueueEventAppend}
 * (structural twin of the queue module's QueuedEventAppend — stated here
 * so the interface stays free of storage-internal imports). */
export type EventAppendRequest = {
  /** The stream's sidecar doc id (`streamEntriesDocId`). */
  sidecarId: string;

  /** The stream link the entry self-describes (events.md §1). */
  stream: { id: string; path: readonly string[]; scope?: CellScope };

  /** The durable client-minted event id (event-identity). */
  eventId: string;

  /** The event payload — a FabricValue (round-2 thread T23): the type
   * is the admission boundary's own domain, so a payload the memory
   * protocol cannot represent is refused at the CALL SITE'S type check
   * instead of failing (or endlessly retrying) at delivery. */
  payload?: FabricValue;

  /** Client-minted append order within this session; allocated by the
   * queue when absent. */
  clientSeq?: number;

  runtimeInjectedEventKeys?: string[];

  /** The runtime's attestation that the sent event was renderer-trusted
   * (server-execution v2 fan-out stage B; the sister of
   * `runtimeInjectedEventKeys` — see `StreamEventEntry.rendererTrusted`).
   * Set by `Cell.send` from the process-local mark, never by callers. */
  rendererTrusted?: true;
};

export type EventAppendDeliveryOutcome =
  | { delivered: true; deduped?: boolean }
  | { delivered: false; refused: string };

/** Exclusive renderer ownership across runtimes sharing one replica. */
export interface ViewInterestLease {
  /** Whether this lease still owns the replica's renderer interests. */
  isCurrent(): boolean;

  /** Allocates a revision that outlives an individual runtime. */
  nextRevision(): number;

  /** Replaces only this owner's interests; retired leases are inert. */
  set(views: ViewInterest[]): Promise<boolean>;

  /** Releases this ownership without clearing a replacement owner's views. */
  release(): void;
}

export interface ISpaceReplica extends ISpace {
  /**
   * Return a state for the requested entry or returns `undefined` if replica
   * does not have it. The state carries `since`, the commit sequence the
   * entry's document last stood at in this space, so two entries read from
   * one replica can be ordered against each other.
   */
  get(entry: BaseMemoryAddress): Revision<State> | undefined;

  /**
   * The doc's visible document (confirmed + this replica's pending
   * overlay). `identity` (server-execution v2 stage A — OW17's instance-
   * keyed replica): the reading run's identity when it is not the
   * replica's own; the replica holds one local doc PER INSTANCE, so a run
   * stamped as one principal reads that principal's instance and never
   * the service's or a sibling's. Absent = the replica's own identity,
   * exactly the pre-stage-A read.
   */
  getDocument(
    id: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
  ): EntityDocument | undefined;

  /** Whether this exact document instance has an unpromoted local write. */
  hasPendingWrite(
    id: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
  ): boolean;

  /** Claims renderer ownership and retires the previous owner's local graphs. */
  acquireViewInterests?(onReplaced: Cancel): ViewInterestLease;

  /** Replaces renderer interests while the optional ownership fence holds. */
  setViewInterests?(
    views: ViewInterest[],
    isCurrent?: () => boolean,
  ): Promise<boolean>;

  /** Negotiates view delivery on this replica's authenticated session. */
  supportsViewReplication?(): Promise<boolean>;

  /** Whether the current connection retains the negotiated view protocol. */
  viewReplicationSupported?(): boolean;

  /** Waits for session restoration before issuing fallback subscriptions. */
  whenSessionRestored?(): Promise<void>;

  /** Observes plan snapshots after their input documents arrive. */
  subscribeViewPlans?(
    observer: (plans: readonly ViewPlan[]) => void,
  ): () => void;

  /** Whether a complete local basis exists, including confirmed absence. */
  hasLocalDocumentCoverage?(
    id: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
  ): boolean;

  /**
   * The seq this replica's CONFIRMED view stands at for the document
   * instance — the last accepted write to it this replica has taken, and 0
   * for one it has taken none of. Says nothing about the replica's own
   * pending writes over that base, which carry no accepted seq.
   *
   * A caller comparing this against the store's head learns whether the
   * replica is behind the store on the document, and so whether a run that
   * read it here read what the store now holds.
   */
  confirmedDocumentSeq(
    id: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
  ): number;

  /** Observes changes in residency, including delivery of a known absence. */
  subscribeLocalCoverage?(
    observer: (
      addresses: readonly Pick<IMemorySpaceAddress, "id" | "scope">[],
    ) => void,
  ): () => void;

  /**
   * The doc's NON-speculative document: confirmed state plus only the
   * durable pending layers (own commits awaiting their verdict),
   * skipping client speculation overlay layers (entries sealed
   * `speculative: true` — speculation.md §1). This is the state a CFC
   * internal-verifier read of a blind UI-input write transaction bases
   * on (RULED 2026-08-21; verification-coverage.md OW47, second
   * producer): the verifier verifies the durable policy state the
   * server will enforce against — a speculation layer never reaches
   * the wire — and the value read here matches the basis
   * `SpaceReplica.#buildReads` names for such reads (speculative layers
   * excluded). Optional:
   * implementations without a speculation overlay may omit it, and
   * readers fall back to {@link getDocument}, whose view is then
   * identical.
   */
  getNonSpeculativeDocument?(
    id: URI,
    scope?: CellScope,
    identity?: ScopeKeyIdentity,
  ): EntityDocument | undefined;

  commitNative?(
    transaction: NativeStorageCommit,
    source?: IStorageTransaction,
    options?: TransactionCommitOptions,
  ): Promise<Result<Unit, StorageTransactionRejected>>;

  /**
   * Seal a native commit into this replica's optimistic overlay WITHOUT
   * pushing it to the store (server-execution v2, serving-loop.md §3d). The
   * local half of commitNative runs unchanged — the writes apply as pending
   * state, so later action runs read them through the ordinary read path
   * (the wave accumulator's layered view IS this overlay) — and the store
   * half is deferred to `verdict`, which the wave commit step resolves:
   * confirmed writes promote at the wave commit's seq, withdrawn writes
   * (superseded, requeued, wave aborted) roll back through the same
   * rejection path a refused push takes.
   */
  sealNative?(
    transaction: NativeStorageCommit,
    source: IStorageTransaction | undefined,
    verdict: Promise<SealedCommitVerdict>,
    options?: {
      /** Server-execution v2 Phase 2 (speculation.md §1, §6): the sealed
       * commit is a CLIENT SPECULATION overlay entry — process-memory
       * only, never durable, retired by the overlay destination when the
       * authoritative derivation covers it. It stays OUT of the
       * `synced()` durability barrier (`#commitPromises`) and the
       * ordered-push outcome map: a client settle must never wait on a
       * speculation's retirement, and nothing ever pushes it. Everything
       * else — optimistic apply, notifications, in-flight registration
       * (reset sweeps and origin-drop cascades reach it) — is the
       * ordinary sealed-commit machinery. */
      readonly speculative?: boolean;

      /** Server-execution v2 stage A (OW17's tx→replica identity seam):
       * the sealing run's identity when it is not the replica's own. Its
       * operations apply to — and its verdict promotes or rolls back —
       * THAT identity's local instances of every scoped doc, and its
       * read set is built against those instances' pending stacks.
       * Absent = the replica's own identity, exactly as before. */
      readonly identity?: ScopeKeyIdentity;

      /** The read set to seal under instead of building one here: the set
       * {@link storeCommitOf} took for the same transaction and identity,
       * which the store has validated, so the store's verdict and the local
       * seal rest on one snapshot. Absent, the seal builds its own. */
      readonly reads?: ClientCommit["reads"];
    },
  ): SealedNativeCommit;

  /**
   * The operations, preconditions, and read set `transaction` would hand
   * the store, as {@link sealNative} builds them into a sealed commit,
   * without applying anything to this replica. A committer that commits to
   * the store ahead of sealing the transaction here (the serving loop's
   * direct commit) reads the store's shape from this; the reads are
   * `source`'s against this replica's records for `identity`'s instances
   * (the replica's own when absent, as {@link sealNative}'s), a pending
   * read naming the durable basis beneath its layers. Optional, as
   * {@link sealNative} is.
   */
  storeCommitOf?(
    transaction: NativeStorageCommit,
    source: IStorageTransaction | undefined,
    identity?: ScopeKeyIdentity,
  ): {
    operations: ClientCommit["operations"];
    preconditions: readonly CommitPrecondition[];
    reads: ClientCommit["reads"];
  };

  /**
   * Resolves when the accepted commit at `localSeq` has been APPLIED to
   * this replica's settled view — immediately when the accept confirmed
   * at verdict time, else when its parked accept promotes (catch-up
   * marker coverage) or dies with the parked set (reset/close).
   *
   * Server-execution v2 stage G's effect-retirement read barrier
   * (serving-loop.md §4): the outbox holds an effect's in-flight entry
   * until every completion commit's writes are readable by the serving
   * runtime, so a stale re-admit of the same key dedupes instead of
   * re-claiming against unabsorbed state. Sequence after the sealed
   * commit's `settled` promise — the park-or-confirm decision runs
   * inside settlement.
   */
  whenApplied?(localSeq: number): Promise<void>;

  /**
   * Queue one EVENT APPEND for this space — the client's only
   * computational commit under EXPERIMENTAL_SERVER_EXECUTION
   * (server-execution v2 Phase 3; events.md §1, §5, §7): fired-order
   * discharge with retry across transport loss and session replacement,
   * a duplicate above the stream's dedupe horizon resolved as delivered,
   * and LT9's durable-queue seam behind it. Resolves with the delivery
   * outcome; the local echo never waits on it.
   */
  enqueueEventAppend?(
    append: EventAppendRequest,
  ): Promise<EventAppendDeliveryOutcome>;

  resolveEventAttention?(
    eventId: string,
    seq: number,
    sidecarId: string,
    action: "retry" | "dismiss",
  ): Promise<EventAttentionResolveResult>;

  /** Pending (undischarged) event intents — the offline event queue's
   * live content (speculation.md §5), bounded by pending-intent count. */
  pendingEventAppends?(): readonly EventAppendRequest[];

  /**
   * The lowest server seq among inbound FOREIGN novelty whose visibility
   * is still shadowed by this replica's own pending (unpromoted) writes —
   * or `undefined` when nothing is shadowed (server-execution v2
   * Phase 2's settle input barrier; the plan's Phase 2 revisit (a)).
   *
   * The shadow case: an upsert/remove integrates into `confirmed` while
   * an own sealed commit's pending entry still overlays the same doc
   * (CT-1927 parks the promotion until a catch-up marker covers it). The
   * materialized view — and therefore the change notification that
   * registers scheduler dirtiness — does not (fully) reflect the foreign
   * value until the pending entry leaves. The serving loop MUST NOT
   * advance W past a seq this method still reports: `inputSynced` cannot
   * await the application (it settles only after the wave commit the
   * loop performs AFTER settling — a deadlock by construction), so the
   * wave EXCLUDES unapplied frames' seqs from its advance instead, per
   * the plan's sanctioned alternative. A shadowed REMOVE carries no seq
   * on the wire and reports the sentinel floor 1 — W holds entirely
   * until it clears (rare, self-clearing at promotion).
   */
  unappliedForeignSeqFloor?(): number | undefined;

  /**
   * The retirement inputs for one doc of a speculation overlay entry
   * (server-execution v2 Phase 2, speculation.md §4): the doc's current
   * CONFIRMED seq (the authoritative basis a covering watermark is
   * compared against) and the localSeqs of every pending (unpromoted)
   * write layered on it. The overlay destination retires an entry only
   * when no pending layer BELOW it remains on any doc it read through —
   * an unacked authored origin (the user mid-typing) or a parked
   * promotion keeps the echo alive, exactly speculation.md §4 step 3's
   * "acked AND W ≥ that commit's seq" condition, evaluated on replica
   * state instead of tracked acks.
   *
   * `coverClass` is the covering commit's class where the replica knows
   * it (the arrival-witness predicate, RULED 2026-08-22: a cover AT an
   * entry's floor witnesses arrival only when derived-class). Undefined
   * — an OFF-arm or pre-predicate frame, or a fake in tests — reads as
   * "class unknown", which never witnesses arrival at the floor.
   */
  speculationRetirementView?(
    id: URI,
    scope?: CellScope,
  ): {
    confirmedSeq: number;
    coverClass?: CommitClass;
    pendingLocalSeqs: number[];
  };

  /**
   * The store seq a local commit's accept committed at (speculation.md
   * §4's "acked AND W ≥ that commit's seq" retirement floor), or
   * undefined while unsettled / rejected / pruned from the bounded
   * record. Undefined reads as "no ack floor" — a rejected or retired
   * origin's echo falls back to its confirmed read basis.
   */
  ackedSeqOf?(localSeq: number): number | undefined;

  /**
   * The settle input barrier's WAKE (server-execution v2 Phase 2): when
   * set, invoked synchronously whenever a promotion flips shadowed
   * foreign novelty visible — the flag-ON condition of the shadow-flip
   * notification, fired whether or not the flip produced a value diff
   * (an echo-equal flip still lifts `unappliedForeignSeqFloor`). The
   * SpaceServer installs it on its serving replica at activation so a
   * clamped wave's floor lifting wakes the loop directly: the flip is
   * the one input whose dirtiness arrives WITHOUT a new admitted commit
   * on the host feed, so nothing else ends the loop's input wait before
   * the idle timeout.
   */
  shadowFlipObserver?: (() => void) | undefined;

  /**
   * The overlay's retirement WAKE for origin accepts (server-execution
   * v2 Phase 2, speculation.md §4; leg-C 2026-08-13): when set, invoked
   * whenever a pushed commit's accept records its ack seq. The
   * speculation overlay destination installs it beside its watermark
   * sink: a sweep evaluated while an origin's verdict was still in
   * flight skips its entries as blocked (unacked pending layer below),
   * and if the covering watermark event has already passed, nothing
   * else re-sweeps on a then-quiet space — a REJECTED origin cascades
   * into the entry through the dependency machinery, but an ACCEPTED
   * one had no client-side wake, so the entry stayed pending forever.
   */
  speculationAckObserver?: (() => void) | undefined;

  /**
   * The overlay's retirement WAKE for AUTHORITATIVE ARRIVALS
   * (server-execution v2 stage C tuning T2 — speculation.md §4's owed
   * "arrival re-sweep"): when set, invoked at the end of integrating a
   * session sync frame whose upserts moved at least one doc's CONFIRMED
   * seq forward, with exactly those docs. The speculation overlay
   * destination installs it beside its watermark sink: the arrival gate
   * retires an entry only once every doc it wrote holds a confirmed value
   * at seq ≥ its floor, and until this wake existed the sweep ran only
   * from the watermark sink, the origin-ack observer and chained
   * settlements — so a derived value that arrived DECOUPLED from a
   * watermark advance (an exhausted wave carries no watermark movement;
   * a doc arriving in a later frame than the covering W) kept its echo
   * standing until the next unrelated commit lifted W. Fired regardless of
   * whether the value is VISIBLE through materialization (an arrival under
   * the entry's own pending layer is invisible to the change
   * notification, which is why the notification cannot carry this).
   */
  speculationArrivalObserver?:
    | ((arrived: readonly { id: URI; scope?: CellScope }[]) => void)
    | undefined;
}

/**
 * The wave commit step's per-sealed-commit disposition (serving-loop.md
 * §3d). `committed` carries the wave commit's accepted store seq — the
 * sealed commit's pending writes promote to confirmed at that seq.
 * `withdrawn` rolls the sealed commit's pending writes back: its ops were
 * dropped (superseded pure derivation), requeued (raced non-re-derivable
 * consequence), or the wave never committed (lease lost, abandon). The
 * replica shapes the withdrawal into its own rejection type; the wave
 * supplies only the reason.
 *
 * `superseded: true` (server-execution v2 Phase 2, speculation.md §4)
 * marks a SUCCESS-shaped withdrawal: a client speculation overlay entry
 * retiring because the authoritative derivation now covers it. The
 * replica drops the pending writes and notifies the visible flip like
 * any withdrawal, but it does NOT cascade-reject dependants (an
 * authored commit that read the echo is fine — the store's CAS decides
 * it) and the sealed commit settles `ok`, not error.
 */
export type SealedCommitVerdict =
  | { committed: { seq: number } }
  | {
    withdrawn: {
      message: string;
      superseded?: true;
      /** Structured withdrawal classification for consumers that must not
       * parse diagnostic prose. A contribution drop is retryable in place;
       * an explicit wave abandon is expected enclosing-lifecycle teardown. */
      cause?: "contribution-dropped" | "wave-abandoned";
    };
  };

/** A replica's handle for one sealed native commit. */
export interface SealedNativeCommit {
  /** The replica-local seq the sealed pending writes are keyed by. */
  localSeq: number;

  /** The built commit — operations plus the read set (confirmed reads carry
   * the store versions the wave's per-doc CAS and basis rows are computed
   * from; pending reads name earlier sealed commits by localSeq, the
   * in-wave read edges). */
  commit: ClientCommit;

  /** Resolves when the verdict has been applied locally (promotion or
   * rollback complete). */
  settled: Promise<Result<Unit, StorageTransactionRejected>>;
}

export type PushError =
  | IQueryError
  | IStoreError
  | IConnectionError
  | IStorageTransactionInconsistent
  | IConflictError
  | IPreconditionFailedError
  | ICfcCommitRefusalError
  | ICommitPreparationError
  | TransactionError
  | IAuthorizationError;

export type PullError =
  | IQueryError
  | IStoreError
  | IConnectionError
  | IAuthorizationError;

export interface IStoreError extends IStorageError {
  readonly name: "StoreError";
  readonly cause: IStorageError;
}

export interface ITransactionJournal {
  activity(): Iterable<Activity>;

  novelty(space: MemorySpace): Iterable<IAttestation>;
  history(space: MemorySpace): Iterable<IAttestation>;
}

export interface TransactionReactivityLog {
  reads: IMemorySpaceAddress[];
  shallowReads: IMemorySpaceAddress[];
  writes: IMemorySpaceAddress[];
  attemptedWrites?: IMemorySpaceAddress[];
}

export interface TransactionWriteDetail {
  address: IMemorySpaceAddress;
  value?: FabricValue;
  previousValue?: FabricValue;

  /**
   * Pre-transaction slot presence at `address.path` — distinguishes an
   * absent slot from a present slot holding `undefined`, which
   * `previousValue` alone cannot (the storage write path keeps presence
   * distinct from value). Optional: transactions that cannot compute it
   * omit it, and consumers fall back to `previousValue` definedness.
   */
  previousPresent?: boolean;
}

export interface TransactionReadDetail {
  address: IMemorySpaceAddress;
  value?: FabricValue;
}

export type NativeStorageCommitOperation =
  | {
    op: "set";
    id: URI;
    type: MediaType;
    scope?: CellScope;
    value: FabricValue;
  }
  | {
    op: "delete";
    id: URI;
    type: MediaType;
    scope?: CellScope;
  }
  | {
    op: "patch";
    id: URI;
    type: MediaType;
    scope?: CellScope;
    patches: PatchOp[];
    value: FabricValue;
  };

export interface NativeStorageCommit {
  operations: readonly NativeStorageCommitOperation[];
  preconditions?: readonly CommitPrecondition[];

  /**
   * Folded SQLite write ops, applied in the same wire commit as `operations`
   * (appended last). They are NOT entity revisions and stay out of the
   * doc-pending / touched / notify machinery.
   */
  sqliteOps?: readonly SqliteOperation[];
}

export type Activity = Variant<{
  read: IReadActivity;
  write: IMemorySpaceAddress;
}>;

export interface IReadActivity extends IMemorySpaceAddress {
  meta: Metadata;
  nonRecursive?: boolean;

  /**
   * Position of this read on the transaction's activity clock — a single
   * per-transaction monotonic counter shared with write attempts
   * ({@link IWriteAttempt}), stamped at record time by the storage
   * transaction. Gives the read|write interleaving order without a journal
   * scan (V2 journals do not support `activity()`). Consumed by the CFC
   * write-prefix provenance gate and bound into the prepared digest
   * (docs/specs/cfc-write-prefix-provenance.md §6). Optional only for
   * backends that predate the clock; absent means "order unknown" and CFC
   * treats the read as preceding every write (conservative).
   */
  journalIndex?: number;
}

/**
 * One applied write attempt, in transaction order. `path` is the RAW storage
 * path as written (`["value", ...]` for user data, `["cfc"]`/`["source"]`
 * for runtime surfaces, `[]` for whole-envelope writes) — deliberately not
 * canonicalized, so surface distinctions survive. Value-equal writes that
 * the storage layer elides entirely (no write details, no reactivity) do
 * not appear here either: the log records exactly the write set the rest of
 * the transaction inspection surface sees. `journalIndex` is the shared
 * activity clock (see {@link IReadActivity.journalIndex}).
 */
export interface IWriteAttempt extends IMemorySpaceAddress {
  journalIndex: number;
}

/**
 * Error is returned on an attempt to open writer in a transaction that already
 * has a writer for a different space.
 */
export interface IStorageTransactionWriteIsolationError extends IStorageError {
  readonly name: "StorageTransactionWriteIsolationError";

  /**
   * Memory space writer that is already open.
   */
  readonly open: MemorySpace;

  /**
   * Memory space writer could not be opened for.
   */
  readonly requested: MemorySpace;
}

/**
 * Error returned when attempting to write to a read-only address (data: URI).
 */
export interface IReadOnlyAddressError extends IStorageError {
  readonly name: "ReadOnlyAddressError";

  /**
   * The read-only address that was attempted to be written to.
   */
  readonly address: IMemoryAddress;

  from(space: MemorySpace): IReadOnlyAddressError;
}

/**
 * Error returned when attempting to access a property on a non-object value.
 * This is different from NotFound (document doesn't exist) and Inconsistency
 * (state changed). This error indicates a type mismatch that would persist
 * even if the transaction were retried.
 */
export interface ITypeMismatchError extends IStorageError {
  readonly name: "TypeMismatchError";

  /**
   * The address being accessed.
   */
  readonly address: IMemoryAddress;

  /**
   * The actual type encountered.
   */
  readonly actualType: string;

  from(space: MemorySpace): ITypeMismatchError;
}

/**
 * Describes either observed or desired state of the memory at a specific
 * address.
 */
export interface IAttestation {
  readonly address: IMemoryAddress;
  readonly value?: FabricValue;
}

// An IAttestation where the address is an IMemorySpaceAddress
export interface IMemorySpaceAttestation {
  readonly address: IMemorySpaceAddress;
  readonly value?: FabricValue;
}

// Re-export transaction wrapper utilities from implementation
export {
  createChildCellTransaction,
  createNonReactiveTransaction,
  TransactionWrapper,
} from "./extended-storage-transaction.ts";

export const createReadOnlyTransactionError = (
  method: string,
  source = "runtime.readTx()",
): Error => {
  const error = new Error(
    `Cannot call ${method} on a read-only transaction returned by ${source}; ` +
      "use runtime.edit() to create an owned writable transaction.",
  );
  error.name = "ReadOnlyTransactionError";
  return error;
};

/**
 * Converts an IStorageError to a throwable Error instance.
 * Use this when you need to actually throw a storage error.
 */
export const toThrowable = (error: IStorageError): Error => {
  const throwable = new Error(error.message);
  throwable.name = error.name;
  // Copy all enumerable properties from the storage error
  Object.assign(throwable, error);
  return throwable;
};
