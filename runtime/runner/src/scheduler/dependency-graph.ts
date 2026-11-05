import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import { entityKey } from "./keys.ts";
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

function assertLivenessEquivalence(
  state: SchedulerLivenessState,
  site: string,
): void {
  if (!LIVENESS_EQUIVALENCE_CHECK) return;
  const records = [...state.nodes.nodes()];
  const incremental = records.map((record) => record.liveRefs);
  recomputeLiveRefs(state);
  const drift: string[] = [];
  records.forEach((record, i) => {
    if (record.liveRefs !== incremental[i]) {
      const name = (record.action as { name?: string }).name || "<anonymous>";
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

  if (wasLive) {
    withdrawDemandFrom(state, action);
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
  } else {
    node.provisionalDemandPass = undefined;
  }
  // Root removal must re-derive even when a stale internal cycle ref makes the
  // node appear live: those refs can be circular, and only a walk from the
  // remaining roots can tell.
  if (provisionalDemand) {
    if (!wasLive && isLive(state, node)) grantDemandFrom(state, node.action);
  } else {
    withdrawDemandFrom(state, node.action);
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
      if (!wasLive) stack.push(writer);
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
 * through it, after `origin` lost a reference or a root status.
 *
 * The region is `origin`'s transitive upstream, which is closed under the
 * writer edge: any node whose support routes through `origin` must be upstream
 * of it. So a live reader *outside* the region cannot owe its own liveness to
 * anything inside, and its support can be taken at face value. Clearing the
 * region and re-seeding from roots inside it plus live readers outside is
 * therefore both diamond-accurate and cycle-safe — a rootless cycle finds no
 * seed and settles dormant — while touching only the affected region.
 */
function withdrawDemandFrom(
  state: SchedulerDemandState,
  origin: Action,
): void {
  const originRecord = state.nodes.get(origin);
  if (!originRecord || !isRegisteredNode(state, originRecord)) return;
  // A root holds its own demand, so it neither dies nor changes what it
  // contributes upstream.
  if (isDemandRoot(state, originRecord)) return;

  const region = new Set<Action>([origin]);
  const pending: Action[] = [origin];
  while (pending.length > 0) {
    const reader = pending.pop()!;
    const writers = state.reverseDependencies.get(reader);
    if (!writers) continue;
    for (const writer of writers) {
      livenessWork.edgeVisits++;
      if (region.has(writer)) continue;
      const record = state.nodes.get(writer);
      if (!record || !isRegisteredNode(state, record)) continue;
      region.add(writer);
      pending.push(writer);
    }
  }

  for (const action of region) {
    livenessWork.nodeWrites++;
    state.nodes.get(action)!.liveRefs = 0;
  }

  const seeds: Action[] = [];
  for (const action of region) {
    const record = state.nodes.get(action)!;
    let supported = isDemandRoot(state, record);
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

export function groupReadsByEntity(
  reads: readonly IMemorySpaceAddress[],
  identity: ScopeKeyIdentity,
): Map<SpaceScopeAndURI, IMemorySpaceAddress[]> {
  const readsByEntity = new Map<SpaceScopeAndURI, IMemorySpaceAddress[]>();
  for (const read of reads) {
    const entity = entityKey(read, identity);
    let entityReads = readsByEntity.get(entity);
    if (!entityReads) {
      entityReads = [];
      readsByEntity.set(entity, entityReads);
    }
    entityReads.push(read);
  }
  return readsByEntity;
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
    if (!wasLive) grantDemandFrom(state, writer);
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
    // recounts the region when the writer is not a root, but a root short-
    // circuits that walk, so drop the reference here to keep the count equal
    // to the number of live direct readers either way.
    const writerRecord = state.nodes.get(writer);
    const dependentRecord = state.nodes.get(dependent);
    if (
      writerRecord && isRegisteredNode(state, writerRecord) &&
      dependentRecord && isLive(state, dependentRecord)
    ) {
      livenessWork.nodeWrites++;
      writerRecord.liveRefs--;
    }
    withdrawDemandFrom(state, writer);
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
