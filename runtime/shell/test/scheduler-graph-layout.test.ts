import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { SchedulerGraphNode } from "@commonfabric/runtime-client";

import type { GraphEdgeWithHistory } from "../src/lib/debugger-controller.ts";
import {
  adjacentNodes,
  CENTERED_ZOOM,
  centerOn,
  computeParentGroups,
  extractEntityId,
  fitZoom,
  type GraphViewport,
  inferParentsByEntity,
  type LayoutEdge,
  type LayoutNode,
  layoutSchedulerGraph,
  nodeTooltip,
  truncateLabel,
  zoomAroundCenter,
  zoomAtPointer,
} from "../src/lib/scheduler-graph-layout.ts";

/** A space id long enough that no label holding it fits the default bound. */
const SPACE = "did:key:z6MkabcdefghijkLMNOP";

/** Stats for `runCount` runs taking `totalTime` milliseconds in all. */
function stats(runCount: number, totalTime: number) {
  return {
    runCount,
    totalTime,
    averageTime: totalTime / runCount,
    lastRunTime: 1,
    lastRunTimestamp: 0,
  };
}

/** A scheduler graph node for `id`, a clean, idle computation by default. */
function graphNode(
  id: string,
  extra: Partial<SchedulerGraphNode> = {},
): SchedulerGraphNode {
  return {
    id,
    type: "computation",
    isDirty: false,
    isPending: false,
    ...extra,
  };
}

/** A current scheduler graph edge carrying no cells, by default. */
function edge(
  from: string,
  to: string,
  extra: Partial<GraphEdgeWithHistory> = {},
): GraphEdgeWithHistory {
  return { from, to, cells: [], isHistorical: false, ...extra };
}

/** A laid-out computation for `id`, at the origin by default. */
function layoutNode(id: string, extra: Partial<LayoutNode> = {}): LayoutNode {
  return {
    id,
    label: id,
    fullId: id,
    type: "computation",
    x: 0,
    y: 0,
    width: 140,
    height: 36,
    isDirty: false,
    isPending: false,
    ...extra,
  };
}

/** A laid-out current edge carrying no cells. */
function layoutEdge(
  from: string,
  to: string,
  edgeType?: "data" | "parent",
): LayoutEdge {
  return {
    id: `${from}->${to}`,
    from,
    to,
    cells: [],
    isHistorical: false,
    edgeType,
  };
}

/** A viewport of the given size, scroll offsets, and position on the page. */
function viewport(options: {
  width?: number;
  height?: number;
  left?: number;
  top?: number;
  rectLeft?: number;
  rectTop?: number;
}): GraphViewport {
  return {
    clientWidth: options.width ?? 400,
    clientHeight: options.height ?? 300,
    scrollLeft: options.left ?? 0,
    scrollTop: options.top ?? 0,
    getBoundingClientRect: () => ({
      left: options.rectLeft ?? 0,
      top: options.rectTop ?? 0,
    }),
  };
}

/** A frame scheduler that holds each callback until `run()` is called. */
function frameQueue() {
  const frames: (() => void)[] = [];
  return {
    schedule: (callback: () => void) => {
      frames.push(callback);
    },
    run: () => {
      for (const frame of frames.splice(0)) frame();
    },
    get pending() {
      return frames.length;
    },
  };
}

describe("scheduler-graph-layout", () => {
  describe("truncateLabel()", () => {
    // Each expectation is the whole label the method assembles, so a case
    // turns on the assembly itself and not on a fragment surviving it.

    it("returns a label no longer than the default bound unchanged", () => {
      expect(truncateLabel("parentAction")).toBe("parentAction");
      expect(truncateLabel("a".repeat(20))).toBe("a".repeat(20));
    });

    it("returns a label no longer than a given `maxLen` unchanged", () => {
      expect(truncateLabel("abcdefghij", 10)).toBe("abcdefghij");
    });

    describe("given a schemed entity segment", () => {
      it("returns the prefix, the last four characters of the entity, and the path", () => {
        expect(
          truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`),
        ).toBe("sink:...DDDD/value");
      });

      it("returns a `computed:` entity the same way as an `of:` one", () => {
        expect(
          truncateLabel(
            `action:${SPACE}/computed:fid1:EEEEFFFFGGGGHHHH/count`,
          ),
        ).toBe("action:...HHHH/count");
      });

      it("keeps the prefix in the case the label wrote it", () => {
        expect(
          truncateLabel(`Sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`),
        ).toBe("Sink:...DDDD/value");
      });

      it("returns no prefix when the label has none", () => {
        expect(
          truncateLabel(`${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`),
        ).toBe("...DDDD/value");
      });

      it("returns no path when only empty segments follow the entity", () => {
        expect(
          truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/`),
        ).toBe("sink:...DDDD");
      });

      it("cuts the path to fit when the assembled label is still too long", () => {
        expect(
          truncateLabel(
            `sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/some/deeply/nested/path`,
          ),
        ).toBe("sink:...DDDD/some...");
      });

      it("returns the whole assembled label when it is exactly `maxLen` long", () => {
        expect(
          truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`, 18),
        ).toBe("sink:...DDDD/value");
      });
    });

    describe("given no schemed entity segment", () => {
      it("returns the last four characters of the first segment longer than 20 characters, then the segments after it", () => {
        expect(truncateLabel("space/abcdefghijklmnopqrstuvwx/count")).toBe(
          "...uvwx/count",
        );
      });

      it("returns the last four characters of the first segment when none is longer than 20 characters", () => {
        expect(truncateLabel("space/entity/some/longer/path")).toBe(
          "...pace/entity/so...",
        );
      });

      it("keeps an entity of four characters or fewer whole", () => {
        expect(truncateLabel("ab/cdefghijklmnopqrstu")).toBe(
          "ab/cdefghijklmnop...",
        );
      });
    });

    describe("given a label whose assembled form is longer than `maxLen`", () => {
      // The prefix and the entity tail are never cut, so the path takes the
      // whole cut. `sink:...DDDD` is 12 characters long and `action:...HHHH`
      // is 14. Each `maxLen` below is chosen against those two lengths.

      it("returns the prefix and the entity tail alone when the two are exactly `maxLen` long", () => {
        expect(
          truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`, 12),
        ).toBe("sink:...DDDD");
      });

      it("returns the prefix and the entity tail alone, uncut, when the two are longer than `maxLen`", () => {
        expect(
          truncateLabel(
            `action:${SPACE}/computed:fid1:EEEEFFFFGGGGHHHH/count`,
            12,
          ),
        ).toBe("action:...HHHH");
      });

      it("returns the path cut to the room that the prefix and the entity tail leave", () => {
        expect(
          truncateLabel(`${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`, 12),
        ).toBe("...DDDD/v...");
        expect(
          truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`, 17),
        ).toBe("sink:...DDDD/v...");
      });

      it("returns `/...` for the path when there is room for nothing more", () => {
        expect(
          truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`, 16),
        ).toBe("sink:...DDDD/...");
      });

      it("returns no path when there is less room than `/...` takes", () => {
        expect(
          truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`, 15),
        ).toBe("sink:...DDDD");
        expect(
          truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`, 13),
        ).toBe("sink:...DDDD");
      });

      it("returns no path at the default bound for a `computation:` label", () => {
        // `computation:...DDDD` is 19 characters long, one short of the
        // default bound.

        expect(
          truncateLabel(
            `computation:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`,
          ),
        ).toBe("computation:...DDDD");
      });
    });

    describe("given fewer than two non-empty segments", () => {
      it("cuts the label from the end", () => {
        expect(truncateLabel("aVeryLongActionIdentifierName")).toBe(
          "aVeryLongActionId...",
        );
      });

      it("returns the prefix as part of the cut label", () => {
        expect(truncateLabel("handler:someVeryLongHandlerName")).toBe(
          "handler:someVeryL...",
        );
      });

      it("cuts to a given `maxLen`", () => {
        expect(truncateLabel("abcdefghijk", 10)).toBe("abcdefg...");
      });

      it("cuts a lone segment followed by `/` the same way", () => {
        expect(truncateLabel("abcdefghijklmnopqrstuvwxyz/")).toBe(
          "abcdefghijklmnopq...",
        );
      });
    });
  });

  describe("extractEntityId()", () => {
    it("returns the schemed entity URI the id holds", () => {
      expect(extractEntityId(`sink:${SPACE}/of:fid1:AAAA/value`)).toBe(
        "of:fid1:AAAA",
      );
      expect(extractEntityId("sink:did:key:z6Mkabc/of:fid1:AAA/path")).toBe(
        "of:fid1:AAA",
      );
      expect(extractEntityId(
        "action:pattern:did:key:z6Mkabc/computed:fid1:BBB/value",
      )).toBe("computed:fid1:BBB");
    });

    it("returns a segment longer than 40 characters with no `:` when the id holds no schemed entity", () => {
      const entity = "b".repeat(41);

      expect(extractEntityId(`action:${SPACE}/${entity}/value`)).toBe(entity);
    });

    it("returns `undefined` for an id with neither", () => {
      expect(extractEntityId(`action:${SPACE}/${"b".repeat(40)}/value`))
        .toBeUndefined();
      expect(extractEntityId(`action:${SPACE}/x:${"b".repeat(41)}/value`))
        .toBeUndefined();
    });
  });

  describe("inferParentsByEntity()", () => {
    it("returns the first computation naming a parentless sink's entity as its parent", () => {
      const nodes = [
        graphNode(`effect:${SPACE}/of:fid1:AAAA/x`, { type: "effect" }),
        graphNode(`computation:${SPACE}/of:fid1:AAAA/y`),
        graphNode(`computation:${SPACE}/of:fid1:AAAA/z`),
        graphNode(`sink:${SPACE}/of:fid1:AAAA/value`, { type: "effect" }),
      ];

      expect(inferParentsByEntity(nodes)).toEqual(
        new Map([[nodes[3].id, nodes[1].id]]),
      );
    });

    it("returns the first non-sink node as the parent when no computation names the entity", () => {
      const nodes = [
        graphNode(`sink:${SPACE}/of:fid1:AAAA/one`, { type: "effect" }),
        graphNode(`effect:${SPACE}/of:fid1:AAAA/x`, { type: "effect" }),
        graphNode(`sink:${SPACE}/of:fid1:AAAA/two`, { type: "effect" }),
      ];

      expect(inferParentsByEntity(nodes)).toEqual(
        new Map([[nodes[0].id, nodes[1].id], [nodes[2].id, nodes[1].id]]),
      );
    });

    it("returns no parent for a sink that has one already, or whose entity no other node names", () => {
      const nodes = [
        graphNode(`computation:${SPACE}/of:fid1:AAAA/x`),
        graphNode(`sink:${SPACE}/of:fid1:AAAA/value`, {
          type: "effect",
          parentId: "elsewhere",
        }),
        graphNode(`sink:${SPACE}/of:fid1:BBBB/value`, { type: "effect" }),
        graphNode("sink:unscoped", { type: "effect" }),
      ];

      expect(inferParentsByEntity(nodes)).toEqual(new Map());
    });
  });

  describe("layoutSchedulerGraph()", () => {
    it("returns each node placed and labeled, carrying what the graph says of it", () => {
      const reader = graphNode(`computation:${SPACE}/of:fid1:AAAA/value`, {
        stats: stats(3, 6),
        isDirty: true,
        preview: "() => 1",
        reads: ["r"],
        writes: ["w"],
        debounceMs: 10,
        throttleMs: 20,
        patternIdentity: { identity: "pattern-hash", symbol: "default" },
      });
      const writer = graphNode("input:source", { type: "input" });

      const layout = layoutSchedulerGraph(
        { nodes: [reader, writer], edges: [edge(writer.id, reader.id)] },
        new Set(),
      );

      const placed = layout.nodes.get(reader.id)!;
      expect(placed).toEqual({
        id: reader.id,
        label: "computation:...AAAA",
        fullId: reader.id,
        type: "computation",
        x: placed.x,
        y: placed.y,
        width: 140,
        height: 36,
        stats: stats(3, 6),
        isDirty: true,
        isPending: false,
        parentId: undefined,
        childCount: undefined,
        collapsedChildCount: undefined,
        preview: "() => 1",
        reads: ["r"],
        writes: ["w"],
        debounceMs: 10,
        throttleMs: 20,
        patternIdentity: "pattern-hash",
      });
      // The writer is drawn a rank above the node that reads from it.
      expect(placed.y).toBeGreaterThan(layout.nodes.get(writer.id)!.y);
      expect([...layout.nodes.keys()]).toEqual([reader.id, writer.id]);
    });

    it("returns a drawing at least 800 by 400, and wider for a wider graph", () => {
      const small = layoutSchedulerGraph(
        { nodes: [graphNode("a")], edges: [] },
        new Set(),
      );
      const wide = layoutSchedulerGraph(
        {
          nodes: ["a", "b", "c", "d", "e", "f"].map((id) => graphNode(id)),
          edges: [],
        },
        new Set(),
      );

      expect([small.width, small.height]).toEqual([800, 400]);
      expect(wide.width).toBeGreaterThan(800);
      expect(wide.height).toBe(400);
    });

    it("returns each edge with its cells, history, and kind", () => {
      const layout = layoutSchedulerGraph(
        {
          nodes: [graphNode("a"), graphNode("b"), graphNode("c")],
          edges: [
            edge("a", "b", { cells: ["cell"] }),
            edge("b", "c", { isHistorical: true, edgeType: "parent" }),
          ],
        },
        new Set(),
      );

      expect(layout.edges).toEqual([
        {
          id: "a->b",
          from: "a",
          to: "b",
          cells: ["cell"],
          isHistorical: false,
          edgeType: undefined,
        },
        {
          id: "b->c",
          from: "b",
          to: "c",
          cells: [],
          isHistorical: true,
          edgeType: "parent",
        },
      ]);
    });

    it("returns one edge for two between the same nodes, with the cells of the last and the history of the first", () => {
      const layout = layoutSchedulerGraph(
        {
          nodes: [graphNode("a"), graphNode("b")],
          edges: [
            edge("a", "b", { cells: ["first"], isHistorical: true }),
            edge("a", "b", { cells: ["last"] }),
          ],
        },
        new Set(),
      );

      expect(layout.edges.map((e) => [e.cells, e.isHistorical])).toEqual([
        [["last"], true],
      ]);
    });

    it("returns an edge to a node the graph does not list, with no node for that end", () => {
      const layout = layoutSchedulerGraph(
        {
          nodes: [graphNode("a")],
          edges: [edge("a", "gone", { isHistorical: true })],
        },
        new Set(),
      );

      expect([...layout.nodes.keys()]).toEqual(["a"]);
      expect(layout.edges.map((e) => e.id)).toEqual(["a->gone"]);
    });

    it("returns a parent collapsed, with its children and their edges left out", () => {
      const nodes = [
        graphNode("parent"),
        graphNode("child", { parentId: "parent" }),
        graphNode("other"),
      ];

      const layout = layoutSchedulerGraph(
        {
          nodes,
          edges: [edge("parent", "other"), edge("child", "other")],
        },
        new Set(["other"]),
      );

      expect([...layout.nodes.keys()]).toEqual(["parent", "other"]);
      expect(layout.nodes.get("parent")).toMatchObject({
        childCount: 1,
        collapsedChildCount: 1,
      });
      expect(layout.edges.map((e) => e.id)).toEqual(["parent->other"]);
    });

    it("returns a sink collapsed under the parent its entity infers", () => {
      const parent = graphNode(`computation:${SPACE}/of:fid1:AAAA/value`);
      const sink = graphNode(`sink:${SPACE}/of:fid1:AAAA/value`, {
        type: "effect",
      });

      const layout = layoutSchedulerGraph(
        { nodes: [parent, sink], edges: [] },
        new Set(),
      );

      expect([...layout.nodes.keys()]).toEqual([parent.id]);
      expect(layout.nodes.get(parent.id)?.collapsedChildCount).toBe(1);
    });

    it("returns an expanded parent's children and their edges", () => {
      const layout = layoutSchedulerGraph(
        {
          nodes: [
            graphNode("parent"),
            graphNode("child", { parentId: "parent" }),
            graphNode("other"),
          ],
          edges: [edge("child", "other")],
        },
        new Set(["parent"]),
      );

      expect([...layout.nodes.keys()]).toEqual(["parent", "child", "other"]);
      expect(layout.nodes.get("parent")).toMatchObject({
        childCount: 1,
        collapsedChildCount: undefined,
      });
      expect(layout.edges.map((e) => e.id)).toEqual(["child->other"]);
    });

    describe("given nested parents", () => {
      // `a` is the parent of `b`, which is the parent of `c`.

      const graph = {
        nodes: [
          graphNode("a"),
          graphNode("b", { parentId: "a" }),
          graphNode("c", { parentId: "b" }),
        ],
        edges: [edge("b", "c")],
      };

      it("returns a grandchild hidden when its grandparent is collapsed, though its parent is expanded", () => {
        const layout = layoutSchedulerGraph(graph, new Set(["b"]));

        expect([...layout.nodes.keys()]).toEqual(["a"]);
        expect(layout.nodes.get("a")?.collapsedChildCount).toBe(2);
        expect(layout.edges).toEqual([]);
      });

      it("returns every descendant of the outermost collapsed parent counted on it alone", () => {
        const layout = layoutSchedulerGraph(graph, new Set());

        expect([...layout.nodes.keys()]).toEqual(["a"]);
        expect(layout.nodes.get("a")?.collapsedChildCount).toBe(2);
      });

      it("returns the descendants of a collapsed parent within an expanded one counted on that parent", () => {
        const layout = layoutSchedulerGraph(graph, new Set(["a"]));

        expect([...layout.nodes.keys()]).toEqual(["a", "b"]);
        expect(layout.nodes.get("a")?.collapsedChildCount).toBeUndefined();
        expect(layout.nodes.get("b")?.collapsedChildCount).toBe(1);
      });

      it("returns every generation when every parent is expanded", () => {
        const layout = layoutSchedulerGraph(graph, new Set(["a", "b"]));

        expect([...layout.nodes.keys()]).toEqual(["a", "b", "c"]);
        expect(layout.edges.map((e) => e.id)).toEqual(["b->c"]);
      });
    });

    it("returns every node of the graph described, hidden or not", () => {
      const layout = layoutSchedulerGraph(
        {
          nodes: [
            graphNode("parent", { stats: stats(1, 2) }),
            graphNode("child", { parentId: "parent", stats: stats(3, 4) }),
          ],
          edges: [],
        },
        new Set(),
      );

      expect([...layout.nodes.keys()]).toEqual(["parent"]);
      expect([...layout.allNodes.values()]).toEqual([
        {
          id: "parent",
          label: "parent",
          fullId: "parent",
          type: "computation",
          stats: stats(1, 2),
          isDirty: false,
          isPending: false,
          parentId: undefined,
          childCount: 1,
          preview: undefined,
          reads: undefined,
          writes: undefined,
          debounceMs: undefined,
          throttleMs: undefined,
          patternIdentity: undefined,
        },
        expect.objectContaining({
          id: "child",
          parentId: "parent",
          childCount: undefined,
          stats: stats(3, 4),
        }),
      ]);
      expect(layout.allNodes.get("child")).not.toHaveProperty("x");
    });

    it("returns a node whose parent the graph does not list, since nothing drawn could expand it", () => {
      const layout = layoutSchedulerGraph(
        { nodes: [graphNode("orphan", { parentId: "absent" })], edges: [] },
        new Set(),
      );

      expect([...layout.nodes.keys()]).toEqual(["orphan"]);
    });

    it("returns a parent cycle with the member it is entered at drawn, its parent dropped, and the rest under it", () => {
      // The walk up from `w` enters the cycle of `x` and `y` at `x`.
      const graph = {
        nodes: [
          graphNode("w", { parentId: "x" }),
          graphNode("y", { parentId: "x" }),
          graphNode("x", { parentId: "y" }),
          graphNode("z"),
        ],
        edges: [],
      };

      const collapsed = layoutSchedulerGraph(graph, new Set());
      const expanded = layoutSchedulerGraph(graph, new Set(["x"]));

      expect([...collapsed.nodes.keys()]).toEqual(["x", "z"]);
      expect(collapsed.nodes.get("x")).toMatchObject({
        parentId: undefined,
        childCount: 2,
        collapsedChildCount: 2,
      });
      expect(collapsed.allNodes.get("y")?.parentId).toBe("x");
      expect([...expanded.nodes.keys()]).toEqual(["w", "y", "x", "z"]);
    });
  });

  describe("computeParentGroups()", () => {
    it("returns a group for each parent among the nodes, bounding it and its children with 15 to spare", () => {
      const parent = layoutNode("parent", { x: 100, y: 50 });
      const child = layoutNode("child", { x: 300, y: 150, parentId: "parent" });
      const orphan = layoutNode("orphan", { parentId: "absent" });
      const nodes = new Map([parent, child, orphan].map((n) => [n.id, n]));

      expect(computeParentGroups(nodes)).toEqual(
        new Map([["parent", {
          parent,
          children: [child],
          bounds: { x: 15, y: 17, width: 370, height: 166 },
        }]]),
      );
    });
  });

  describe("adjacentNodes()", () => {
    const nodes = new Map(
      ["a", "b", "c", "d"].map((id) => [id, layoutNode(id)]),
    );
    const edges: LayoutEdge[] = [
      layoutEdge("b", "a"),
      layoutEdge("c", "a"),
      layoutEdge("b", "a"),
      layoutEdge("d", "a", "parent"),
      layoutEdge("gone", "a"),
      layoutEdge("a", "d"),
    ];

    it("returns each node with a data edge into the node once, in edge order", () => {
      expect(adjacentNodes(nodes, edges, "a", "inbound").map((n) => n.id))
        .toEqual(["b", "c"]);
    });

    it("returns each node a data edge out of the node reaches", () => {
      expect(adjacentNodes(nodes, edges, "a", "outbound").map((n) => n.id))
        .toEqual(["d"]);
      expect(adjacentNodes(nodes, edges, "c", "inbound")).toEqual([]);
    });
  });

  describe("nodeTooltip()", () => {
    it("returns the id and that an input has no writer", () => {
      expect(nodeTooltip(layoutNode("input:x", { type: "input" }))).toBe(
        "input:x\n(Source cell - no writer)",
      );
    });

    it("returns an action's id, preview, and the first five cells it reads and writes", () => {
      const node = layoutNode("a", {
        preview: "() => 1",
        reads: ["r1", "r2", "r3", "r4", "r5", "r6"],
        writes: ["w1"],
      });

      expect(nodeTooltip(node)).toBe(
        "a\n\n() => 1\nReads (6): r1, r2, r3, r4, r5...\nWrites (1): w1",
      );
    });

    it("returns `none` for an action that reads and writes nothing", () => {
      expect(nodeTooltip(layoutNode("a", { reads: [] }))).toBe(
        "a\nReads: none\nWrites: none",
      );
    });
  });

  describe("fitZoom()", () => {
    it("returns the zoom that fits the drawing in the viewport with 40 to spare", () => {
      expect(fitZoom(viewport({ width: 440, height: 340 }), 800, 400, 3))
        .toBe(0.5);
    });

    it("returns at most 1, and at least 0.1", () => {
      expect(fitZoom(viewport({ width: 4000, height: 4000 }), 800, 400, 3))
        .toBe(1);
      expect(fitZoom(viewport({ width: 50, height: 50 }), 800, 400, 3))
        .toBe(0.1);
    });

    it("returns the zoom it was given when there is no viewport", () => {
      expect(fitZoom(null, 800, 400, 3)).toBe(3);
    });
  });

  describe("zoomAroundCenter()", () => {
    it("scrolls, once the next frame renders, so that the point at the center stays there", () => {
      const view = viewport({ width: 400, height: 300, left: 100, top: 50 });
      const frames = frameQueue();

      zoomAroundCenter(view, 1, 2, frames.schedule);
      expect([view.scrollLeft, view.scrollTop]).toEqual([100, 50]);
      frames.run();

      expect([view.scrollLeft, view.scrollTop]).toEqual([400, 250]);
    });

    it("scrolls no further than the start", () => {
      const view = viewport({ width: 400, height: 300, left: 100, top: 50 });
      const frames = frameQueue();

      zoomAroundCenter(view, 1, 0.5, frames.schedule);
      frames.run();

      expect([view.scrollLeft, view.scrollTop]).toEqual([0, 0]);
    });

    it("schedules nothing without a viewport or a change of zoom", () => {
      const frames = frameQueue();

      zoomAroundCenter(null, 1, 2, frames.schedule);
      zoomAroundCenter(viewport({}), 2, 2, frames.schedule);

      expect(frames.pending).toBe(0);
    });
  });

  describe("zoomAtPointer()", () => {
    const step = (deltaY: number) => ({ clientX: 110, clientY: 70, deltaY });

    it("returns the zoom a tenth further in for a step up, keeping the point under the pointer in place", () => {
      const view = viewport({ left: 100, top: 50, rectLeft: 10, rectTop: 20 });
      const frames = frameQueue();

      expect(zoomAtPointer(view, 1, step(-1), frames.schedule)).toBe(1.1);
      frames.run();

      // The pointer is at 200 by 100 of the drawing at zoom 1.
      expect(view.scrollLeft).toBeCloseTo(200 * 1.1 - 100);
      expect(view.scrollTop).toBeCloseTo(100 * 1.1 - 50);
    });

    it("returns the zoom a tenth further out for a step down", () => {
      expect(zoomAtPointer(viewport({}), 1, step(1), () => {})).toBe(0.9);
    });

    it("returns the zoom unchanged, scheduling nothing, at 5 going in and at 0.1 going out", () => {
      const frames = frameQueue();

      expect(zoomAtPointer(viewport({}), 5, step(-1), frames.schedule))
        .toBe(5);
      expect(zoomAtPointer(viewport({}), 0.1, step(1), frames.schedule))
        .toBe(0.1);
      expect(frames.pending).toBe(0);
    });

    it("returns the zoom unchanged without a viewport", () => {
      expect(zoomAtPointer(null, 1, step(-1), () => {})).toBe(1);
    });
  });

  describe("centerOn()", () => {
    it("returns `CENTERED_ZOOM`, and scrolls the point to the center at that zoom", () => {
      const view = viewport({ width: 400, height: 300 });
      const frames = frameQueue();

      expect(centerOn(view, 1000, 800, 2, frames.schedule)).toBe(
        CENTERED_ZOOM,
      );
      frames.run();

      expect([view.scrollLeft, view.scrollTop]).toEqual([
        1000 * CENTERED_ZOOM - 200,
        800 * CENTERED_ZOOM - 150,
      ]);
    });

    it("returns the zoom it was given without a viewport", () => {
      expect(centerOn(null, 1000, 800, 2, () => {})).toBe(2);
    });
  });
});
