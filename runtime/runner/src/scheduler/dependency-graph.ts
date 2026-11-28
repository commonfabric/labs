import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import type { MaterializerIndexState } from "./materializers.ts";
import type { NodeRegistry, SchedulerNode } from "./node-record.ts";
import { forEachOverlappingWriter } from "./scheduling-writes.ts";
import type { TriggerIndexState } from "./trigger-index.ts";
import type {
  Action,
  EventPreflightTraceContext,
  ReactivityLog,
  SpaceScopeAndURI,
} from "./types.ts";

export interface DependencyGraphState {
  /** Identity entity keys resolve scoped addresses against (keys.ts). */
  readonly scopeKeyIdentity: () => ScopeKeyIdentity;

  readonly triggerIndex: TriggerIndexState;
  readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
  readonly dependencies: WeakMap<Action, ReactivityLog>;
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly reverseDependencies: WeakMap<Action, Set<Action>>;
  readonly nodes: NodeRegistry;
  readonly materializerIndex: Pick<MaterializerIndexState, "isMaterializer">;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
}

export type SchedulerLivenessState = Pick<
  DependencyGraphState,
  "nodes" | "reverseDependencies" | "materializerIndex"
>;

/**
 * Liveness state plus the forward reader edges. Withdrawing demand needs them
 * to find the live readers that support a node from outside the region it is
 * re-deriving; {@link recomputeLiveRefs} derives everything from the roots and
 * so stays on the narrower state.
 */
export type SchedulerDemandState =
  & SchedulerLivenessState
  & Pick<DependencyGraphState, "dependents">;

/**
 * True when `node` carries demand on its own, independent of any reader.
 *
 * A root needs no incoming reference to stay live, which is why granting or
 * withdrawing demand can treat it as a fixed point rather than walking through
 * it.
 */
function isDemandRoot(
  state: SchedulerLivenessState,
  node: SchedulerNode,
): boolean {
  return state.nodes.isEffect(node.action) ||
    node.provisionalDemand ||
    state.materializerIndex.isMaterializer(node.action) ||
    // (d′) — the standing `demandedWriters` root kind (design
    // §2.4; serving-loop.md §8's positive tripwire): a writer of an
    // instance a client session tracks holds demand while any session
    // tracks it. Every transition into and out of the set is bracketed
    // with the liveness notifications (facade.enterDemandedEntity /
    // leaveDemandedEntity / the write-index registration hook).
    state.nodes.isDemandedWriter(node.action);
}

export function isLive(
  state: SchedulerLivenessState,
  node: SchedulerNode,
): boolean {
  if (!isRegisteredNode(state, node)) return false;

  return isDemandRoot(state, node) || node.liveRefs > 0;
}

/**
 * Liveness maintenance work, counted for the scaling profile in
 * `test/liveness-scaling.profile.ts`. Process-wide, so a reading covers every
 * runtime alive in it.
 */
export const livenessWork = { nodeWrites: 0, edgeVisits: 0, operations: 0 };

export function resetLivenessWork(): void {
  livenessWork.nodeWrites = 0;
  livenessWork.edgeVisits = 0;
  livenessWork.operations = 0;
}

/**
 * Every-mutation equivalence verifier, disabled unless
 * `SCHEDULER_LIVENESS_EQUIVALENCE=1`. With it on, every exit from the four
 * liveness mutators asserts the incrementally maintained refcounts equal a
 * full rebuild from the demand roots ({@link recomputeLiveRefs}), which is
 * the definition they implement. The rebuild overwrites in place, so state
 * is canonical after the check either way; drift throws with the mutation
 * site and the drifted nodes. Run it across the whole runner suite after
 * changes that touch liveness maintenance, registration ordering, or edge
 * derivation — the original pass over this suite is what caught
 * `unregisterDependentEdge` dropping a decrement for root writers (see
 * docs/history/development/performance/2026-08-scheduler-liveness-maintenance.md).
 * Off by default: the check costs the full-graph walk the incremental path
 * exists to avoid.
 */
const LIVENESS_EQUIVALENCE_CHECK: boolean = (() => {
  try {
    return typeof Deno !== "undefined" &&
      Deno.env.get("SCHEDULER_LIVENESS_EQUIVALENCE") === "1";
  } catch {
    return false; // no env permission: stay disabled
  }
})();

/**
 * Throws when a node's incrementally maintained `liveRefs` differs from a full
 * rebuild ({@link recomputeLiveRefs}), naming `site` and each drifted node.
 * The rebuilt counts stand either way. Does nothing unless `enabled`.
 */
export function assertLivenessEquivalence(
  state: SchedulerLivenessState,
  site: string,
  enabled: boolean = LIVENESS_EQUIVALENCE_CHECK,
): void {
  if (!enabled) return;
  const records = [...state.nodes.nodes()];
  const incremental = records.map((record) => record.liveRefs);
  // The rebuild is a check on maintenance rather than part of it, so the work
  // counters read the same with the check on as off.
  const work = { ...livenessWork };
  recomputeLiveRefs(state);
  Object.assign(livenessWork, work);
  const drift: string[] = [];
  records.forEach((record, i) => {
    if (record.liveRefs !== incremental[i]) {
      const name = record.action.name || "<anonymous>";
      drift.push(
        `${name}: incremental=${incremental[i]} rebuilt=${record.liveRefs}`,
      );
    }
  });
  if (drift.length > 0) {
    throw new Error(
      `liveness drift after ${site}: ${drift.join("; ")}`,
    );
  }
}

/**
 * Take account of a node whose root status or registration changed underneath
 * the graph — it became an effect, gained or lost materializer envelopes, or
 * (re-)registered.
 *
 * A node that was live is re-derived rather than compared: it may have lost a
 * root status while references that are only circular keep it looking live, and
 * no local check can tell those apart. `withdrawDemandFrom` returns at once
 * when the node still holds demand of its own, so the common case stays cheap.
 */
export function notifyNodeLivenessChange(
  state: SchedulerDemandState,
  action: Action,
  wasLive: boolean,
): void {
  notifyNodeLivenessChangeImpl(state, action, wasLive);
  assertLivenessEquivalence(state, "notifyNodeLivenessChange");
}

function notifyNodeLivenessChangeImpl(
  state: SchedulerDemandState,
  action: Action,
  wasLive: boolean,
): void {
  livenessWork.operations++;
  const node = state.nodes.get(action);
  if (!node) return;
  // The node's root status or registration changed, which can make it live
  // with no reference granted.
  state.nodes.noteMayBeLive(action);

  if (wasLive) {
    withdrawDemandFrom(state, action, true);
    return;
  }

  // A reference is granted only while the writer is registered, so edges that
  // already name a node registering now hold none. Recover them from the
  // readers before deciding whether the node came alive.
  if (isRegisteredNode(state, node)) {
    let liveReaders = 0;
    const readers = state.dependents.get(action);
    if (readers) {
      for (const reader of readers) {
        livenessWork.edgeVisits++;
        const readerRecord = state.nodes.get(reader);
        if (readerRecord && isLive(state, readerRecord)) liveReaders++;
      }
    }
    livenessWork.nodeWrites++;
    node.liveRefs = liveReaders;
  }
  if (isLive(state, node)) grantDemandFrom(state, action);
}

export function setNodeProvisionalDemand(
  state: SchedulerDemandState,
  node: SchedulerNode,
  provisionalDemand: boolean,
  passId?: number,
): void {
  setNodeProvisionalDemandImpl(state, node, provisionalDemand, passId);
  assertLivenessEquivalence(state, "setNodeProvisionalDemand");
}

function setNodeProvisionalDemandImpl(
  state: SchedulerDemandState,
  node: SchedulerNode,
  provisionalDemand: boolean,
  passId?: number,
): void {
  livenessWork.operations++;
  const wasLive = isLive(state, node);
  node.provisionalDemand = provisionalDemand;
  if (provisionalDemand) {
    node.provisionalDemandPass = passId;
    state.nodes.noteMayBeLive(node.action);
  } else {
    node.provisionalDemandPass = undefined;
  }
  // Root removal must re-derive even when a stale internal cycle ref makes the
  // node appear live: those refs can be circular, and only a walk from the
  // remaining roots can tell.
  if (provisionalDemand) {
    if (!wasLive && isLive(state, node)) grantDemandFrom(state, node.action);
  } else {
    withdrawDemandFrom(state, node.action, wasLive);
  }
}

/**
 * Propagate demand from nodes that just became live to the writers they read.
 *
 * Each seed contributes one reference to each of its writers; a writer that
 * crosses from dormant to live passes the same contribution further upstream.
 * A node is enqueued only on that crossing, so a cycle settles instead of
 * looping: once live, later increments find it already live.
 */
function propagateDemand(
  state: SchedulerLivenessState,
  seeds: readonly Action[],
): void {
  const stack = [...seeds];

  while (stack.length > 0) {
    const reader = stack.pop()!;
    const writers = state.reverseDependencies.get(reader);
    if (!writers) continue;
    for (const writer of writers) {
      livenessWork.edgeVisits++;
      const record = state.nodes.get(writer);
      if (!record || !isRegisteredNode(state, record)) continue;
      const wasLive = isLive(state, record);
      livenessWork.nodeWrites++;
      record.liveRefs++;
      if (!wasLive) {
        state.nodes.noteMayBeLive(writer);
        stack.push(writer);
      }
    }
  }
}

/**
 * Record that `action` became live without gaining a reference — by becoming a
 * root, or by registering — and pass its demand upstream.
 */
function grantDemandFrom(
  state: SchedulerLivenessState,
  action: Action,
): void {
  propagateDemand(state, [action]);
}

/**
 * Re-derive demand for `origin` and everything that could reach a root only
 * through it, after `origin` lost a reference or a root status. `originWasLive`
 * is whether it was live before, and so whether the writers it reads count a
 * reference from it.
 *
 * The region is the part of `origin`'s transitive upstream that may die with
 * it. A writer that a root still reaches without passing through the region
 * ({@link reachedBypassing}) stays live, and so does everything upstream of it
 * that the region does not otherwise reach, so the walk stops there and keeps
 * the writer as the region's boundary. Any other node whose support routes
 * through `origin` is upstream of it, and every writer of a region node is in
 * the region or on its boundary. So a live reader *outside* the region cannot
 * owe its own liveness to anything inside, and its support can be taken at face
 * value. Clearing the region and re-seeding from the live readers outside it is
 * therefore both diamond-accurate and cycle-safe — a rootless cycle finds no
 * seed and settles dormant. A boundary node first gives back the references
 * the region's live nodes held on it, and the re-seeding hands back those of
 * the survivors, so its count stays the number of its live readers.
 *
 * Where a root still reaches `origin` itself, the region is empty: `origin`
 * stays live and contributes upstream exactly what it did. For a writer
 * shared by many rows, that keeps the departure of one row from paying for the
 * writer's whole upstream.
 */
function withdrawDemandFrom(
  state: SchedulerDemandState,
  origin: Action,
  originWasLive: boolean,
): void {
  const originRecord = state.nodes.get(origin);
  if (!originRecord || !isRegisteredNode(state, originRecord)) return;
  // A root holds its own demand, so it neither dies nor changes what it
  // contributes upstream.
  if (isDemandRoot(state, originRecord)) return;
  // A node that was not live held no reference on its writers, so losing one
  // of its own changes nothing upstream.
  if (!originWasLive) return;

  const search: BypassSearch = {
    region: new Set([origin]),
    boundary: new Set(),
    stranded: new Set(),
  };
  // With no writer to keep live, re-deriving `origin` alone costs only its
  // readers, which is less than a search for a root that may lie far below.
  if (
    hasRegisteredWriter(state, origin) &&
    reachedBypassing(state, origin, search)
  ) {
    return;
  }

  const { region, boundary } = search;
  const pending: Action[] = [origin];
  while (pending.length > 0) {
    const reader = pending.pop()!;
    const writers = state.reverseDependencies.get(reader);
    if (!writers) continue;
    for (const writer of writers) {
      livenessWork.edgeVisits++;
      if (region.has(writer) || boundary.has(writer)) continue;
      const record = state.nodes.get(writer);
      if (!record || !isRegisteredNode(state, record)) continue;
      if (
        isDemandRoot(state, record) ||
        (!search.stranded.has(writer) &&
          reachedBypassing(state, writer, search))
      ) {
        boundary.add(writer);
        continue;
      }
      region.add(writer);
      pending.push(writer);
    }
  }

  // Every region node was live, and so held a reference on each writer it
  // reads: `origin` by the `originWasLive` check, and each other node as a
  // registered writer of a region node that was live.
  for (const action of region) {
    for (const writer of state.reverseDependencies.get(action) ?? NO_ACTIONS) {
      livenessWork.edgeVisits++;
      if (!boundary.has(writer)) continue;
      livenessWork.nodeWrites++;
      state.nodes.get(writer)!.liveRefs--;
    }
  }

  for (const action of region) {
    livenessWork.nodeWrites++;
    state.nodes.get(action)!.liveRefs = 0;
  }

  const seeds: Action[] = [];
  for (const action of region) {
    const record = state.nodes.get(action)!;
    // The region holds no root: a root origin returns above, and a root
    // writer joins the boundary.
    let supported = false;
    const readers = state.dependents.get(action);
    if (readers) {
      for (const reader of readers) {
        livenessWork.edgeVisits++;
        if (region.has(reader)) continue;
        const readerRecord = state.nodes.get(reader);
        if (readerRecord && isLive(state, readerRecord)) {
          livenessWork.nodeWrites++;
          record.liveRefs++;
          supported = true;
        }
      }
    }
    if (supported) seeds.push(action);
  }

  propagateDemand(state, seeds);
}

/** Whether any writer `action` reads is registered. */
function hasRegisteredWriter(
  state: SchedulerDemandState,
  action: Action,
): boolean {
  for (const writer of state.reverseDependencies.get(action) ?? NO_ACTIONS) {
    livenessWork.edgeVisits++;
    const record = state.nodes.get(writer);
    if (record && isRegisteredNode(state, record)) return true;
  }
  return false;
}

/** The readers of a node that has none. */
const NO_ACTIONS: ReadonlySet<Action> = new Set();

/** What one {@link withdrawDemandFrom} has learned so far about its region. */
interface BypassSearch {
  /** The nodes that may die with the origin. */
  readonly region: Set<Action>;

  /**
   * Nodes that a root reaches bypassing the region, among them every writer
   * of a region node that is not itself in the region.
   */
  readonly boundary: Set<Action>;

  /** Nodes from which no root is reachable bypassing the region. */
  readonly stranded: Set<Action>;
}

/**
 * Helper for {@link withdrawDemandFrom}, which says whether a demand root
 * reaches `start` along reader edges that pass through no node of the
 * region, and so keeps it live whatever the region loses.
 *
 * The search walks downstream from `start`'s readers and skips nodes that are
 * not live. That pruning loses no path: a change that withdraws demand only
 * removes reachability, so a node not live before it is not live after it.
 * And a root it finds is a real support even where counts on the way still
 * reflect the old graph: a node a root reaches without passing through the
 * region does not owe its liveness to the region. No node on such a path ever
 * joins the region, since the one nearest the root would have found that root
 * itself, so a boundary node it reaches ends the search too.
 *
 * The walk is depth-first and descends into a live reader as soon as it
 * finds one, so a node with many readers costs only those it tries before a
 * root turns up; for a UI node that is usually a few readers away. Which
 * root it reaches first depends on the order the readers were added in, and
 * a dead end tried first is walked before a root read later, but at most
 * once per withdrawal, as follows. Where the walk finds a root, that root
 * and every node on the path to it past `start` reach a root bypassing the
 * region, and join the boundary, where a later walk stops: a node on the
 * boundary that reads no region node only ends walks, and one that does is
 * one the caller's recount covers. Every other node the walk entered is
 * recorded as stranded, and so is every node a walk that found nothing
 * entered; later walks treat stranded nodes as dead ends, and the caller
 * puts a stranded writer in the region without starting a walk from it. A
 * node a successful walk backed out of may reach a root after all, through
 * the path it found, and a failed walk can stop at such a node, so stranding
 * is sound rather than exact: it can only make a later walk fail and put
 * more nodes in the region, which the caller's re-seeding gives back
 * whatever support they have. The counts come out right whatever is
 * stranded, so long as every boundary node really reaches a root bypassing
 * the region, every registered writer of a region node is in the region or
 * on the boundary, and the region holds no root. Putting the nodes of a
 * found path on the boundary is what bounds the work: no later walk enters
 * them, and a stranded node is never the start of a walk. So each node is
 * entered by at most one walk in a withdrawal, and the walks together cost
 * at most the readers of the nodes they enter.
 */
function reachedBypassing(
  state: SchedulerDemandState,
  start: Action,
  search: BypassSearch,
): boolean {
  const readersOf = (action: Action): Iterator<Action> =>
    (state.dependents.get(action) ?? NO_ACTIONS).values();
  const entered = new Set<Action>([start]);
  // `path[i]` is the node whose readers `stack[i]` iterates.
  const path = [start];
  const stack = [readersOf(start)];
  const settle = (found: boolean): boolean => {
    const onPath = new Set(path);
    for (const action of path.slice(1)) search.boundary.add(action);
    for (const action of entered) {
      if (!onPath.has(action)) search.stranded.add(action);
    }
    return found;
  };
  while (stack.length > 0) {
    const next = stack[stack.length - 1]!.next();
    if (next.done) {
      stack.pop();
      path.pop();
      continue;
    }
    const reader = next.value;
    livenessWork.edgeVisits++;
    if (search.boundary.has(reader)) return settle(true);
    if (
      entered.has(reader) || search.region.has(reader) ||
      search.stranded.has(reader)
    ) {
      continue;
    }
    entered.add(reader);
    const record = state.nodes.get(reader);
    if (!record || !isLive(state, record)) continue;
    path.push(reader);
    if (isDemandRoot(state, record)) return settle(true);
    stack.push(readersOf(reader));
  }
  return settle(false);
}

/**
 * True when an invalid/never-ran node is transitively upstream of `action`.
 *
 * Walks `action`'s upstream cone through the writer edge, iteratively so a
 * deep graph costs no stack, and stops at the first invalid node it reaches.
 * `action` itself is excluded: a resubscribe records a run that just
 * completed, so callers use this to decide whether newly-live upstream work
 * needs a wake.
 */
export function hasInvalidUpstream(
  state: Pick<DependencyGraphState, "reverseDependencies" | "nodes">,
  action: Action,
): boolean {
  const invalid = state.nodes.getInvalidNodes();
  if (invalid.size === 0) return false;

  const visited = new Set<Action>([action]);
  const pending: Action[] = [action];
  while (pending.length > 0) {
    const reader = pending.pop()!;
    const writers = state.reverseDependencies.get(reader);
    if (!writers) continue;
    for (const writer of writers) {
      if (visited.has(writer)) continue;
      if (invalid.has(writer)) return true;
      visited.add(writer);
      pending.push(writer);
    }
  }

  return false;
}

export function collectDirectWritersForLog(state: {
  readonly scopeKeyIdentity: () => ScopeKeyIdentity;
  readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
  readonly effects: ReadonlySet<Action>;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly trace?: EventPreflightTraceContext;
}, log: ReactivityLog): Set<Action> {
  const directWriters = new Set<Action>();
  if (state.trace) {
    state.trace.logReadCount += log.reads.length;
    state.trace.logShallowReadCount += log.shallowReads.length;
  }

  forEachOverlappingWriter(state, log.reads, log.shallowReads, (writer) => {
    if (state.trace && !directWriters.has(writer)) {
      state.trace.writerOverlapCount++;
    }
    directWriters.add(writer);
  }, {
    filter: (writer) => !state.effects.has(writer),
    onCandidate: () => {
      if (state.trace) state.trace.writerCandidateCount++;
    },
  });

  return directWriters;
}

export function collectReverseDependenciesForLog(
  state: {
    readonly scopeKeyIdentity: () => ScopeKeyIdentity;
    readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
    readonly getSchedulingWrites: (
      action: Action,
    ) => readonly IMemorySpaceAddress[] | undefined;
  },
  action: Action,
  log: ReactivityLog,
): Set<Action> {
  const dependencies = new Set<Action>();

  forEachOverlappingWriter(
    state,
    log.reads,
    log.shallowReads,
    (writer) => {
      dependencies.add(writer);
    },
    {
      filter: (writer) => writer !== action && !dependencies.has(writer),
    },
  );

  return dependencies;
}

export function updateDependentEdgesForLog(
  state: DependencyGraphState,
  action: Action,
  log: ReactivityLog,
): void {
  const previousDependencies = state.reverseDependencies.get(action) ??
    new Set<Action>();
  const newDependencies = collectReverseDependenciesForLog(
    state,
    action,
    log,
  );

  for (const dependency of previousDependencies) {
    if (!newDependencies.has(dependency)) {
      unregisterDependentEdge(state, dependency, action);
    }
  }
  for (const dependency of newDependencies) {
    if (!previousDependencies.has(dependency)) {
      registerDependentEdge(state, dependency, action);
    }
  }

  state.reverseDependencies.set(action, newDependencies);
}

export function registerDependentEdge(
  state: DependencyGraphState,
  writer: Action,
  dependent: Action,
): boolean {
  const changed = registerDependentEdgeImpl(state, writer, dependent);
  assertLivenessEquivalence(state, "registerDependentEdge");
  return changed;
}

function registerDependentEdgeImpl(
  state: DependencyGraphState,
  writer: Action,
  dependent: Action,
): boolean {
  if (writer === dependent) return false;
  livenessWork.operations++;

  let dependents = state.dependents.get(writer);
  if (!dependents) {
    dependents = new Set();
    state.dependents.set(writer, dependents);
  }
  const alreadyDependent = dependents.has(dependent);
  dependents.add(dependent);

  let reverse = state.reverseDependencies.get(dependent);
  if (!reverse) {
    reverse = new Set();
    state.reverseDependencies.set(dependent, reverse);
  }
  reverse.add(writer);

  if (alreadyDependent) return false;

  // The new reader hands one reference to the writer it reads, and only when
  // that reader is itself live.
  const dependentRecord = state.nodes.get(dependent);
  const writerRecord = state.nodes.get(writer);
  if (
    writerRecord && isRegisteredNode(state, writerRecord) &&
    dependentRecord && isLive(state, dependentRecord)
  ) {
    const wasLive = isLive(state, writerRecord);
    livenessWork.nodeWrites++;
    writerRecord.liveRefs++;
    if (!wasLive) {
      state.nodes.noteMayBeLive(writer);
      grantDemandFrom(state, writer);
    }
  }
  return true;
}

export function registerDependentsForWriterSurface(
  state: DependencyGraphState,
  writer: Action,
  writes: readonly IMemorySpaceAddress[],
): void {
  const readers = new Set<Action>();
  for (const write of writes) {
    for (const action of state.triggerIndex.collectReadersForWrite(write)) {
      readers.add(action);
    }
  }
  readers.delete(writer);

  for (const action of readers) {
    registerDependentEdge(state, writer, action);
  }
}

export function unregisterDependentEdge(
  state: DependencyGraphState,
  writer: Action,
  dependent: Action,
): boolean {
  const changed = unregisterDependentEdgeImpl(state, writer, dependent);
  assertLivenessEquivalence(state, "unregisterDependentEdge");
  return changed;
}

function unregisterDependentEdgeImpl(
  state: DependencyGraphState,
  writer: Action,
  dependent: Action,
): boolean {
  livenessWork.operations++;
  const dependents = state.dependents.get(writer);
  const hadDependent = dependents?.delete(dependent) ?? false;
  if (dependents && dependents.size === 0) {
    state.dependents.delete(writer);
  }

  const reverse = state.reverseDependencies.get(dependent);
  reverse?.delete(writer);
  if (reverse && reverse.size === 0) {
    state.reverseDependencies.delete(dependent);
  }

  if (hadDependent) {
    // The departing reader takes its reference with it. `withdrawDemandFrom`
    // recounts the region when the writer may have died, but returns at once
    // where it has not, so drop the reference here to keep the count equal
    // to the number of live direct readers either way.
    // A reader that was not live held no reference, so its departure
    // leaves the writer's count, and its liveness, as they were.
    const writerRecord = state.nodes.get(writer);
    const dependentRecord = state.nodes.get(dependent);
    if (dependentRecord && isLive(state, dependentRecord)) {
      const writerWasLive = writerRecord !== undefined &&
        isLive(state, writerRecord);
      if (writerRecord && isRegisteredNode(state, writerRecord)) {
        livenessWork.nodeWrites++;
        writerRecord.liveRefs--;
      }
      withdrawDemandFrom(state, writer, writerWasLive);
    }
  }
  return hadDependent;
}

/**
 * Derive demand refcounts from the explicit demand roots in one pass over the
 * whole graph.
 *
 * Walk reader→writer edges from the roots to form the root-reachable set, then
 * count each reachable node's live direct readers. This is the definition
 * `liveRefs` carries. Nothing on the maintenance path calls it — granting and
 * withdrawing demand hold the same state incrementally — so it stands as the
 * reference those updates are checked against.
 */
export function recomputeLiveRefs(state: SchedulerLivenessState): void {
  // The rebuild stands whatever the counts were, so it can find a node live
  // that the counts it replaces called dormant.
  state.nodes.noteAllMayBeLive();
  const records = [...state.nodes.nodes()];
  const reachable = new Set<Action>();
  const stack: Action[] = [];

  for (const record of records) {
    livenessWork.nodeWrites++;
    record.liveRefs = 0;
    if (
      state.nodes.isEffect(record.action) ||
      record.provisionalDemand ||
      state.materializerIndex.isMaterializer(record.action) ||
      state.nodes.isDemandedWriter(record.action)
    ) {
      reachable.add(record.action);
      stack.push(record.action);
    }
  }

  while (stack.length > 0) {
    const reader = stack.pop()!;
    const writers = state.reverseDependencies.get(reader);
    if (!writers) continue;
    for (const writer of writers) {
      livenessWork.edgeVisits++;
      const writerRecord = state.nodes.get(writer);
      if (!writerRecord || !isRegisteredNode(state, writerRecord)) continue;
      if (!reachable.has(writer)) {
        reachable.add(writer);
        stack.push(writer);
      }
    }
  }

  for (const reader of reachable) {
    const writers = state.reverseDependencies.get(reader);
    if (!writers) continue;
    for (const writer of writers) {
      livenessWork.edgeVisits++;
      const writerRecord = state.nodes.get(writer);
      if (
        writerRecord &&
        reachable.has(writer) &&
        isRegisteredNode(state, writerRecord)
      ) {
        livenessWork.nodeWrites++;
        writerRecord.liveRefs++;
      }
    }
  }
}

function isRegisteredNode(
  state: SchedulerLivenessState,
  node: SchedulerNode,
): boolean {
  return state.nodes.isEffect(node.action) ||
    state.nodes.isComputation(node.action);
}
