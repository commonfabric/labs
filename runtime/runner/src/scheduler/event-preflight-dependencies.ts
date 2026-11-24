import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import type {
  SchedulerEventPreflightActionSummary,
  SchedulerEventPreflightStats,
} from "../telemetry.ts";
import { collectDirectWritersForLog } from "./dependency-graph.ts";
import {
  collectMaterializerWritersForLog,
  type MaterializerIndexState,
} from "./materializers.ts";
import { entityKey } from "./keys.ts";
import type { NodeRegistry, SchedulerNode } from "./node-record.ts";
import { readsOverlapWrites } from "./scheduling-writes.ts";
import type { TriggerIndexState } from "./trigger-index.ts";
import type {
  Action,
  EventPreflightTraceContext,
  ReactivityLog,
  SpaceScopeAndURI,
} from "./types.ts";

export interface EventPreflightDependencyState {
  /** Identity entity keys resolve scoped addresses against (keys.ts). */
  readonly scopeKeyIdentity: () => ScopeKeyIdentity;

  readonly getTrace: () => EventPreflightTraceContext | undefined;
  readonly nodes: NodeRegistry;
  readonly pending: ReadonlySet<Action>;
  readonly reverseDependencies: WeakMap<Action, Set<Action>>;
  // Inverse of `reverseDependencies` (writer → readers); maintained together
  // by the dependency graph. The downstream half of the inverted preflight
  // reachability (decision 15).
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly dependencies: WeakMap<Action, ReactivityLog>;
  readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
  readonly effects: ReadonlySet<Action>;
  readonly materializerIndex: MaterializerIndexState;
  readonly triggerIndex: Pick<TriggerIndexState, "collectReadersForWrite">;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly getActionId: (action: Action) => string;
}

export function collectInvalidUpstreamForLog(
  state: EventPreflightDependencyState,
  log: ReactivityLog,
  workSet: Set<Action>,
): boolean {
  const trace = state.getTrace();
  const directWriters = collectDirectWritersForLog({
    scopeKeyIdentity: state.scopeKeyIdentity,
    writersByEntity: state.writersByEntity,
    effects: state.effects,
    getSchedulingWrites: state.getSchedulingWrites,
    trace,
  }, log);
  for (
    const materializer of collectMaterializerWritersForLog(
      state.materializerIndex,
      log,
    )
  ) {
    directWriters.add(materializer);
  }

  if (trace) {
    trace.directWriterCount += directWriters.size;
    for (const writer of directWriters) {
      trace.rootDirectWriterActions.add(writer);
      getTraceActionSummary(state, trace, writer);
    }
  }

  // Inverted reachability (decision 15). The consistency gate needs the set of
  // invalid nodes that are transitively upstream of the handler's closure.
  // Walking *up* from the closure visits its entire upstream cone — O(graph)
  // against a hub (a list cell aggregating N rows), which is O(N^2) under
  // rapid creation. Instead, seed from the maintained invalid-node set and
  // walk *down* to the closure: cost is bounded by the invalid set and its
  // downstream cone, not the closure's upstream fan-out.
  const invalidNodes = state.nodes.getInvalidNodes();
  if (invalidNodes.size === 0 || directWriters.size === 0) {
    return false;
  }

  let hasInvalidUpstream = false;
  for (const candidate of invalidNodes) {
    if (!reachesClosure(state, candidate, directWriters)) continue;
    if (trace) {
      if (!workSet.has(candidate)) trace.workSetAddCount++;
      trace.dirtyInputCount++;
      const summary = getTraceActionSummary(state, trace, candidate);
      summary.dirtyInputCount++;
      summary.resultTrueCount++;
    }
    workSet.add(candidate);
    hasInvalidUpstream = true;
  }
  return hasInvalidUpstream;
}

/**
 * In-flight document loads that gate the head event (CT-1795): keys of
 * loading documents that the handler's closure reads directly, or whose
 * readers are transitively upstream of the closure. The invalid-upstream gate
 * covers *graph* staleness (nodes whose inputs changed); this covers *replica*
 * staleness — an address the closure depends on whose load has not completed.
 * Only events need it: computations self-heal through the change channel when
 * the load lands, but handlers are at-most-once (D7). Same inverted shape as
 * decision 15: seed from the (small) pending-load set, walk downstream to the
 * closure — never up the closure's cone.
 */
export function collectPendingLoadParkKeys(
  state: EventPreflightDependencyState,
  pendingLoadAddresses: readonly Pick<
    IMemorySpaceAddress,
    "space" | "scope" | "id"
  >[],
  log: ReactivityLog,
): string[] {
  if (pendingLoadAddresses.length === 0) return [];
  const identity = state.scopeKeyIdentity();
  const pendingByKey = new Map(
    pendingLoadAddresses.map((
      address,
    ) => [entityKey(address, identity), address]),
  );

  const keys = new Set<string>();
  // Direct: the closure itself reads a loading document.
  for (const read of [...log.reads, ...log.shallowReads]) {
    const key = entityKey(read, identity);
    if (pendingByKey.has(key)) keys.add(key);
  }

  // Upstream: a reader of the loading document feeds the closure. The
  // closure set mirrors collectInvalidUpstreamForLog's (direct writers of the
  // log plus materializer writers).
  const closure = collectDirectWritersForLog({
    scopeKeyIdentity: state.scopeKeyIdentity,
    writersByEntity: state.writersByEntity,
    effects: state.effects,
    getSchedulingWrites: state.getSchedulingWrites,
  }, log);
  for (
    const materializer of collectMaterializerWritersForLog(
      state.materializerIndex,
      log,
    )
  ) {
    closure.add(materializer);
  }
  if (closure.size > 0) {
    for (const [key, address] of pendingByKey) {
      if (keys.has(key)) continue;
      // A root-path probe matches every registered reader of the document.
      const readers = state.triggerIndex.collectReadersForWrite(
        { ...address, path: [] } as IMemorySpaceAddress,
      );
      for (const reader of readers) {
        if (closure.has(reader) || reachesClosure(state, reader, closure)) {
          keys.add(key);
          break;
        }
      }
    }
  }
  return [...keys];
}

/**
 * True iff the handler `closure` is reachable downstream from `start` — i.e.
 * `start` is transitively upstream of the closure. Plain BFS with a visited
 * set: cycle-safe and bounded by `start`'s downstream cone. The adjacency
 * mirrors the writer→reader edges the forward closure collection
 * (`collectDirectWritersForLog` + materializer overlap) derives, inverted.
 */
function reachesClosure(
  state: EventPreflightDependencyState,
  start: Action,
  closure: ReadonlySet<Action>,
): boolean {
  if (closure.has(start)) return true;

  const trace = state.getTrace();
  const visited = new Set<Action>([start]);
  const frontier: Action[] = [start];
  while (frontier.length > 0) {
    const node = frontier.pop() as Action;
    if (trace) {
      trace.visitCount++;
      getTraceActionSummary(state, trace, node).visitCount++;
    }
    const readers = collectDownstreamReaders(state, node);
    if (readers.size > 0 && trace) {
      recordReverseDependencyTrace(state, trace, node, readers);
    }
    for (const reader of readers) {
      if (closure.has(reader)) return true;
      if (!visited.has(reader)) {
        visited.add(reader);
        frontier.push(reader);
      }
    }
  }
  return false;
}

/**
 * Downstream readers of `node` — the inverse adjacency of the forward
 * writer collection. `dependents` is the maintained inverse of
 * `reverseDependencies` (dependency edges). Materializer edges all originate
 * from materializer writers, so they are mirrored only when `node` is a
 * materializer: an action whose reads overlap the materializer's write
 * envelopes is its downstream reader (same overlap test as
 * `collectMaterializerWritersForLog`, with the self-edge excluded).
 */
function collectDownstreamReaders(
  state: EventPreflightDependencyState,
  node: Action,
): Set<Action> {
  const readers = new Set<Action>(state.dependents.get(node) ?? []);

  if (state.materializerIndex.isMaterializer(node)) {
    const envelopes = state.materializerIndex.getMaterializerWriteEnvelopes(
      node,
    );
    if (envelopes && envelopes.length > 0) {
      const candidates = new Set<Action>();
      for (const envelope of envelopes) {
        for (
          const reader of state.triggerIndex.collectReadersForWrite(envelope)
        ) {
          candidates.add(reader);
        }
      }
      for (const reader of candidates) {
        if (reader === node) continue;
        const readerLog = state.dependencies.get(reader);
        if (!readerLog) continue;
        if (
          readsOverlapWrites(readerLog.reads, readerLog.shallowReads, envelopes)
        ) {
          readers.add(reader);
        }
      }
    }
  }

  return readers;
}

function isInvalidNode(record: SchedulerNode | undefined): boolean {
  return record?.status === "invalid" || record?.status === "never-ran";
}

export function snapshotEventPreflightTraceContext(
  state: EventPreflightDependencyState,
  context: EventPreflightTraceContext,
): SchedulerEventPreflightStats {
  const {
    actionSummaries,
    rootDirectWriterActions,
    ...stats
  } = context;
  const actionRows = [...actionSummaries.values()];
  const topBy = (
    rows: SchedulerEventPreflightActionSummary[],
    key: "visitCount" | "reverseDependencyEdgeCount",
  ) =>
    rows
      .filter((row) => row[key] > 0)
      .sort((a, b) =>
        b[key] - a[key] ||
        b.visitCount - a.visitCount ||
        a.actionId.localeCompare(b.actionId)
      )
      .slice(0, 12);

  const rootDirectWriterRows = [...rootDirectWriterActions].map((action) =>
    getTraceActionSummary(state, context, action)
  );

  return {
    ...stats,
    hotActions: topBy(actionRows, "visitCount"),
    hotFanoutActions: topBy(actionRows, "reverseDependencyEdgeCount"),
    rootDirectWriters: topBy(rootDirectWriterRows, "visitCount"),
  };
}

function recordReverseDependencyTrace(
  state: EventPreflightDependencyState,
  trace: EventPreflightTraceContext,
  action: Action,
  directWriters: Set<Action>,
): void {
  trace.reverseDependencyActionCount++;
  trace.reverseDependencyEdgeCount += directWriters.size;
  const actionSummary = getTraceActionSummary(state, trace, action);
  actionSummary.reverseDependencyEdgeCount += directWriters.size;
  actionSummary.maxDirectWriterCount = Math.max(
    actionSummary.maxDirectWriterCount,
    directWriters.size,
  );
}

function getTraceActionSummary(
  state: EventPreflightDependencyState,
  trace: EventPreflightTraceContext,
  action: Action,
): SchedulerEventPreflightActionSummary {
  let summary = trace.actionSummaries.get(action);
  if (!summary) {
    const log = state.dependencies.get(action);
    summary = {
      actionId: state.getActionId(action),
      actionType: state.effects.has(action)
        ? "effect"
        : state.nodes.isComputation(action)
        ? "computation"
        : "unknown",
      visitCount: 0,
      dirtyInputCount: 0,
      resultTrueCount: 0,
      reverseDependencyEdgeCount: 0,
      maxDirectWriterCount: 0,
      dirty: isInvalidNode(state.nodes.get(action)),
      pending: state.pending.has(action),
      readCount: log?.reads.length ?? 0,
      shallowReadCount: log?.shallowReads.length ?? 0,
      writeCount: state.getSchedulingWrites(action)?.length ?? 0,
    };
    trace.actionSummaries.set(action, summary);
  }
  return summary;
}
