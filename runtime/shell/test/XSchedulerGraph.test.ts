import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { SchedulerGraphNode } from "@commonfabric/runtime-client";

import {
  DebuggerController,
  type GraphEdgeWithHistory,
  type GraphWithHistory,
} from "../src/lib/debugger-controller.ts";
import type { GraphViewport } from "../src/lib/scheduler-graph-layout.ts";
import { XSchedulerGraph } from "../src/views/SchedulerGraphView.ts";
import {
  templateBindings,
  templateListeners,
  templateMarkup,
} from "./lit-template-markup.ts";

/** A space id long enough that no label holding it fits the default bound. */
const SPACE = "did:key:z6MkabcdefghijkLMNOP";

/**
 * A debugger controller that serves the graph a test sets, and records the
 * requests the view makes of it rather than passing them to a runtime.
 */
class StandInController extends DebuggerController {
  graph: GraphWithHistory | undefined = undefined;
  graphVersion = 0;
  readonly requests: string[] = [];

  override getGraphWithHistory(): GraphWithHistory | undefined {
    return this.graph;
  }

  override getGraphUpdateVersion(): number {
    return this.graphVersion;
  }

  override requestGraphSnapshot(): Promise<void> {
    this.requests.push("snapshot");
    return Promise.resolve();
  }

  override requestFlags(): Promise<void> {
    this.requests.push("flags");
    return Promise.resolve();
  }

  override requestPatternSources(): Promise<void> {
    this.requests.push("sources");
    return Promise.resolve();
  }
}

/** Stats for `runCount` runs taking `totalTime` milliseconds in all. */
function stats(runCount: number, totalTime: number) {
  return {
    runCount,
    totalTime,
    averageTime: totalTime / runCount,
    lastRunTime: totalTime / runCount,
    lastRunTimestamp: 0,
  };
}

/** A scheduler graph computation for `id`, which ran once for 1ms. */
function action(
  id: string,
  extra: Partial<SchedulerGraphNode> = {},
): SchedulerGraphNode {
  return {
    id,
    type: "computation",
    isDirty: false,
    isPending: false,
    stats: stats(1, 1),
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

/**
 * A view showing `nodes` and `edges`, laid out by the view's own update step
 * from a stand-in controller.
 */
function viewOf(
  nodes: SchedulerGraphNode[],
  edges: GraphEdgeWithHistory[] = [],
) {
  const graph = new XSchedulerGraph();
  const controller = new StandInController(graph);
  controller.graph = { nodes, edges, timestamp: 0 };
  graph.debuggerController = controller;
  graph.updated(new Map());
  return { graph, controller };
}

/**
 * Connects `graph` the way a page does, except that updates do nothing, since
 * there is no DOM to render into.
 */
function connect(graph: XSchedulerGraph): void {
  Object.defineProperty(graph, "performUpdate", { value: () => {} });
  Object.defineProperty(graph, "renderRoot", { value: {} });
  graph.connectedCallback();
}

/**
 * Gives `graph` a stand-in for the container it draws the graph in, at the
 * page's origin, with the given size and scroll offsets, and returns it.
 */
function standInContainer(
  graph: XSchedulerGraph,
  size: { width: number; height: number; left?: number; top?: number },
): GraphViewport {
  const container = {
    clientWidth: size.width,
    clientHeight: size.height,
    scrollLeft: size.left ?? 0,
    scrollTop: size.top ?? 0,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  Object.defineProperty(graph, "renderRoot", {
    value: { querySelector: () => container },
  });
  return container;
}

/**
 * Returns what the view renders now, with each run of whitespace one space
 * and each listener `[listener]`.
 */
function markup(graph: XSchedulerGraph): string {
  return templateMarkup(graph.render(), { elideListeners: true })
    .replaceAll(/\s+/g, " ");
}

/** A cancelable event of type `type`, at `clientX` and `clientY`. */
function pointerEvent(
  type: string,
  extra: Record<string, unknown> = {},
): Event {
  return Object.assign(
    new Event(type, { cancelable: true }),
    { clientX: 0, clientY: 0, ...extra },
  );
}

/**
 * Fires `event` at the one element of what the view renders now whose
 * opening tag and the text after it hold every one of `needles`, and returns
 * the event.
 */
async function fire(
  graph: XSchedulerGraph,
  needles: string[],
  event: Event = pointerEvent("click"),
): Promise<Event> {
  const matches = templateListeners(graph.render(), event.type, graph)
    .filter(({ tag, text }) =>
      needles.every((needle) => `${tag}${text}`.includes(needle))
    );
  expect(matches.map(({ tag }) => tag)).toHaveLength(1);
  await matches[0].dispatch(event);
  return event;
}

/** Switches the view to the graph. */
async function showGraph(graph: XSchedulerGraph): Promise<void> {
  await fire(graph, ['title="Graph view"']);
}

describe("XSchedulerGraph", () => {
  // The view schedules its scrolling on animation frames. Each case holds
  // them in `frames`, and runs them when it chooses.

  let frames: (() => void)[] = [];
  let original: PropertyDescriptor | undefined;

  beforeEach(() => {
    frames = [];
    original = Object.getOwnPropertyDescriptor(
      globalThis,
      "requestAnimationFrame",
    );
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: (callback: FrameRequestCallback) => {
        frames.push(() => callback(0));
        return frames.length;
      },
    });
  });

  afterEach(() => {
    if (original) {
      Object.defineProperty(globalThis, "requestAnimationFrame", original);
    } else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  });

  describe("instance members", () => {
    describe("connectedCallback()", () => {
      it("lays out the controller's graph", () => {
        const graph = new XSchedulerGraph();
        const controller = new StandInController(graph);
        controller.graph = {
          nodes: [action("a"), action("b")],
          edges: [edge("a", "b")],
          timestamp: 0,
        };
        graph.debuggerController = controller;
        expect(graph.accessForTestingOnly.layoutNodes.size).toBe(0);

        connect(graph);

        expect([...graph.accessForTestingOnly.layoutNodes.keys()]).toEqual([
          "a",
          "b",
        ]);
        expect(markup(graph)).toContain(
          'Edges: <span class="stat-value">1</span>',
        );
        graph.disconnectedCallback();
      });

      it("lays out nothing without a controller", () => {
        const graph = new XSchedulerGraph();
        connect(graph);

        expect(graph.accessForTestingOnly.layoutNodes.size).toBe(0);
        expect(markup(graph)).toContain(
          'Nodes: <span class="stat-value">0</span>',
        );
        graph.disconnectedCallback();
      });
    });

    describe("updated()", () => {
      it("lays out the controller's graph", () => {
        const { graph } = viewOf([action("a"), action("b")], [
          edge("a", "b"),
        ]);

        const text = markup(graph);

        expect(text).toContain('Nodes: <span class="stat-value">2</span>');
        expect(text).toContain('Edges: <span class="stat-value">1</span>');
      });

      it("lays the graph out again only once the controller's graph version moves", () => {
        const { graph, controller } = viewOf([action("a")]);
        controller.graph = {
          nodes: [action("a"), action("b")],
          edges: [],
          timestamp: 1,
        };

        graph.updated(new Map());
        expect(markup(graph)).toContain(
          'Nodes: <span class="stat-value">1</span>',
        );

        controller.graphVersion++;
        graph.updated(new Map());
        expect(markup(graph)).toContain(
          'Nodes: <span class="stat-value">2</span>',
        );
      });

      it("clears the layout when the controller has no graph", () => {
        const { graph, controller } = viewOf([action("a")]);
        controller.graph = undefined;
        controller.graphVersion++;

        graph.updated(new Map());

        expect(markup(graph)).toContain(
          'Nodes: <span class="stat-value">0</span>',
        );
      });

      it("schedules a zoom to fit once, for the first graph that has nodes", async () => {
        const { graph, controller } = viewOf([]);
        expect(frames).toHaveLength(0);

        controller.graph = { nodes: [action("a")], edges: [], timestamp: 1 };
        controller.graphVersion++;
        graph.updated(new Map());
        controller.graphVersion++;
        graph.updated(new Map());
        expect(frames).toHaveLength(1);

        // The container leaves 400 by 200 for the drawing, which is at least
        // 800 by 400, so the drawing fits at half size.
        standInContainer(graph, { width: 440, height: 240 });
        frames[0]();
        await showGraph(graph);
        expect(markup(graph)).toContain("> 50% <");
        expect(markup(graph)).toContain('width="400" height="200"');
      });
    });

    describe("render()", () => {
      describe("toolbar", () => {
        it("shows the runs and time summed over the graph", () => {
          const { graph } = viewOf([
            action("a", { stats: stats(3, 6) }),
            action("b", { stats: stats(2, 4) }),
          ]);

          expect(markup(graph)).toContain(
            'Total: <span class="stat-value">5 runs</span> <span class="stat-value">10.0ms</span>',
          );
        });

        it("shows the count of historical edges only when there are some", () => {
          const current = viewOf([action("a"), action("b")], [edge("a", "b")]);
          const historical = viewOf([action("a"), action("b")], [
            edge("a", "b", { isHistorical: true }),
          ]);

          expect(markup(current.graph)).not.toContain("Historical:");
          expect(markup(historical.graph)).toContain(
            'Historical: <span class="stat-value">1</span>',
          );
          expect(markup(historical.graph)).toContain(
            'Edges: <span class="stat-value">0</span>',
          );
        });

        it("records the current stats as the baseline when Reset Baseline is clicked, and shows the change since", async () => {
          const { graph, controller } = viewOf([
            action("a", { stats: stats(3, 6) }),
          ]);
          expect(markup(graph)).not.toContain("Δ:");

          await fire(graph, ['title="Reset baseline']);
          expect(controller.getSchedulerBaselineStats()).toEqual(
            new Map([["a", { runCount: 3, totalTime: 6 }]]),
          );
          expect(markup(graph)).toContain(
            'Δ: <span class="stat-value delta">0 runs</span> <span class="stat-value delta">-</span>',
          );

          controller.graph = {
            nodes: [action("a", { stats: stats(5, 8) })],
            edges: [],
            timestamp: 1,
          };
          controller.graphVersion++;
          graph.updated(new Map());

          expect(markup(graph)).toContain(
            'Δ: <span class="stat-value delta positive">+2 runs</span> <span class="stat-value delta positive">+2.0ms</span>',
          );
        });

        it("shows a fall since the baseline signed, in the unit its size calls for", () => {
          const { graph, controller } = viewOf([
            action("a", { stats: stats(3, 6.5) }),
          ]);
          controller.setSchedulerBaselineStats(
            new Map([["a", { runCount: 5, totalTime: 8 }]]),
          );

          expect(markup(graph)).toContain(
            'Δ: <span class="stat-value delta">-2 runs</span> <span class="stat-value delta">-1.5ms</span>',
          );
        });

        it("sums over every node, and records every node in the baseline, whatever the graph view hides", async () => {
          // The parent starts collapsed, hiding its child from the graph.

          const { graph, controller } = viewOf([
            action("parent", { stats: stats(1, 10) }),
            action("child", { parentId: "parent", stats: stats(2, 5) }),
          ]);
          const totals =
            'Total: <span class="stat-value">3 runs</span> <span class="stat-value">15.0ms</span>';
          const unchanged =
            'Δ: <span class="stat-value delta">0 runs</span> <span class="stat-value delta">-</span>';
          expect(markup(graph)).toContain(totals);

          await fire(graph, ['title="Reset baseline']);
          expect(controller.getSchedulerBaselineStats()).toEqual(
            new Map([
              ["parent", { runCount: 1, totalTime: 10 }],
              ["child", { runCount: 2, totalTime: 5 }],
            ]),
          );
          await showGraph(graph);
          await fire(graph, ['class="node-collapse-toggle"']);

          expect([...graph.accessForTestingOnly.layoutNodes.keys()]).toEqual([
            "parent",
            "child",
          ]);
          expect(markup(graph)).toContain(totals);
          expect(markup(graph)).toContain(unchanged);
        });

        it("requests a snapshot when Snapshot is clicked", async () => {
          const { graph, controller } = viewOf([]);

          await fire(graph, ['title="Capture current scheduler state"']);

          expect(controller.requests).toEqual(["snapshot"]);
        });
      });

      describe("view toggle", () => {
        it("shows the table first", () => {
          const { graph } = viewOf([action("a")]);

          const text = markup(graph);

          expect(text).toContain('class="stats-table"');
          expect(text.match(/toggle-button active/g)).toHaveLength(1);
          expect(text).toMatch(/toggle-button active"[^>]*title="Table view/);
        });

        it("shows the view each button selects", async () => {
          const { graph } = viewOf([action("a")]);

          await showGraph(graph);
          expect(markup(graph)).toContain('class="graph-svg"');
          await fire(graph, ['title="Actions with invalid']);
          expect(markup(graph)).toContain('class="flags-container"');
          await fire(graph, ['title="View pattern source']);
          expect(markup(graph)).toContain("<x-scheduler-source");
          await fire(graph, ['title="Table view']);
          expect(markup(graph)).toContain('class="stats-table"');
        });

        it("requests the flags for the flags view, and the pattern sources for the source view", async () => {
          const { graph, controller } = viewOf([]);

          await fire(graph, ['title="Actions with invalid']);
          await fire(graph, ['title="View pattern source']);

          expect(controller.requests).toEqual(["flags", "sources"]);
        });

        it("centers the graph on the selected node two frames after switching to it", async () => {
          // The container stands in for the one the graph is drawn in, small
          // enough that centering scrolls it in both directions.

          const { graph } = viewOf([action("a")]);
          const container = standInContainer(graph, { width: 10, height: 10 });
          await fire(graph, ['title="a"']);
          const node = graph.accessForTestingOnly.layoutNodes.get("a")!;

          await showGraph(graph);
          expect(frames).toHaveLength(2);
          frames[1]();
          expect(frames).toHaveLength(3);
          frames[2]();
          expect(frames).toHaveLength(4);
          frames[3]();

          expect(container.scrollLeft).toBe(node.x * 0.5 - 5);
          expect(container.scrollTop).toBe(node.y * 0.5 - 5);
          expect(markup(graph)).toContain("50%");
        });

        it("schedules nothing when switching to the graph with nothing selected", async () => {
          const { graph } = viewOf([action("a")]);
          frames.length = 0;

          await showGraph(graph);

          expect(frames).toHaveLength(0);
        });
      });

      describe("graph view", () => {
        it("shows a button to load the graph when there is none", async () => {
          const { graph, controller } = viewOf([]);
          await showGraph(graph);

          expect(markup(graph)).toContain("No graph data available");
          await fire(graph, ["Load Graph"]);
          expect(controller.requests).toEqual(["snapshot"]);
        });

        it("draws each node with its kind, state, label, and stats", async () => {
          const { graph } = viewOf([
            action("a", { type: "effect", isDirty: true, stats: stats(3, 6) }),
            action("b", { isPending: true, stats: undefined }),
            action("input:c", { type: "input", stats: undefined }),
          ]);
          await showGraph(graph);

          const text = markup(graph);

          expect(text).toMatch(
            /class="node-group node-effect node-dirty"[^]*?node-type-badge" x="4" y="10" > E <[^]*?> a <[^]*?> 3× 2ms </,
          );
          expect(text).toMatch(
            /class="node-group node-computation node-pending"[^]*?node-type-badge" x="4" y="10" > C </,
          );
          expect(text).toMatch(
            /class="node-group node-input"[^]*?<title>input:c \(Source cell - no writer\)<\/title>[^]*?> I </,
          );
          expect(text.match(/class="node-stats"/g)).toHaveLength(1);
        });

        it("draws each edge from the bottom of its source to the top of its target", async () => {
          const { graph } = viewOf([action("a"), action("b"), action("c")], [
            edge("a", "b"),
            edge("b", "c", { isHistorical: true, edgeType: "parent" }),
            edge("c", "gone"),
          ]);
          await showGraph(graph);
          const nodes = graph.accessForTestingOnly.layoutNodes;
          const [a, b] = [nodes.get("a")!, nodes.get("b")!];

          const text = markup(graph);

          expect(text).toContain(
            `class="edge-path edge-current" d="M ${a.x} ${a.y + 18} L ${b.x} ${
              b.y - 18
            }"`,
          );
          expect(text).toContain(
            'class="edge-path edge-historical edge-parent"',
          );
          expect(text.match(/<path/g)).toHaveLength(2);
        });

        it("draws a collapsed parent with a toggle and the count of its hidden children", async () => {
          const { graph } = viewOf([
            action("parent"),
            action("child", { parentId: "parent" }),
            action("leaf"),
          ]);
          await showGraph(graph);

          const text = markup(graph);

          expect(text).toMatch(/class="node-collapse-toggle"[^]*?> \+ </);
          expect(text).toContain("(1 hidden)");
          expect(text.match(/node-collapse-toggle/g)).toHaveLength(1);
        });

        it("stops a click on a collapse toggle from reaching the node", async () => {
          const { graph } = viewOf([
            action("parent"),
            action("child", { parentId: "parent" }),
          ]);
          await showGraph(graph);

          const event = await fire(graph, ['class="node-collapse-toggle"']);

          expect(event.cancelBubble).toBe(true);
        });

        it("shows a parent's children when its toggle is clicked, and hides them again on a second click", async () => {
          const { graph } = viewOf([
            action("parent"),
            action("child", { parentId: "parent" }),
          ]);
          await showGraph(graph);
          expect(markup(graph)).toContain("(1 hidden)");
          expect([...graph.accessForTestingOnly.layoutNodes.keys()]).toEqual([
            "parent",
          ]);

          await fire(graph, ['class="node-collapse-toggle"']);

          expect(markup(graph)).toMatch(/node-collapse-toggle"[^]*?> - </);
          expect(markup(graph)).not.toContain("hidden)");
          expect([...graph.accessForTestingOnly.layoutNodes.keys()]).toEqual([
            "parent",
            "child",
          ]);

          await fire(graph, ['class="node-collapse-toggle"']);

          expect(markup(graph)).toMatch(/node-collapse-toggle"[^]*?> \+ </);
          expect(markup(graph)).toContain("(1 hidden)");
          expect([...graph.accessForTestingOnly.layoutNodes.keys()]).toEqual([
            "parent",
          ]);
        });

        it("draws a box around an expanded parent and its children, labeled with the parent", async () => {
          // The child is the parent's by the entity they share. The group's
          // label is the parent's full id cut to a bound of 12, which keeps
          // the prefix and the tail of the entity.

          const parentId =
            `computation:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`;
          const childId = `sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`;
          const { graph } = viewOf([
            action(parentId),
            action(childId, { type: "effect" }),
          ]);
          await showGraph(graph);
          expect(markup(graph)).not.toContain('class="parent-group"');

          await fire(graph, ['class="node-collapse-toggle"']);
          const nodes = graph.accessForTestingOnly.layoutNodes;
          expect([...nodes.keys()]).toEqual([parentId, childId]);
          const [p, c] = [nodes.get(parentId)!, nodes.get(childId)!];
          const left = Math.min(p.x, c.x) - 70 - 15;
          const top = Math.min(p.y, c.y) - 18 - 15;
          const right = Math.max(p.x, c.x) + 70 + 15;
          const bottom = Math.max(p.y, c.y) + 18 + 15;

          const text = markup(graph);
          expect(text.match(/class="parent-group"/g)).toHaveLength(1);
          expect(text).toContain(
            `class="parent-group-rect" x="${left}" y="${top}" width="${
              right - left
            }" height="${bottom - top}"`,
          );
          expect(text).toContain(
            `class="parent-group-label" x="${left + 6}" y="${
              top + 12
            }" > computation:...DDDD <`,
          );
        });
      });

      describe("zoom", () => {
        it("zooms in and out by a quarter, keeping the point at the center there", async () => {
          const { graph } = viewOf([action("a")]);
          const container = standInContainer(graph, {
            width: 400,
            height: 300,
          });
          await showGraph(graph);
          frames.length = 0;

          await fire(graph, ['title="Zoom in"']);
          expect(markup(graph)).toContain("> 125% <");
          expect(markup(graph)).toContain('width="1000" height="500"');
          expect(frames).toHaveLength(1);
          frames[0]();
          expect([container.scrollLeft, container.scrollTop]).toEqual([
            200 * 1.25 - 200,
            150 * 1.25 - 150,
          ]);

          await fire(graph, ['title="Zoom out"']);
          await fire(graph, ['title="Zoom out"']);
          expect(markup(graph)).toContain("> 80% <");
        });

        it("zooms to fit the container on a reset", async () => {
          // The container leaves 400 by 200 for the drawing, which is 800 by
          // 400, so the drawing fits at half size.

          const { graph } = viewOf([action("a")]);
          standInContainer(graph, { width: 440, height: 240 });
          await showGraph(graph);

          await fire(graph, ['title="Reset zoom"']);

          expect(markup(graph)).toContain("> 50% <");
          expect(markup(graph)).toContain('width="400" height="200"');
        });

        it("leaves the zoom alone on a reset when the graph has not been drawn", async () => {
          const { graph } = viewOf([action("a")]);
          await showGraph(graph);
          await fire(graph, ['title="Zoom in"']);

          await fire(graph, ['title="Reset zoom"']);
          frames.forEach((frame) => frame());

          expect(markup(graph)).toContain("> 125% <");
        });

        it("takes a wheel step as a zoom only with a modifier key held, keeping the point under the pointer there", async () => {
          // The pointer is at 120 by 60 of the drawing, which is scrolled by
          // 100 by 50.

          const { graph } = viewOf([action("a")]);
          const container = standInContainer(graph, {
            width: 400,
            height: 300,
            left: 100,
            top: 50,
          });
          await showGraph(graph);
          frames.length = 0;
          const pointer = { deltaY: -1, clientX: 20, clientY: 10 };

          const plain = await fire(
            graph,
            ['class="graph-container"'],
            pointerEvent("wheel", pointer),
          );
          expect(plain.defaultPrevented).toBe(false);
          expect(markup(graph)).toContain("> 100% <");
          expect(frames).toHaveLength(0);

          const zoom = await fire(
            graph,
            ['class="graph-container"'],
            pointerEvent("wheel", { ...pointer, metaKey: true }),
          );
          expect(zoom.defaultPrevented).toBe(true);
          expect(markup(graph)).toContain("> 110% <");
          expect(frames).toHaveLength(1);
          frames[0]();
          expect(container.scrollLeft).toBeCloseTo(120 * 1.1 - 20);
          expect(container.scrollTop).toBeCloseTo(60 * 1.1 - 10);
        });
      });

      describe("selection", () => {
        it("selects a node clicked in the graph, and deselects it on a second click", async () => {
          const { graph } = viewOf([action("a")]);
          await showGraph(graph);

          const event = await fire(graph, ['class="node-group']);
          expect(event.cancelBubble).toBe(true);
          expect(markup(graph)).toContain(
            "node-group node-computation node-selected",
          );
          expect(markup(graph)).toContain('class="detail-pane"');

          await fire(graph, ['class="node-group']);
          expect(markup(graph)).not.toContain("node-selected");
          expect(markup(graph)).not.toContain('class="detail-pane"');
        });

        it("clears the selection on a click on the graph's background", async () => {
          const { graph } = viewOf([action("a")]);
          await showGraph(graph);
          await fire(graph, ['class="node-group']);

          await fire(graph, ['class="graph-container"']);

          expect(markup(graph)).not.toContain('class="detail-pane"');
        });

        it("shows an edge clicked in the graph beside the pointer, and hides it on a second click", async () => {
          const { graph } = viewOf([action("a"), action("b")], [
            edge("a", "b", { cells: ["cell-1"], isHistorical: true }),
          ]);
          await showGraph(graph);

          const event = await fire(
            graph,
            ['class="edge-path'],
            pointerEvent("click", { clientX: 30, clientY: 40 }),
          );
          const text = markup(graph);

          expect(event.cancelBubble).toBe(true);
          expect(text).toContain(
            'class="tooltip" style="left: 40px; top: 50px;"',
          );
          expect(text).toContain("a → b");
          expect(text).toContain('<div class="tooltip-cell">cell-1</div>');
          expect(text).toContain("Historical (no longer active)");
          expect(text).toContain('<span class="detail-pane-title">Edge</span>');
          expect(text).toContain("This edge is historical (no longer active)");

          await fire(graph, ['class="edge-path']);
          expect(markup(graph)).not.toContain('class="tooltip"');
        });
      });

      describe("detail pane", () => {
        it("shows a node's stats, with their change since the baseline", async () => {
          const { graph, controller } = viewOf([
            action("a", { stats: stats(5, 2500) }),
          ]);
          controller.setSchedulerBaselineStats(
            new Map([["a", { runCount: 3, totalTime: 500 }]]),
          );

          await fire(graph, ['title="a"']);
          const text = markup(graph);

          expect(text).toContain(
            '<div class="detail-stat-label">Runs</div> <div class="detail-stat-value"> 5 </div> <div class="detail-stat-delta positive"> +2 </div>',
          );
          expect(text).toContain(
            '<div class="detail-stat-label">Total</div> <div class="detail-stat-value"> 2.50s </div> <div class="detail-stat-delta positive"> +2.00s </div>',
          );
          expect(text).toContain(
            '<div class="detail-stat-label">Average</div> <div class="detail-stat-value"> 500.0ms </div>',
          );
        });

        it("shows no change for a node's stats when there is no baseline", async () => {
          const { graph } = viewOf([action("a", { stats: stats(5, 25) })]);

          await fire(graph, ['title="a"']);

          expect(markup(graph)).toContain('class="detail-stat-value"');
          expect(markup(graph)).not.toContain("detail-stat-delta");
        });

        it("shows a node's preview, and the cells it reads and writes", async () => {
          const { graph } = viewOf([
            action("a", { preview: "() => x", reads: ["r1"], writes: ["w1"] }),
          ]);

          await fire(graph, ['title="a']);
          const text = markup(graph);

          expect(text).toContain('<div class="detail-preview">() => x</div>');
          expect(text).toMatch(
            /Reads \(1\) <\/div> <div class="detail-cell-list"> <div class="detail-cell">r1<\/div>/,
          );
          expect(text).toMatch(
            /Writes \(1\) <\/div> <div class="detail-cell-list"> <div class="detail-cell">w1<\/div>/,
          );
          expect(text).not.toContain("View in Source");
        });

        it("switches to the source view from a node that names its source location", async () => {
          const id = "action:pattern/main.tsx:3:5";
          const { graph, controller } = viewOf([action(id)]);
          await fire(graph, [`title="${id}"`]);

          await fire(graph, ['class="source-jump-button"']);

          expect(controller.requests).toEqual(["sources"]);
          expect(markup(graph)).toContain("<x-scheduler-source");
        });

        it("shows the nodes on either side of a node's data edges, and selects one clicked", async () => {
          const { graph } = viewOf([action("a"), action("b"), action("c")], [
            edge("a", "b"),
            edge("b", "c"),
          ]);
          await fire(graph, ['title="b"']);

          const text = markup(graph);
          expect(text).toMatch(
            /Dependents \(1\) <\/div> <div class="adjacent-nodes"> <div class="adjacent-node" [^>]*title="a"/,
          );
          expect(text).toMatch(
            /Dependencies \(1\) <\/div> <div class="adjacent-nodes"> <div class="adjacent-node" [^>]*title="c"/,
          );

          await fire(graph, ['class="adjacent-node"', 'title="c"']);
          expect(markup(graph)).toContain(
            '<div class="detail-section-content">c</div>',
          );
        });

        it("shows the neighbors of a node the graph hides, selected from the table", async () => {
          const { graph } = viewOf([
            action("parent"),
            action("child", { parentId: "parent" }),
            action("before"),
            action("after"),
          ], [edge("before", "child"), edge("child", "after")]);
          await fire(graph, ['class="expand-toggle"']);
          await fire(graph, ['class="child-row', 'title="child"']);

          const text = markup(graph);
          expect(graph.accessForTestingOnly.layoutNodes.has("child")).toBe(
            false,
          );
          expect(text).toMatch(
            /Dependents \(1\) <\/div> <div class="adjacent-nodes"> <div class="adjacent-node" [^>]*title="before"/,
          );
          expect(text).toMatch(
            /Dependencies \(1\) <\/div> <div class="adjacent-nodes"> <div class="adjacent-node" [^>]*title="after"/,
          );
        });

        it("shows the diagnostics recorded for a node with invalid input", async () => {
          const { graph, controller } = viewOf([action("a"), action("b")]);
          controller.updateFlags({
            runner: {
              "action invalid input": {
                a: { schema: { type: "number" }, raw: "seven" },
                b: {},
              },
            },
          });

          await fire(graph, ['title="a"']);
          const text = markup(graph);
          expect(text).toContain("Invalid Input Diagnostics");
          expect(text).toContain(
            '<pre class="flag-meta-value">{ "type": "number" }</pre>',
          );
          expect(text).toContain('<pre class="flag-meta-value">"seven"</pre>');

          await fire(graph, ['title="b"']);
          expect(markup(graph)).toContain("Invalid Input Diagnostics");
          expect(markup(graph)).not.toContain("flag-meta-field");
        });

        it("closes a node's pane on the close button", async () => {
          const { graph } = viewOf([action("a")]);
          await fire(graph, ['title="a"']);

          await fire(graph, ['class="detail-pane-close"']);

          expect(markup(graph)).not.toContain('class="detail-pane"');
        });

        it("shows an edge's ends and cells, and closes on the close button", async () => {
          const { graph } = viewOf([action("a"), action("b")], [
            edge("a", "b"),
          ]);
          await showGraph(graph);
          await fire(graph, ['class="edge-path']);

          const text = markup(graph);
          expect(text).toMatch(
            /From<\/div> <div class="detail-section-content"> a <\/div>/,
          );
          expect(text).toMatch(
            /To<\/div> <div class="detail-section-content"> b <\/div>/,
          );
          expect(text).toContain("Cells (0)");
          expect(text).toContain(
            '<div class="detail-cell">(no cells tracked)</div>',
          );
          expect(text).toContain(
            '<div class="tooltip-cell">(no cells tracked)</div>',
          );
          expect(text).not.toContain("historical");

          await fire(graph, ['class="detail-pane-close"']);
          expect(markup(graph)).not.toContain('class="detail-pane"');
        });
      });

      describe("flags view", () => {
        it("shows that no action has invalid input when none has", async () => {
          const { graph } = viewOf([action("a")]);

          await fire(graph, ['title="Actions with invalid']);

          expect(markup(graph)).toContain(
            "No actions with invalid inputs detected.",
          );
        });

        it("lists the actions with invalid input, those not in the graph apart, and selects one clicked", async () => {
          // `b` is hidden in the graph view, under its collapsed parent `a`,
          // and is in the graph all the same.

          const { graph, controller } = viewOf([
            action("a"),
            action("b", { parentId: "a" }),
            action("c"),
          ]);
          controller.updateFlags({
            runner: {
              "action invalid input": { a: null, b: null, gone: null },
            },
          });
          await fire(graph, ['title="Actions with invalid']);

          const text = markup(graph);
          expect(text).toContain("Actions with invalid inputs (3)");
          expect(text).toMatch(
            /<div class="flag-item " @click="\[listener\]" title="a" >/,
          );
          expect(text).toMatch(
            /<div class="flag-item " @click="\[listener\]" title="b" >/,
          );
          expect(text).toContain("Not in graph (1)");
          expect(text).toContain('<span class="flag-label">gone</span>');
          expect(text).not.toContain('<span class="flag-label">c</span>');

          await fire(graph, ['class="flag-item', 'title="a"']);
          expect(markup(graph)).toContain('class="flag-item selected"');
          expect(markup(graph)).toContain('class="detail-pane"');
        });
      });

      describe("source view", () => {
        it("hands the source view every node, and selects the node it reports", async () => {
          // `b` is hidden in the graph view, under its collapsed parent `a`.

          const { graph } = viewOf([
            action("a", { patternIdentity: { identity: "p", symbol: "s" } }),
            action("b", { parentId: "a", stats: undefined }),
          ]);
          await fire(graph, ['title="View pattern source']);
          expect(templateBindings(graph.render(), "nodes")).toEqual([
            new Map([["a", {
              id: "a",
              type: "computation",
              label: "a",
              stats: { totalTime: 1, runCount: 1 },
              patternIdentity: "p",
            }], ["b", {
              id: "b",
              type: "computation",
              label: "b",
              stats: undefined,
              patternIdentity: undefined,
            }]]),
          ]);

          await fire(
            graph,
            ["<x-scheduler-source"],
            new CustomEvent(
              "node-selected",
              { detail: { nodeId: "gone" } },
            ),
          );
          expect(markup(graph)).not.toContain('class="detail-pane"');

          await fire(
            graph,
            ["<x-scheduler-source"],
            new CustomEvent(
              "node-selected",
              { detail: { nodeId: "b" } },
            ),
          );
          expect(markup(graph)).toContain(
            '<div class="detail-section-content">b</div>',
          );
        });

        it("sets the breakpoints the source view toggles", async () => {
          const { graph, controller } = viewOf([action("a")]);
          await fire(graph, ['title="View pattern source']);

          await fire(
            graph,
            ["<x-scheduler-source"],
            new CustomEvent(
              "breakpoint-toggle",
              { detail: { actionIds: ["a", "b"], enabled: true } },
            ),
          );

          expect(controller.getBreakpoints()).toEqual(new Set(["a", "b"]));
        });
      });

      describe("table view", () => {
        // Every parent starts collapsed in the graph view, hiding its
        // children there; the table shows them all the same.

        /** The ids in the titles of the table's rows, in order. */
        function rowIds(graph: XSchedulerGraph): string[] {
          return [...markup(graph).matchAll(/<tr class="[^"]*" title="(\w+)/g)]
            .map((match) => match[1]);
        }

        const ranNode = (id: string, runs: number, time: number) =>
          action(id, { stats: stats(runs, time) });

        it("lists the actions largest total time first, and sorts by the column clicked", async () => {
          const { graph } = viewOf([
            ranNode("few", 1, 30),
            ranNode("many", 9, 20),
          ]);
          expect(rowIds(graph)).toEqual(["few", "many"]);
          expect(markup(graph)).toMatch(
            /class="col-number sorted"[^>]*> Total <span class="sort-indicator">▼/,
          );

          await fire(graph, ["<th", "Runs"]);
          expect(rowIds(graph)).toEqual(["many", "few"]);
          expect(markup(graph)).toMatch(
            /class="col-number sorted"[^>]*> Runs <span class="sort-indicator">▼/,
          );

          await fire(graph, ["<th", "Runs"]);
          expect(rowIds(graph)).toEqual(["few", "many"]);
          expect(markup(graph)).toContain('<span class="sort-indicator">▲');

          await fire(graph, ["<th", "Avg"]);
          expect(rowIds(graph)).toEqual(["few", "many"]);
          expect(markup(graph)).toMatch(
            /class="col-number sorted"[^>]*> Avg <span class="sort-indicator">▼/,
          );

          await fire(graph, ["<th", "Last"]);
          expect(markup(graph)).toMatch(
            /class="col-number sorted"[^>]*> Last <span class="sort-indicator">▼/,
          );
        });

        it("shows each figure's change since the baseline, and sorts by it once Δ is clicked", async () => {
          const { graph, controller } = viewOf([
            ranNode("few", 1, 30),
            ranNode("many", 9, 20),
          ]);
          expect(markup(graph)).not.toContain("delta-sort-toggle");
          controller.setSchedulerBaselineStats(
            new Map([["few", { runCount: 1, totalTime: 29 }]]),
          );

          const text = markup(graph);
          expect(text).toContain(
            '<span class="stat-main">30.0ms</span> <span class="stat-delta positive"> +1.0ms </span>',
          );
          expect(text).toContain(
            '<div class="stat-with-delta"> <span class="stat-main">1</span> </div>',
          );

          const event = await fire(graph, ['title="Sort by delta']);
          expect(event.cancelBubble).toBe(true);
          expect(rowIds(graph)).toEqual(["many", "few"]);
          expect(markup(graph)).toMatch(
            /class="active"[^>]*title="Sort by delta/,
          );

          await fire(graph, ['title="Sort by lifetime']);
          expect(rowIds(graph)).toEqual(["few", "many"]);
        });

        it("shows a parent's figures summed with its children's until it is expanded", async () => {
          const { graph } = viewOf([
            ranNode("parent", 1, 10),
            action("child", { stats: stats(2, 5), parentId: "parent" }),
          ]);
          expect(rowIds(graph)).toEqual(["parent"]);
          expect(markup(graph)).toContain(
            '<span class="child-count">(1)</span>',
          );
          expect(markup(graph)).toContain(
            '<span class="aggregated">3</span>',
          );
          expect(markup(graph)).toContain(
            '<span class="aggregated">15.0ms</span>',
          );

          const event = await fire(graph, ['class="expand-toggle"']);
          expect(event.cancelBubble).toBe(true);
          expect(rowIds(graph)).toEqual(["parent", "child"]);
          expect(markup(graph)).not.toContain('class="aggregated"');
          expect(markup(graph)).toContain(
            '<tr class="child-row " title="child"',
          );

          await fire(graph, ['class="expand-toggle"']);
          expect(rowIds(graph)).toEqual(["parent"]);
        });

        it("selects a child whose row is clicked", async () => {
          const { graph } = viewOf([
            ranNode("parent", 1, 10),
            action("child", { stats: stats(2, 5), parentId: "parent" }),
          ]);
          await fire(graph, ['class="expand-toggle"']);

          await fire(graph, ['title="child"']);

          expect(markup(graph)).toContain(
            '<tr class="child-row selected" title="child"',
          );
        });

        it("shows the debounce and throttle of an action", async () => {
          const { graph } = viewOf([
            action("parent", {
              stats: stats(1, 1),
              debounceMs: 10,
              throttleMs: 20,
            }),
            action("child", {
              stats: stats(1, 1),
              parentId: "parent",
              debounceMs: 30,
            }),
            ranNode("plain", 1, 1),
          ]);
          await fire(graph, ['class="expand-toggle"']);

          const text = markup(graph);
          expect(text).toContain(">D:10ms</span>");
          expect(text).toContain(">T:20ms</span>");
          expect(text).toContain(">D:30ms</span>");
          expect(text.match(/timing-badge/g)).toHaveLength(3);
        });
      });
    });
  });
});
