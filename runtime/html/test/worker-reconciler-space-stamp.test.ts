import { assertEquals, assertStrictEquals } from "@std/assert";

import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { CellHandle } from "@commonfabric/runtime-client";

import {
  clearPieceBoundary,
  getPieceBoundary,
  provideElementSpace,
  providePieceBoundary,
  subscribePieceBoundary,
} from "../src/main/space-context.ts";
import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";

// Space stamping (seefeldb's #4074 design): each create-element op
// carries the space of the cell whose render produced it, elided when
// the nearest stamped ancestor's space is the same — so cross-space
// TRANSCLUSION re-stamps at its boundary and everything else inherits.

function createOpsCollector() {
  const allOps: VDomOp[] = [];
  return {
    onOps: (ops: VDomOp[]) => {
      for (const op of ops) allOps.push(op);
    },
    creates: () =>
      allOps.filter((op) => op.op === "create-element") as Array<
        { op: string; nodeId: number; tagName: string; space?: string }
      >,
  };
}

Deno.test("worker reconciler - space stamping across transclusion", async (t) => {
  const signer = await Identity.fromPassphrase("test space stamp");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });
  const dummyTx = runtime.edit();
  const dummyCell = runtime.getCell(signer.did(), "dummy", undefined, dummyTx);
  const CellImplConstructor = dummyCell.constructor;

  class MockCell extends (CellImplConstructor as any) {
    #space: string;
    constructor(public value: any, space: string) {
      super(runtime, undefined, undefined, false, undefined, "cell");
      this.value = value;
      this.#space = space;
    }
    get space() {
      return this.#space;
    }
    sink(callback: (value: any) => void) {
      callback(this.value);
      return () => {};
    }
    isStream() {
      return false;
    }
    get() {
      return this.value;
    }
    getAsNormalizedFullLink() {
      return {
        id: "of:mock",
        space: this.#space,
        path: [],
        scope: "space",
      };
    }
  }

  const spaceA = "did:key:z6Mk-stamp-outer";
  const spaceB = "did:key:z6Mk-stamp-transcluded";

  await t.step(
    "root stamps; same-space child elides; transcluded subtree re-stamps",
    async () => {
      const transcluded = new MockCell(
        { type: "vnode", name: "span", props: {}, children: ["inner"] },
        spaceB,
      );
      const root = new MockCell(
        {
          type: "vnode",
          name: "div",
          props: {},
          children: [
            { type: "vnode", name: "p", props: {}, children: ["same"] },
            transcluded,
          ],
        },
        spaceA,
      );
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({ onOps: collector.onOps });
      const cancel = reconciler.mount(root as any);
      await new Promise((resolve) => setTimeout(resolve, 0)); // op flush
      const byTag = Object.fromEntries(
        collector.creates().map((op) => [op.tagName, op.space]),
      );
      // Root element carries the mounting cell's space.
      assertEquals(byTag["div"], spaceA);
      // Same-space child inherits (elided).
      assertEquals(byTag["p"], undefined);
      // The transcluded cell's subtree re-stamps with ITS space.
      assertEquals(byTag["span"], spaceB);
      cancel();
    },
  );

  await t.step("static mounts carry no space", async () => {
    const collector = createOpsCollector();
    const reconciler = new WorkerReconciler({ onOps: collector.onOps });
    const cancel = reconciler.mount({
      type: "vnode",
      name: "div",
      props: {},
      children: [],
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 0)); // op flush
    assertEquals(collector.creates()[0].space, undefined);
    cancel();
  });

  await runtime.dispose();
  await storageManager.close();
});

Deno.test("element render contexts share the standard context protocol", () => {
  const target = new EventTarget();
  provideElementSpace(target, "did:key:z6Mk-ctx");
  let received: string | undefined;
  let stopped = false;
  const event = Object.assign(
    new Event("context-request", { bubbles: true }),
    {
      context: "space",
      callback: (value: string | undefined) => {
        received = value;
      },
    },
  );
  const origStop = event.stopPropagation.bind(event);
  event.stopPropagation = () => {
    stopped = true;
    origStop();
  };
  target.dispatchEvent(event);
  assertEquals(received, "did:key:z6Mk-ctx");
  assertEquals(stopped, true);

  // Other contexts pass through untouched.
  let otherAnswered = false;
  const other = Object.assign(new Event("context-request"), {
    context: "runtime",
    callback: () => {
      otherAnswered = true;
    },
  });
  target.dispatchEvent(other);
  assertEquals(otherAnswered, false);

  const cell = {} as CellHandle;
  providePieceBoundary(target as unknown as Element, cell);
  const piece = getPieceBoundary(target);
  assertStrictEquals(piece?.cell, cell);
  assertStrictEquals(piece?.element, target);

  const deliveries: Array<CellHandle | undefined> = [];
  const unsubscribe = subscribePieceBoundary(target, (value) => {
    deliveries.push(value?.cell);
  });
  clearPieceBoundary(target as unknown as Element);
  providePieceBoundary(target as unknown as Element, cell);
  unsubscribe();
  clearPieceBoundary(target as unknown as Element);
  assertEquals(deliveries, [cell, undefined, cell]);
});
