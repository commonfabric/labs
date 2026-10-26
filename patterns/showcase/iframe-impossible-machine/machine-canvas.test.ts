/** Exercises the React hook boundary that owns one browser's canvas state. */

import {
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  type CanvasReactRuntime,
  createMachineCanvas,
  type MachineCanvasProps,
} from "./machine-canvas/guest.ts";

type TestNode = Node<{ label: string }, "sensor" | "gate">;

interface FakeElement {
  type: unknown;
  properties: Record<string, unknown>;
  children: unknown[];
}

interface CanvasProperties {
  nodes: TestNode[];
  onNodesChange(changes: NodeChange<TestNode>[]): void;
  onNodeClick(event: unknown, node: TestNode): void;
  onNodeDragStop(event: unknown, node: TestNode): void;
  onConnect(connection: { source: string; target: string }): void;
}

function createHookHarness() {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const layoutEffectDependencies: Array<readonly unknown[] | undefined> = [];
  let stateIndex = 0;
  let refIndex = 0;
  let layoutEffectIndex = 0;
  let layoutEffectRuns = 0;

  const runtime: CanvasReactRuntime = {
    useState<T>(initial: T) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index] as T, (update) => {
        const current = states[index] as T;
        states[index] = typeof update === "function"
          ? (update as (value: T) => T)(current)
          : update;
      }];
    },
    useRef<T>(initial: T) {
      const index = refIndex++;
      if (!(index in refs)) refs[index] = { current: initial };
      return refs[index] as { current: T };
    },
    useLayoutEffect(effect, dependencies) {
      const index = layoutEffectIndex++;
      const previous = layoutEffectDependencies[index];
      if (
        previous !== undefined &&
        previous.length === dependencies.length &&
        dependencies.every((value, dependencyIndex) =>
          Object.is(value, previous[dependencyIndex])
        )
      ) return;
      layoutEffectDependencies[index] = [...dependencies];
      layoutEffectRuns++;
      effect();
    },
    useCallback<T>(callback: T) {
      return callback;
    },
    createElement(type, properties, ...children) {
      return { type, properties: properties ?? {}, children };
    },
  };

  return {
    runtime,
    render(
      component: (properties: MachineCanvasProps<TestNode>) => object,
      properties: MachineCanvasProps<TestNode>,
    ): FakeElement {
      stateIndex = 0;
      refIndex = 0;
      layoutEffectIndex = 0;
      return component(properties) as FakeElement;
    },
    layoutEffectRuns() {
      return layoutEffectRuns;
    },
  };
}

function canvasProperties(element: FakeElement): CanvasProperties {
  return element.properties as unknown as CanvasProperties;
}

function initialNodes(): TestNode[] {
  return [
    {
      id: "sensor",
      type: "sensor",
      position: { x: 0, y: 0 },
      data: { label: "Sensor" },
      selected: true,
    },
    {
      id: "gate",
      type: "gate",
      position: { x: 20, y: 20 },
      data: { label: "Gate" },
      selected: false,
    },
  ];
}

function createCanvas(harness: ReturnType<typeof createHookHarness>) {
  return createMachineCanvas<TestNode>(
    harness.runtime,
    {
      ReactFlow: "flow",
      Background: "background",
      Controls: "controls",
      MiniMap: "minimap",
      applyNodeChanges: (changes, nodes) =>
        applyNodeChanges(changes as NodeChange<TestNode>[], nodes),
    },
    { sensor: "sensor-component", gate: "gate-component" },
    { sensor: "blue", gate: "purple" },
  );
}

describe("machine canvas lifecycle", () => {
  it("keeps drag changes local and persists only completed positions", async () => {
    const harness = createHookHarness();
    const Canvas = createCanvas(harness);
    const nodes = initialNodes();
    const edges: Edge[] = [];
    const connections: Array<{ source: string; target: string }> = [];
    const commits: Array<
      { nodeId: string; position: { x: number; y: number } }
    > = [];
    let element = harness.render(Canvas, {
      authoritativeNodes: nodes,
      authoritativeSelection: "sensor",
      edges,
      onConnect: (connection) =>
        connections.push(
          connection as {
            source: string;
            target: string;
          },
        ),
      onNodeSelection: () => Promise.resolve(true),
      onPositionCommit: (nodeId, position) => {
        commits.push({ nodeId, position });
        return Promise.resolve(position);
      },
    });

    expect(element.type).toBe("flow");
    expect(element.children.map((child) => (child as FakeElement).type))
      .toEqual(
        ["background", "controls", "minimap"],
      );
    const minimap = element.children[2] as FakeElement;
    expect(
      (minimap.properties.nodeColor as (node: TestNode) => string)(nodes[1]),
    ).toBe("purple");

    let properties = canvasProperties(element);
    properties.onConnect({ source: "sensor", target: "gate" });
    properties.onNodesChange([{
      id: "sensor",
      type: "position",
      position: { x: 8, y: 9 },
      dragging: true,
    }]);
    expect(harness.layoutEffectRuns()).toBe(1);
    element = harness.render(Canvas, {
      authoritativeNodes: nodes,
      authoritativeSelection: "sensor",
      edges,
      onConnect: (connection) =>
        connections.push(
          connection as {
            source: string;
            target: string;
          },
        ),
      onNodeSelection: () => Promise.resolve(true),
      onPositionCommit: (nodeId, position) => {
        commits.push({ nodeId, position });
        return Promise.resolve(position);
      },
    });
    properties = canvasProperties(element);
    expect(harness.layoutEffectRuns()).toBe(1);
    expect(properties.nodes[0].position).toEqual({ x: 8, y: 9 });
    expect(properties.nodes[0].dragging).toBe(true);

    properties.onNodeDragStop(undefined, properties.nodes[0]);
    await Promise.resolve();
    await Promise.resolve();
    element = harness.render(Canvas, {
      authoritativeNodes: [{ ...nodes[0], position: { x: 8, y: 9 } }, nodes[1]],
      authoritativeSelection: "sensor",
      edges,
      onConnect: () => {},
      onNodeSelection: () => Promise.resolve(true),
      onPositionCommit: (_nodeId, position) => Promise.resolve(position),
    });

    expect(harness.layoutEffectRuns()).toBe(2);
    expect(commits).toEqual([{
      nodeId: "sensor",
      position: { x: 8, y: 9 },
    }]);
    expect(connections).toEqual([{ source: "sensor", target: "gate" }]);
    expect(canvasProperties(element).nodes[0].position).toEqual({ x: 8, y: 9 });
  });

  it("ignores superseded drops and restores a failed current drop", async () => {
    const harness = createHookHarness();
    const Canvas = createCanvas(harness);
    const nodes = initialNodes();
    const releases: Array<
      (position: { x: number; y: number } | undefined) => void
    > = [];
    const properties: MachineCanvasProps<TestNode> = {
      authoritativeNodes: nodes,
      authoritativeSelection: "sensor",
      edges: [],
      onConnect: () => {},
      onNodeSelection: () => Promise.resolve(true),
      onPositionCommit: () => new Promise((resolve) => releases.push(resolve)),
    };
    let element = harness.render(Canvas, properties);
    let canvas = canvasProperties(element);

    canvas.onNodesChange([{
      id: "sensor",
      type: "position",
      position: { x: 5, y: 5 },
      dragging: false,
    }]);
    element = harness.render(Canvas, properties);
    canvas = canvasProperties(element);
    canvas.onNodeDragStop(undefined, canvas.nodes[0]);
    canvas.onNodesChange([{
      id: "sensor",
      type: "position",
      position: { x: 7, y: 7 },
      dragging: true,
    }]);
    releases[0]({ x: 5, y: 5 });
    await Promise.resolve();
    await Promise.resolve();

    element = harness.render(Canvas, properties);
    canvas = canvasProperties(element);
    expect(canvas.nodes[0].position).toEqual({ x: 7, y: 7 });
    canvas.onNodeDragStop(undefined, canvas.nodes[0]);
    releases[1](undefined);
    await Promise.resolve();
    await Promise.resolve();

    element = harness.render(Canvas, properties);
    expect(canvasProperties(element).nodes[0].position).toEqual({ x: 0, y: 0 });
    canvasProperties(element).onNodeDragStop(undefined, {
      id: "missing",
      type: "sensor",
      position: { x: 1, y: 1 },
      data: { label: "Missing" },
    });
    releases[2](undefined);
    await Promise.resolve();
    await Promise.resolve();
  });

  it("retains a pending selection through acknowledgement and failure", async () => {
    const harness = createHookHarness();
    const Canvas = createCanvas(harness);
    const nodes = initialNodes();
    const releases: Array<(succeeded: boolean) => void> = [];
    const selection = (_nodeId: string) =>
      new Promise<boolean>((resolve) => releases.push(resolve));
    const properties = (authoritativeSelection: string) => ({
      authoritativeNodes: nodes.map((node) => ({
        ...node,
        selected: node.id === authoritativeSelection,
      })),
      authoritativeSelection,
      edges: [] as Edge[],
      onConnect: () => {},
      onNodeSelection: selection,
      onPositionCommit: (_nodeId: string, position: { x: number; y: number }) =>
        Promise.resolve(position),
    });

    let element = harness.render(Canvas, properties("sensor"));
    let canvas = canvasProperties(element);
    canvas.onNodeClick(undefined, canvas.nodes[0]);
    canvas.onNodeClick(undefined, canvas.nodes[1]);
    element = harness.render(Canvas, properties("sensor"));
    expect(canvasProperties(element).nodes[1].selected).toBe(true);

    releases[0](true);
    await Promise.resolve();
    await Promise.resolve();
    element = harness.render(Canvas, properties("sensor"));
    expect(canvasProperties(element).nodes[1].selected).toBe(true);
    element = harness.render(Canvas, properties("gate"));
    element = harness.render(Canvas, properties("gate"));
    expect(canvasProperties(element).nodes[1].selected).toBe(true);

    canvas = canvasProperties(element);
    canvas.onNodeClick(undefined, canvas.nodes[0]);
    canvas.onNodeClick(undefined, canvas.nodes[1]);
    releases[2](false);
    releases[1](true);
    await Promise.resolve();
    await Promise.resolve();
    element = harness.render(Canvas, properties("gate"));
    expect(canvasProperties(element).nodes[1].selected).toBe(true);
  });
});
