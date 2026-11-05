import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import {
  arraysOverlap,
  nonRecursiveReadMayOverlapWrite,
} from "../reactive-dependencies.ts";
import { normalizeCellScope } from "../scope.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import { entityNameKey } from "./keys.ts";
import type { Action, SpaceScopeAndURI } from "./types.ts";

export interface WriterIndexState {
  /** Identity entity keys resolve scoped addresses against (keys.ts). */
  readonly scopeKeyIdentity: () => ScopeKeyIdentity;

  readonly writersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
  readonly actionWriteEntities: WeakMap<Action, Set<SpaceScopeAndURI>>;
  setSurface(action: Action, surface: IMemorySpaceAddress[]): void;
  updateWriterIndex(
    action: Action,
    nextSchedulingWrites: readonly IMemorySpaceAddress[],
  ): {
    nextEntities: Set<SpaceScopeAndURI>;
    addedEntities: Set<SpaceScopeAndURI>;
    removedEntities: Set<SpaceScopeAndURI>;
  };
  clearAction(action: Action): void;
}

export interface SchedulingWriteState {
  readonly currentKnownWrites: WeakMap<Action, IMemorySpaceAddress[]>;
  getSchedulingWrites(action: Action): IMemorySpaceAddress[] | undefined;
  getSchedulingWritesMap(): WeakMap<Action, IMemorySpaceAddress[]>;
}

export class SchedulerWriteIndex
  implements WriterIndexState, SchedulingWriteState {
  constructor(
    /** Identity entity keys resolve scoped addresses against (keys.ts). */
    readonly scopeKeyIdentity: () => ScopeKeyIdentity,
  ) {}

  /** Current-known writes: each action's static declared write surface. */
  readonly currentKnownWrites = new WeakMap<Action, IMemorySpaceAddress[]>();

  /**
   * Index: entity → actions that write to it (for fast dependency lookup).
   * Updated from the active scheduling write set. Keyed by scope _name_
   * (`entityNameKey()`, the instance-_agnostic_ writer index): the
   * reader→writer relation is a _node_-level topology relation — one node
   * writes _all_ instances of its declared surface — so a reader whose logged
   * read names one principal's instance must still find the writer whose
   * surface declares the scope by name. An instance-keyed index would drop that
   * edge the moment reads carry non-own instances. Cost of the fan-in: any
   * instance's change re-dirties the (singular) node, so all N instances re-run
   * — O(N) per input change, equality cutoffs absorb the unchanged siblings;
   * instance-precise dirtiness is never a correctness need here
   * (dirtiness/dependency keys stay per instance via `entityKey()`).
   */
  readonly writersByEntity = new Map<SpaceScopeAndURI, Set<Action>>();

  /** Reverse index: action → entities it writes to (for cleanup). */
  readonly actionWriteEntities = new WeakMap<
    Action,
    Set<SpaceScopeAndURI>
  >();

  getSchedulingWrites(action: Action): IMemorySpaceAddress[] | undefined {
    return this.currentKnownWrites.get(action);
  }

  getSchedulingWritesMap(): WeakMap<Action, IMemorySpaceAddress[]> {
    return this.currentKnownWrites;
  }

  /** Registers the action's static write surface (idempotent). */
  setSurface(action: Action, surface: IMemorySpaceAddress[]): void {
    this.currentKnownWrites.set(action, surface);
    this.updateWriterIndex(action, surface);
  }

  updateWriterIndex(
    action: Action,
    nextSchedulingWrites: readonly IMemorySpaceAddress[],
  ): {
    nextEntities: Set<SpaceScopeAndURI>;
    addedEntities: Set<SpaceScopeAndURI>;
    removedEntities: Set<SpaceScopeAndURI>;
  } {
    const existingEntities = this.actionWriteEntities.get(action) ?? new Set();
    const nextEntities = new Set<SpaceScopeAndURI>();
    const addedEntities = new Set<SpaceScopeAndURI>();
    const removedEntities = new Set<SpaceScopeAndURI>();

    for (const write of nextSchedulingWrites) {
      const entity = entityNameKey(write);
      nextEntities.add(entity);
      if (!existingEntities.has(entity)) {
        addedEntities.add(entity);
      }
    }

    for (const entity of existingEntities) {
      if (!nextEntities.has(entity)) {
        removedEntities.add(entity);
      }
    }

    for (const entity of removedEntities) {
      const writers = this.writersByEntity.get(entity);
      writers?.delete(action);
      if (writers && writers.size === 0) {
        this.writersByEntity.delete(entity);
      }
    }

    for (const entity of addedEntities) {
      let writers = this.writersByEntity.get(entity);
      if (!writers) {
        writers = new Set();
        this.writersByEntity.set(entity, writers);
      }
      writers.add(action);
    }

    this.actionWriteEntities.set(action, nextEntities);
    if (addedEntities.size > 0 || removedEntities.size > 0) {
      this.onWriterEntitiesChanged?.(action, addedEntities, removedEntities);
    }
    return { nextEntities, addedEntities, removedEntities };
  }

  /** (d′) — the REGISTRATION hook for the standing
   * `demandedWriters` root kind (design §2.4: "a writer that registers
   * AFTER its output is demanded must consult the demanded set on
   * registration … unregistration releases"). Fired with the entities a
   * writer's surface gained and lost; the facade consults its demanded
   * entity set and brackets the root transition. Undefined off the
   * serving posture (never installed). */
  onWriterEntitiesChanged:
    | ((
      action: Action,
      added: ReadonlySet<SpaceScopeAndURI>,
      removed: ReadonlySet<SpaceScopeAndURI>,
    ) => void)
    | undefined;

  clearAction(action: Action): void {
    const writeEntities = this.actionWriteEntities.get(action);
    if (!writeEntities) return;

    for (const entity of writeEntities) {
      const writers = this.writersByEntity.get(entity);
      writers?.delete(action);
      if (writers && writers.size === 0) {
        this.writersByEntity.delete(entity);
      }
    }
    // Clear actionWriteEntities so resubscribe will re-register the action.
    this.actionWriteEntities.delete(action);
    this.onWriterEntitiesChanged?.(action, new Set(), writeEntities);
  }
}

export function getSchedulingWrites(
  state: SchedulingWriteState,
  action: Action,
): IMemorySpaceAddress[] | undefined {
  return state.getSchedulingWrites(action);
}

export function getSchedulingWritesMap(
  state: SchedulingWriteState,
): WeakMap<Action, IMemorySpaceAddress[]> {
  return state.getSchedulingWritesMap();
}

export function updateWriterIndex(
  state: WriterIndexState,
  action: Action,
  nextSchedulingWrites: readonly IMemorySpaceAddress[],
): {
  nextEntities: Set<SpaceScopeAndURI>;
  addedEntities: Set<SpaceScopeAndURI>;
  removedEntities: Set<SpaceScopeAndURI>;
} {
  return state.updateWriterIndex(action, nextSchedulingWrites);
}

export function readsOverlapWrites(
  reads: readonly IMemorySpaceAddress[],
  shallowReads: readonly IMemorySpaceAddress[],
  writes: readonly IMemorySpaceAddress[],
): boolean {
  for (const read of reads) {
    for (const write of writes) {
      if (
        read.space === write.space &&
        read.id === write.id &&
        normalizeCellScope(read.scope) === normalizeCellScope(write.scope) &&
        arraysOverlap(write.path, read.path)
      ) {
        return true;
      }
    }
  }

  // For non-recursive reads, only same/ancestor path or direct child writes
  // create a dependency. Deep descendant writes cannot affect shallow structure.
  for (const read of shallowReads) {
    for (const write of writes) {
      if (
        read.space === write.space &&
        read.id === write.id &&
        normalizeCellScope(read.scope) === normalizeCellScope(write.scope) &&
        nonRecursiveReadMayOverlapWrite(read.path, write.path)
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Visit every writer whose write surface overlaps one of `reads` /
 * `shallowReads`, via the writersByEntity index: the entity-pruned overlap
 * scan, testing each read alone against the writers indexed on its entity.
 * Call-site policy (which writers qualify, dedup, early exit) stays in the
 * visitor.
 *
 * `filter` is the cheap pre-overlap writer filter; `onCandidate` fires once
 * per (read, surviving writer) pair before the overlap test (trace
 * bookkeeping). `visit` may be called more than once for the same writer
 * (once per matching read) — visitors dedupe via their own set; returning
 * true stops the whole scan.
 */
export function forEachOverlappingWriter<Writer = Action>(
  state: {
    readonly scopeKeyIdentity?: () => ScopeKeyIdentity;
    readonly writersByEntity: ReadonlyMap<
      SpaceScopeAndURI,
      ReadonlySet<Writer>
    >;
    readonly getSchedulingWrites: (
      action: Writer,
    ) => readonly IMemorySpaceAddress[] | undefined;
  },
  reads: readonly IMemorySpaceAddress[],
  shallowReads: readonly IMemorySpaceAddress[],
  visit: (writer: Writer) => boolean | void,
  hooks: {
    readonly filter?: (writer: Writer) => boolean;
    readonly onCandidate?: (writer: Writer) => void;
  } = {},
): void {
  const scan = (
    read: IMemorySpaceAddress,
    shallow: boolean,
  ): boolean => {
    // Looked up by NAME (see writersByEntity): the read's instance is
    // irrelevant to WHICH node writes the doc.
    const writers = state.writersByEntity.get(entityNameKey(read));
    if (!writers) return false;
    for (const writer of writers) {
      if (hooks.filter && !hooks.filter(writer)) continue;
      hooks.onCandidate?.(writer);
      const writes = state.getSchedulingWrites(writer) ?? [];
      const overlaps = shallow
        ? readsOverlapWrites([], [read], writes)
        : readsOverlapWrites([read], [], writes);
      if (overlaps && visit(writer) === true) return true;
    }
    return false;
  };
  for (const read of reads) {
    if (scan(read, false)) return;
  }
  for (const read of shallowReads) {
    if (scan(read, true)) return;
  }
}
