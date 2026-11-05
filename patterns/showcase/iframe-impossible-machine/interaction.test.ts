import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  createActionRunner,
  createSelectionRequestTracker,
  errorFrom,
  findAppendOnlyItem,
  nodeControlBoundaryProps,
  stopNodeControlPropagation,
  updateLatestValue,
} from "./model.ts";

describe("Impossible Machine interaction lifecycle", () => {
  it("exposes the interaction boundary through the guest model", () => {
    expect(typeof findAppendOnlyItem).toBe("function");
    expect(typeof createActionRunner).toBe("function");
  });

  it("keeps an append-only item address stable as later items arrive", () => {
    const initial = [
      { id: "sensor", value: 1 },
      { id: "gate", value: 2 },
    ];
    const located = findAppendOnlyItem(initial, "gate");

    expect(located).toEqual({ index: 1, item: initial[1] });
    expect(findAppendOnlyItem([...initial, { id: "delay", value: 3 }], "gate"))
      .toEqual({ index: 1, item: initial[1] });
    expect(findAppendOnlyItem(initial, "missing")).toBeUndefined();
  });

  it("stops embedded controls at the node boundary", () => {
    let stopped = false;
    stopNodeControlPropagation({ stopPropagation: () => stopped = true });

    expect(stopped).toBe(true);
    expect(nodeControlBoundaryProps()).toEqual({
      className: "node-parameters nodrag nopan",
      onClick: stopNodeControlPropagation,
    });
  });

  it("orders actions while keeping node pending state local", async () => {
    let globalPending = false;
    let actionError: Error | undefined;
    let busyNodes: Readonly<Record<string, number>> = {};
    const runner = createActionRunner({
      setGlobalPending: (value) => globalPending = value,
      setActionError: (value) => actionError = value,
      setBusyNodeCounts: (update) => busyNodes = update(busyNodes),
    });
    const order: string[] = [];
    let releaseNode!: () => void;
    const nodeGate = new Promise<void>((resolve) => releaseNode = resolve);

    const nodeAction = runner.runNode("gate", async () => {
      order.push("node:start");
      await nodeGate;
      order.push("node:end");
    });
    const globalAction = runner.run(() => {
      order.push("global");
      return Promise.reject("visible failure");
    });
    const laterAction = runner.run(() => {
      order.push("later");
      return Promise.resolve();
    });

    await Promise.resolve();
    expect(globalPending).toBe(false);
    expect(busyNodes).toEqual({ gate: 1 });
    expect(order).toEqual(["node:start"]);

    releaseNode();
    expect(await nodeAction).toBe(true);
    expect(await globalAction).toBe(false);
    expect(await laterAction).toBe(true);

    expect(order).toEqual(["node:start", "node:end", "global", "later"]);
    expect(globalPending).toBe(false);
    expect(busyNodes).toEqual({});
    expect(actionError).toEqual(new Error("visible failure"));
    expect(errorFrom(new Error("same"))).toEqual(new Error("same"));
  });

  it("updates toolbar values from the latest queued state", async () => {
    let value = 3;
    let releaseNode!: () => void;
    const nodeGate = new Promise<void>((resolve) => releaseNode = resolve);
    const cell = {
      pull: () => Promise.resolve(value),
      set: (next: number) => {
        value = next;
        return Promise.resolve();
      },
    };
    const runner = createActionRunner({
      setGlobalPending: () => {},
      setActionError: () => {},
      setBusyNodeCounts: () => {},
    });

    const nodeAction = runner.runNode("gate", () => nodeGate);
    const first = runner.run(() =>
      updateLatestValue(cell, (current) => current + 1)
    );
    const second = runner.run(() =>
      updateLatestValue(cell, (current) => current + 1)
    );

    releaseNode();
    await Promise.all([nodeAction, first, second]);

    expect(value).toBe(5);
  });

  it("orders quiet actions without changing pending controls", async () => {
    const pendingUpdates: boolean[] = [];
    let actionError: Error | undefined;
    const runner = createActionRunner({
      setGlobalPending: (value) => pendingUpdates.push(value),
      setActionError: (value) => actionError = value,
      setBusyNodeCounts: () => {},
    });

    expect(await runner.runQuiet(() => Promise.resolve())).toBe(true);
    expect(await runner.runQuiet(() => Promise.reject("quiet failure"))).toBe(
      false,
    );

    expect(pendingUpdates).toEqual([]);
    expect(actionError).toEqual(new Error("quiet failure"));
  });

  it("retains the latest rapid selection request", async () => {
    const tracker = createSelectionRequestTracker("node-a");
    const writes: string[] = [];
    let releaseNodeB!: () => void;
    const nodeBGate = new Promise<void>((resolve) => releaseNodeB = resolve);
    const writeSelection = (nodeId: string) => {
      writes.push(nodeId);
      return nodeId === "node-b" ? nodeBGate : Promise.resolve();
    };

    const duplicate = tracker.request("node-a", writeSelection);
    const nodeB = tracker.request("node-b", writeSelection);
    tracker.reconcile("node-b");
    const nodeA = tracker.request("node-a", writeSelection);

    expect(writes).toEqual(["node-b", "node-a"]);
    releaseNodeB();
    await Promise.all([duplicate, nodeB, nodeA]);

    tracker.reconcile("node-a");
    await tracker.request("node-a", writeSelection);
    expect(writes).toEqual(["node-b", "node-a"]);

    await tracker.request("node-b", writeSelection);
    await tracker.request("node-b", writeSelection);
    expect(writes).toEqual(["node-b", "node-a", "node-b"]);

    expect(
      await tracker.request("node-c", (nodeId) => {
        writes.push(nodeId);
        return Promise.resolve(false);
      }),
    ).toBe(false);
    await tracker.request("node-c", (nodeId) => {
      writes.push(nodeId);
      return Promise.resolve(true);
    });
    expect(writes).toEqual([
      "node-b",
      "node-a",
      "node-b",
      "node-c",
      "node-c",
    ]);

    let releaseNodeD!: () => void;
    const nodeDGate = new Promise<void>((resolve) => releaseNodeD = resolve);
    const nodeD = tracker.request("node-d", (nodeId) => {
      writes.push(nodeId);
      return nodeDGate;
    });
    tracker.reconcile("node-external");
    releaseNodeD();
    await nodeD;
    await tracker.request("node-external", (nodeId) => {
      writes.push(nodeId);
      return Promise.resolve();
    });
    expect(writes.at(-1)).toBe("node-d");
  });

  it("shares the result of a duplicate pending selection", async () => {
    const tracker = createSelectionRequestTracker("node-a");
    let release!: (succeeded: boolean) => void;
    const gate = new Promise<boolean>((resolve) => release = resolve);
    let writes = 0;

    const first = tracker.request("node-b", () => {
      writes++;
      return gate;
    });
    const duplicate = tracker.request("node-b", () => {
      writes++;
      return Promise.resolve(true);
    });
    let duplicateSettled = false;
    void duplicate.then(() => duplicateSettled = true);

    await Promise.resolve();
    expect(writes).toBe(1);
    expect(duplicateSettled).toBe(false);

    release(false);
    expect(await first).toBe(false);
    expect(await duplicate).toBe(false);
  });

  it("does not reuse a failed result after restoring an older selection", async () => {
    const tracker = createSelectionRequestTracker("node-a");
    let releaseOlder!: () => void;
    const olderGate = new Promise<void>((resolve) => releaseOlder = resolve);
    let restoredWrites = 0;

    const older = tracker.request("node-b", () => olderGate);
    expect(await tracker.request("node-c", () => Promise.resolve(false))).toBe(
      false,
    );

    expect(
      await tracker.request("node-a", () => {
        restoredWrites++;
        return Promise.resolve(true);
      }),
    ).toBe(true);
    expect(restoredWrites).toBe(0);

    releaseOlder();
    expect(await older).toBe(true);
  });
});
