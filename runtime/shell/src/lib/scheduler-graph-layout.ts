/**
 * The computations behind the scheduler graph view, `x-scheduler-graph`:
 * short labels for action ids, the parent each orphan sink is grouped under,
 * the description of every node, the dagre layout of the nodes no collapsed
 * ancestor hides, the boxes drawn around parent groups, and the zoom and
 * scroll arithmetic. Nothing here renders; the only DOM it touches is the
 * scroll offsets of a viewport it is handed.
 */

import { ENTITY_URI_SCHEMES } from "@commonfabric/runner/entity-kind";
import type { SchedulerGraphNode } from "@commonfabric/runtime-client";
import dagre from "dagre";

import type { GraphWithHistory } from "./debugger-controller.ts";
import { entityUriFromActionId } from "./scheduler-graph-identity.ts";

/** A scheduler graph node, described for display, whether drawn or not. */
export interface GraphNodeInfo {
  /** The action id, or `input:...` for a source cell. */
  id: string;

  /** The id shortened for display, by `truncateLabel()`. */
  label: string;

  /** The id in full, for a tooltip. */
  fullId: string;

  type: SchedulerGraphNode["type"];

  stats?: SchedulerGraphNode["stats"];

  isDirty: boolean;

  isPending: boolean;

  /**
   * The explicit parent, or the one `inferParentsByEntity()` found; absent
   * where that parent would close a cycle of parents.
   */
  parentId?: string;

  /** Number of children, explicit and inferred; absent when there are none. */
  childCount?: number;

  /** Function body preview, for the hover tooltip. */
  preview?: string;

  /** Cell paths this action reads. */
  reads?: string[];

  /** Cell paths this action writes. */
  writes?: string[];

  /** Current debounce delay, in milliseconds. */
  debounceMs?: number;

  /** Current throttle period, in milliseconds. */
  throttleMs?: number;

  /** Content identity of the pattern this action belongs to. */
  patternIdentity?: string;
}

/** A scheduler graph node, placed by the layout. */
export interface LayoutNode extends GraphNodeInfo {
  /** Center of the node, horizontally. */
  x: number;

  /** Center of the node, vertically. */
  y: number;

  width: number;

  height: number;

  /**
   * Number of descendants, of every generation, hidden because this node is
   * collapsed; absent when there are none.
   */
  collapsedChildCount?: number;
}

/** A scheduler graph edge between two nodes of a layout. */
export interface LayoutEdge {
  /** `from->to`. */
  id: string;

  from: string;

  to: string;

  /** Cells creating this dependency. */
  cells: string[];

  /** Whether the edge was seen in an earlier snapshot but not the current. */
  isHistorical: boolean;

  edgeType?: "data" | "parent";
}

/** What `layoutSchedulerGraph()` produces. */
export interface SchedulerGraphLayout {
  /** Every node of the graph, drawn or not, in the order the graph lists them. */
  allNodes: Map<string, GraphNodeInfo>;

  /** The visible nodes, placed, in the order the graph lists them. */
  nodes: Map<string, LayoutNode>;

  /** The edges between visible node ids, in the order the graph lists them. */
  edges: LayoutEdge[];

  /** Width of the drawing, at least 800. */
  width: number;

  /** Height of the drawing, at least 400. */
  height: number;
}

/** A parent node and the visible children drawn in a box around them. */
export interface ParentGroup {
  parent: LayoutNode;

  children: LayoutNode[];

  /** The box: the nodes' bounds, padded by 15 on every side. */
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * The scroll container the graph is drawn in, or as much of it as the zoom
 * arithmetic reads and writes.
 */
export interface GraphViewport {
  readonly clientWidth: number;

  readonly clientHeight: number;

  scrollLeft: number;

  scrollTop: number;

  getBoundingClientRect(): { readonly left: number; readonly top: number };
}

/**
 * Runs a callback once the next frame has rendered, as `requestAnimationFrame`
 * does, so that a scroll lands after the zoom it depends on has been drawn.
 */
export type FrameScheduler = (callback: () => void) => void;

/** Width of a node, before zooming. */
export const NODE_WIDTH = 140;

/** Height of a node, before zooming. */
export const NODE_HEIGHT = 36;

/** The zoom `centerOn()` sets. */
export const CENTERED_ZOOM = 0.5;

const MIN_ZOOM = 0.1;
const MAX_WHEEL_ZOOM = 5;

// Entity-scheme parser derived from the canonical scheme set, so a new entity
// kind cannot leave a stale `of|computed` alternation here.
const ENTITY_SCHEME_PART_RE = new RegExp(
  `^(?:${ENTITY_URI_SCHEMES.join("|")}):(.*)$`,
);

/**
 * Creates a short, readable label from an action ID. A label no longer than
 * `maxLen` is returned unchanged, and a longer one in which an entity can be
 * found is returned in the form `prefix:...last4/path`.
 *
 * In that form the prefix and the `...last4` of the entity are never cut,
 * and the path takes the whole cut: it is cut to the room those two leave
 * and ends in `...`, and is left out when that room holds less than `/...`.
 * The result is therefore longer than `maxLen` when the prefix and the
 * `...last4` alone are, and only then. A label in which no entity can be
 * found, which includes every label with no `/` in it, is cut from its end
 * instead, to `maxLen` including the `...`. `maxLen` must be at least 3, the
 * length of that `...`.
 *
 * Examples:
 * - `sink:did:key:z6Mkk/of:fid1:abcdwxyz/value` → `sink:...wxyz/value`
 * - the same label when `maxLen === 12` → `sink:...wxyz`
 * - `computation:did:key:z6Mkk/of:fid1:abcdwxyz/value` →
 *   `computation:...wxyz`
 * - `parentAction` → `parentAction`
 */
export function truncateLabel(label: string, maxLen = 20): string {
  if (label.length <= maxLen) return label;

  const prefixMatch = label.match(
    /^(sink|action|handler|effect|computation):/i,
  );
  const prefix = prefixMatch ? prefixMatch[1] + ":" : "";
  const parts = label.slice(prefix.length).split("/");

  // Where the label has a `/`, the entity is the first segment carrying an
  // entity URI scheme, without the scheme. Failing that, it is the first
  // non-empty segment longer than 20 characters, or else the first non-empty
  // segment, provided at least one more follows. The path is the non-empty
  // segments after the entity.
  let entityPart = "";
  let pathParts: string[] = [];
  if (parts.length >= 2) {
    for (const [i, part] of parts.entries()) {
      const schemeMatch = part.match(ENTITY_SCHEME_PART_RE);
      if (schemeMatch) {
        entityPart = schemeMatch[1];
        pathParts = parts.slice(i + 1).filter((p) => p.length > 0);
        break;
      }
    }
    const nonEmpty = parts.filter((p) => p.length > 0);
    if (!entityPart && nonEmpty.length >= 2) {
      const entityIdx = Math.max(0, nonEmpty.findIndex((p) => p.length > 20));
      entityPart = nonEmpty[entityIdx];
      pathParts = nonEmpty.slice(entityIdx + 1);
    }
  }

  if (entityPart) {
    const shortEntity = entityPart.length > 4
      ? "..." + entityPart.slice(-4)
      : entityPart;
    const path = pathParts.length > 0 ? "/" + pathParts.join("/") : "";
    const head = prefix + shortEntity;
    if (head.length + path.length <= maxLen) return head + path;

    // The path takes the whole cut. What is left of it keeps at least its
    // `/` in front of the `...`, so that the `...` cannot be read as
    // belonging to the entity.
    const room = maxLen - head.length;
    return room >= 4 ? head + path.slice(0, room - 3) + "..." : head;
  }

  return label.slice(0, maxLen - 3) + "...";
}

/**
 * Returns the entity an action id names: the schemed entity URI when the id
 * holds one, as in `sink:did:key:.../of:entityId/path`, or else the first
 * `/`-separated segment longer than 40 characters with no `:` in it.
 */
export function extractEntityId(actionId: string): string | undefined {
  return entityUriFromActionId(actionId) ??
    actionId.split("/").find((part) => part.length > 40 && !part.includes(":"));
}

/**
 * Returns a parent for each `sink:` node that has no explicit parent: the
 * first computation naming the same entity, or failing that the first other
 * non-sink node naming it. A sink with no such node, or naming no entity, has
 * no entry.
 */
export function inferParentsByEntity(
  nodes: readonly SchedulerGraphNode[],
): Map<string, string> {
  const nodesByEntity = new Map<string, SchedulerGraphNode[]>();
  for (const node of nodes) {
    const entityId = extractEntityId(node.id);
    if (entityId) {
      const group = nodesByEntity.get(entityId) ?? [];
      group.push(node);
      nodesByEntity.set(entityId, group);
    }
  }

  const inferredParents = new Map<string, string>();
  for (const groupNodes of nodesByEntity.values()) {
    const isSink = (n: SchedulerGraphNode) => n.id.startsWith("sink:");
    const parent = groupNodes.find((n) =>
      !isSink(n) && n.type === "computation"
    ) ?? groupNodes.find((n) => !isSink(n));
    if (!parent) continue;
    for (const node of groupNodes) {
      if (isSink(node) && !node.parentId) {
        inferredParents.set(node.id, parent.id);
      }
    }
  }
  return inferredParents;
}

/**
 * Lays `graph` out top to bottom with dagre. Every node with children,
 * explicit or inferred by `inferParentsByEntity()`, is collapsed unless it is
 * in `expandedParents`, and a node with a collapsed ancestor is left out
 * along with every edge touching it. Each hidden node is counted in the
 * `collapsedChildCount` of its outermost collapsed ancestor, which is the one
 * drawn. A parent the graph does not list is never drawn, so it hides
 * nothing. Where parents form a cycle, walking up from the first node the
 * graph lists that leads into it enters it at one member, whose parent is
 * treated as absent, so that member is drawn and expanding it reaches the
 * rest. An edge naming a node the graph does not list is kept, with no node
 * drawn for its missing end.
 */
export function layoutSchedulerGraph(
  graph: Pick<GraphWithHistory, "nodes" | "edges">,
  expandedParents: ReadonlySet<string>,
): SchedulerGraphLayout {
  const inferredParents = inferParentsByEntity(graph.nodes);
  const parentIds = new Map(
    graph.nodes.map((n) => [n.id, n.parentId || inferredParents.get(n.id)]),
  );
  // The parent link that closes a cycle is dropped, so that some member of
  // the cycle is drawn and expanding it reaches the rest.
  const acyclic = new Set<string>();
  for (const id of parentIds.keys()) {
    const path = new Set<string>();
    for (
      let at: string | undefined = id;
      at !== undefined && parentIds.has(at) && !acyclic.has(at);
      at = parentIds.get(at)
    ) {
      if (path.has(at)) {
        parentIds.set(at, undefined);
        break;
      }
      path.add(at);
    }
    for (const at of path) acyclic.add(at);
  }
  const childCounts = new Map<string, number>();
  for (const parentId of parentIds.values()) {
    if (parentId) {
      childCounts.set(parentId, (childCounts.get(parentId) ?? 0) + 1);
    }
  }

  const allNodes = new Map<string, GraphNodeInfo>();
  for (const node of graph.nodes) {
    allNodes.set(node.id, {
      id: node.id,
      label: truncateLabel(node.id),
      fullId: node.id,
      type: node.type,
      stats: node.stats,
      isDirty: node.isDirty,
      isPending: node.isPending,
      parentId: parentIds.get(node.id),
      childCount: childCounts.get(node.id),
      preview: node.preview,
      reads: node.reads,
      writes: node.writes,
      debounceMs: node.debounceMs,
      throttleMs: node.throttleMs,
      patternIdentity: node.patternIdentity?.identity,
    });
  }

  const hiddenNodes = new Set<string>();
  const collapsedChildCounts = new Map<string, number>();
  for (const id of allNodes.keys()) {
    // The walk up stops at a parent the graph does not list.
    let outermost: string | undefined;
    for (
      let ancestor = parentIds.get(id);
      ancestor !== undefined && allNodes.has(ancestor);
      ancestor = parentIds.get(ancestor)
    ) {
      if (!expandedParents.has(ancestor)) outermost = ancestor;
    }
    if (outermost === undefined) continue;
    hiddenNodes.add(id);
    collapsedChildCounts.set(
      outermost,
      (collapsedChildCounts.get(outermost) ?? 0) + 1,
    );
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "TB",
    nodesep: 50,
    ranksep: 70,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of graph.nodes) {
    if (hiddenNodes.has(node.id)) continue;
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  const visibleEdges = graph.edges.filter((edge) =>
    !hiddenNodes.has(edge.from) && !hiddenNodes.has(edge.to)
  );
  for (const edge of visibleEdges) g.setEdge(edge.from, edge.to);
  dagre.layout(g);

  const nodes = new Map<string, LayoutNode>();
  for (const id of g.nodes()) {
    // A node dagre made for the missing end of an edge has no label.
    const placed: { x: number; y: number } | undefined = g.node(id);
    const info = allNodes.get(id);
    if (!placed || !info) continue;
    nodes.set(id, {
      ...info,
      x: placed.x,
      y: placed.y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      collapsedChildCount: collapsedChildCounts.get(id),
    });
  }

  // dagre keeps one edge per pair of ends, carrying the cells of the last
  // edge set between them and the history of the first.
  const edges = new Map<string, LayoutEdge>();
  for (const edge of visibleEdges) {
    const id = `${edge.from}->${edge.to}`;
    const first = edges.get(id) ?? edge;
    edges.set(id, {
      id,
      from: edge.from,
      to: edge.to,
      cells: edge.cells,
      isHistorical: first.isHistorical ?? false,
      edgeType: first.edgeType,
    });
  }

  const { width, height } = g.graph();
  return {
    allNodes,
    nodes,
    edges: [...edges.values()],
    width: Math.max(800, (width ?? 0) + 40),
    height: Math.max(400, (height ?? 0) + 40),
  };
}

/**
 * Returns a group for each node in `nodes` that is the parent of another,
 * holding its children in `nodes` in order, keyed by the parent's id.
 */
export function computeParentGroups(
  nodes: ReadonlyMap<string, LayoutNode>,
): Map<string, ParentGroup> {
  const groups = new Map<string, ParentGroup>();
  for (const node of nodes.values()) {
    if (node.parentId === undefined) continue;
    const parent = nodes.get(node.parentId);
    if (!parent) continue;
    const group = groups.get(node.parentId) ??
      { parent, children: [], bounds: { x: 0, y: 0, width: 0, height: 0 } };
    group.children.push(node);
    groups.set(node.parentId, group);
  }

  const padding = 15;
  for (const group of groups.values()) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of [group.parent, ...group.children]) {
      minX = Math.min(minX, n.x - n.width / 2);
      minY = Math.min(minY, n.y - n.height / 2);
      maxX = Math.max(maxX, n.x + n.width / 2);
      maxY = Math.max(maxY, n.y + n.height / 2);
    }
    group.bounds = {
      x: minX - padding,
      y: minY - padding,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2,
    };
  }
  return groups;
}

/**
 * Returns the nodes at the far end of the data edges into `nodeId`
 * (`inbound`) or out of it (`outbound`), each once, in the order of the
 * edges. Parent edges, and ends with no node in `nodes`, are left out.
 */
export function adjacentNodes(
  nodes: ReadonlyMap<string, GraphNodeInfo>,
  edges: readonly Pick<LayoutEdge, "from" | "to" | "edgeType">[],
  nodeId: string,
  direction: "inbound" | "outbound",
): GraphNodeInfo[] {
  const ids = new Set(
    edges.filter((e) =>
      e.edgeType !== "parent" &&
      (direction === "inbound" ? e.to : e.from) === nodeId
    ).map((e) => direction === "inbound" ? e.from : e.to),
  );
  return [...ids].flatMap((id) => nodes.get(id) ?? []);
}

/**
 * Returns the hover text of a node: its id, then for an action its preview,
 * and the first five cells it reads and writes.
 */
export function nodeTooltip(node: LayoutNode): string {
  if (node.type === "input") {
    return `${node.fullId}\n(Source cell - no writer)`;
  }
  const cellList = (title: string, cells: string[] | undefined) =>
    cells?.length
      ? `\n${title} (${cells.length}): ${cells.slice(0, 5).join(", ")}${
        cells.length > 5 ? "..." : ""
      }`
      : `\n${title}: none`;
  const preview = node.preview ? `\n\n${node.preview}` : "";
  return `${node.fullId}${preview}${cellList("Reads", node.reads)}${
    cellList("Writes", node.writes)
  }`;
}

/**
 * Returns the zoom at which a drawing of `width` by `height` fits `viewport`
 * with 40 pixels to spare, at most 1 and at least 0.1. Without a viewport, it
 * returns `zoom`.
 */
export function fitZoom(
  viewport: GraphViewport | null,
  width: number,
  height: number,
  zoom: number,
): number {
  if (!viewport) return zoom;
  const padding = 40;
  const fit = Math.min(
    (viewport.clientWidth - padding) / width,
    (viewport.clientHeight - padding) / height,
    1,
  );
  return Math.max(MIN_ZOOM, fit);
}

/**
 * Prepares a zoom from `oldZoom` to `newZoom` that keeps the center of
 * `viewport` on the same point of the drawing: it reads the scroll offsets
 * now, and schedules the scroll for after the new zoom has rendered. Without a
 * viewport, or when the zoom is unchanged, nothing is scheduled.
 */
export function zoomAroundCenter(
  viewport: GraphViewport | null,
  oldZoom: number,
  newZoom: number,
  schedule: FrameScheduler,
): void {
  if (!viewport || oldZoom === newZoom) return;
  const { clientWidth, clientHeight } = viewport;
  const centerX = (viewport.scrollLeft + clientWidth / 2) / oldZoom;
  const centerY = (viewport.scrollTop + clientHeight / 2) / oldZoom;
  schedule(() =>
    scrollTo(
      viewport,
      centerX * newZoom - clientWidth / 2,
      centerY * newZoom - clientHeight / 2,
    )
  );
}

/**
 * Returns the zoom a wheel step sets, from `zoom`: a tenth further out for a
 * step down, a tenth further in for one up, and between 0.1 and 5. It
 * schedules a scroll that keeps the point under the pointer in place. Without
 * a viewport, it returns `zoom` and schedules nothing.
 */
export function zoomAtPointer(
  viewport: GraphViewport | null,
  zoom: number,
  pointer: { clientX: number; clientY: number; deltaY: number },
  schedule: FrameScheduler,
): number {
  if (!viewport) return zoom;
  const newZoom = Math.max(
    MIN_ZOOM,
    Math.min(MAX_WHEEL_ZOOM, zoom * (pointer.deltaY > 0 ? 0.9 : 1.1)),
  );
  if (newZoom === zoom) return zoom;

  // The pointer in the coordinates of the zoomed drawing.
  const rect = viewport.getBoundingClientRect();
  const pointX = pointer.clientX - rect.left + viewport.scrollLeft;
  const pointY = pointer.clientY - rect.top + viewport.scrollTop;
  schedule(() =>
    scrollTo(
      viewport,
      (pointX / zoom) * newZoom - (pointX - viewport.scrollLeft),
      (pointY / zoom) * newZoom - (pointY - viewport.scrollTop),
    )
  );
  return newZoom;
}

/**
 * Returns `CENTERED_ZOOM`, and schedules the scroll that brings the point at
 * `x` and `y` of the drawing to the center of `viewport` at that zoom.
 * Without a viewport, it returns `zoom` and schedules nothing.
 */
export function centerOn(
  viewport: GraphViewport | null,
  x: number,
  y: number,
  zoom: number,
  schedule: FrameScheduler,
): number {
  if (!viewport) return zoom;
  schedule(() =>
    scrollTo(
      viewport,
      x * CENTERED_ZOOM - viewport.clientWidth / 2,
      y * CENTERED_ZOOM - viewport.clientHeight / 2,
    )
  );
  return CENTERED_ZOOM;
}

/** Helper for the zoom functions, which scrolls to a point, clamped at 0. */
function scrollTo(viewport: GraphViewport, left: number, top: number): void {
  viewport.scrollLeft = Math.max(0, left);
  viewport.scrollTop = Math.max(0, top);
}
