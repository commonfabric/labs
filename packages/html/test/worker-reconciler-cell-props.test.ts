import { assertEquals } from "@std/assert";

import { Identity } from "@commonfabric/identity";
import { KeepAsCell, Runtime } from "@commonfabric/runner";
import { cfcLabelViewForCell } from "@commonfabric/runner/cfc";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type { WorkerVNode } from "../src/worker/types.ts";

/**
 * Helper to collect ops emitted by the reconciler.
 */
function createOpsCollector() {
  const allOps: VDomOp[] = [];
  const batchIds: number[] = [];
  let nextBatchId = 0;
  return {
    onOps: (ops: VDomOp[]) => {
      const batchId = nextBatchId++;
      allOps.push(...ops);
      batchIds.push(batchId);
      return batchId;
    },
    getOps: () => allOps,
    getLastBatchId: () => batchIds.at(-1),
    clear: () => {
      allOps.length = 0;
    },
    hasOp: (opType: string) => allOps.some((op) => op.op === opType),
    getOpsOfType: (opType: string) => allOps.filter((op) => op.op === opType),
  };
}

Deno.test("worker reconciler - Cell<Props> handling", async (t) => {
  // Setup minimal runtime to get CellImpl
  const signer = await Identity.fromPassphrase("test cell-props");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });

  try {
    // Get CellImpl constructor
    const dummyTx = runtime.edit();
    const dummyCell = runtime.getCell(
      signer.did(),
      "dummy",
      undefined,
      dummyTx,
    );
    const CellImplConstructor = dummyCell.constructor;

    // MockCell extending CellImpl for basic Cell behavior
    class MockCell extends (CellImplConstructor as any) {
      #subscribers = new Set<(value: any) => void>();

      constructor(public value: any) {
        super(runtime, undefined, undefined, false, undefined, "cell");
        this.value = value;
      }

      sink(callback: (value: any) => void) {
        this.#subscribers.add(callback);
        callback(this.value);
        return () => {
          this.#subscribers.delete(callback);
        };
      }

      set(newValue: any) {
        this.value = newValue;
        for (const sub of this.#subscribers) {
          sub(newValue);
        }
      }

      isStream() {
        return false;
      }
    }

    /**
     * MockPropsCell: simulates Cell<Props> with key(), resolveAsCell() support.
     * When sunk, emits the props object. key() returns a MockPropCell for that key.
     */
    class MockPropsCell extends MockCell {
      static nextId = 0;
      #propCells = new Map<string, MockPropCell>();
      readonly #linkId = `test-props-${++MockPropsCell.nextId}`;
      #rawValue: any;

      constructor(value: any, rawValue: any = value) {
        super(value);
        this.#rawValue = rawValue;
      }

      key(propName: string) {
        if (!this.#propCells.has(propName)) {
          this.#propCells.set(
            propName,
            new MockPropCell(this.value?.[propName], this, propName),
          );
        }
        return this.#propCells.get(propName)!;
      }

      getRawUntyped() {
        return this.#rawValue;
      }

      getAsNormalizedFullLink() {
        return { space: "test-space", id: this.#linkId, path: [] };
      }

      override set(newValue: any) {
        super.set(newValue);
        this.#rawValue = newValue;
        // Propagate updates to existing child prop cells
        for (const [k, propCell] of this.#propCells) {
          propCell.set(newValue?.[k]);
        }
      }
    }

    /**
     * MockPropCell: represents a single prop's Cell.
     * Supports asSchema(), resolveAsCell(), getAsNormalizedFullLink().
     */
    class MockPropCell extends MockCell {
      #parentCell?: MockPropsCell;
      #propKey?: string;

      constructor(value: any, parentCell?: MockPropsCell, propKey?: string) {
        super(value);
        this.#parentCell = parentCell;
        this.#propKey = propKey;
      }

      asSchema(_schema: any) {
        return this;
      }

      resolveAsCell() {
        // Read live value from parent (matches real Cell.key().resolveAsCell()
        // which navigates the live data, not a stale cache)
        const liveValue = this.#parentCell
          ? this.#parentCell.value?.[this.#propKey!]
          : this.value;
        if (
          liveValue && typeof liveValue === "object" && "sink" in liveValue
        ) {
          return liveValue;
        }
        return this;
      }

      getAsNormalizedFullLink() {
        return { space: "test-space", id: "test-id", path: [] };
      }

      getRawUntyped() {
        return this.#parentCell
          ? this.#parentCell.value?.[this.#propKey!]
          : this.value;
      }
    }

    /**
     * MockStream: a Cell-like object that isStream() returns true for.
     */
    class MockStream extends MockCell {
      static nextId = 0;
      public sent: unknown[] = [];
      readonly #linkId = `test-stream-${++MockStream.nextId}`;

      constructor() {
        super(undefined);
      }

      override isStream() {
        return true;
      }

      withTx(tx?: unknown) {
        this.usedTx = tx;
        return this;
      }

      send(event: unknown) {
        this.sent.push(event);
      }

      getAsNormalizedFullLink() {
        return { space: "test-space", id: this.#linkId, path: [] };
      }

      public usedTx: unknown;
    }

    const mountReconciler = (
      reconciler: WorkerReconciler,
      rootCell: MockCell,
    ): () => void => reconciler.mount(rootCell as any);

    await t.step("Cell<Props> renders primitive props", async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const propsCell = new MockPropsCell({
        className: "foo",
        title: "bar",
      });

      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: propsCell,
        children: [],
      });

      const cancel = mountReconciler(reconciler, rootCell);
      try {
        await t.settle();

        const setPropOps = collector.getOpsOfType("set-prop");
        const classOp = setPropOps.find((op: any) => op.key === "className");
        const titleOp = setPropOps.find((op: any) => op.key === "title");

        assertEquals(
          classOp !== undefined,
          true,
          "Should emit set-prop for className",
        );
        assertEquals((classOp as any)?.value, "foo");
        assertEquals(
          titleOp !== undefined,
          true,
          "Should emit set-prop for title",
        );
        assertEquals((titleOp as any)?.value, "bar");
      } finally {
        cancel();
      }
    });

    await t.step("Cell<Props> primitive prop updates", async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const propsCell = new MockPropsCell({ className: "foo" });
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: propsCell,
        children: [],
      });

      const cancel = mountReconciler(reconciler, rootCell);
      try {
        await t.settle();
        collector.clear();

        // Update primitive prop
        propsCell.set({ className: "bar" });
        await t.settle();

        const setPropOps = collector.getOpsOfType("set-prop");
        const classOp = setPropOps.find((op: any) => op.key === "className");
        assertEquals(
          classOp !== undefined,
          true,
          "Should emit set-prop for updated className",
        );
        assertEquals((classOp as any)?.value, "bar");
      } finally {
        cancel();
      }
    });

    await t.step("Cell<Props> prop addition", async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const propsCell = new MockPropsCell({ className: "foo" });
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: propsCell,
        children: [],
      });

      const cancel = mountReconciler(reconciler, rootCell);
      try {
        await t.settle();
        collector.clear();

        // Add a new prop
        propsCell.set({ className: "foo", title: "new" });
        await t.settle();

        const setPropOps = collector.getOpsOfType("set-prop");
        const titleOp = setPropOps.find((op: any) => op.key === "title");
        assertEquals(
          titleOp !== undefined,
          true,
          "Should emit set-prop for new title",
        );
        assertEquals((titleOp as any)?.value, "new");
      } finally {
        cancel();
      }
    });

    await t.step("Cell<Props> prop removal", async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const propsCell = new MockPropsCell({
        className: "foo",
        title: "bar",
      });
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: propsCell,
        children: [],
      });

      const cancel = mountReconciler(reconciler, rootCell);
      try {
        await t.settle();
        collector.clear();

        // Remove title prop
        propsCell.set({ className: "foo" });
        await t.settle();

        const removePropOps = collector.getOpsOfType("remove-prop");
        const titleRemoved = removePropOps.some((op: any) =>
          op.key === "title"
        );
        assertEquals(titleRemoved, true, "Should emit remove-prop for title");
      } finally {
        cancel();
      }
    });

    await t.step("Cell<Props> object prop (style)", async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const propsCell = new MockPropsCell({
        style: { color: "red" },
      });
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: propsCell,
        children: [],
      });

      const cancel = mountReconciler(reconciler, rootCell);
      try {
        await t.settle();

        const setPropOps = collector.getOpsOfType("set-prop");
        const styleOp = setPropOps.find((op: any) => op.key === "style");
        assertEquals(
          styleOp !== undefined,
          true,
          "Should emit set-prop for schema-resolved style",
        );
        // Style objects get transformed to CSS strings by transformPropValue
        // after the parent props schema resolves the full object.
      } finally {
        cancel();
      }
    });

    await t.step(
      "Cell<Props> object prop transitioning to undefined is emitted",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        const propsCell = new MockPropsCell({ items: [1, 2, 3] });
        const rootCell = new MockCell({
          type: "vnode",
          name: "div",
          props: propsCell,
          children: [],
        });

        const cancel = mountReconciler(reconciler, rootCell);
        try {
          await t.settle();
          collector.clear();

          propsCell.set({ items: undefined });
          await t.settle();

          const setPropOps = collector.getOpsOfType("set-prop");
          assertEquals(
            setPropOps.some((op: any) =>
              op.key === "items" && op.value === undefined
            ),
            true,
            "Should emit set-prop when a generic object prop becomes undefined",
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step("Cell<Props> array prop", async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const propsCell = new MockPropsCell({
        items: [1, 2, 3],
      });
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: propsCell,
        children: [],
      });

      const cancel = mountReconciler(reconciler, rootCell);
      try {
        await t.settle();

        const setPropOps = collector.getOpsOfType("set-prop");
        const itemsOp = setPropOps.find((op: any) => op.key === "items");
        assertEquals(
          itemsOp !== undefined,
          true,
          "Should emit set-prop for array items (via per-prop sink)",
        );
      } finally {
        cancel();
      }
    });

    await t.step("Cell<Props> event handler (stream)", async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const mockStream = new MockStream();
      const propsCell = new MockPropsCell({
        onclick: mockStream,
      });
      const rootCell = new MockCell({
        type: "vnode",
        name: "button",
        props: propsCell,
        children: ["Click"],
      });

      const cancel = mountReconciler(reconciler, rootCell);
      try {
        await t.settle();

        const setEventOps = collector.getOpsOfType("set-event");
        assertEquals(setEventOps.length >= 1, true, "Should emit set-event");
        assertEquals((setEventOps[0] as any).eventType, "click");
      } finally {
        cancel();
      }
    });

    await t.step(
      "Cell<Props> stream event dispatch avoids render transaction reuse",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        const mockStream = new MockStream();
        const propsCell = new MockPropsCell({
          onclick: mockStream,
        });
        const rootCell = new MockCell({
          type: "vnode",
          name: "button",
          props: propsCell,
          children: ["Click"],
        });

        const cancel = mountReconciler(reconciler, rootCell);
        try {
          await t.settle();

          const setEventOps = collector.getOpsOfType("set-event");
          const eventOp = setEventOps[0] as Extract<
            VDomOp,
            { op: "set-event" }
          >;
          reconciler.dispatchEvent(
            eventOp.handlerId,
            { type: "click" },
          );

          assertEquals(mockStream.usedTx, undefined);
          assertEquals(mockStream.sent, [{ type: "click" }]);
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "Cell<Props> event handler remains available during listener updates",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        const firstStream = new MockStream();
        const secondStream = new MockStream();
        const propsCell = new MockPropsCell({
          onclick: firstStream,
        });
        const rootCell = new MockCell({
          type: "vnode",
          name: "button",
          props: propsCell,
          children: ["Click"],
        });

        const cancel = mountReconciler(reconciler, rootCell);
        try {
          await t.settle();

          const firstEventOps = collector.getOpsOfType("set-event");
          const firstEventOp = firstEventOps[0] as Extract<
            VDomOp,
            { op: "set-event" }
          >;
          collector.clear();

          propsCell.set({ onclick: secondStream });
          await t.settle();

          const secondEventOps = collector.getOpsOfType("set-event");
          const secondEventOp = secondEventOps[0] as Extract<
            VDomOp,
            { op: "set-event" }
          >;

          assertEquals(
            reconciler.dispatchEvent(
              firstEventOp.handlerId,
              { type: "click", phase: "old-listener" },
            ),
            true,
          );
          assertEquals(
            reconciler.dispatchEvent(
              secondEventOp.handlerId,
              { type: "click", phase: "new-listener" },
            ),
            true,
          );
          assertEquals(firstStream.sent, [
            { type: "click", phase: "old-listener" },
          ]);
          assertEquals(secondStream.sent, [
            { type: "click", phase: "new-listener" },
          ]);

          const appliedBatchId = collector.getLastBatchId();
          if (appliedBatchId === undefined) {
            throw new Error("expected listener update batch");
          }
          reconciler.acknowledgeBatchApplied(appliedBatchId);
          assertEquals(
            reconciler.dispatchEvent(
              firstEventOp.handlerId,
              { type: "click", phase: "after-ack" },
            ),
            false,
          );
          assertEquals(
            reconciler.dispatchEvent(
              secondEventOp.handlerId,
              { type: "click", phase: "after-ack" },
            ),
            true,
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "Cell<Props> event handler remains available during node replacement",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        const stream = new MockStream();
        const propsCell = new MockPropsCell({
          onclick: stream,
        });
        const rootCell = new MockCell({
          type: "vnode",
          name: "button",
          props: propsCell,
          children: ["Click"],
        });

        const cancel = mountReconciler(reconciler, rootCell);
        try {
          await t.settle();

          const eventOps = collector.getOpsOfType("set-event");
          const eventOp = eventOps[0] as Extract<
            VDomOp,
            { op: "set-event" }
          >;
          collector.clear();

          rootCell.set("Replaced");
          await t.settle();

          assertEquals(
            reconciler.dispatchEvent(
              eventOp.handlerId,
              { type: "click", phase: "removed-node" },
            ),
            true,
          );
          assertEquals(stream.sent, [
            { type: "click", phase: "removed-node" },
          ]);

          const appliedBatchId = collector.getLastBatchId();
          if (appliedBatchId === undefined) {
            throw new Error("expected node replacement batch");
          }
          reconciler.acknowledgeBatchApplied(appliedBatchId);
          assertEquals(
            reconciler.dispatchEvent(
              eventOp.handlerId,
              { type: "click", phase: "after-ack" },
            ),
            false,
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "Cell<Props> event handler is removed when a new props cell omits it",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        const stream = new MockStream();
        const firstPropsCell = new MockPropsCell({ onclick: stream });
        const secondPropsCell = new MockPropsCell({ title: "plain" });
        const rootCell = new MockCell({
          type: "vnode",
          name: "button",
          props: firstPropsCell,
          children: ["Click"],
        });

        const cancel = mountReconciler(reconciler, rootCell);
        try {
          await t.settle();

          const eventOp = collector.getOpsOfType("set-event")[0] as Extract<
            VDomOp,
            { op: "set-event" }
          >;
          collector.clear();

          rootCell.set({
            type: "vnode",
            name: "button",
            props: secondPropsCell,
            children: ["Click"],
          });
          await t.settle();

          assertEquals(
            collector.getOpsOfType("remove-event").some((op: any) =>
              op.eventType === "click"
            ),
            true,
          );
          assertEquals(
            reconciler.dispatchEvent(
              eventOp.handlerId,
              { type: "click", phase: "props-cell-swap" },
            ),
            true,
          );

          const appliedBatchId = collector.getLastBatchId();
          if (appliedBatchId === undefined) {
            throw new Error("expected props cell replacement batch");
          }
          reconciler.acknowledgeBatchApplied(appliedBatchId);
          assertEquals(
            reconciler.dispatchEvent(
              eventOp.handlerId,
              { type: "click", phase: "after-ack" },
            ),
            false,
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "Cell<Props> event handler is removed after unmount acknowledgment",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        const stream = new MockStream();
        const propsCell = new MockPropsCell({ onclick: stream });
        const rootCell = new MockCell({
          type: "vnode",
          name: "button",
          props: propsCell,
          children: ["Click"],
        });

        const cancel = mountReconciler(reconciler, rootCell);
        try {
          await t.settle();

          const eventOp = collector.getOpsOfType("set-event")[0] as Extract<
            VDomOp,
            { op: "set-event" }
          >;
          collector.clear();

          reconciler.unmount();

          assertEquals(
            reconciler.dispatchEvent(
              eventOp.handlerId,
              { type: "click", phase: "unmount-before-ack" },
            ),
            true,
          );

          const appliedBatchId = collector.getLastBatchId();
          if (appliedBatchId === undefined) {
            throw new Error("expected unmount batch");
          }
          reconciler.acknowledgeBatchApplied(appliedBatchId);
          assertEquals(
            reconciler.dispatchEvent(
              eventOp.handlerId,
              { type: "click", phase: "unmount-after-ack" },
            ),
            false,
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step("Cell<Props> binding prop", async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const bindingCell = runtime.getCell(
        signer.did(),
        "binding-test-cell",
        undefined,
        dummyTx,
      );
      bindingCell.set("hello");

      const propsCell = new MockPropsCell({
        $value: bindingCell,
      });
      const rootCell = new MockCell({
        type: "vnode",
        name: "cf-input",
        props: propsCell,
        children: [],
      });

      const cancel = mountReconciler(reconciler, rootCell);
      try {
        await t.settle();

        const setBindingOps = collector.getOpsOfType("set-binding");
        assertEquals(
          setBindingOps.length >= 1,
          true,
          "Should emit set-binding",
        );
        assertEquals((setBindingOps[0] as any).propName, "value");
      } finally {
        cancel();
      }
    });

    await t.step(
      "Cell<Props> binding prop preserves linked cell identity",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        const bindingCell = runtime.getCell(
          signer.did(),
          "linked-binding-test-cell",
          undefined,
          dummyTx,
        );
        bindingCell.set("linked content");

        const propsCell = new MockPropsCell({
          $value: "linked content",
        }, {
          $value: bindingCell.getAsLink({ keepAsCell: KeepAsCell.All }),
        });
        const rootCell = new MockCell({
          type: "vnode",
          name: "cf-cfc-label",
          props: propsCell,
          children: [],
        });

        const cancel = mountReconciler(reconciler, rootCell);
        try {
          await t.settle();

          const setBindingOps = collector.getOpsOfType("set-binding");
          assertEquals(
            setBindingOps.length >= 1,
            true,
            "Should emit set-binding",
          );
          const bindingOp = setBindingOps[0] as Extract<
            VDomOp,
            { op: "set-binding" }
          >;
          assertEquals(bindingOp.propName, "value");
          assertEquals(
            bindingOp.cellRef.id,
            bindingCell.getAsNormalizedFullLink().id,
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "Cell<Props> binding prop preserves CellResult proxy identity",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        const bindingCell = runtime.getCell(
          signer.did(),
          "cell-result-binding-test-cell",
          undefined,
          dummyTx,
        );
        bindingCell.set({
          senderId: "alice",
          body: "linked content",
        });

        const cellResult = bindingCell.getAsQueryResult();
        const propsCell = new MockPropsCell({
          $value: cellResult,
        });
        const rootCell = new MockCell({
          type: "vnode",
          name: "cf-cfc-authorship",
          props: propsCell,
          children: [],
        });

        const cancel = mountReconciler(reconciler, rootCell);
        try {
          await t.settle();

          const setBindingOps = collector.getOpsOfType("set-binding");
          assertEquals(
            setBindingOps.length >= 1,
            true,
            "Should emit set-binding",
          );
          const bindingOp = setBindingOps[0] as Extract<
            VDomOp,
            { op: "set-binding" }
          >;
          assertEquals(bindingOp.propName, "value");
          assertEquals(
            bindingOp.cellRef.id,
            bindingCell.getAsNormalizedFullLink().id,
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "renderer VDOM schema preserves linked binding prop identity",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        const tx = runtime.edit();
        const bindingSchema = {
          type: "string",
          ifc: {
            integrity: [{
              kind: "authored-by",
              subject: "alice",
            }],
          },
        } as const;
        const bindingCell = runtime.getCell(
          signer.did(),
          "renderer-schema-binding-target",
          bindingSchema,
          tx,
        );
        bindingCell.set("renderer schema linked content");
        const rootCell = runtime.getCell(
          signer.did(),
          "renderer-schema-binding-root",
          undefined,
          tx,
        );
        rootCell.setRawUntyped({
          type: "vnode",
          name: "cf-cfc-authorship",
          props: {
            $value: bindingCell.getAsLink({
              includeSchema: true,
              keepAsCell: KeepAsCell.All,
            }),
            author: "alice",
          },
          children: [],
        });
        runtime.prepareTxForCommit(tx);
        const commitResult = await tx.commit();
        assertEquals(commitResult.ok !== undefined, true);

        const rootVDOMCell = runtime.getCell(
          signer.did(),
          "renderer-schema-binding-root",
        ).asSchema(rendererVDOMSchema);
        const cancel = reconciler.mount(rootVDOMCell as never);
        try {
          await t.settle();

          const setBindingOps = collector.getOpsOfType("set-binding");
          assertEquals(
            setBindingOps.length >= 1,
            true,
            "Should emit set-binding",
          );
          const bindingOp = setBindingOps[0] as Extract<
            VDomOp,
            { op: "set-binding" }
          >;
          assertEquals(bindingOp.propName, "value");
          assertEquals(
            bindingOp.cellRef.id,
            bindingCell.getAsNormalizedFullLink().id,
          );
          assertEquals(
            cfcLabelViewForCell(runtime.getCellFromLink(bindingOp.cellRef)),
            {
              version: 1,
              entries: [{
                path: [],
                label: {
                  integrity: [{
                    kind: "authored-by",
                    subject: "alice",
                  }],
                },
              }],
            },
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "renderer VDOM schema preserves linked child render nodes",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        const tx = runtime.edit();
        const linkedChild = runtime.getCell(
          signer.did(),
          "renderer-schema-linked-child",
          undefined,
          tx,
        );
        linkedChild.setRawUntyped({
          type: "vnode",
          name: "cf-card",
          props: { id: "linked-child-card" },
          children: ["Linked child"],
        });
        const rootCell = runtime.getCell(
          signer.did(),
          "renderer-schema-linked-child-root",
          undefined,
          tx,
        );
        rootCell.setRawUntyped({
          type: "vnode",
          name: "cf-vstack",
          props: {},
          children: [linkedChild.getAsLink({ keepAsCell: KeepAsCell.All })],
        });
        runtime.prepareTxForCommit(tx);
        const commitResult = await tx.commit();
        assertEquals(commitResult.ok !== undefined, true);

        const rootVDOMCell = runtime.getCell(
          signer.did(),
          "renderer-schema-linked-child-root",
        ).asSchema(rendererVDOMSchema);
        const cancel = reconciler.mount(rootVDOMCell as never);
        try {
          await t.settle();

          const createdTags = collector.getOpsOfType("create-element").map(
            (op) => (op as Extract<VDomOp, { op: "create-element" }>).tagName,
          );
          assertEquals(createdTags.includes("cf-vstack"), true);
          assertEquals(createdTags.includes("cf-card"), true);
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "renderer VDOM schema preserves nested render node children",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        const tx = runtime.edit();
        const linkedChild = runtime.getCell(
          signer.did(),
          "renderer-schema-nested-linked-child",
          undefined,
          tx,
        );
        linkedChild.setRawUntyped({
          type: "vnode",
          name: "cf-cfc-authorship",
          props: { author: "alice" },
          children: ["Nested linked child"],
        });
        const rootCell = runtime.getCell(
          signer.did(),
          "renderer-schema-nested-linked-child-root",
          undefined,
          tx,
        );
        rootCell.setRawUntyped({
          type: "vnode",
          name: "cf-screen",
          props: { title: "Nested children" },
          children: [{
            type: "vnode",
            name: "cf-vstack",
            props: {},
            children: [
              {
                type: "vnode",
                name: "cf-card",
                props: { id: "nested-inline-card" },
                children: ["Nested inline child"],
              },
              linkedChild.getAsLink({ keepAsCell: KeepAsCell.All }),
            ],
          }],
        });
        runtime.prepareTxForCommit(tx);
        const commitResult = await tx.commit();
        assertEquals(commitResult.ok !== undefined, true);

        const rootVDOMCell = runtime.getCell(
          signer.did(),
          "renderer-schema-nested-linked-child-root",
        ).asSchema(rendererVDOMSchema);
        const cancel = reconciler.mount(rootVDOMCell as never);
        try {
          await t.settle();

          const createdTags = collector.getOpsOfType("create-element").map(
            (op) => (op as Extract<VDomOp, { op: "create-element" }>).tagName,
          );
          assertEquals(createdTags.includes("cf-screen"), true);
          assertEquals(createdTags.includes("cf-vstack"), true);
          assertEquals(createdTags.includes("cf-card"), true);
          assertEquals(createdTags.includes("cf-cfc-authorship"), true);
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "Cell<Props> same cell on update → no re-bind",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        const propsCell = new MockPropsCell({ className: "foo" });
        const rootVNode: WorkerVNode = {
          type: "vnode",
          name: "div",
          props: propsCell as any,
          children: [],
        };
        const rootCell = new MockCell(rootVNode);

        const cancel = mountReconciler(reconciler, rootCell);
        try {
          await t.settle();
          // Pins the absence below to the same-cell check rather than to the
          // props never having been rendered at all.
          assertEquals(
            collector.getOpsOfType("set-prop").some((op: any) =>
              op.key === "className"
            ),
            true,
            "mount should emit set-prop for className",
          );
          collector.clear();

          // Update root but keep same propsCell reference
          rootCell.set({
            type: "vnode",
            name: "div",
            props: propsCell as any,
            children: [],
          });
          await t.settle();

          // Same Cell<Props> → updatePropsInPlace should detect same cell and skip
          const setPropOps = collector.getOpsOfType("set-prop");
          assertEquals(
            setPropOps.length,
            0,
            "Should emit NO set-prop ops when same Cell<Props> is re-used",
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "Cell<Props> props cleared then re-emitted re-registers handlers",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        const mockStream = new MockStream();
        const propsCell = new MockPropsCell({
          className: "foo",
          onclick: mockStream,
        });
        const rootCell = new MockCell({
          type: "vnode",
          name: "button",
          props: propsCell,
          children: ["Click"],
        });

        const cancel = mountReconciler(reconciler, rootCell);
        try {
          await t.settle();

          const initialEvents = collector.getOpsOfType("set-event");
          assertEquals(initialEvents.length >= 1, true, "Initial set-event");
          const initialProps = collector.getOpsOfType("set-prop");
          assertEquals(
            initialProps.some((op: any) => op.key === "className"),
            true,
            "Initial className",
          );
          collector.clear();

          // Clear all props
          propsCell.set(null);
          await t.settle();

          const removeOps = collector.getOps();
          assertEquals(removeOps.length > 0, true, "Should emit removal ops");
          collector.clear();

          // Re-emit the same props — handlers must be re-registered
          propsCell.set({ className: "foo", onclick: mockStream });
          await t.settle();

          const reEvents = collector.getOpsOfType("set-event");
          assertEquals(
            reEvents.length >= 1,
            true,
            "Must re-register event handler after props were cleared",
          );

          const reProps = collector.getOpsOfType("set-prop");
          assertEquals(
            reProps.some((op: any) => op.key === "className"),
            true,
            "Must re-set className after props were cleared",
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "Cell<Props> unchanged primitive props are not re-emitted",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        const propsCell = new MockPropsCell({
          className: "foo",
          title: "bar",
        });
        const rootCell = new MockCell({
          type: "vnode",
          name: "div",
          props: propsCell,
          children: [],
        });

        const cancel = mountReconciler(reconciler, rootCell);
        try {
          await t.settle();
          collector.clear();

          // Re-emit identical values
          propsCell.set({ className: "foo", title: "bar" });
          await t.settle();

          const setPropOps = collector.getOpsOfType("set-prop");
          assertEquals(
            setPropOps.length,
            0,
            "Should emit NO set-prop ops when primitive values are unchanged",
          );

          collector.clear();

          // Change only one value
          propsCell.set({ className: "foo", title: "baz" });
          await t.settle();

          const updatedOps = collector.getOpsOfType("set-prop");
          assertEquals(
            updatedOps.length,
            1,
            "Should emit exactly one set-prop for the changed value",
          );
          assertEquals(
            (updatedOps[0] as any).key,
            "title",
            "Changed prop should be title",
          );
          assertEquals((updatedOps[0] as any).value, "baz");
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "Cell<Props> re-emits DOM-live props (value) on an unchanged repeat, parity with inline props (CT-1803)",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        const propsCell = new MockPropsCell({
          className: "foo",
          value: "hello",
        });
        const rootCell = new MockCell({
          type: "vnode",
          name: "input",
          props: propsCell,
          children: [],
        });

        const cancel = mountReconciler(reconciler, rootCell);
        try {
          await t.settle();
          collector.clear();

          // Re-emit identical values. The worker can't see live DOM drift, so
          // the DOM-live `value` must re-emit to let setPropDefault repair it;
          // the inert className stays quiet (parity with the inline static path).
          propsCell.set({ className: "foo", value: "hello" });
          await t.settle();

          const keys = collector.getOpsOfType("set-prop")
            .map((op: any) => op.key);
          assertEquals(
            keys.includes("value"),
            true,
            "DOM-live `value` must re-emit so drift can be repaired",
          );
          assertEquals(
            keys.includes("className"),
            false,
            "inert className should be skipped when unchanged",
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step(
      "Cell<Props> re-emits text-integrity props (cf-chat-message name/content) on an unchanged repeat (CT-1803)",
      async () => {
        const collector = createOpsCollector();
        const reconciler = new WorkerReconciler({
          onOps: collector.onOps,
        });

        const propsCell = new MockPropsCell({
          id: "m1",
          name: "Alice",
          content: "hi",
        });
        const rootCell = new MockCell({
          type: "vnode",
          name: "cf-chat-message",
          props: propsCell,
          children: [],
        });

        const cancel = mountReconciler(reconciler, rootCell);
        try {
          await t.settle();
          collector.clear();

          // Text-integrity sinks have policy-dependent transforms and must
          // re-run; only the inert id may be skipped.
          propsCell.set({ id: "m1", name: "Alice", content: "hi" });
          await t.settle();

          const keys = collector.getOpsOfType("set-prop")
            .map((op: any) => op.key);
          assertEquals(
            keys.includes("name"),
            true,
            "text-integrity `name` must re-emit",
          );
          assertEquals(
            keys.includes("content"),
            true,
            "text-integrity `content` must re-emit",
          );
          assertEquals(
            keys.includes("id"),
            false,
            "inert id should be skipped when unchanged",
          );
        } finally {
          cancel();
        }
      },
    );

    await t.step("Cell<Props> mixed prop types", async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const mockStream = new MockStream();
      const bindingCell = runtime.getCell(
        signer.did(),
        "binding-mixed-cell",
        undefined,
        dummyTx,
      );
      bindingCell.set("test");

      const propsCell = new MockPropsCell({
        className: "container",
        style: { color: "blue" },
        onclick: mockStream,
        $value: bindingCell,
      });
      const rootCell = new MockCell({
        type: "vnode",
        name: "cf-input",
        props: propsCell,
        children: [],
      });

      const cancel = mountReconciler(reconciler, rootCell);
      try {
        await t.settle();

        // Verify primitive prop
        const setPropOps = collector.getOpsOfType("set-prop");
        const classOp = setPropOps.find((op: any) => op.key === "className");
        assertEquals(
          classOp !== undefined,
          true,
          "Should have className set-prop",
        );

        // Verify schema-resolved style.
        const styleOp = setPropOps.find((op: any) => op.key === "style");
        assertEquals(styleOp !== undefined, true, "Should have style set-prop");

        // Verify event handler
        const setEventOps = collector.getOpsOfType("set-event");
        assertEquals(setEventOps.length >= 1, true, "Should have set-event");

        // Verify binding
        const setBindingOps = collector.getOpsOfType("set-binding");
        assertEquals(
          setBindingOps.length >= 1,
          true,
          "Should have set-binding",
        );
        assertEquals((setBindingOps[0] as any).propName, "value");
      } finally {
        cancel();
      }
    });
  } finally {
    await runtime.dispose();
  }
});

Deno.test(
  "worker reconciler - static Cell event prop sends to resolved stream target",
  async () => {
    const signer = await Identity.fromPassphrase("test static cell event prop");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      storageManager,
      apiUrl: new URL("http://localhost"),
    });
    let tx = runtime.edit();

    try {
      const streamCell = runtime.getCell<unknown>(
        signer.did(),
        "static-event-stream",
        { asCell: ["stream"] },
        tx,
      );

      const eventTargetCell = runtime.getCell<unknown>(
        signer.did(),
        "static-event-target",
        undefined,
        tx,
      );
      eventTargetCell.set(streamCell as never);

      const output = runtime.getCell<number>(
        signer.did(),
        "render-event-output",
        undefined,
        tx,
      );
      output.set(0);
      await tx.commit();
      tx = runtime.edit();

      let eventSeen: unknown;
      runtime.scheduler.addEventHandler(
        (handlerTx, event) => {
          eventSeen = event;
          output.withTx(handlerTx).set(1);
        },
        streamCell.getAsNormalizedFullLink(),
      );

      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });
      const vnode: WorkerVNode = {
        type: "vnode",
        name: "button",
        props: {
          onClick: eventTargetCell,
        },
        children: ["Send"],
      };

      const cancel = reconciler.mount(vnode);
      try {
        await runtime.idle();

        const setEventOp = collector.getOpsOfType("set-event")[0] as
          | { handlerId: number }
          | undefined;
        assertEquals(setEventOp !== undefined, true);

        assertEquals(output.get(), 0);
        reconciler.dispatchEvent(
          setEventOp!.handlerId,
          { type: "click" },
        );

        await runtime.idle();
        assertEquals(eventSeen, { type: "click" });
        assertEquals(output.get(), 1);
      } finally {
        cancel();
      }
    } finally {
      tx.abort("test cleanup");
      await runtime.dispose();
    }
  },
);
