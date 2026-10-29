/**
 * Selects local interaction inputs from observed execution dependencies. The
 * selected data is delivered independently of server execution demand.
 */

import type { ViewExecutionError } from "@commonfabric/memory/v2";

import type { NormalizedFullLink } from "./link-utils.ts";
import { entityNameKey } from "./scheduler/keys.ts";
import { forEachOverlappingWriter } from "./scheduler/scheduling-writes.ts";
import type { SpaceScopeAndURI } from "./scheduler/types.ts";
import type {
  IMemorySpaceAddress,
  TransactionReactivityLog,
} from "./storage/interface.ts";

/** One execution instance observed under the viewing session's identity. */
export type ViewExecutionNode = {
  id: string;
  piece: NormalizedFullLink;
  kind: "computation" | "boundary" | "handler";
  /** Whether the observed instance is current after the serving wave settles. */
  current?: boolean;
  error?: ViewExecutionError;
  log: TransactionReactivityLog;
  writes: IMemorySpaceAddress[];
  stream?: NormalizedFullLink;
};

/** The visible interaction cone and its complete local input documents. */
export type ViewDataSelection = {
  actions: string[];
  reads: IMemorySpaceAddress[];
  pieces: NormalizedFullLink[];
};

/**
 * An identity-specific execution snapshot indexed by written entity. Dependency
 * walks retain exact path and shallow-read checks within each entity bucket.
 */
export class ViewDependencyGraph {
  #nodes: readonly ViewExecutionNode[];
  #writersByEntity = new Map<SpaceScopeAndURI, Set<ViewExecutionNode>>();
  #writes = new Map<ViewExecutionNode, readonly IMemorySpaceAddress[]>();

  /** Indexes the supplied write surface for each observed execution instance. */
  constructor(
    nodes: readonly ViewExecutionNode[],
    writesOf: (node: ViewExecutionNode) => readonly IMemorySpaceAddress[] = (
      node,
    ) => node.writes,
  ) {
    this.#nodes = nodes;
    for (const node of nodes) {
      const writes = writesOf(node);
      this.#writes.set(node, writes);
      for (const write of writes) {
        const key = entityNameKey(write);
        let writers = this.#writersByEntity.get(key);
        if (writers === undefined) {
          writers = new Set();
          this.#writersByEntity.set(key, writers);
        }
        writers.add(node);
      }
    }
  }

  /** Follows producer edges, stopping at nodes excluded by the supplied policy. */
  ancestors(
    reads: readonly IMemorySpaceAddress[],
    shallowReads: readonly IMemorySpaceAddress[] = [],
    include: (node: ViewExecutionNode) => boolean = () => true,
  ): Set<ViewExecutionNode> {
    const ancestors = new Set<ViewExecutionNode>();
    const visit = (node: ViewExecutionNode) => {
      ancestors.add(node);
    };
    const accept = (node: ViewExecutionNode) =>
      !ancestors.has(node) && include(node);
    this.#visitWriters(reads, shallowReads, visit, accept);
    // Set iteration includes newly discovered nodes; every node is expanded once.
    for (const node of ancestors) {
      this.#visitWriters(node.log.reads, node.log.shallowReads, visit, accept);
    }
    return ancestors;
  }

  /**
   * Selects the visible interaction cone. Only computations propagate edits;
   * handlers contribute their observed inputs and initial writes.
   */
  select(
    renderReads: readonly IMemorySpaceAddress[],
    bindingWrites: readonly IMemorySpaceAddress[],
    visibleHandlers: ReadonlySet<string>,
    renderShallowReads: readonly IMemorySpaceAddress[] = [],
  ): ViewDataSelection {
    const handlers = this.#nodes.filter((node) =>
      node.kind === "handler" && visibleHandlers.has(node.id)
    );
    const ancestors = this.ancestors(
      renderReads,
      renderShallowReads,
      (node) => node.kind === "computation",
    );
    const selected = new Set(handlers);
    // The edits a visible interaction can make, indexed by the entity they
    // write. The index holds each source's edits sliced by entity, so an
    // ancestor's read is tested only against the edits to the entity it names.
    const editsByEntity = new Map<
      SpaceScopeAndURI,
      Set<readonly IMemorySpaceAddress[]>
    >();
    for (
      const edits of [
        bindingWrites,
        ...handlers.map((node) => node.writes),
      ]
    ) {
      const slices = new Map<SpaceScopeAndURI, IMemorySpaceAddress[]>();
      for (const write of edits) {
        const key = entityNameKey(write);
        let slice = slices.get(key);
        if (slice === undefined) {
          slice = [];
          slices.set(key, slice);
          let writers = editsByEntity.get(key);
          if (writers === undefined) {
            writers = new Set();
            editsByEntity.set(key, writers);
          }
          writers.add(slice);
        }
        slice.push(write);
      }
    }
    const consumers = new Map<ViewExecutionNode, Set<ViewExecutionNode>>();
    for (const node of ancestors) {
      let edited = false;
      forEachOverlappingWriter(
        {
          writersByEntity: editsByEntity,
          getSchedulingWrites: (edits) => edits,
        },
        node.log.reads,
        node.log.shallowReads,
        () => {
          edited = true;
          return true;
        },
      );
      if (edited) selected.add(node);
      this.#visitWriters(node.log.reads, node.log.shallowReads, (writer) => {
        let next = consumers.get(writer);
        if (next === undefined) {
          next = new Set();
          consumers.set(writer, next);
        }
        next.add(node);
      }, (writer) => ancestors.has(writer));
    }
    for (const node of selected) {
      for (const consumer of consumers.get(node) ?? []) selected.add(consumer);
    }
    // Snapshot order makes equivalent walks publish the same array ordering.
    const ordered = this.#nodes.filter((node) => selected.has(node));
    return {
      actions: ordered.map((node) => node.id),
      reads: [
        ...renderReads,
        ...renderShallowReads,
        ...ordered.flatMap((
          node,
        ) => [...node.log.reads, ...node.log.shallowReads]),
      ],
      pieces: ordered.map((node) => node.piece),
    };
  }

  #visitWriters(
    reads: readonly IMemorySpaceAddress[],
    shallowReads: readonly IMemorySpaceAddress[],
    visit: (node: ViewExecutionNode) => void,
    filter: (node: ViewExecutionNode) => boolean,
  ): void {
    forEachOverlappingWriter(
      {
        writersByEntity: this.#writersByEntity,
        getSchedulingWrites: (node) => this.#writes.get(node),
      },
      reads,
      shallowReads,
      visit,
      { filter },
    );
  }
}

/**
 * Selects computations reachable from visible edits that can affect rendering.
 * Observed reads include side inputs; server-only nodes end local propagation.
 */
export function selectViewData(
  nodes: readonly ViewExecutionNode[],
  renderReads: readonly IMemorySpaceAddress[],
  bindingWrites: readonly IMemorySpaceAddress[],
  visibleHandlers: ReadonlySet<string>,
  renderShallowReads: readonly IMemorySpaceAddress[] = [],
): ViewDataSelection {
  return new ViewDependencyGraph(nodes).select(
    renderReads,
    bindingWrites,
    visibleHandlers,
    renderShallowReads,
  );
}

/** Follows observed producer edges while retaining path and shallow-read bounds. */
export function collectViewAncestors(
  nodes: readonly ViewExecutionNode[],
  reads: readonly IMemorySpaceAddress[],
  shallowReads: readonly IMemorySpaceAddress[] = [],
): Set<ViewExecutionNode> {
  return new ViewDependencyGraph(nodes).ancestors(reads, shallowReads);
}

/** Stable graph position, independent of how much binding data a replica has. */
export function viewNodeId(piece: NormalizedFullLink, index: number): string {
  return `${piece.scope}\0${piece.id}\0${index}`;
}
