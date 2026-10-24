/** Publishes observed view inputs after a serving wave has settled. */

import { valueEqual } from "@commonfabric/data-model";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type {
  ScopeKeyIdentity,
  ViewPlan,
  ViewQuery,
} from "@commonfabric/memory/v2";
import type { Server } from "@commonfabric/memory/v2/server";
import { getLogger } from "@commonfabric/utils/logger";
import { PathKeyMap } from "@commonfabric/utils/path-key-map";

import { COMPONENT_READ_CONTRACT_VERSION } from "../component-read-contract.ts";
import {
  areNormalizedLinksSame,
  getMetaCell,
  getMetaLink,
} from "../link-utils.ts";
import { sortAndCompactPaths } from "../reactive-dependencies.ts";
import { getPatternIdentityRef, patternIdentityKey } from "../runner.ts";
import type { Runtime } from "../runtime.ts";
import { txToReactivityLog } from "../scheduler/reactivity.ts";
import type {
  IMemorySpaceAddress,
  IStorageNotification,
  TransactionReactivityLog,
} from "../storage/interface.ts";
import { viewInputBasis } from "../view-input-basis.ts";
import {
  collectViewRenderReads,
  type ViewRenderReads,
} from "../view-render-reads.ts";
import {
  ViewDependencyGraph,
  type ViewExecutionNode,
} from "../view-replication.ts";
import { ViewReadCache } from "./view-read-cache.ts";
import { hasInlineCellScheme } from "../immutable-cell.ts";

const logger = getLogger("view-replication");
type Selection = Omit<ViewPlan, "id" | "revision" | "generation"> & {
  delivery: ViewQuery[];
};

/** Independent invalidation of rendered reads and execution-dependent output. */
type CachedView = {
  render: ViewReadCache<ViewRenderReads>;
  selection: ViewReadCache<true>;
  execution?: ViewExecutionNode[];
};

/** Keeps unchanged selections stable while expiring every removed view lifetime. */
export class ViewPlanPublisher {
  #published = new Map<string, Selection>();
  #views = new Map<string, CachedView>();
  #runtime: Runtime | undefined;
  #subscription: IStorageNotification = {
    next: (notification) => {
      for (const view of this.#views.values()) {
        view.render.notify(notification);
        view.selection.notify(notification);
      }
      return { done: false };
    },
  };

  /** Releases cached read dependencies with the serving runtime's lifetime. */
  dispose(): void {
    this.#runtime?.storageManager.unsubscribe?.(this.#subscription);
    this.#runtime = undefined;
    this.#views.clear();
    this.#published.clear();
  }

  /** Selects actual reads under each viewing identity and publishes complete roots. */
  async publish(
    runtime: Runtime,
    server: Server,
    space: MemorySpace,
  ): Promise<void> {
    if (this.#runtime !== runtime) {
      this.dispose();
      this.#runtime = runtime;
      runtime.storageManager.subscribe(this.#subscription);
    }
    const live = new Set<string>();
    const interests = server.viewInterestsForSpace(space);
    runtime.scheduler.setViewConsumers(
      space,
      interests.map((interest) => ({
        principal: interest.principal,
        sessionId: interest.handle.sessionId as ScopeKeyIdentity["sessionId"],
      })),
    );
    for (const interest of interests) {
      const { handle, view, principal } = interest;
      const key = `${handle.sessionEpoch}\0${handle.viewEpoch}`;
      live.add(key);
      if (!interest.attached) {
        logger.debug("detached-view", "Deferring planning for a detached view");
        continue;
      }
      if (
        principal === undefined ||
        view.componentContractVersion !== COMPONENT_READ_CONTRACT_VERSION
      ) continue;
      const identity: ScopeKeyIdentity = {
        principal,
        sessionId: handle.sessionId as ScopeKeyIdentity["sessionId"],
      };
      let cache = this.#views.get(key);
      if (cache === undefined) {
        cache = {
          render: new ViewReadCache(identity),
          selection: new ViewReadCache(identity),
        };
        this.#views.set(key, cache);
      }
      let planStart: number | undefined;
      try {
        const snapshotStart = performance.now();
        const observed = runtime.scheduler.viewExecutionNodes(space, identity);
        // Scheduler observations replace logs and write surfaces when they
        // change. Compare those identities plus the current outcome fields;
        // document values invalidate through the read caches independently.
        const sameExecution = cache.execution?.length === observed.length &&
          observed.every((node, index) => {
            const previous = cache.execution![index];
            return previous.id === node.id && previous.kind === node.kind &&
              previous.current === node.current &&
              previous.error === node.error &&
              previous.piece === node.piece &&
              previous.stream === node.stream &&
              previous.log === node.log && previous.writes === node.writes;
          });
        logger.time(snapshotStart, "snapshot");
        if (
          cache.render.value !== undefined &&
          cache.selection.value !== undefined && sameExecution
        ) continue;
        planStart = performance.now();
        let render = cache.render.value;
        if (render === undefined) {
          const renderStart = performance.now();
          render = collectViewRenderReads(runtime, space, view, identity);
          cache.render.set(render, render);
          logger.time(renderStart, "render");
        }
        const handlers = new Set(
          observed.filter((node) =>
            node.stream !== undefined &&
            render.streams.some((stream) =>
              areNormalizedLinksSame(node.stream!, stream)
            )
          ).map((node) => node.id),
        );
        // A cross-space dependency requires its own authorized view subscription.
        const candidates = observed.filter((node) =>
          [...node.log.reads, ...node.log.shallowReads].every((read) =>
            read.space === space
          )
        );
        const graph = new ViewDependencyGraph(candidates);
        const selected = graph.select(
          render.reads,
          view.mode === "speculate" ? render.bindings : [],
          view.mode === "speculate" ? handlers : new Set(),
          render.shallowReads,
        );
        const roots = new PathKeyMap<ViewQuery["roots"][number]>();
        const addRoot = (
          id: string,
          scope: ViewQuery["roots"][number]["scope"] = "space",
        ) => {
          if (hasInlineCellScheme(id)) return;
          roots.set([scope ?? "space", id], {
            id,
            scope,
            selector: { path: [], schema: false },
          });
        };
        for (const read of selected.reads) {
          if (read.space === space) addRoot(read.id, read.scope);
        }
        const pieces = new PathKeyMap<ViewPlan["pieces"][number]>();
        const tx = runtime.readTx();
        tx.tx.scopeKeyIdentity = identity;
        let metadataReads: TransactionReactivityLog;
        try {
          for (const link of selected.pieces) {
            addRoot(link.id, link.scope);
            const piece = runtime.getCellFromLink(link, undefined, tx);
            const ref = getPatternIdentityRef(piece);
            pieces.set([link.scope ?? "space", link.id], {
              id: link.id,
              scope: link.scope,
              ...(ref === undefined
                ? {}
                : { patternIdentity: patternIdentityKey(ref) }),
            });
            for (const field of ["argument", "internal"] as const) {
              const metadata = field === "internal"
                ? getMetaCell(piece, field, tx).getAsNormalizedFullLink()
                : getMetaLink(piece, field, {});
              if (metadata?.space === space) {
                addRoot(metadata.id, metadata.scope);
              }
            }
          }
          metadataReads = txToReactivityLog(tx);
        } finally {
          tx.clearReadOnly?.();
          tx.abort("view registration metadata read complete");
        }
        const inputs = [...roots.entries()].map(([, root]) => ({
          id: root.id,
          scope: root.scope ?? "space" as const,
        }));
        const producers = candidates.filter((node) =>
          node.kind === "computation"
        );
        const producerGraph = new ViewDependencyGraph(
          producers,
          (node) => [...node.writes, ...node.log.writes],
        );
        const ancestors = producerGraph.ancestors(inputs.map((input) => ({
          ...input,
          id: input.id as IMemorySpaceAddress["id"],
          space,
          type: "application/json",
          path: [],
        })));
        const errorAncestors = graph.ancestors(
          render.reads,
          render.shallowReads,
          (node) => node.kind !== "handler",
        );
        const replica = runtime.storageManager.open(space).replica;
        const addressOf = (address: IMemorySpaceAddress) => ({
          id: address.id,
          scope: address.scope ?? "space" as const,
          path: [...address.path],
        });
        const documentAt = (address: IMemorySpaceAddress) =>
          replica.getDocument(address.id, address.scope, identity);
        const selectedProducers = producers.filter((node) =>
          ancestors.has(node)
        );
        const selection: Selection = {
          delivery: [{ roots: [...roots.entries()].map(([, root]) => root) }],
          eligibleActions: view.mode === "speculate" ? selected.actions : [],
          pieces: [...pieces.entries()].map(([, piece]) => piece),
          errors: candidates.flatMap((node) =>
            errorAncestors.has(node) && node.error !== undefined
              ? [node.error]
              : []
          ),
          inputs,
          producers: selectedProducers.map((
            node,
          ) => ({
            id: node.id,
            writes: sortAndCompactPaths([...node.writes, ...node.log.writes])
              .map(addressOf),
            ...(node.current === true
              ? {
                basis: {
                  reads: viewInputBasis(
                    [...node.log.reads, ...node.log.shallowReads],
                    documentAt,
                  ),
                  outputs: viewInputBasis(
                    [...node.writes, ...node.log.writes],
                    documentAt,
                  ),
                },
              }
              : {}),
          })),
        };
        // Fingerprints consume whole values even for shallow execution reads.
        // Install dependencies before publication awaits, so concurrent changes
        // invalidate this result rather than being forgotten when it returns.
        cache.selection.set(true, {
          reads: [
            ...metadataReads.reads,
            ...selectedProducers.flatMap((node) => [
              ...node.log.reads,
              ...node.log.shallowReads,
              ...node.writes,
              ...node.log.writes,
            ]),
          ],
          shallowReads: metadataReads.shallowReads,
        });
        cache.execution = observed.map((node) => ({ ...node }));
        if (valueEqual(this.#published.get(key), selection)) continue;
        if (
          await server.setViewSelection(space, handle, {
            ...selection,
            generation: (interest.selectionGeneration ?? 0) + 1,
          })
        ) {
          this.#published.set(key, selection);
        } else {
          this.#views.delete(key);
        }
      } catch (error) {
        this.#views.delete(key);
        this.#published.delete(key);
        await server.setViewSelection(space, handle, {
          generation: (interest.selectionGeneration ?? 0) + 1,
          delivery: [],
          eligibleActions: [],
          pieces: [],
          inputs: [],
          producers: [],
        });
        logger.error(
          "view-selection-failed",
          "View selection could not be published",
          error,
        );
      } finally {
        if (planStart !== undefined) logger.time(planStart, "plan");
      }
    }
    for (const key of this.#published.keys()) {
      if (!live.has(key)) this.#published.delete(key);
    }
    for (const key of this.#views.keys()) {
      if (!live.has(key)) this.#views.delete(key);
    }
  }
}
