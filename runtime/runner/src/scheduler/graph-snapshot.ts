import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import { getAuthoredDebugSource } from "../harness/authored-debug-source.ts";
import { arraysOverlap } from "../reactive-dependencies.ts";
import { normalizeCellScope } from "../scope.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import type {
  ActionStats,
  SchedulerGraphEdge,
  SchedulerGraphNode,
  SchedulerGraphSnapshot,
} from "../telemetry.ts";
import { entityKey } from "./keys.ts";
import type { NodeRegistry } from "./node-record.ts";
import type { Action, ReactivityLog } from "./types.ts";

export interface SchedulerGraphSnapshotState {
  /** Identity entity keys resolve scoped addresses against (keys.ts). */
  readonly scopeKeyIdentity: () => ScopeKeyIdentity;

  readonly effects: ReadonlySet<Action>;
  readonly computations: ReadonlySet<Action>;
  readonly pending: ReadonlySet<Action>;
  readonly dependencies: WeakMap<Action, ReactivityLog>;
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly nodes: NodeRegistry;
  readonly actionStats: ReadonlyMap<string, ActionStats>;
  readonly getDebounce: (action: Action) => number | undefined;
  readonly getThrottle: (action: Action) => number | undefined;
  readonly hasActiveDebounceTimer: (action: Action) => boolean;
  readonly getActionId: (action: Action) => string;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly getNextDebounceRunTime: (action: Action) => number | undefined;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly isDemandedPullComputation: (action: Action) => boolean;
  readonly isLiveEffect: (action: Action) => boolean;
  readonly isPullDemandRootEffect: (action: Action) => boolean;
  readonly getPatternIdentity: (
    action: Action,
  ) => { identity: string; symbol: string } | undefined;
}

export function buildSchedulerGraphSnapshot(
  state: SchedulerGraphSnapshotState,
  now = performance.now(),
): SchedulerGraphSnapshot {
  const nodes: SchedulerGraphNode[] = [];
  const edges: SchedulerGraphEdge[] = [];
  const actionById = new Map<string, Action>();
  const actions = [...state.effects, ...state.computations];
  const identity = state.scopeKeyIdentity();

  // Build nodes from all known actions (effects + computations)
  for (const action of actions) {
    const id = state.getActionId(action);
    actionById.set(id, action);

    // Get parent-child relationships
    const parent = state.nodes.parentActionOf(action);
    const parentId = parent ? state.getActionId(parent) : undefined;
    const children = state.nodes.childrenOf(action);
    const childCount = children ? children.size : undefined;

    // Get reads and writes for diagnostics
    const deps = state.dependencies.get(action);
    const reads = deps?.reads.map((read) => formatAddress(read, identity));
    const shallowReads = deps?.shallowReads.map((read) =>
      formatAddress(read, identity)
    );
    const writes = state.getSchedulingWrites(action)?.map((write) =>
      formatAddress(write, identity)
    );

    // The authored implementation, for the two debug-only labels below.
    const implementation = (action as Action & {
      module?: { implementation?: unknown };
    }).module?.implementation;

    // Get timing controls
    const debounceMs = state.getDebounce(action);
    const throttleMs = state.getThrottle(action);
    const nextDebounceRunAt = state.getNextDebounceRunTime(action);
    const nextEligibleRunAt = state.getNextEligibleRunTime(action);

    nodes.push({
      id,
      type: state.effects.has(action) ? "effect" : "computation",
      stats: state.actionStats.get(id),
      isDirty: isInvalidAction(state.nodes, action),
      isPending: state.pending.has(action),
      isDemanded: state.isDemandedPullComputation(action),
      isLiveEffect: state.isLiveEffect(action),
      isPullDemandRoot: state.isPullDemandRootEffect(action),
      isDebouncedWaiting: nextDebounceRunAt !== undefined &&
        nextDebounceRunAt > now,
      hasActiveDebounceTimer: state.hasActiveDebounceTimer(action),
      nextDebounceRunInMs: nextDebounceRunAt !== undefined
        ? Math.max(0, Math.round(nextDebounceRunAt - now))
        : undefined,
      nextEligibleRunInMs: nextEligibleRunAt !== undefined
        ? Math.max(0, Math.round(nextEligibleRunAt - now))
        : undefined,
      parentId,
      childCount: childCount && childCount > 0 ? childCount : undefined,
      preview: (implementation as { preview?: string } | undefined)?.preview,
      src: getAuthoredDebugSource(implementation)?.src,
      reads,
      shallowReads,
      writes,
      debounceMs: debounceMs && debounceMs > 0 ? debounceMs : undefined,
      throttleMs: throttleMs && throttleMs > 0 ? throttleMs : undefined,
      patternIdentity: state.getPatternIdentity(action),
    });
  }

  // Build edges from dependents map
  for (const action of actions) {
    const actionId = state.getActionId(action);
    const deps = state.dependents.get(action);
    if (!deps) continue;

    for (const dependent of deps) {
      const dependentId = state.getActionId(dependent);
      // Find overlapping cells between action's writes and dependent's reads
      const cells = findOverlappingCells(state, action, dependent);
      edges.push({
        from: actionId,
        to: dependentId,
        cells,
      });
    }
  }

  // Find source entities (read but not written by any action)
  // These represent pattern inputs / external data
  const entityReaders = new Map<string, Set<string>>(); // entity -> action IDs that read it
  const writtenEntities = new Set<string>();

  for (const action of actions) {
    const actionId = state.getActionId(action);
    const deps = state.dependencies.get(action);
    if (deps) {
      for (const read of [...deps.reads, ...deps.shallowReads]) {
        const entity = entityKey(read, identity);
        if (!entityReaders.has(entity)) {
          entityReaders.set(entity, new Set());
        }
        entityReaders.get(entity)!.add(actionId);
      }
    }

    const writes = state.getSchedulingWrites(action);
    if (writes) {
      for (const write of writes) {
        writtenEntities.add(entityKey(write, identity));
      }
    }
  }

  // Add input nodes for source entities
  for (const [entity, readers] of entityReaders) {
    if (!writtenEntities.has(entity)) {
      const inputId = `input:${entity}`;
      nodes.push({
        id: inputId,
        type: "input",
        isDirty: false,
        isPending: false,
      });

      // Add edges from input to all actions that read it
      for (const readerId of readers) {
        edges.push({
          from: inputId,
          to: readerId,
          cells: [entity],
        });
      }
    }
  }

  // Add parent-child edges
  for (const action of actions) {
    const parent = state.nodes.parentActionOf(action);
    if (!parent) continue;

    const parentId = state.getActionId(parent);
    const childId = state.getActionId(action);
    // Only add if both nodes exist in the graph
    if (actionById.has(parentId)) {
      edges.push({
        from: parentId,
        to: childId,
        cells: [],
        edgeType: "parent",
      });
    }
  }

  // Add inactive nodes for actions that have stats but are no longer registered
  // This preserves visibility of actions that were unsubscribed
  for (const [actionId, stats] of state.actionStats) {
    if (!actionById.has(actionId)) {
      nodes.push({
        id: actionId,
        type: "inactive",
        stats,
        isDirty: false,
        isPending: false,
      });
    }
  }

  return {
    nodes,
    edges,
    timestamp: now,
  };
}

function isInvalidAction(nodes: NodeRegistry, action: Action): boolean {
  const record = nodes.get(action);
  return record?.status === "invalid" || record?.status === "never-ran";
}

/**
 * Finds the cell IDs that create a dependency between producer and consumer.
 */
export function findOverlappingCells(
  state: Pick<
    SchedulerGraphSnapshotState,
    "dependencies" | "getSchedulingWrites" | "scopeKeyIdentity"
  >,
  producer: Action,
  consumer: Action,
): string[] {
  const producerWrites = state.getSchedulingWrites(producer) ?? [];
  const consumerDeps = state.dependencies.get(consumer);
  if (!consumerDeps) return [];

  const identity = state.scopeKeyIdentity();
  const overlapping: string[] = [];
  for (const write of producerWrites) {
    for (const read of [...consumerDeps.reads, ...consumerDeps.shallowReads]) {
      if (
        write.space === read.space &&
        write.id === read.id &&
        normalizeCellScope(write.scope) === normalizeCellScope(read.scope) &&
        arraysOverlap(write.path, read.path)
      ) {
        overlapping.push(entityKey(write, identity));
      }
    }
  }
  return [...new Set(overlapping)]; // Deduplicate
}

// Diagnostic label, per instance like every other in-memory identity key
// (key-vocabulary.md §1 site 9): a per-instance graph would otherwise
// render N indistinguishable rows, which is how a fan-out bug hides.
function formatAddress(
  address: IMemorySpaceAddress,
  identity: ScopeKeyIdentity,
): string {
  // An address that NAMES its instance (`scopeKey`, server-execution v2
  // stage A — a served per-instance run's logged read) renders that
  // instance; the runtime's identity resolves the rest, as before.
  return `${address.space}/${address.id}/${
    address.scopeKey ?? resolveScopeKey(address.scope, identity)
  }/${address.path.join("/")}`;
}
