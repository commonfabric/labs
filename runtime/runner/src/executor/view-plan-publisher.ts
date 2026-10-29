/** Publishes observed view inputs after a serving wave has settled. */

import { valueEqualByWalk } from "@commonfabric/data-model";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type {
  EntityDocument,
  ScopeKeyIdentity,
  ViewPlan,
  ViewQuery,
} from "@commonfabric/memory/v2";
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
import { viewInputBasisOf, viewInputFingerprint } from "../view-input-basis.ts";
import {
  collectViewRenderReads,
  type ViewRenderReads,
  ViewRenderWalkMemo,
} from "../view-render-reads.ts";
import {
  type ViewDataSelection,
  ViewDependencyGraph,
  type ViewExecutionNode,
} from "../view-replication.ts";
import type { HostMemoryServer } from "./host-memory-server.ts";
import { ViewReadCache, type ViewReadPart } from "./view-read-cache.ts";
import { hasInlineCellScheme } from "../immutable-cell.ts";

const logger = getLogger("view-replication");
type Selection = Omit<ViewPlan, "id" | "revision" | "generation"> & {
  delivery: ViewQuery[];
};

/** Independent invalidation of rendered reads and execution-dependent output. */
type CachedView = {
  render: ViewReadCache<ViewRenderReads>;

  /** What the UI walk found at each visible cell, kept across walks. */
  walk: ViewRenderWalkMemo;

  selection: ViewReadCache<true>;
  execution?: ViewExecutionNode[];
};

/**
 * The part of one view's plan that depends on the execution snapshot and the
 * UI walk alone, and on nothing of the viewing session: two views of one
 * publish whose snapshots carry the same observations and whose walks read
 * the same addresses select the same cone, and compute it once. Node
 * identities are the publish's own, so the result names nodes by id.
 */
type SharedSelection = {
  signature: string;
  render: ViewRenderReads;
  selected: ViewDataSelection;
  producerGraph: ViewDependencyGraph;
  errorAncestorIds: Set<string>;
};

/** Keeps unchanged selections stable while expiring every removed view lifetime. */
export class ViewPlanPublisher {
  #published = new Map<string, Selection>();
  #views = new Map<string, CachedView>();
  #runtime: Runtime | undefined;

  /**
   * Fingerprints by the document version they were taken over, so that a
   * document unchanged since the last plan, or shared by several viewing
   * sessions, is hashed once at each path. A version is a new object.
   */
  #fingerprints = new WeakMap<EntityDocument, Map<string, string>>();

  /**
   * Each producer's write surface and basis reads, sorted and compacted, by
   * the observation they were taken from, so that a node that has not run
   * again since the last plan sorts neither again. A node that ran again is a
   * new key: `viewExecutionNodes` reports the log its last run handed the
   * scheduler, and nothing changes a log once handed out, since a transaction
   * builds a new one after any later read or write rather than appending to
   * the old. The write surface is the node's declared one, which a change
   * replaces rather than edits, and `writes` holds the one the entry was
   * sorted from.
   */
  #surfaces = new WeakMap<TransactionReactivityLog, {
    writes: readonly IMemorySpaceAddress[];
    surface: IMemorySpaceAddress[];
    reads: IMemorySpaceAddress[];
  }>();

  #subscription: IStorageNotification = {
    next: (notification) => {
      for (const view of this.#views.values()) {
        view.render.notify(notification);
        view.walk.notify(notification);
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

  /**
   * Selects actual reads under each viewing identity and publishes complete
   * roots. `quiescent` says whether the settlement this follows reached
   * quiescence: after one the flush deadline cut, a view that already holds
   * a published selection keeps it, and only a view with none is planned, so
   * that a burst of cut waves plans each view once, at the settlement that
   * ends it, over the snapshot that settlement left.
   */
  async publish(
    runtime: Runtime,
    server: HostMemoryServer,
    space: MemorySpace,
    { quiescent = true }: { quiescent?: boolean } = {},
  ): Promise<void> {
    if (this.#runtime !== runtime) {
      this.dispose();
      this.#runtime = runtime;
      runtime.storageManager.subscribe(this.#subscription);
    }
    const live = new Set<string>();
    const interests = await server.viewInterestsForSpace(space);
    runtime.scheduler.setViewConsumers(
      space,
      interests.map((interest) => ({
        principal: interest.principal,
        sessionId: interest.handle.sessionId as ScopeKeyIdentity["sessionId"],
      })),
    );
    const shared: SharedSelection[] = [];
    // One UI walk serves every session viewing the same roots when it read
    // no user- or session-scoped document: such a walk resolves nothing by
    // identity, so it reads the same addresses under any. It serves while
    // the cache of the view that walked it still holds it, since a document
    // it read can change while an earlier view's selection is published.
    const sharedRenders = new Map<string, {
      render: ViewRenderReads;
      cache: ViewReadCache<ViewRenderReads>;
    }>();
    const identityFree = (render: ViewRenderReads): boolean =>
      [...render.reads, ...render.shallowReads, ...render.bindings].every((
        address,
      ) => address.scope === undefined || address.scope === "space") &&
      render.streams.every((stream) =>
        stream.scope === undefined || stream.scope === "space"
      );
    const objectIds = new WeakMap<object, number>();
    let nextObjectId = 0;
    const objectId = (value: object): number => {
      let id = objectIds.get(value);
      if (id === undefined) objectIds.set(value, id = nextObjectId++);
      return id;
    };
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
      if (!quiescent && this.#published.has(key)) continue;
      const identity: ScopeKeyIdentity = {
        principal,
        sessionId: handle.sessionId as ScopeKeyIdentity["sessionId"],
      };
      let cache = this.#views.get(key);
      if (cache === undefined) {
        cache = {
          render: new ViewReadCache(identity),
          walk: new ViewRenderWalkMemo(identity),
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
          const rootsKey = `${view.mode}\n${JSON.stringify(view.query.roots)}`;
          const walked = sharedRenders.get(rootsKey);
          if (walked !== undefined && walked.cache.value === walked.render) {
            render = walked.render;
          } else {
            const renderStart = performance.now();
            render = collectViewRenderReads(
              runtime,
              space,
              view,
              identity,
              cache.walk,
            );
            logger.time(renderStart, "render");
            if (identityFree(render)) {
              sharedRenders.set(rootsKey, { render, cache: cache.render });
            }
          }
          cache.render.set(render, render);
        }
        // A cross-space dependency requires its own authorized view subscription.
        const candidates = observed.filter((node) =>
          [...node.log.reads, ...node.log.shallowReads].every((read) =>
            read.space === space
          )
        );
        const signature = `${view.mode}\n` + candidates.map((node) =>
          [
            node.id,
            node.kind,
            node.current === true ? "c" : "",
            node.error === undefined ? "" : objectId(node.error),
            node.stream === undefined ? "" : objectId(node.stream),
            objectId(node.log),
            objectId(node.writes),
          ].join("\0")
        ).join("\n");
        let cone = shared.find((entry) =>
          entry.signature === signature &&
          valueEqualByWalk(entry.render, render)
        );
        if (cone === undefined) {
          const handlers = new Set(
            candidates.filter((node) =>
              node.stream !== undefined &&
              render.streams.some((stream) =>
                areNormalizedLinksSame(node.stream!, stream)
              )
            ).map((node) => node.id),
          );
          const graph = new ViewDependencyGraph(candidates);
          cone = {
            signature,
            render,
            selected: graph.select(
              render.reads,
              view.mode === "speculate" ? render.bindings : [],
              view.mode === "speculate" ? handlers : new Set(),
              render.shallowReads,
            ),
            producerGraph: new ViewDependencyGraph(
              candidates.filter((node) => node.kind === "computation"),
              (node) => [...node.writes, ...node.log.writes],
            ),
            errorAncestorIds: new Set(
              [...graph.ancestors(
                render.reads,
                render.shallowReads,
                (node) => node.kind !== "handler",
              )].map((node) => node.id),
            ),
          };
          shared.push(cone);
        }
        const { selected } = cone;
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
        // The producer graph is the cone's, built over the first such
        // snapshot's nodes, so its ancestors are matched to this snapshot's
        // nodes by id.
        const ancestorIds = new Set(
          [...cone.producerGraph.ancestors(inputs.map((input) => ({
            ...input,
            id: input.id as IMemorySpaceAddress["id"],
            space,
            type: "application/json",
            path: [],
          })))].map((node) => node.id),
        );
        const replica = runtime.storageManager.open(space).replica;
        const addressOf = (address: IMemorySpaceAddress) => ({
          id: address.id,
          scope: address.scope ?? "space" as const,
          path: [...address.path],
        });
        const documentAt = (address: IMemorySpaceAddress) =>
          replica.getDocument(address.id, address.scope, identity);
        const fingerprintOf = (
          document: EntityDocument | undefined,
          path: readonly string[],
        ): string => {
          if (document === undefined) {
            return viewInputFingerprint(document, path);
          }
          let known = this.#fingerprints.get(document);
          if (known === undefined) {
            this.#fingerprints.set(document, known = new Map());
          }
          const pathKey = JSON.stringify(path);
          let fingerprint = known.get(pathKey);
          if (fingerprint === undefined) {
            known.set(
              pathKey,
              fingerprint = viewInputFingerprint(document, path),
            );
          }
          return fingerprint;
        };
        const selectedProducers = candidates.filter((node) =>
          node.kind === "computation" && ancestorIds.has(node.id)
        );
        const surfacesOf = (node: ViewExecutionNode) => {
          let surfaces = this.#surfaces.get(node.log);
          if (surfaces?.writes !== node.writes) {
            surfaces = {
              writes: node.writes,
              surface: sortAndCompactPaths([
                ...node.writes,
                ...node.log.writes,
              ]),
              reads: sortAndCompactPaths([
                ...node.log.reads,
                ...node.log.shallowReads,
              ]),
            };
            this.#surfaces.set(node.log, surfaces);
          }
          return surfaces;
        };
        const selection: Selection = {
          delivery: [{ roots: [...roots.entries()].map(([, root]) => root) }],
          eligibleActions: view.mode === "speculate" ? selected.actions : [],
          pieces: [...pieces.entries()].map(([, piece]) => piece),
          errors: candidates.flatMap((node) =>
            cone.errorAncestorIds.has(node.id) && node.error !== undefined
              ? [node.error]
              : []
          ),
          inputs,
          producers: selectedProducers.map((node) => {
            const { surface, reads } = surfacesOf(node);
            return {
              id: node.id,
              writes: surface.map(addressOf),
              ...(node.current === true
                ? {
                  basis: {
                    reads: viewInputBasisOf(reads, documentAt, fingerprintOf),
                    outputs: viewInputBasisOf(
                      surface,
                      documentAt,
                      fingerprintOf,
                    ),
                  },
                }
                : {}),
            };
          }),
        };
        // Fingerprints consume whole values even for shallow execution reads.
        // Install dependencies before publication awaits, so concurrent changes
        // invalidate this result rather than being forgotten when it returns.
        // Each producer is a part of its own, so a plan indexes again only the
        // producers that ran since the last one.
        const parts = new Map<string, ViewReadPart>([[
          "",
          {
            reads: [metadataReads.reads],
            shallowReads: [metadataReads.shallowReads],
          },
        ]]);
        for (const node of selectedProducers) {
          parts.set(node.id, {
            reads: [
              node.log.reads,
              node.log.shallowReads,
              node.writes,
              node.log.writes,
            ],
            shallowReads: [],
          });
        }
        cache.selection.setParts(true, parts);
        cache.execution = observed.map((node) => ({ ...node }));
        if (valueEqualByWalk(this.#published.get(key), selection)) continue;
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
