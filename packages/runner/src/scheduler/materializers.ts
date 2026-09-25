import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import { sortAndCompactPaths } from "../reactive-dependencies.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import { toMemorySpaceAddress } from "../link-utils.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import { entityNameKey } from "./keys.ts";
import { forEachOverlappingWriter } from "./scheduling-writes.ts";
import type { Action, ReactivityLog, SpaceScopeAndURI } from "./types.ts";

export interface MaterializerIndexState {
  /** Identity entity keys resolve scoped addresses against (keys.ts). */
  readonly scopeKeyIdentity: () => ScopeKeyIdentity;

  readonly materializersByEntity: Map<SpaceScopeAndURI, Set<Action>>;
  readonly effects: ReadonlySet<Action>;
  getMaterializerWriteEnvelopes(
    action: Action,
  ): readonly IMemorySpaceAddress[] | undefined;
  isMaterializer(action: Action): boolean;
}

export class SchedulerMaterializers implements MaterializerIndexState {
  readonly materializers = new Set<Action>();
  readonly materializersByEntity = new Map<SpaceScopeAndURI, Set<Action>>();
  readonly #writeEnvelopes = new WeakMap<
    Action,
    IMemorySpaceAddress[]
  >();
  readonly #actionEntities = new WeakMap<
    Action,
    Set<SpaceScopeAndURI>
  >();

  constructor(
    readonly effects: ReadonlySet<Action>,
    /** Identity entity keys resolve scoped addresses against (keys.ts). */
    readonly scopeKeyIdentity: () => ScopeKeyIdentity,
  ) {}

  register(
    action: Action,
    envelopes: readonly NormalizedFullLink[] | undefined,
  ): void {
    this.clearAction(action);
    if (!envelopes || envelopes.length === 0) return;

    this.registerAddresses(action, envelopes.map(toMemorySpaceAddress));
  }

  registerAddresses(
    action: Action,
    envelopes: readonly IMemorySpaceAddress[] | undefined,
  ): void {
    this.clearAction(action);
    if (!envelopes || envelopes.length === 0) return;

    const writes = sortAndCompactPaths([...envelopes]);
    if (writes.length === 0) return;

    this.materializers.add(action);
    this.#writeEnvelopes.set(action, writes);

    const entities = new Set<SpaceScopeAndURI>();
    // Reader→writer TOPOLOGY, keyed by scope NAME (server-execution v2
    // stage A; see entityNameKey): a materializer's envelope covers every
    // instance of its declared surface, so a reader running as any
    // principal must find it. Overlap is decided by name (readsOverlapWrites)
    // as before; only the index key stops resolving an instance.
    for (const write of writes) {
      const entity = entityNameKey(write);
      entities.add(entity);
      let materializers = this.materializersByEntity.get(entity);
      if (!materializers) {
        materializers = new Set<Action>();
        this.materializersByEntity.set(entity, materializers);
      }
      materializers.add(action);
    }
    this.#actionEntities.set(action, entities);
  }

  clearAction(action: Action): void {
    this.materializers.delete(action);
    this.#writeEnvelopes.delete(action);
    const entities = this.#actionEntities.get(action);
    if (!entities) return;

    for (const entity of entities) {
      const materializers = this.materializersByEntity.get(entity);
      materializers?.delete(action);
      if (materializers && materializers.size === 0) {
        this.materializersByEntity.delete(entity);
      }
    }
    this.#actionEntities.delete(action);
  }

  isMaterializer(action: Action): boolean {
    return this.materializers.has(action);
  }

  getMaterializerWriteEnvelopes(
    action: Action,
  ): readonly IMemorySpaceAddress[] | undefined {
    return this.#writeEnvelopes.get(action);
  }
}

/**
 * The materializers, other than effects and `options.exclude`, whose write
 * envelopes overlap one of `log`'s reads, deep reads and shallow reads each
 * under their own overlap rule (see `readsOverlapWrites`). The set iterates in
 * the order the log's reads, deep then shallow, first reach each materializer
 * through the entity index. The work is at most one test of a single read
 * against one materializer's envelopes per (read, indexed materializer) pair.
 */
export function collectMaterializerWritersForLog(
  state: MaterializerIndexState,
  log: ReactivityLog,
  options: { exclude?: Action } = {},
): Set<Action> {
  // A read can only overlap an envelope on its own entity, so testing each
  // read alone against the materializers indexed there finds every overlap.
  // A materializer already found to overlap is filtered out before its test.
  const reached = new Set<Action>();
  const overlapping = new Set<Action>();
  forEachOverlappingWriter(
    {
      writersByEntity: state.materializersByEntity,
      getSchedulingWrites: (action) =>
        state.getMaterializerWriteEnvelopes(action),
    },
    log.reads,
    log.shallowReads,
    (writer) => {
      overlapping.add(writer);
    },
    {
      filter: (writer) =>
        writer !== options.exclude && !state.effects.has(writer) &&
        !overlapping.has(writer),
      onCandidate: (writer) => {
        reached.add(writer);
      },
    },
  );

  // `overlapping` holds each writer in the order its overlap was found;
  // filtering `reached` instead keeps first-reach order.
  for (const writer of reached) {
    if (!overlapping.has(writer)) reached.delete(writer);
  }
  return reached;
}
