import type { IMemorySpaceAddress } from "../storage/interface.ts";
import { endLocalReadValidationStretch } from "../storage/local-read-policy.ts";
import type { FanOutNodeState } from "./fan-out.ts";
import type { Action, ReactivityLog, TelemetryAnnotations } from "./types.ts";

export type NodeKind = "computation" | "effect";
export type NodeStatus = "never-ran" | "clean" | "invalid" | "unavailable";

export interface SchedulerGateState {
  debounceMs?: number;
  noAutoDebounce?: boolean;
  throttleMs?: number;
  debounceReadyAt?: number;
  throttleReadyAt?: number;

  /** Keeps freshness gates released until the owed run starts. */
  retryOwed?: true;

  backoffUntil?: number;
  backoffStreak: number;

  /** Backoff passes charged to the current idle-wait episode. */
  convergenceHoldPasses: number;

  /**
   * Remote-echo breaker backoff
   * (docs/plans/scheduler-remote-echo-breaker.md): the instant a re-run
   * deferred by a tripped echo loop becomes eligible. Separate from
   * `backoffUntil` so clearing the convergence backoff never lifts it and so
   * the idle probe (`isConvergenceBackoffDeferred` reads `backoffUntil`
   * alone) treats a deferred echo re-run like a throttle window — a freshness
   * bound that does not hold `idle()` open.
   */
  echoBackoffUntil?: number;
}

/**
 * Whether `gate` holds convergence-backoff state: a deadline, a streak or
 * hold passes charged. The remote-echo backoff is a separate gate and is not
 * part of it.
 */
export function holdsBackoffState(gate: SchedulerGateState): boolean {
  return gate.backoffUntil !== undefined || gate.backoffStreak > 0 ||
    gate.convergenceHoldPasses > 0;
}

export interface SchedulerNode {
  readonly action: Action;
  /** Whether this registration has an accepted result to retain while gated. */
  hasCommittedResult?: boolean;
  /** Whether a run of this registration has finished without being withdrawn
   * for a read it could not take as state: its output, absent or not, is what
   * it produced. */
  produced?: boolean;
  /** The latest sealed run that can still owe dependency-withdrawal recovery. */
  pendingWaveRun?: object;

  // Monotonic registration ordinal, assigned once when the record is first
  // created and preserved across re-subscribe and re-registration (first
  // registration wins). The deterministic tie-break in `topologicalSort`
  // (spec §7.4 rule 3) falls back to this so run order does not depend on the
  // order actions were invalidated / arrived over the network.
  readonly ordinal: number;
  // Mutable for the one sanctioned transition: computation → effect
  // promotion on re-registration ("once an effect, stays an effect").
  kind: NodeKind;
  parentAction?: Action;
  children?: Set<Action>;
  status: NodeStatus;

  /** Identity of the current registration lifetime, including reactivation. */
  registrationToken: object;

  /** Bound source whose server proof justifies this initial clean state. */
  adoptedViewIdentity?: string;

  /**
   * The wake dependencies that proof installed, which a later proof of the
   * same adoption is compared against.
   */
  adoptedViewDependencies?: ReactivityLog;

  /** Releases the residency wake of a parked local computation. */
  cancelLocalReadWake?: () => void;
  declaredReads: IMemorySpaceAddress[];

  /**
   * The addresses whose changes invalidated this node since it last ran, in
   * arrival order, keyed by `invalidCauseKey` (scheduler/invalidation.ts) so
   * that a cause arriving again — from a later notification, or restored by
   * a retry — is recorded once. Taken by the run that consumes them.
   */
  invalidCauses: Map<string, IMemorySpaceAddress>;

  /**
   * Where the node stands among the invalid nodes: taken from a counter each
   * time it joins them, so ascending ordinals are the order
   * `NodeRegistry.getInvalidNodes()` iterates in. Meaningless while the node
   * is not one of them.
   */
  invalidOrdinal: number;
  liveRefs: number;
  provisionalDemand: boolean;
  provisionalDemandPass?: number;
  gate: SchedulerGateState;
  passRuns: number;

  /** Server-execution v2 fan-out stage B: the node's known-scope
   * ratchet and per-instance record (scheduler/fan-out.ts). Present ONLY
   * once the serving loop's demand registry supplied demanders for this
   * node — never on a client, never in the OFF arm — and dropped when
   * the node runs as the wave-level fallback again or unsubscribes. The
   * node itself stays singular (C11b): this is a record ON the node, not
   * a node per instance. */
  fanOut?: FanOutNodeState;
}

export class NodeRegistry {
  #records = new WeakMap<Action, SchedulerNode>();
  #childActionsByParent = new WeakMap<Action, Set<Action>>();
  #all = new Set<SchedulerNode>();
  #activeEffects = new Set<Action>();
  #activeComputations = new Set<Action>();

  /**
   * Active nodes whose status is `invalid` or `never-ran` — i.e. the nodes
   * `isInvalidOrNeverRan()` would match. Maintained incrementally through
   * `setStatus()`/`activate()`/`remove()` so the event-preflight gate and the
   * pull seed scans can iterate the (small) invalid set instead of every
   * registered node. Membership tracks both status _and_ active membership: a
   * removed node drops out even though its record persists in `#records`.
   */
  #invalidNodes = new Set<Action>();

  /** Source of `SchedulerNode.invalidOrdinal`. */
  #nextInvalidOrdinal = 0;

  /**
   * The invalid nodes a pull seed scan still has to look at: every invalid
   * node except those a scan found dormant (neither live nor pending) and
   * parked with `parkSeedCandidate()`. A dormant node contributes nothing to
   * a seed scan, and under lazy materialization nearly every invalid node of
   * a large graph is dormant, so the scans walk this set and not
   * `#invalidNodes`.
   *
   * A parked node returns when it joins the invalid nodes again, when its
   * status is written, and when whoever maintains liveness reports that it
   * may have become live (`noteMayBeLive()`). Reporting too often only costs
   * a scan one more look; a liveness change that is NOT reported leaves a
   * runnable node unseen, so every site that can make a node live reports
   * it. Pending nodes are not tracked here: the scans read the pending set
   * themselves.
   */
  #seedCandidates = new Set<Action>();

  /**
   * Active nodes whose gate holds convergence-backoff state
   * (`holdsBackoffState()`). The pass-end clearing and the idle-episode reset
   * walk this set instead of every registered node, since on a large graph a
   * handful of nodes hold backoff while thousands never do. Every writer of
   * that state calls `noteBackoff()` after writing it, and
   * `SchedulerGates.clearBackoff()` calls `forgetBackoff()` after clearing
   * it; like `#invalidNodes`, membership also tracks active membership, so a
   * removed node drops out and a reactivated one re-enters iff its preserved
   * gate still holds the state.
   */
  #backedOffNodes = new Set<SchedulerNode>();

  /**
   * Active nodes by each demand root their action's observation identity
   * names: its `demandRootIds`, or its `pieceRootId` where it names none. The
   * arrival re-arm reads the nodes beneath the roots that arrived from here
   * (`nodesUnderDemandRoots()`) instead of walking every registered node,
   * which it is asked to do once for each demand key a session brings.
   * A node is filed when it joins the active set (`activate()`) and unfiled
   * when it leaves (`remove()`), so like `#invalidNodes` membership tracks
   * active membership, and a reactivated node re-enters under the roots its
   * action names then. An identity set on a node that is already active moves
   * it only through `noteObservationIdentity()`, which the scheduler calls
   * wherever it sets one.
   */
  #nodesByDemandRoot = new Map<string, Set<SchedulerNode>>();

  /**
   * The roots whose set in `#nodesByDemandRoot` is not in joining order. A
   * node is filed as it joins, which is already that order; only a node
   * filed again while active (`noteObservationIdentity()`) lands after nodes
   * that joined later. `nodesUnderDemandRoots()` puts such a set back in
   * order the next time it reads it, so a root with thousands of nodes
   * beneath it is not sorted on every lookup.
   */
  #unorderedDemandRoots = new Set<string>();

  /**
   * The roots each node is filed under in `#nodesByDemandRoot`, as they were
   * read off its action when it was filed, each with the set it was added to.
   * Unfiling goes by these, so it does not depend on what the action names by
   * then. A set holding the node is not empty, so it is still the one
   * `#nodesByDemandRoot` maps its root to.
   */
  #filedDemandRoots = new Map<
    SchedulerNode,
    ReadonlyMap<string, Set<SchedulerNode>>
  >();

  /**
   * When each active node joined the active set, as a count. `nodes()` yields
   * active nodes in this order, and `nodesUnderDemandRoots()` returns its
   * matches in it too.
   */
  #joinedAt = new Map<SchedulerNode, number>();
  #nextJoin = 0;

  /**
   * Source of monotonic registration ordinals (see `SchedulerNode.ordinal`).
   */
  #nextOrdinal = 0;

  /** Advances each time a node joins or leaves the active set. */
  #membership = 0;

  /**
   * The pieces a node of which joined or left the active set, or had its
   * status written, since `takeChangedPieces()` last ran: each one named by
   * the `pieceRootId` of the node's action, or, for a node that names none,
   * each piece that answers for it. `undefined` until `trackChangedPieces()`
   * asks for the record, so a runtime nothing reads it from keeps none.
   */
  #changedPieces: Set<string> | undefined;

  /**
   * The pieces that answer for each computation that names no piece, as
   * `setAnsweredFor()` was last told of them.
   */
  readonly #answering = new WeakMap<Action, Set<string>>();

  /** The computations each piece answers for, which is `#answering` inverted. */
  readonly #answeredBy = new Map<string, ReadonlySet<Action>>();

  readonly effects: ReadonlySet<Action> = this.#activeEffects;
  readonly computations: ReadonlySet<Action> = this.#activeComputations;

  /** (d′) — the STANDING, refcounted `demandedWriters` root
   * kind (design §2.4; serving-loop.md §1's "a demanded instance's
   * writers hold demand … while any session tracks the instance"): the
   * writers of instances a client session TRACKS. A third `isDemandRoot`
   * disjunct beside effects and materializers — NOT `provisionalDemand`
   * (pass-scoped, one-shot). Held here so every liveness state bundle
   * (`nodes` is on all of them) sees it with no plumbing. Only the
   * serving loop's demand pass ever adds to it (through the facade's
   * enter/leave, bracketed with the liveness notifications); EMPTY off
   * the serving posture and on every client. Refcounts (per demanded
   * entity) live in the facade. */
  readonly demandedWriters = new Set<Action>();

  /** How many nodes are registered and active, of either kind. */
  get activeCount(): number {
    return this.#all.size;
  }

  /** How many active nodes are `invalid` or `never-ran`. */
  get invalidCount(): number {
    return this.#invalidNodes.size;
  }

  /**
   * A count that advances each time a node joins or leaves the active set, so
   * that an index over active nodes can tell whether it still describes them.
   */
  get membership(): number {
    return this.#membership;
  }

  isDemandedWriter(action: Action): boolean {
    return this.demandedWriters.has(action);
  }

  register(
    action: Action,
    kind: NodeKind,
    parentAction?: Action,
  ): SchedulerNode {
    const existing = this.#records.get(action);
    if (existing) {
      if (existing.kind !== kind) {
        // v1 parity: a computation re-subscribed with `isEffect: true` is
        // promoted ("once an effect, stays an effect"). Demotion has no
        // sanctioned caller and stays an error.
        if (existing.kind === "computation" && kind === "effect") {
          existing.kind = "effect";
        } else {
          throw new Error(
            `Scheduler action re-registered as ${kind}; was ${existing.kind}`,
          );
        }
      }
      this.#activate(existing);
      return existing;
    }

    const record: SchedulerNode = {
      action,
      ordinal: this.#nextOrdinal++,
      kind,
      status: "never-ran",
      registrationToken: {},
      declaredReads: [],
      invalidCauses: new Map(),
      invalidOrdinal: 0,
      liveRefs: 0,
      provisionalDemand: false,
      gate: { backoffStreak: 0, convergenceHoldPasses: 0 },
      passRuns: 0,
    };
    this.#records.set(action, record);
    const children = this.#childActionsByParent.get(action);
    if (children) {
      record.children = children;
    }
    this.#activate(record);
    if (parentAction !== undefined) {
      this.#captureParentAction(record, parentAction);
    }
    return record;
  }

  remove(action: Action): SchedulerNode | undefined {
    const record = this.#records.get(action);
    if (!record) return undefined;
    // A removed node is no current producer, which a validation made before
    // may have counted on.
    endLocalReadValidationStretch();
    record.registrationToken = {};
    delete record.hasCommittedResult;
    delete record.produced;
    delete record.gate.retryOwed;
    delete record.pendingWaveRun;
    record.adoptedViewIdentity = undefined;
    record.adoptedViewDependencies = undefined;
    record.cancelLocalReadWake?.();
    record.cancelLocalReadWake = undefined;
    if (this.#all.delete(record)) this.#membership++;
    this.#noteChangedPiece(record);
    this.#activeEffects.delete(action);
    this.#activeComputations.delete(action);
    this.#invalidNodes.delete(action);
    this.#seedCandidates.delete(action);
    this.#backedOffNodes.delete(record);
    this.#unfileFromDemandRoots(record);
    this.#joinedAt.delete(record);
    // Drop the child from its parent's index. The index holds actions
    // strongly, so a child left in it is retained by the parent — along with
    // the frame of the child's last run, that run's storage transaction, and
    // the values the transaction read — for as long as the parent lives. A
    // parent that starts and stops children repeatedly, such as a list
    // projecting a window that moves, accumulates one of those per child run.
    // The record keeps `parentAction`, so the parent stays known across a
    // re-registration window, and re-subscribing re-enters the index.
    if (record.parentAction !== undefined) {
      this.#childActionsByParent.get(record.parentAction)?.delete(action);
    }
    return record;
  }

  get(action: Action): SchedulerNode | undefined {
    return this.#records.get(action);
  }

  /**
   * The stable registration ordinal for `action`, or `undefined` if it was
   * never registered. Assigned once at first registration and preserved
   * across re-subscribe/re-registration (the record persists in `#records`
   * even after `remove`), so it is a stable, arrival-order-independent
   * tie-break key for `topologicalSort` (spec §7.4 rule 3).
   */
  getRegistrationOrdinal(action: Action): number | undefined {
    return this.#records.get(action)?.ordinal;
  }

  /**
   * The only sanctioned status mutator. Routing every status write here keeps
   * the `#invalidNodes` index in lockstep with `record.status` (the index is a
   * derived view, never authoritative). Callers keep their own transition
   * guards (e.g. clean→invalid only); this just assigns and re-indexes.
   */
  setStatus(action: Action, status: NodeStatus): void {
    const record = this.#records.get(action);
    if (!record) return;
    if (status !== "clean") {
      // A node that is not clean is no current producer, which a validation
      // made before may have counted on.
      endLocalReadValidationStretch();
      record.adoptedViewIdentity = undefined;
      record.adoptedViewDependencies = undefined;
    }
    record.status = status;
    this.#syncInvalidIndex(record);
    this.#noteChangedPiece(record);
  }

  /**
   * Starts recording the pieces whose nodes change, which
   * `takeChangedPieces()` reads.
   */
  trackChangedPieces(): void {
    this.#changedPieces ??= new Set();
  }

  /**
   * The pieces a node of which joined or left the active set, or had its
   * status written, since this was last called, each named by the
   * `pieceRootId` of the node's action. A node that names no piece counts
   * for each piece `setAnsweredFor()` said answers for it. A run writes its
   * node's status as it starts, so every piece a run touched is among them.
   * Empty unless `trackChangedPieces()` was called.
   */
  takeChangedPieces(): string[] {
    const changed = this.#changedPieces;
    if (changed === undefined || changed.size === 0) return [];
    const taken = [...changed];
    changed.clear();
    return taken;
  }

  /**
   * Records that `piece` answers for `actions`, computations that name no
   * piece, and for no other: `piece` is among the changed pieces whenever
   * one of them is the node that changed.
   */
  setAnsweredFor(piece: string, actions: ReadonlySet<Action>): void {
    for (const action of this.#answeredBy.get(piece) ?? []) {
      if (!actions.has(action)) this.#answering.get(action)?.delete(piece);
    }
    if (actions.size === 0) this.#answeredBy.delete(piece);
    else this.#answeredBy.set(piece, actions);
    for (const action of actions) {
      const pieces = this.#answering.get(action);
      if (pieces === undefined) this.#answering.set(action, new Set([piece]));
      else pieces.add(piece);
    }
  }

  /**
   * Helper for the members above, which records the piece of `record`, or
   * the pieces that answer for it where it names none.
   */
  #noteChangedPiece(record: SchedulerNode): void {
    const changed = this.#changedPieces;
    if (changed === undefined) return;
    const pieceRootId = (record.action as Partial<TelemetryAnnotations>)
      .schedulerObservationIdentity?.pieceRootId;
    if (pieceRootId !== undefined) {
      changed.add(pieceRootId);
      return;
    }
    for (const piece of this.#answering.get(record.action) ?? []) {
      changed.add(piece);
    }
  }

  /**
   * Active nodes whose status is `invalid` or `never-ran`. Seeds the inverted
   * event-preflight walk (decision 15) and the pull scheduling scans.
   */
  getInvalidNodes(): ReadonlySet<Action> {
    return this.#invalidNodes;
  }

  /** Whether `action` is an active node that is `invalid` or `never-ran`. */
  isInvalid(action: Action): boolean {
    return this.#invalidNodes.has(action);
  }

  /**
   * The invalid nodes no scan has parked: the ones a pull seed scan has to
   * look at. In no particular order; `SchedulerNode.invalidOrdinal` restores
   * the order of `getInvalidNodes()`.
   */
  getSeedCandidates(): ReadonlySet<Action> {
    return this.#seedCandidates;
  }

  /**
   * Takes `action` out of the seed candidates. For a scan that found the
   * node dormant: neither live nor pending. Safe to call while iterating
   * `getSeedCandidates()`.
   */
  parkSeedCandidate(action: Action): void {
    this.#seedCandidates.delete(action);
  }

  /**
   * Reports that `action` may have become live, so the next seed scan looks
   * at it again if it is invalid. Every site that can turn a node live calls
   * this; a call for a node that did not become live is harmless.
   */
  noteMayBeLive(action: Action): void {
    if (this.#invalidNodes.has(action)) this.#seedCandidates.add(action);
  }

  /** `noteMayBeLive()` for every node, after liveness was rebuilt wholesale. */
  noteAllMayBeLive(): void {
    for (const action of this.#invalidNodes) this.#seedCandidates.add(action);
  }

  /** Active nodes whose gate holds convergence-backoff state. */
  getBackedOffNodes(): ReadonlySet<SchedulerNode> {
    return this.#backedOffNodes;
  }

  /** Indexes `record` after a write of convergence-backoff state to its gate. */
  noteBackoff(record: SchedulerNode): void {
    if (this.#all.has(record)) this.#backedOffNodes.add(record);
  }

  /** Drops `record` from the index after its backoff state is cleared. */
  forgetBackoff(record: SchedulerNode): void {
    this.#backedOffNodes.delete(record);
  }

  #syncInvalidIndex(record: SchedulerNode): void {
    if (
      this.#all.has(record) &&
      (record.status === "invalid" || record.status === "never-ran")
    ) {
      if (!this.#invalidNodes.has(record.action)) {
        record.invalidOrdinal = this.#nextInvalidOrdinal++;
        this.#invalidNodes.add(record.action);
      }
      // A status write is also a fresh look: cheap, and it keeps a node that
      // was parked as `never-ran` from staying parked through an invalidation.
      this.#seedCandidates.add(record.action);
    } else {
      this.#invalidNodes.delete(record.action);
      this.#seedCandidates.delete(record.action);
    }
  }

  linkParent(
    childAction: Action,
    parentAction: Action | null | undefined,
    options: { allowExisting?: boolean } = {},
  ): SchedulerNode | undefined {
    const { allowExisting = true } = options;
    if (!parentAction || parentAction === childAction) return undefined;

    const child = this.#records.get(childAction);
    if (!child) return undefined;
    if (!allowExisting && child.parentAction) {
      return this.parentOf(childAction);
    }

    if (child.parentAction && child.parentAction !== parentAction) {
      this.#childActionsByParent.get(child.parentAction)?.delete(child.action);
    }
    this.#captureParentAction(child, parentAction);
    return this.parentOf(childAction);
  }

  parentOf(action: Action): SchedulerNode | undefined {
    const parentAction = this.#records.get(action)?.parentAction;
    return parentAction ? this.#records.get(parentAction) : undefined;
  }

  /**
   * The captured parent ACTION, independent of whether the parent's record
   * is (still/already) registered — exact parity with the v1 parent WeakMap.
   * Demand and trace checks key off action objects, so they must see the
   * parent through registration churn windows where parentOf() is undefined.
   */
  parentActionOf(action: Action): Action | undefined {
    return this.#records.get(action)?.parentAction;
  }

  childrenOf(action: Action): ReadonlySet<SchedulerNode> | undefined {
    const childActions = this.#childActionsByParent.get(action);
    if (!childActions) return undefined;

    const children = new Set<SchedulerNode>();
    for (const childAction of childActions) {
      const child = this.#records.get(childAction);
      if (child) children.add(child);
    }
    return children;
  }

  isEffect(action: Action): boolean {
    return this.#activeEffects.has(action);
  }

  isComputation(action: Action): boolean {
    return this.#activeComputations.has(action);
  }

  isKnownEffect(action: Action): boolean {
    return this.#records.get(action)?.kind === "effect";
  }

  *nodes(kind?: NodeKind): IterableIterator<SchedulerNode> {
    for (const record of this.#all) {
      if (kind === undefined || record.kind === kind) {
        yield record;
      }
    }
  }

  /**
   * The active nodes whose action names any of `rootIds` as a demand root,
   * each once, in the order `nodes()` yields them. A node's roots are its
   * action's `demandRootIds`, or its `pieceRootId` where it names none; a
   * node whose action names neither is beneath no root.
   */
  nodesUnderDemandRoots(rootIds: Iterable<string>): SchedulerNode[] {
    const byJoining = (a: SchedulerNode, b: SchedulerNode) =>
      this.#joinedAt.get(a)! - this.#joinedAt.get(b)!;
    const sets: Set<SchedulerNode>[] = [];
    for (const id of new Set(rootIds)) {
      const filed = this.#nodesByDemandRoot.get(id);
      if (filed === undefined) continue;
      if (this.#unorderedDemandRoots.delete(id)) {
        const ordered = [...filed].sort(byJoining);
        filed.clear();
        for (const record of ordered) filed.add(record);
      }
      sets.push(filed);
    }
    if (sets.length === 0) return [];
    // One root's set is already in joining order, which is the usual lookup:
    // the space server asks about one root at a time.
    if (sets.length === 1) return [...sets[0]];
    const found = new Set<SchedulerNode>();
    for (const filed of sets) {
      for (const record of filed) found.add(record);
    }
    return [...found].sort(byJoining);
  }

  /** Whether any active node names `rootId` as a demand root. */
  hasNodesUnderDemandRoot(rootId: string): boolean {
    return this.#nodesByDemandRoot.has(rootId);
  }

  /**
   * Files `action`'s node under the demand roots its observation identity
   * names now, in place of the ones it was filed under. The scheduler calls
   * this after it sets an identity: an active node stays filed under the
   * roots its action named when it joined until then. A no-op for an action
   * with no active node, which joining files.
   */
  noteObservationIdentity(action: Action): void {
    const record = this.#records.get(action);
    if (record !== undefined && this.#all.has(record)) {
      this.#fileUnderDemandRoots(record, { joining: false });
    }
  }

  #fileUnderDemandRoots(
    record: SchedulerNode,
    { joining }: { joining: boolean },
  ): void {
    this.#unfileFromDemandRoots(record);
    const identity = (record.action as Partial<TelemetryAnnotations>)
      .schedulerObservationIdentity;
    const named = identity?.demandRootIds ??
      (identity?.pieceRootId !== undefined ? [identity.pieceRootId] : []);
    if (named.length === 0) return;
    const roots = new Map<string, Set<SchedulerNode>>();
    for (const id of named) {
      if (roots.has(id)) continue;
      let filed = this.#nodesByDemandRoot.get(id);
      if (filed === undefined) {
        filed = new Set();
        this.#nodesByDemandRoot.set(id, filed);
      } else if (!joining) {
        // A node that joined earlier now sits after ones that joined later.
        this.#unorderedDemandRoots.add(id);
      }
      filed.add(record);
      roots.set(id, filed);
    }
    this.#filedDemandRoots.set(record, roots);
  }

  #unfileFromDemandRoots(record: SchedulerNode): void {
    const roots = this.#filedDemandRoots.get(record);
    if (roots === undefined) return;
    for (const [id, filed] of roots) {
      filed.delete(record);
      if (filed.size === 0) {
        this.#nodesByDemandRoot.delete(id);
        this.#unorderedDemandRoots.delete(id);
      }
    }
    this.#filedDemandRoots.delete(record);
  }

  #captureParentAction(
    child: SchedulerNode,
    parentAction: Action,
  ): void {
    child.parentAction = parentAction;

    let children = this.#childActionsByParent.get(parentAction);
    if (!children) {
      children = new Set();
      this.#childActionsByParent.set(parentAction, children);
    }
    children.add(child.action);

    const parent = this.#records.get(parentAction);
    if (parent) {
      parent.children = children;
    }
  }

  #activate(record: SchedulerNode): void {
    if (!this.#all.has(record)) {
      record.registrationToken = {};
      this.#membership++;
      this.#joinedAt.set(record, this.#nextJoin++);
      this.#fileUnderDemandRoots(record, { joining: true });
      this.#noteChangedPiece(record);
    }
    this.#all.add(record);
    if (record.kind === "effect") {
      this.#activeEffects.add(record.action);
      this.#activeComputations.delete(record.action);
    } else {
      this.#activeComputations.add(record.action);
      this.#activeEffects.delete(record.action);
    }
    // A freshly registered node is born `never-ran`; a reactivated record
    // re-enters the index iff its (preserved) status still qualifies.
    this.#syncInvalidIndex(record);
    if (holdsBackoffState(record.gate)) this.#backedOffNodes.add(record);
  }
}
