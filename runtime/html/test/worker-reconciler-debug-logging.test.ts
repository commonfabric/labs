/**
 * What the worker reconciler's debug log says as it renders. The log is off
 * unless a developer turns it on, so these tests turn it on, drive a mount
 * through the reconciler's main transitions, and check that it named each
 * transition the emitted operations show.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import {
  type CapturedLogs,
  captureLogsForTestingOnly,
} from "@commonfabric/logger/for-testing-only";
import { type Cell, type JSONSchema, Runtime } from "@commonfabric/runner";
import {
  debugVDOMSchema,
  rendererVDOMSchema,
} from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";

const signer = await Identity.fromPassphrase("test reconciler debug logging");
const space = signer.did();

/**
 * Builds the root view `drive()` renders: a `div` whose `onClick` sends to one
 * stream, or to another once `retargeted`.
 */
type View = (options: { revision: number; retargeted?: boolean }) => unknown;

/** Reads a root whose props and children each arrive as one cell. */
const cellPartsSchema = {
  type: "object",
  properties: {
    type: { type: "string" },
    name: { type: "string" },
    revision: { type: "number" },
    props: { type: "object", asCell: ["cell"] },
    children: { type: "array", asCell: ["cell"] },
  },
} as const satisfies JSONSchema;

describe("reconciler debug logging", () => {
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

  /** Writes `value` to `cell`, and waits for what the write sets off. */
  const write = async (cell: Cell<unknown>, value: unknown) => {
    const tx = runtime.edit();
    cell.withTx(tx).set(value);
    await tx.commit().settled;
    await settle();
  };
  const settle = async () => {
    await runtime.idle();
    await runtime.storageManager.synced();
    await runtime.idle();
  };

  /** A reconciler, and the operations it has emitted since `take()` last ran. */
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

  /**
   * Mounts a root read through `schema`, writes what each of `updates` makes
   * of its view to it in turn, and unmounts. Returns the operations the
   * reconciler emitted for the mount and then for each update.
   */
  const drive = async (
    name: string,
    schema: JSONSchema | undefined,
    updates: ((view: View) => unknown)[],
  ) => {
    const [target, retarget] = ["target", "retarget"].map((role) =>
      runtime.getCell<unknown>(space, `${name} ${role}`, {
        asCell: ["stream"],
      })
    );
    const label = runtime.getCell<unknown>(space, `${name} label`);
    await write(label, "label");
    const root = runtime.getCell<unknown>(space, `${name} root`);
    const view: View = ({ revision, retargeted = false }) => ({
      type: "vnode",
      name: "div",
      revision,
      props: {
        onClick: retargeted ? retarget : target,
        title: label,
        $value: label,
      },
      children: ["text"],
    });
    await write(root, view({ revision: 1 }));
    const { reconciler, take } = reconcilerWithOps();
    reconciler.mount(schema ? root.asSchema(schema) : root);
    await settle();
    const steps = [take()];
    for (const update of updates) {
      await write(root, update(view));
      steps.push(take());
    }
    reconciler.unmount();
    return steps;
  };

  const keysOf = (captured: CapturedLogs) =>
    captured.logs.map(({ key }) => key);

  describe("with the log turned on", () => {
    it("names each step of a mount, an in-place update, a replacement and an unmount", async () => {
      using logs = captureLogsForTestingOnly("worker-reconciler");

      const steps = await drive("plain", undefined, [
        (view) => view({ revision: 2, retargeted: true }),
        (view) => view({ revision: 3, retargeted: true }),
        () => ({ type: "vnode", name: "p", props: {}, children: [] }),
      ]);

      // The `div` stays through the first two updates, the first moving its
      // handler to the other stream and the second changing nothing, and the
      // third replaces it.
      expect(steps[1]).toEqual([
        { op: "remove-event", nodeId: 1, eventType: "click" },
        {
          op: "set-event",
          nodeId: 1,
          eventType: "click",
          handlerId: expect.any(Number),
        },
      ]);
      expect(steps[2]).toEqual([]);
      expect(steps[3]).toEqual([
        { op: "remove-node", nodeId: 1 },
        expect.objectContaining({ op: "create-element", tagName: "p" }),
        expect.objectContaining({ op: "insert-child", parentId: 0 }),
      ]);
      expect(keysOf(logs)).toEqual(
        expect.arrayContaining([
          "mount",
          "root-cell-update",
          "reconcile-check",
          "flush-ops",
          "update-event-prop",
          "reconcile-node",
          "unmount",
        ]),
      );
    });

    it("names a prop and a binding left on the same cell", async () => {
      using logs = captureLogsForTestingOnly("worker-reconciler");

      const steps = await drive("debug schema", debugVDOMSchema, [
        (view) => view({ revision: 2, retargeted: true }),
      ]);

      expect(steps[0]).toEqual(expect.arrayContaining([
        expect.objectContaining({ op: "set-prop", key: "title" }),
        expect.objectContaining({ op: "set-binding", propName: "value" }),
      ]));
      expect(steps[1]).toEqual([]);
      expect(keysOf(logs)).toEqual(
        expect.arrayContaining(["prop-same-cell", "binding-same-cell"]),
      );
    });

    it("names props and children left on the same cell", async () => {
      using logs = captureLogsForTestingOnly("worker-reconciler");

      const steps = await drive("cell parts", cellPartsSchema, [
        (view) => view({ revision: 2 }),
      ]);

      expect(steps[0]).toEqual(expect.arrayContaining([
        expect.objectContaining({ op: "set-prop", key: "title" }),
        expect.objectContaining({ op: "create-text", text: "text" }),
      ]));
      expect(steps[1]).toEqual([]);
      expect(keysOf(logs)).toEqual(
        expect.arrayContaining([
          "cell-props-emit",
          "props-same-cell",
          "children-same-cell",
        ]),
      );
    });

    it("names the static tree it mounts", () => {
      using logs = captureLogsForTestingOnly("worker-reconciler");
      const { reconciler, take } = reconcilerWithOps();

      reconciler.mount({ type: "vnode", name: "p", props: {}, children: [] });
      const ops = take();
      reconciler.unmount();

      expect(ops).toEqual([
        { op: "create-element", nodeId: 1, tagName: "p" },
        { op: "insert-child", parentId: 0, childId: 1, beforeId: null },
      ]);
      expect(keysOf(logs)).toContain("mount");
    });

    it("names a cell child replaced by one of another kind", async () => {
      using logs = captureLogsForTestingOnly("worker-reconciler");
      const child = runtime.getCell<unknown>(space, "replaced child");
      await write(child, "text");
      const root = runtime.getCell<unknown>(space, "replaced child root");
      await write(root, {
        type: "vnode",
        name: "div",
        props: {},
        children: [child],
      });
      const { reconciler, take } = reconcilerWithOps();
      reconciler.mount(root.asSchema(rendererVDOMSchema));
      await settle();
      take();

      await write(child, {
        type: "vnode",
        name: "b",
        props: {},
        children: [],
      });
      const replaced = take();
      reconciler.unmount();

      expect(replaced).toEqual([
        { op: "remove-node", nodeId: 2 },
        { op: "create-element", nodeId: 3, tagName: "b" },
        { op: "insert-child", parentId: 1, childId: 3, beforeId: null },
      ]);
      expect(keysOf(logs)).toContain("reconcile-cell-child");
    });
  });

  it("prints nothing while the log is off", async () => {
    const logger = getLogger("worker-reconciler");
    const disabled = logger.disabled;
    logger.disabled = true;
    using debug = stub(console, "debug");
    try {
      await drive("silent", undefined, [
        (view) => view({ revision: 2, retargeted: true }),
      ]);
    } finally {
      logger.disabled = disabled;
    }

    expect(debug.calls).toEqual([]);
  });
});
