/**
 * What the worker reconciler keeps and what it rebuilds when a node it
 * rendered is handed a new value: a props or children cell replaced by
 * something else, and a child that keeps its key while what it holds changes.
 *
 * A child's key is a hash of its content, so two children key alike only when
 * they hold the same thing — except when the hash refuses what a child holds,
 * as it refuses a `Map`. Such a child keys by its tag alone, which is how a
 * child of a different shape comes to stand at a key an earlier one held.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { captureLogsForTestingOnly } from "@commonfabric/logger/for-testing-only";
import { type Cell, type JSONSchema, Runtime, UI } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { clock } from "@commonfabric/test-support/fake-clock";

import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type { WorkerVNode } from "../src/worker/types.ts";
import { valueCell } from "./value-cell.ts";

const signer = await Identity.fromPassphrase("test reconciler in place");
const space = signer.did();

/** Reads a root whose props and children each arrive as one cell. */
const cellPartsSchema = {
  type: "object",
  properties: {
    type: { type: "string" },
    name: { type: "string" },
    props: { type: "object", asCell: ["cell"] },
    children: { type: "array", asCell: ["cell"] },
  },
} as const satisfies JSONSchema;

const vnode = (
  name: string,
  props: Record<string, unknown> | Cell<unknown>,
  children: unknown[],
): WorkerVNode => ({
  type: "vnode",
  name,
  props: props as WorkerVNode["props"],
  children: children as WorkerVNode["children"],
});

/**
 * A value the key hash refuses, which a test puts beside what a child holds so
 * that the child keys by its tag alone.
 */
const unhashable = () => new Map();

describe("worker reconciler in-place updates", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  const settle = async () => {
    await runtime.idle();
    await runtime.storageManager.synced();
    await runtime.idle();
    await clock.settle();
  };

  /** Writes `value` to the cell named `id`, and returns the cell. */
  const write = async (id: string, value: unknown): Promise<Cell<unknown>> => {
    const cell = runtime.getCell<unknown>(space, id);
    const tx = runtime.edit();
    cell.withTx(tx).set(value);
    await tx.commit().settled;
    await settle();
    return cell;
  };

  /** A reconciler, and the operations it has emitted since `take()` ran. */
  const reconcilerWithOps = () => {
    let ops: VDomOp[] = [];
    const reconciler = new WorkerReconciler({
      onOps: (batch) => {
        for (const op of batch) ops.push(op);
      },
    });
    const take = () => {
      reconciler.flush();
      const taken = ops;
      ops = [];
      return taken;
    };
    return { reconciler, take };
  };

  const created = (ops: readonly VDomOp[], tagName: string) =>
    ops.filter((op): op is Extract<VDomOp, { op: "create-element" }> =>
      op.op === "create-element" && op.tagName === tagName
    );

  it("stops following a children cell once another replaces it", async () => {
    using logs = captureLogsForTestingOnly("worker-reconciler");
    const first = await write("first children", ["from first"]);
    const second = await write("second children", ["from second", "more"]);
    const third = await write("third children", "not a list");
    const withChildren = (children: Cell<unknown>) =>
      write("children root", {
        type: "vnode",
        name: "div",
        props: {},
        children,
      });
    const root = await withChildren(first);
    const { reconciler, take } = reconcilerWithOps();
    reconciler.mount(root.asSchema(cellPartsSchema));
    await settle();
    expect(take()).toContainEqual(
      expect.objectContaining({ op: "create-text", text: "from first" }),
    );

    await withChildren(second);
    const replaced = take();
    expect(replaced).toContainEqual(
      expect.objectContaining({ op: "create-text", text: "from second" }),
    );
    expect(created(replaced, "div")).toEqual([]);

    await write("first children", ["first again"]);
    expect(take()).toEqual([]);
    await write("second children", ["second again"]);
    expect(take()).toContainEqual(
      expect.objectContaining({ op: "create-text", text: "second again" }),
    );

    // A children cell holding no list, as the schema reads it, empties the
    // node.
    await withChildren(third);
    const emptied = take();
    expect(emptied.some((op) => op.op === "remove-node")).toBe(true);
    expect(emptied.some((op) => op.op === "create-text")).toBe(false);
    expect(
      logs.logs.filter(({ key }) => key === "children-update")
        .map(({ messages }) => messages),
    ).toEqual([
      [{ nodeId: 1, count: 2 }],
      [{ nodeId: 1, count: 1 }],
      [{ nodeId: 1, count: 0 }],
    ]);
    reconciler.unmount();
  });

  it("stops following a props cell once static props replace it", async () => {
    const props = await write("replaced props", { title: "from cell" });
    const root = valueCell<object>(runtime, space, vnode("div", {}, []));
    root.set({ type: "vnode", name: "div", props, children: [] });
    const { reconciler, take } = reconcilerWithOps();
    reconciler.mount(root.cell);
    await settle();
    expect(take()).toContainEqual(
      { op: "set-prop", nodeId: 1, key: "title", value: "from cell" },
    );

    root.set(vnode("div", { class: "static" }, []));
    expect(take()).toEqual([
      { op: "remove-prop", nodeId: 1, key: "title" },
      { op: "set-prop", nodeId: 1, key: "class", value: "static" },
    ]);

    await write("replaced props", { title: "after replacement" });
    expect(take()).toEqual([]);
    reconciler.unmount();
  });

  it("keeps the handler of an event prop whose target a props cell still names", async () => {
    const target = runtime.getCell<unknown>(space, "kept event target", {
      asCell: ["stream"],
    });
    const props = (title: string) => ({
      onClick: target.getAsLink({ includeSchema: true }),
      title,
    });
    const cell = await write("kept event props", props("first"));
    const { reconciler, take } = reconcilerWithOps();
    reconciler.mount(vnode("button", cell, []));
    await settle();
    expect(take().filter((op) => op.op === "set-event")).toHaveLength(1);

    await write("kept event props", props("second"));
    expect(take()).toEqual([
      { op: "set-prop", nodeId: 1, key: "title", value: "second" },
    ]);
    reconciler.unmount();
  });

  describe("a child keeping its key while what it holds changes", () => {
    /** Mounts a `div` whose children are `children`, and returns a setter. */
    const mountChildren = async (children: unknown[]) => {
      const root = valueCell(runtime, space, vnode("div", {}, children));
      const { reconciler, take } = reconcilerWithOps();
      reconciler.mount(root.cell);
      await settle();
      return {
        initial: take(),
        replace: (next: unknown[]) => {
          root.set(vnode("div", {}, next));
          return take();
        },
        reconciler,
      };
    };

    it("updates an element of the same tag in place", async () => {
      const { initial, replace, reconciler } = await mountChildren([
        { [UI]: vnode("b", {}, ["before"]), hash: unhashable() },
      ]);
      const [bold] = created(initial, "b");

      const ops = replace([
        { [UI]: vnode("b", {}, ["after"]), hash: unhashable() },
      ]);
      expect(created(ops, "b")).toEqual([]);
      expect(ops).not.toContainEqual(
        expect.objectContaining({ op: "remove-node", nodeId: bold.nodeId }),
      );
      expect(ops).toContainEqual(
        expect.objectContaining({ op: "create-text", text: "after" }),
      );
      reconciler.unmount();
    });

    it("rebuilds an element whose tag changed", async () => {
      const { initial, replace, reconciler } = await mountChildren([
        { [UI]: vnode("b", {}, ["bold"]), hash: unhashable() },
      ]);
      const [bold] = created(initial, "b");

      const ops = replace([
        { [UI]: vnode("i", {}, ["italic"]), hash: unhashable() },
      ]);
      expect(ops).toContainEqual({ op: "remove-node", nodeId: bold.nodeId });
      expect(created(ops, "i")).toHaveLength(1);
      reconciler.unmount();
    });

    it("rebuilds an element as the placeholder for a [UI] chain that loops", async () => {
      const { initial, replace, reconciler } = await mountChildren([
        { ...vnode("b", {}, ["bold"]), hash: unhashable() },
      ]);
      const [bold] = created(initial, "b");
      const looped: Record<PropertyKey, unknown> = {
        name: "b",
        hash: unhashable(),
      };
      looped[UI] = looped;

      const ops = replace([looped]);
      expect(ops).toContainEqual({ op: "remove-node", nodeId: bold.nodeId });
      expect(ops).toContainEqual(
        expect.objectContaining({
          op: "set-prop",
          key: "title",
          value: "Circular reference detected",
        }),
      );
      reconciler.unmount();
    });

    it("rebuilds text as the element now standing at its key", async () => {
      using warn = stub(console, "warn");
      const { initial, replace, reconciler } = await mountChildren([
        { hash: unhashable() },
      ]);
      const [text] = initial.filter((
        op,
      ): op is Extract<VDomOp, { op: "create-text" }> =>
        op.op === "create-text"
      );
      // A child holding no `[UI]` renders as the text of what it holds.
      expect(text.text).toBe('{"hash":{}}');
      expect(warn.calls.map(({ args }) => args[0])).toEqual([
        "unexpected object when value was expected",
      ]);

      const ops = replace([
        { [UI]: vnode("b", {}, ["bold"]), hash: unhashable() },
      ]);
      expect(ops).toContainEqual({ op: "remove-node", nodeId: text.nodeId });
      expect(created(ops, "b")).toHaveLength(1);
      expect(warn.calls).toHaveLength(1);
      reconciler.unmount();
    });
  });

  describe("render nodes it refuses", () => {
    it("renders nothing for a [UI] chain ending at a function", () => {
      const { reconciler, take } = reconcilerWithOps();
      reconciler.mount(vnode("div", {}, [{ [UI]: () => {} }, "beside it"]));
      const ops = take();
      expect(ops.filter((op) => op.op === "create-element")).toHaveLength(1);
      expect(ops).toContainEqual(
        expect.objectContaining({ op: "create-text", text: "beside it" }),
      );
      reconciler.unmount();
    });

    it("throws for a [UI] chain ending at a cell", () => {
      const cell = runtime.getCell<unknown>(space, "behind a UI chain");
      const { reconciler } = reconcilerWithOps();
      expect(() => reconciler.mount(vnode("div", {}, [{ [UI]: cell }])))
        .toThrow(
          "Unexpected Cell in renderNode - a [UI] chain ending at a cell cannot be rendered.",
        );
      expect(() =>
        reconciler.mount(vnode("div", {}, [{ [UI]: vnode("b", {}, []) }]))
      ).not.toThrow();
      reconciler.unmount();
    });

    it("throws for a cell child whose value is a cell", () => {
      const inner = runtime.getCell<unknown>(space, "held by a cell");
      const { reconciler } = reconcilerWithOps();
      expect(() =>
        reconciler.mount(
          vnode("div", {}, [valueCell(runtime, space, inner).cell]),
        )
      ).toThrow("Unexpected Cell in renderChildContent");
      expect(() =>
        reconciler.mount(
          vnode("div", {}, [
            valueCell(runtime, space, vnode("b", {}, [])).cell,
          ]),
        )
      ).not.toThrow();
      reconciler.unmount();
    });
  });
});
