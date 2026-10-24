/** Owns renderer demand and local execution eligibility for one client runtime. */

import { valueEqual } from "@commonfabric/data-model";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type {
  ViewInterest,
  ViewPlan,
  ViewValueBasis,
} from "@commonfabric/memory/v2";
import { getLogger } from "@commonfabric/utils/logger";

import type { Cancel } from "./cancel.ts";
import type { Cell } from "./cell.ts";
import { COMPONENT_READ_CONTRACT_VERSION } from "./component-read-contract.ts";
import { type NormalizedFullLink, toMemorySpaceAddress } from "./link-utils.ts";
import {
  getPatternIdentityRef,
  patternIdentityKey,
  type ViewPieceRegistration,
} from "./runner.ts";
import type { Runtime } from "./runtime.ts";
import { entityNameKey } from "./scheduler/keys.ts";
import { forEachOverlappingWriter } from "./scheduler/scheduling-writes.ts";
import type { ReactivityLog, SpaceScopeAndURI } from "./scheduler/types.ts";
import { rendererVDOMSchema } from "./schemas.ts";
import type {
  IMemorySpaceAddress,
  ISpaceReplica,
  ViewInterestLease,
} from "./storage/interface.ts";
import { restrictToLocalReads } from "./storage/local-read-policy.ts";
import { ViewInputBasisCache } from "./view-input-basis.ts";
import { hasInlineCellScheme } from "./immutable-cell.ts";

type ViewProducer = NonNullable<ViewPlan["producers"]>[number];

const logger = getLogger("view-replication", { enabled: true, level: "warn" });

type SpaceViews = {
  replica: ISpaceReplica;
  views: Map<string, ViewInterest>;
  lease: ViewInterestLease;
  retired: PromiseWithResolvers<void>;
  roots: Map<string, Cell<unknown>>;
  errorHandlers: Map<string, (error: Error) => void>;
  fallback: boolean;
  plans: readonly ViewPlan[];
  eligible: Set<string>;
  inputs: Set<SpaceScopeAndURI>;
  producers: Map<string, ViewProducer>;
  producerWrites: Map<string, IMemorySpaceAddress[]>;
  writersByEntity: Map<SpaceScopeAndURI, Set<string>>;
  pieces: Map<string, ViewPieceRegistration>;
  installing: Promise<void>;
  cancelCoverage: Cancel;
  version: number;
  cancelPlans: Cancel;
};

/** Registers each renderer independently on its tab's own authenticated replica. */
export class ViewReplicationClient {
  #runtime: Runtime;
  #spaces = new Map<MemorySpace, SpaceViews>();
  #enabling = new Map<MemorySpace, Promise<boolean>>();
  #disposed = false;
  #inputBasis = new ViewInputBasisCache();

  /** Binds view lifetimes to the runtime that owns their graphs. */
  constructor(runtime: Runtime) {
    this.#runtime = runtime;
  }

  /** Negotiates the requested client-class mode before ordinary piece startup. */
  async enable(space: MemorySpace): Promise<boolean> {
    if (this.#disposed || !this.#runtime.viewScopedReplicationRequested) {
      return false;
    }
    if (this.#spaces.has(space)) return this.active(space);
    const pending = this.#enabling.get(space);
    if (pending !== undefined) return await pending;
    const enabling = (async () => {
      const replica = this.#runtime.storageManager.open(space).replica;
      if (
        await replica.supportsViewReplication?.() !== true || this.#disposed ||
        replica.acquireViewInterests === undefined
      ) return false;
      const lease = replica.acquireViewInterests(() =>
        this.#retire(space, state)
      );
      const state: SpaceViews = {
        replica,
        views: new Map(),
        lease,
        retired: Promise.withResolvers<void>(),
        roots: new Map(),
        errorHandlers: new Map(),
        fallback: false,
        plans: [],
        eligible: new Set(),
        inputs: new Set(),
        producers: new Map(),
        producerWrites: new Map(),
        writersByEntity: new Map(),
        pieces: new Map(),
        version: 0,
        cancelPlans: () => {},
        cancelCoverage: () => {},
        installing: Promise.resolve(),
      };
      this.#spaces.set(space, state);
      state.cancelPlans = replica.subscribeViewPlans!((plans) =>
        this.#accept(space, state, plans)
      );
      state.cancelCoverage = replica.subscribeLocalCoverage?.(() => {
        this.#runtime.scheduler.wakeViewReplication(space, { parked: false });
        this.#install(space, state);
      }) ?? (() => {});
      try {
        await lease.set([]);
      } catch (error) {
        this.#retire(space, state);
        lease.release();
        throw error;
      }
      return this.active(space);
    })();
    this.#enabling.set(space, enabling);
    try {
      return await enabling;
    } finally {
      this.#enabling.delete(space);
    }
  }

  /** Whether ordinary graph startup must use the stored graph registration path. */
  active(space: MemorySpace): boolean {
    const state = this.#spaces.get(space);
    return !this.#disposed && state !== undefined && !state.fallback &&
      state.lease.isCurrent() &&
      state.replica.viewReplicationSupported?.() === true;
  }

  /** Current local eligibility; separate from the currency of a displayed value. */
  eligible(space: MemorySpace, id: string): boolean {
    return this.active(space) && this.#spaces.get(space)!.eligible.has(id);
  }

  /** Generation fence captured by a local transaction before its first read. */
  version(space: MemorySpace): number {
    return this.#spaces.get(space)?.version ?? 0;
  }

  /** Adds one mounted view and returns the cancellation for exactly that mount. */
  async mount(
    cell: Cell<unknown>,
    id: string,
    onError?: (error: Error) => void,
  ): Promise<Cancel | undefined> {
    const link = cell.getAsNormalizedFullLink();
    if (!await this.enable(link.space)) return undefined;
    const state = this.#spaces.get(link.space);
    if (state === undefined || !state.lease.isCurrent()) return undefined;
    const interest: ViewInterest = {
      id,
      revision: state.lease.nextRevision(),
      query: {
        roots: [{
          id: link.id,
          scope: link.scope,
          selector: { path: link.path, schema: rendererVDOMSchema },
        }],
      },
      mode: "speculate",
      componentContractVersion: COMPONENT_READ_CONTRACT_VERSION,
    };
    state.views.set(id, interest);
    if (onError !== undefined) state.errorHandlers.set(id, onError);
    else state.errorHandlers.delete(id);
    state.roots.set(id, this.#runtime.getCellFromLink({ ...link, path: [] }));
    this.#accept(
      link.space,
      state,
      state.plans.filter((plan) => plan.id !== id),
    );
    const cancel = () => {
      if (state.views.get(id) !== interest) return;
      state.views.delete(id);
      state.errorHandlers.delete(id);
      state.roots.delete(id);
      this.#accept(
        link.space,
        state,
        state.plans.filter((plan) => plan.id !== id),
      );
      this.#runtime.scheduler.trackBackgroundTask(
        Promise.race([
          state.lease.set(state.fallback ? [] : [...state.views.values()]),
          state.retired.promise,
        ]),
      );
    };
    try {
      await state.lease.set([...state.views.values()]);
    } catch (error) {
      cancel();
      throw error;
    }
    if (this.#disposed) return () => {};
    return cancel;
  }

  /** Rejects cached documents that are outside the admitted view input union. */
  permits(address: IMemorySpaceAddress): boolean {
    if (hasInlineCellScheme(address.id)) return true;
    const state = this.#spaces.get(address.space);
    return state?.inputs.has(entityNameKey(address)) ?? false;
  }

  /** Observed writers supplement structural bindings, including redirect targets. */
  producers(address: IMemorySpaceAddress): Set<string> {
    const result = new Set<string>();
    const state = this.#spaces.get(address.space);
    if (state === undefined) return result;
    forEachOverlappingWriter(
      {
        writersByEntity: state.writersByEntity,
        getSchedulingWrites: (id: string) => state.producerWrites.get(id),
      },
      [address],
      [],
      (id) => {
        result.add(id);
      },
    );
    return result;
  }

  /** Accepts an unchanged authoritative output, including its producer ancestors. */
  producerCurrent(
    space: MemorySpace,
    id: string,
    localCurrent: (id: string) => boolean,
    observe: (address: IMemorySpaceAddress) => void,
  ): boolean {
    return this.createProducerCheck(space, localCurrent, observe)(id);
  }

  /** Checks multiple producers within one synchronous read-validation pass. */
  createProducerCheck(
    space: MemorySpace,
    localCurrent: (id: string) => boolean,
    observe: (address: IMemorySpaceAddress) => void,
  ): (id: string) => boolean {
    const state = this.#spaces.get(space);
    if (state === undefined || !this.active(space)) return () => false;
    const producers = state.producers;
    // A proof is synchronous. Its memo belongs to this pass so a later read
    // or commit rechecks both replica values and local producer state.
    const checked = new Map<string, boolean>();
    const visiting = new Set<string>();
    const matches = (basis: ViewValueBasis) => {
      const uri = basis.id as IMemorySpaceAddress["id"];
      if (state.replica.hasLocalDocumentCoverage?.(uri, basis.scope) !== true) {
        return state.replica.speculationRetirementView?.(uri, basis.scope)
          .pendingLocalSeqs.length === 0;
      }
      return this.#inputBasis.matches(
        state.replica.getDocument(uri, basis.scope),
        basis,
      );
    };
    const current = (producerId: string): boolean => {
      const known = checked.get(producerId);
      if (known !== undefined) return known;
      const result = check(producerId);
      checked.set(producerId, result);
      return result;
    };
    const check = (producerId: string): boolean => {
      if (localCurrent(producerId)) return true;
      const producer = producers.get(producerId);
      if (producer?.basis === undefined || visiting.has(producerId)) {
        return false;
      }
      visiting.add(producerId);
      for (
        const value of [...producer.basis.reads, ...producer.basis.outputs]
      ) {
        observe({
          ...value,
          id: value.id as IMemorySpaceAddress["id"],
          space,
          type: "application/json",
        });
      }
      try {
        if (
          !producer.basis.outputs.every(matches) ||
          !producer.basis.reads.every(matches)
        ) return false;
        for (const read of producer.basis.reads) {
          const address = {
            ...read,
            id: read.id as IMemorySpaceAddress["id"],
            space,
            type: "application/json" as const,
          };
          for (const ancestor of this.producers(address)) {
            if (ancestor !== producerId && !current(ancestor)) return false;
          }
        }
        return true;
      } finally {
        visiting.delete(producerId);
      }
    };
    return current;
  }

  /**
   * Collects the complete wake basis for an initially current computation.
   * Its own values must be resident; omitted ancestors use the server proof.
   */
  initialViewDependencies(
    piece: NormalizedFullLink,
    id: string,
    expectedIdentity: string,
  ): ReactivityLog | undefined {
    const state = this.#spaces.get(piece.space);
    const basis = state?.producers.get(id)?.basis;
    if (
      state === undefined || basis === undefined ||
      !this.eligible(piece.space, id)
    ) return undefined;
    const generation = state.version;
    const reads: IMemorySpaceAddress[] = [];
    const observe = (address: IMemorySpaceAddress) => reads.push(address);
    if (!this.pieceCurrent(piece, expectedIdentity, observe)) return undefined;
    if (
      basis.reads.some((value) =>
        !this.permits({
          ...value,
          id: value.id as IMemorySpaceAddress["id"],
          space: piece.space,
          type: "application/json",
        })
      )
    ) return undefined;
    for (const value of [...basis.reads, ...basis.outputs]) {
      if (hasInlineCellScheme(value.id)) continue;
      if (
        state.replica.hasLocalDocumentCoverage?.(
          value.id as IMemorySpaceAddress["id"],
          value.scope,
        ) !== true
      ) return undefined;
    }
    // Server provenance must remain independent of successful local outcomes.
    // Each node collects its own closure, including shared ancestors.
    if (
      !this.producerCurrent(piece.space, id, () => false, observe) ||
      state.version !== generation || !this.active(piece.space)
    ) return undefined;
    return {
      reads,
      shallowReads: [],
      writes: [...(state.producerWrites.get(id) ?? [])],
    };
  }

  /** Checks the stored source against the manifest without acquiring a watch. */
  pieceCurrent(
    piece: NormalizedFullLink,
    expectedIdentity?: string,
    observe?: (address: IMemorySpaceAddress) => void,
  ): boolean {
    const planned = this.#currentPlans(this.#spaces.get(piece.space)).flatMap((
      plan,
    ) => plan.pieces)
      .find((candidate) =>
        candidate.id === piece.id && candidate.scope === piece.scope
      );
    if (
      planned?.patternIdentity === undefined ||
      (expectedIdentity !== undefined &&
        planned.patternIdentity !== expectedIdentity)
    ) return false;
    const tx = this.#runtime.readTx();
    restrictToLocalReads(tx.tx);
    try {
      const ref = getPatternIdentityRef(
        this.#runtime.getCellFromLink(piece, undefined, tx),
      );
      observe?.({ ...toMemorySpaceAddress(piece), path: ["patternIdentity"] });
      return ref !== undefined &&
        patternIdentityKey(ref) === planned.patternIdentity;
    } catch {
      return false;
    } finally {
      tx.clearReadOnly?.();
      tx.abort("view source identity check complete");
    }
  }

  /** Releases server demand and every graph installed for local previews. */
  dispose(): void {
    this.#disposed = true;
    for (const [space, state] of this.#spaces) {
      this.#retire(space, state);
      state.lease.release();
    }
  }

  #retire(space: MemorySpace, state: SpaceViews): void {
    if (this.#spaces.get(space) !== state) return;
    this.#spaces.delete(space);
    state.version++;
    state.retired.resolve();
    state.views.clear();
    state.roots.clear();
    state.errorHandlers.clear();
    state.cancelPlans();
    state.cancelCoverage();
    for (const cancel of state.pieces.values()) cancel();
    state.pieces.clear();
  }

  #currentPlans(state: SpaceViews | undefined): readonly ViewPlan[] {
    return state?.plans.filter((plan) =>
      state.views.get(plan.id)?.revision === plan.revision
    ) ?? [];
  }

  #accept(
    space: MemorySpace,
    state: SpaceViews,
    plans: readonly ViewPlan[],
  ): void {
    plans = plans.map((plan) => {
      const previous = state.plans.find((candidate) =>
        candidate.id === plan.id && candidate.revision === plan.revision
      );
      return previous !== undefined && previous.generation > plan.generation
        ? previous
        : plan;
    });
    if (this.#disposed || this.#spaces.get(space) !== state || state.fallback) {
      return;
    }
    if (
      state.replica.viewReplicationSupported?.() === true &&
      valueEqual(state.plans, plans)
    ) return;
    const previousPlans = state.plans;
    state.plans = plans;
    state.version++;
    if (state.replica.viewReplicationSupported?.() !== true) {
      state.eligible.clear();
      for (const cancel of state.pieces.values()) cancel();
      state.pieces.clear();
      if (!state.fallback) {
        state.fallback = true;
        const fallback = async () => {
          await state.replica.whenSessionRestored?.();
          for (const [id, root] of state.roots) {
            if (this.#disposed || state.roots.get(id) !== root) continue;
            try {
              await root.sync();
              if (this.#disposed || state.roots.get(id) !== root) continue;
              await this.#runtime.start(root);
            } catch (error) {
              if (this.#disposed || state.roots.get(id) !== root) continue;
              this.#reportError(
                state,
                id,
                error instanceof Error ? error : new Error(String(error)),
              );
            }
          }
        };
        this.#runtime.scheduler.trackBackgroundTask(
          Promise.race([fallback(), state.retired.promise]),
        );
      }
      return;
    }
    const current = this.#currentPlans(state);
    for (const plan of current) {
      const previous = previousPlans.find((candidate) =>
        candidate.id === plan.id && candidate.revision === plan.revision
      );
      for (const failure of plan.errors ?? []) {
        if (previous?.errors?.some((error) => valueEqual(error, failure))) {
          continue;
        }
        const { nodeId: _nodeId, message, ...context } = failure;
        this.#reportError(
          state,
          plan.id,
          Object.assign(new Error(message), context, { space }),
        );
      }
    }
    state.inputs.clear();
    state.producers.clear();
    state.producerWrites.clear();
    state.writersByEntity.clear();
    for (const plan of current) {
      for (const input of plan.inputs ?? []) {
        state.inputs.add(entityNameKey({
          ...input,
          id: input.id as IMemorySpaceAddress["id"],
          space,
        }));
      }
      for (const producer of plan.producers ?? []) {
        state.producers.set(producer.id, producer);
        const writes = state.producerWrites.get(producer.id) ?? [];
        for (const write of producer.writes) {
          const address: IMemorySpaceAddress = {
            ...write,
            id: write.id as IMemorySpaceAddress["id"],
            space,
            type: "application/json",
          };
          writes.push(address);
          const entity = entityNameKey(address);
          let writers = state.writersByEntity.get(entity);
          if (writers === undefined) {
            writers = new Set();
            state.writersByEntity.set(entity, writers);
          }
          writers.add(producer.id);
        }
        state.producerWrites.set(producer.id, writes);
      }
    }
    state.eligible = new Set(current.flatMap((plan) => plan.eligibleActions));
    this.#runtime.scheduler.wakeViewReplication(space);
    this.#install(space, state);
  }

  #reportError(state: SpaceViews, id: string, error: Error): void {
    const handler = state.errorHandlers.get(id);
    if (handler === undefined) {
      logger.warn("view-error", () => [error]);
      return;
    }
    try {
      handler(error);
    } catch (cause) {
      logger.warn("view-error-handler", () => [
        "A view error callback failed",
        cause,
      ]);
    }
  }

  #install(space: MemorySpace, state: SpaceViews): void {
    const version = state.version;
    const isCurrent = () =>
      this.active(space) && this.#spaces.get(space) === state &&
      state.version === version;
    const install = async () => {
      if (!isCurrent()) return;
      const pieces = new Map(
        this.#currentPlans(state).flatMap((plan) => plan.pieces).map((
          piece,
        ) => [
          `${piece.scope}\0${piece.id}\0${piece.patternIdentity ?? ""}`,
          piece,
        ]),
      );
      for (const [key, cancel] of state.pieces) {
        if (pieces.has(key) && cancel.resume()) continue;
        cancel();
        state.pieces.delete(key);
      }
      for (const [key, piece] of pieces) {
        if (!isCurrent()) return;
        if (state.pieces.has(key) || piece.patternIdentity === undefined) {
          continue;
        }
        const link: NormalizedFullLink = {
          space,
          id: piece.id as NormalizedFullLink["id"],
          scope: piece.scope,
          path: [],
        };
        const cancel = await this.#runtime.runner.startViewPiece(
          this.#runtime.getCellFromLink(link),
          piece.patternIdentity,
          isCurrent,
        );
        if (cancel === undefined) continue;
        if (!isCurrent()) cancel();
        else state.pieces.set(key, cancel);
      }
    };
    state.installing = state.installing.then(install, install);
    this.#runtime.scheduler.trackBackgroundTask(
      Promise.race([state.installing, state.retired.promise]),
    );
  }
}
