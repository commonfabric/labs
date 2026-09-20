import type { IMemorySpaceAddress } from "../storage/interface.ts";
import type { FanOutNodeState } from "./fan-out.ts";
import type { Action } from "./types.ts";

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
}

export interface SchedulerNode {
  readonly action: Action;
  /** Whether this registration has an accepted result to retain while gated. */
  hasCommittedResult?: boolean;
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

  /**
   * Source of monotonic registration ordinals (see `SchedulerNode.ordinal`).
   */
  #nextOrdinal = 0;

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
    record.registrationToken = {};
    delete record.hasCommittedResult;
    delete record.gate.retryOwed;
    delete record.pendingWaveRun;
    record.adoptedViewIdentity = undefined;
    record.cancelLocalReadWake?.();
    record.cancelLocalReadWake = undefined;
    this.#all.delete(record);
    this.#activeEffects.delete(action);
    this.#activeComputations.delete(action);
    this.#invalidNodes.delete(action);
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
    if (status !== "clean") record.adoptedViewIdentity = undefined;
    record.status = status;
    this.#syncInvalidIndex(record);
  }

  /**
   * Active nodes whose status is `invalid` or `never-ran`. Seeds the inverted
   * event-preflight walk (decision 15) and the pull scheduling scans.
   */
  getInvalidNodes(): ReadonlySet<Action> {
    return this.#invalidNodes;
  }

  #syncInvalidIndex(record: SchedulerNode): void {
    if (
      this.#all.has(record) &&
      (record.status === "invalid" || record.status === "never-ran")
    ) {
      this.#invalidNodes.add(record.action);
    } else {
      this.#invalidNodes.delete(record.action);
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

  isKnownComputation(action: Action): boolean {
    return this.#records.get(action)?.kind === "computation";
  }

  *nodes(kind?: NodeKind): IterableIterator<SchedulerNode> {
    for (const record of this.#all) {
      if (kind === undefined || record.kind === kind) {
        yield record;
      }
    }
  }

  size(kind: NodeKind): number {
    return kind === "effect"
      ? this.#activeEffects.size
      : this.#activeComputations.size;
  }

  isAncestor(
    sourceAction: Action,
    candidateAncestor: Action,
  ): boolean {
    let parentAction = this.#records.get(sourceAction)?.parentAction;
    while (parentAction) {
      if (parentAction === candidateAncestor) {
        return true;
      }
      parentAction = this.#records.get(parentAction)?.parentAction;
    }
    return false;
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
    if (!this.#all.has(record)) record.registrationToken = {};
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
  }
}
