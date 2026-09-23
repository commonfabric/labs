import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";

describe("worker reconciler access loss", () => {
  for (const propsKind of ["static", "cell", "updated static"]) {
    it(`withholds a foreign event after access loss with ${propsKind} properties`, async () => {
      const owner = await Identity.fromPassphrase("event containing space");
      const foreign = await Identity.fromPassphrase("event target space");
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: StorageManager.emulate({ as: owner }),
      });
      let denied = false;
      const ops: VDomOp[] = [];
      const reconciler = new WorkerReconciler({
        onOps: (batch) => {
          ops.push(...batch);
        },
        spaceAccess: {
          error: (space) =>
            space === foreign.did() && denied
              ? new Error("Access revoked")
              : undefined,
          subscribe: () => () => {},
        },
      });
      try {
        const target = runtime.getCell<unknown>(foreign.did(), "event stream", {
          asCell: ["stream"],
        });
        const output = runtime.getCell<number>(foreign.did(), "event count");
        const props = runtime.getCell(owner.did(), "event properties");
        const root = runtime.getCell(owner.did(), "event root");
        const view = {
          type: "vnode",
          name: "button",
          props: propsKind === "cell" ? props : { onClick: target },
          children: ["Send"],
        };
        const seededTarget = await runtime.editWithRetry((tx) => {
          output.withTx(tx).set(0);
        });
        expect(seededTarget.error).toBeUndefined();
        const seeded = await runtime.editWithRetry((tx) => {
          props.withTx(tx).set({ onClick: target });
          root.withTx(tx).set(
            propsKind === "updated static"
              ? { ...view, props: {} }
              : { $UI: view },
          );
        });
        expect(seeded.error).toBeUndefined();
        const cancelHandler = runtime.scheduler.addEventHandler((tx) => {
          const count = output.withTx(tx);
          count.set((count.get() ?? 0) + 1);
        }, target.getAsNormalizedFullLink());
        try {
          reconciler.mount(
            propsKind === "updated static"
              ? root
              : root.asSchema(rendererVDOMSchema),
          );
          await runtime.idle();
          await runtime.storageManager.synced();
          await runtime.idle();
          if (propsKind === "updated static") {
            const updated = await runtime.editWithRetry((tx) => {
              root.withTx(tx).set(view);
            });
            expect(updated.error).toBeUndefined();
            await runtime.idle();
            await runtime.storageManager.synced();
            await runtime.idle();
          }
          reconciler.flush();
          const event = ops.find((op) => op.op === "set-event");
          if (event?.op !== "set-event") {
            throw new Error("Missing event handler");
          }
          reconciler.dispatchEvent(event.handlerId, { type: "click" });
          await runtime.idle();
          await runtime.storageManager.synced();
          expect(output.get()).toBe(1);
          denied = true;
          reconciler.dispatchEvent(event.handlerId, { type: "click" });
          await runtime.idle();
          expect(output.get()).toBe(1);
          denied = false;
          reconciler.dispatchEvent(event.handlerId, { type: "click" });
          await runtime.idle();
          await runtime.storageManager.synced();
          expect(output.get()).toBe(2);
        } finally {
          cancelHandler();
        }
      } finally {
        reconciler.unmount();
        await runtime.dispose();
      }
    });
  }

  it("withholds a cached root when access was lost before mounting", async () => {
    const owner = await Identity.fromPassphrase("render initially denied root");
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: owner }),
    });
    const ops: VDomOp[] = [];
    const reconciler = new WorkerReconciler({
      onOps: (batch) => {
        ops.push(...batch);
      },
      spaceAccess: {
        error: () => new Error("Access revoked"),
        subscribe: () => () => {},
      },
    });
    try {
      const root = runtime.getCell(owner.did(), "cached root", undefined);
      await runtime.editWithRetry((tx) =>
        root.withTx(tx).set({
          $UI: {
            type: "vnode",
            name: "main",
            props: {},
            children: ["Cached secret"],
          },
        })
      );
      reconciler.mount(root.asSchema(rendererVDOMSchema));
      await runtime.idle();
      reconciler.flush();
      expect(
        ops.some((op) =>
          op.op === "create-text" && op.text === "Cached secret"
        ),
      ).toBe(false);
      expect(
        ops.some((op) =>
          op.op === "create-text" && op.text === "Access unavailable"
        ),
      ).toBe(true);
    } finally {
      reconciler.unmount();
      await runtime.dispose();
    }
  });

  it("clears foreign properties and child lists without removing their containing element", async () => {
    const owner = await Identity.fromPassphrase("render foreign properties");
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: owner }),
    });
    let error: Error | undefined;
    const observers = new Set<() => void>();
    const ops: VDomOp[] = [];
    const reconciler = new WorkerReconciler({
      onOps: (batch) => {
        ops.push(...batch);
      },
      spaceAccess: {
        error: () => error,
        subscribe: (_space, observer) => {
          observers.add(observer);
          return () => {
            observers.delete(observer);
          };
        },
      },
    });
    try {
      const title = runtime.getCell<string>(owner.did(), "foreign title", {
        type: "string",
      });
      const children = runtime.getCell<string[]>(
        owner.did(),
        "foreign children",
        { type: "array", items: { type: "string" } },
      );
      await runtime.editWithRetry((tx) => {
        title.withTx(tx).set("Private title");
        children.withTx(tx).set(["Private child"]);
      });
      reconciler.mount({
        type: "vnode",
        name: "section",
        props: { title },
        children,
      });
      await runtime.idle();
      reconciler.flush();
      const rootId = reconciler.getRootNodeId();
      const childId = ops.filter((op) => op.op === "create-text").find((op) =>
        op.text === "Private child"
      )?.nodeId;
      expect(childId).toBeDefined();
      expect(
        ops.some((op) =>
          op.op === "set-prop" && op.key === "title" &&
          op.value === "Private title"
        ),
      ).toBe(true);
      ops.length = 0;
      error = new Error("Access revoked");
      for (const observer of [...observers]) observer();
      reconciler.flush();
      expect(ops).toContainEqual({
        op: "set-prop",
        nodeId: rootId,
        key: "title",
        value: undefined,
      });
      expect(ops).toContainEqual({ op: "remove-node", nodeId: childId });
      expect(ops).not.toContainEqual({ op: "remove-node", nodeId: rootId });
    } finally {
      reconciler.unmount();
      await runtime.dispose();
    }
  });

  it("removes a revoked foreign panel while retaining the authorized root and sibling", async () => {
    const owner = await Identity.fromPassphrase("render access root");
    const foreign = await Identity.fromPassphrase("render access foreign");
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: owner }),
    });
    const errors = new Map<string, Error>();
    const observers = new Map<string, Set<() => void>>();
    const ops: VDomOp[] = [];
    const reconciler = new WorkerReconciler({
      onOps: (batch) => {
        ops.push(...batch);
      },
      spaceAccess: {
        error: (space) => errors.get(space),
        subscribe: (space, observer) => {
          const entries = observers.get(space) ?? new Set();
          observers.set(space, entries);
          entries.add(observer);
          return () => {
            entries.delete(observer);
          };
        },
      },
    });
    try {
      const panel = runtime.getCell(foreign.did(), "foreign panel", undefined);
      const root = runtime.getCell(owner.did(), "root view", undefined);
      await runtime.editWithRetry((tx) =>
        panel.withTx(tx).set({
          $UI: {
            type: "vnode",
            name: "article",
            props: {},
            children: ["Private panel"],
          },
        })
      );
      await runtime.editWithRetry((tx) =>
        root.withTx(tx).set({
          $UI: {
            type: "vnode",
            name: "main",
            props: {},
            children: [
              {
                type: "vnode",
                name: "aside",
                props: {},
                children: ["Authorized sibling"],
              },
              panel,
            ],
          },
        })
      );
      reconciler.mount(root.asSchema(rendererVDOMSchema));
      await runtime.idle();
      await runtime.storageManager.synced();
      await runtime.idle();
      reconciler.flush();
      const element = (tag: string) =>
        ops.filter((op) => op.op === "create-element").find((op) =>
          op.tagName === tag
        )?.nodeId;
      const rootId = element("main");
      const siblingId = element("aside");
      const panelId = element("article");
      expect(rootId).toBeDefined();
      expect(siblingId).toBeDefined();
      expect(panelId).toBeDefined();
      ops.length = 0;
      errors.set(foreign.did(), new Error("Access revoked"));
      for (const observer of [...(observers.get(foreign.did()) ?? [])]) {
        observer();
      }
      reconciler.flush();
      expect(ops).toContainEqual({ op: "remove-node", nodeId: panelId });
      expect(ops).not.toContainEqual({ op: "remove-node", nodeId: rootId });
      expect(ops).not.toContainEqual({ op: "remove-node", nodeId: siblingId });
      expect(
        ops.some((op) =>
          op.op === "create-text" && op.text === "Access unavailable"
        ),
      ).toBe(true);
      ops.length = 0;
      errors.delete(foreign.did());
      for (const observer of [...(observers.get(foreign.did()) ?? [])]) {
        observer();
      }
      await runtime.idle();
      reconciler.flush();
      expect(
        ops.some((op) =>
          op.op === "create-text" && op.text === "Private panel"
        ),
      ).toBe(true);
      expect(ops).not.toContainEqual({ op: "remove-node", nodeId: rootId });
      expect(ops).not.toContainEqual({ op: "remove-node", nodeId: siblingId });
      ops.length = 0;
      errors.set(owner.did(), new Error("Access revoked"));
      for (const observer of [...(observers.get(owner.did()) ?? [])]) {
        observer();
      }
      reconciler.flush();
      expect(ops).toContainEqual({ op: "remove-node", nodeId: rootId });
      reconciler.unmount();
      expect([...observers.values()].every((entries) => entries.size === 0))
        .toBe(true);
    } finally {
      reconciler.unmount();
      await runtime.dispose();
    }
  });
});
