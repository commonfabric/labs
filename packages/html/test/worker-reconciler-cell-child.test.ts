/**
 * Covers what the worker reconciler does with a child that is a `Cell`: which
 * updates it can apply to the node already standing, and where it has to build
 * a new one instead.
 *
 * These tests assert on the ops that reach the document rather than on what the
 * document ends up holding, because reusing a node and rebuilding an identical
 * one leave the same result and cost very different amounts. Where the ordering
 * of children is what is under test, `applyOps` replays those ops into a model
 * so an assertion can name the order instead of inferring it from op counts.
 */

import { assertEquals } from "@std/assert";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { Runtime, UI } from "@commonfabric/runner";
import type { Cell } from "@commonfabric/runner";
import type { CfcLabelView } from "@commonfabric/runner/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type { WorkerRenderNode, WorkerVNode } from "../src/worker/types.ts";

/**
 * Helper to collect ops emitted by the reconciler.
 */
function createOpsCollector() {
  const allOps: VDomOp[] = [];
  return {
    onOps: (ops: VDomOp[]) => allOps.push(...ops),
    getOps: () => allOps,
    clear: () => {
      allOps.length = 0;
    },
    hasOp: (opType: string) => allOps.some((op) => op.op === opType),
    getOpsOfType: (opType: string) => allOps.filter((op) => op.op === opType),
  };
}

/**
 * Replays emitted ops into a model of the document, so a test can assert the
 * order children ended up in rather than only the ops that got them there.
 * Follows the applicator in the one respect that decides ordering: inserting a
 * node that is already attached moves it rather than copying it.
 */
function applyOps(ops: readonly VDomOp[]) {
  const childrenOf = new Map<number, number[]>();
  const parentOf = new Map<number, number>();

  const detach = (id: number) => {
    const parent = parentOf.get(id);
    if (parent === undefined) return;
    const siblings = childrenOf.get(parent);
    if (siblings) siblings.splice(siblings.indexOf(id), 1);
  };

  for (const op of ops) {
    if (op.op === "create-element" || op.op === "create-text") {
      childrenOf.set(op.nodeId, []);
    } else if (op.op === "insert-child") {
      detach(op.childId);
      let siblings = childrenOf.get(op.parentId);
      if (!siblings) {
        siblings = [];
        childrenOf.set(op.parentId, siblings);
      }
      const before = op.beforeId === null
        ? -1
        : siblings.indexOf(op.beforeId as number);
      if (before < 0) siblings.push(op.childId);
      else siblings.splice(before, 0, op.childId);
      parentOf.set(op.childId, op.parentId);
    } else if (op.op === "remove-node") {
      detach(op.nodeId);
      parentOf.delete(op.nodeId);
    }
  }

  return { childrenOf, parentOf };
}

Deno.test("worker reconciler - cell child optimization", async (t) => {
  // Setup minimal runtime to get CellImpl
  const signer = await Identity.fromPassphrase("test reconciler");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });

  // Get CellImpl constructor
  const dummyTx = runtime.edit();
  const dummyCell = runtime.getCell(signer.did(), "dummy", undefined, dummyTx);
  const CellImplConstructor = dummyCell.constructor;

  // Define MockCell extending CellImpl
  class MockCell extends (CellImplConstructor as any) {
    value: any;
    #subscribers = new Set<(value: any) => void>();
    /** A mock's read consumes no labels, which a sink may ask to be told. */
    static readonly consumed = {
      confidentiality: [],
      integrity: [],
      modulePolicySpaces: new Map(),
      sources: [],
    };

    constructor(value: any, labelView?: CfcLabelView) {
      // Pass dummy args to super to satisfy it
      // CellImpl(runtime, tx, link, synced, causeContainer, kind, labelView)
      super(runtime, undefined, undefined, false, undefined, "cell", labelView);
      this.value = value;
    }

    sink(
      callback: (value: any, label?: undefined, consumed?: unknown) => void,
      options?: { includeConsumedLabel?: boolean },
    ) {
      const deliver = (value: any) =>
        callback(
          value,
          undefined,
          options?.includeConsumedLabel ? MockCell.consumed : undefined,
        );
      this.#subscribers.add(deliver);
      // A real cell's `sink()` publishes the current value synchronously at
      // subscription, and the reconciler renders from that first delivery.
      deliver(this.value);
      return () => {
        this.#subscribers.delete(deliver);
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

    /**
     * Returns `undefined`: a mock carries no metadata, and the inherited read
     * throws on a link-less cell.
     */
    getMetaRaw(_field?: string): unknown {
      return undefined;
    }

    /**
     * Returns the inherited link. A step that needs another overrides it on
     * the instance, which it can do because this class, and not the frozen
     * cell prototype, defines it.
     */
    getAsNormalizedFullLink() {
      return super.getAsNormalizedFullLink();
    }

    /**
     * Resolves to itself, since a mock names no link; a step that needs
     * otherwise overrides it on the instance.
     */
    resolveAsCell(): MockCell | Cell<unknown> {
      return this;
    }
  }

  for (const teardown of ["unmount", "replace"] as const) {
    for (const wholeProps of [false, true]) {
      await t.step(
        `cancels in-place ${
          wholeProps ? "Cell props" : "Cell prop values"
        } and children on ${teardown}`,
        async () => {
          const collector = createOpsCollector();
          const reconciler = new WorkerReconciler({ onOps: collector.onOps });
          const suffix = `${teardown}-${wholeProps}`;
          const title = runtime.getCell<string>(
            signer.did(),
            `title-${suffix}`,
          );
          const props = runtime.getCell<{ title: string }>(
            signer.did(),
            `props-${suffix}`,
          );
          const children = runtime.getCell<string[]>(
            signer.did(),
            `children-${suffix}`,
          );
          const write = async (value: string) => {
            const tx = runtime.edit();
            title.withTx(tx).set(value);
            props.withTx(tx).set({ title: value });
            children.withTx(tx).set([value]);
            expect((await tx.commit()).error).toBeUndefined();
            await runtime.idle();
            await t.settle();
          };
          await write("initial");
          const root = new MockCell({
            type: "vnode",
            name: "div",
            props: { title: "static" },
            children: ["static"],
          });
          const cancel = reconciler.mount(root as unknown as Cell<unknown>);
          try {
            await t.settle();
            const element = collector.getOps().find((op) =>
              op.op === "create-element" && op.tagName === "div"
            );
            if (!element || element.op !== "create-element") {
              throw new Error("Expected initial `div`");
            }
            collector.clear();
            root.set({
              type: "vnode",
              name: "div",
              props: wholeProps ? props : { title },
              children,
            });
            await runtime.idle();
            await t.settle();
            expect(collector.getOpsOfType("create-element")).toEqual([]);
            const expectRendered = (value: string) => {
              expect(collector.getOps()).toContainEqual({
                op: "set-prop",
                nodeId: element.nodeId,
                key: "title",
                value,
              });
              expect(
                collector.getOps().some((op) =>
                  "text" in op && op.text === value
                ),
              ).toBe(true);
            };
            expectRendered("initial");
            collector.clear();
            await write("updated");
            expectRendered("updated");
            if (teardown === "unmount") {
              cancel();
            } else {
              root.set({
                type: "vnode",
                name: "section",
                props: {},
                children: [],
              });
            }
            await t.settle();
            collector.clear();
            await write("ignored");
            expect(collector.getOps()).toEqual([]);
          } finally {
            cancel();
          }
        },
      );
    }
  }

  await t.step(
    "keeps a reused element's new reactive props and children read-only and cancels them when replaced",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({ onOps: collector.onOps });
      const title = runtime.getCell<string>(signer.did(), "transition-title");
      const children = runtime.getCell<string[]>(
        signer.did(),
        "transition-children",
      );
      const seed = runtime.edit();
      title.withTx(seed).set("first title");
      children.withTx(seed).set(["first child"]);
      expect((await seed.commit()).error).toBeUndefined();
      await runtime.idle();

      const root = new MockCell({
        type: "vnode",
        name: "div",
        props: { title: "static title" },
        children: ["static child"],
      });
      const cancel = reconciler.mount(root as unknown as Cell<unknown>);
      await t.settle();
      const element = collector.getOpsOfType("create-element")[0];
      expect(element?.op).toBe("create-element");
      const elementId = "nodeId" in element ? element.nodeId : undefined;
      const prepare = runtime.prepareTxForCommit;
      const subscriptionModes: boolean[] = [];
      runtime.prepareTxForCommit = (tx) => {
        subscriptionModes.push(tx.isReadOnly?.() === true);
        prepare.call(runtime, tx);
      };
      try {
        collector.clear();
        root.set({
          type: "vnode",
          name: "div",
          props: { title },
          children,
        });
        await runtime.idle();
        await t.settle();
        expect(collector.getOpsOfType("create-element")).toEqual([]);
        expect(collector.getOpsOfType("set-prop")).toContainEqual({
          op: "set-prop",
          nodeId: elementId,
          key: "title",
          value: "first title",
        });
        expect(
          collector.getOps().some((op) =>
            "text" in op && op.text === "first child"
          ),
        ).toBe(true);
        expect(subscriptionModes.length).toBeGreaterThanOrEqual(4);
        expect(subscriptionModes.every(Boolean)).toBe(true);

        collector.clear();
        subscriptionModes.length = 0;
        const update = runtime.edit();
        title.withTx(update).set("second title");
        children.withTx(update).set(["second child"]);
        expect((await update.commit()).error).toBeUndefined();
        await runtime.idle();
        await t.settle();
        expect(collector.getOpsOfType("set-prop")).toContainEqual({
          op: "set-prop",
          nodeId: elementId,
          key: "title",
          value: "second title",
        });
        expect(
          collector.getOps().some((op) =>
            "text" in op && op.text === "second child"
          ),
        ).toBe(true);
        expect(subscriptionModes.length).toBeGreaterThanOrEqual(4);
        expect(subscriptionModes.every(Boolean)).toBe(true);

        root.set({
          type: "vnode",
          name: "div",
          props: { title: "static again" },
          children: ["static again"],
        });
        await t.settle();
        collector.clear();
        const afterReplacement = runtime.edit();
        title.withTx(afterReplacement).set("ignored title");
        children.withTx(afterReplacement).set(["ignored child"]);
        expect((await afterReplacement.commit()).error).toBeUndefined();
        await runtime.idle();
        await t.settle();
        expect(collector.getOps()).toEqual([]);
      } finally {
        cancel();
        runtime.prepareTxForCommit = prepare;
      }
    },
  );

  await t.step(
    "switches a reused element to a changing Cell-backed handler and cancels the removed prop",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({ onOps: collector.onOps });
      const seen: string[] = [];
      const handler = new MockCell(() => seen.push("first"));
      const root = new MockCell({
        type: "vnode",
        name: "button",
        props: { onClick: () => seen.push("static") },
        children: ["click"],
      });
      const cancel = reconciler.mount(root as unknown as Cell<unknown>);
      try {
        await t.settle();
        collector.clear();
        root.set({
          type: "vnode",
          name: "button",
          props: { onClick: handler },
          children: ["click"],
        });
        await t.settle();
        expect(collector.getOpsOfType("create-element")).toEqual([]);
        const first = collector.getOpsOfType("set-event");
        expect(first).toHaveLength(1);
        if (first[0].op !== "set-event") throw new Error("Expected set-event");
        reconciler.dispatchEvent(first[0].handlerId, { type: "click" });
        expect(seen).toEqual(["first"]);

        collector.clear();
        handler.set(() => seen.push("second"));
        await t.settle();
        expect(collector.getOpsOfType("remove-event")).toHaveLength(1);
        const second = collector.getOpsOfType("set-event");
        expect(second).toHaveLength(1);
        if (second[0].op !== "set-event") throw new Error("Expected set-event");
        reconciler.dispatchEvent(second[0].handlerId, { type: "click" });
        expect(seen).toEqual(["first", "second"]);

        collector.clear();
        root.set({
          type: "vnode",
          name: "button",
          props: {},
          children: ["click"],
        });
        await t.settle();
        expect(collector.getOpsOfType("remove-event")).toHaveLength(1);
        collector.clear();
        handler.set(() => seen.push("removed"));
        await t.settle();
        expect(collector.getOps()).toEqual([]);
        expect(seen).toEqual(["first", "second"]);
      } finally {
        cancel();
      }
    },
  );

  await t.step(
    "renders, updates, and cleans up Cells in a direct array root",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });
      const textCell = new MockCell("before");
      const nestedTextCell = new MockCell("nested before");
      const nestedArrayCell = new MockCell([nestedTextCell]);
      const rootCell = new MockCell([textCell, nestedArrayCell]);

      const cancel = reconciler.mount(
        rootCell as unknown as Cell<unknown>,
      );
      await t.settle();

      const initialText = collector.getOpsOfType("create-text");
      assertEquals(
        initialText.some((op) => "text" in op && op.text === "before"),
        true,
      );
      assertEquals(
        initialText.some((op) => "text" in op && op.text === "nested before"),
        true,
      );

      collector.clear();
      textCell.set("after");
      nestedTextCell.set("nested after");
      await t.settle();

      const updatedText = collector.getOpsOfType("update-text");
      assertEquals(
        updatedText.some((op) => "text" in op && op.text === "after"),
        true,
      );
      assertEquals(
        updatedText.some((op) => "text" in op && op.text === "nested after"),
        true,
      );

      cancel();
      collector.clear();
      textCell.set("ignored");
      nestedTextCell.set("nested ignored");
      await t.settle();
      assertEquals(collector.getOps(), []);
    },
  );

  await t.step(
    "keeps existing rows when a child Cell's array grows by one",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      // A fresh object each call: a recomputed list hands the reconciler new
      // VNodes that carry the same content, which is what keys it by content.
      const row = (id: string): WorkerVNode => ({
        type: "vnode",
        name: "li",
        props: { "data-row": id },
        children: [id],
      });

      const listCell = new MockCell([row("a"), row("b")]);
      const rootCell = new MockCell({
        type: "vnode",
        name: "ul",
        props: {},
        children: [listCell],
      });

      reconciler.mount(rootCell as unknown as Cell<WorkerRenderNode>);
      await t.settle();

      const rowsOf = (ops: VDomOp[]) =>
        ops.filter((op) => "tagName" in op && op.tagName === "li");
      const initialRows = rowsOf(collector.getOpsOfType("create-element"));
      assertEquals(initialRows.length, 2, "both rows render initially");
      const keptIds = initialRows.map((op) => "nodeId" in op ? op.nodeId : -1);

      collector.clear();
      listCell.set([row("a"), row("b"), row("c")]);
      await t.settle();

      assertEquals(
        collector.getOpsOfType("remove-node").length,
        0,
        "appending a row must not remove the array wrapper or any row",
      );
      const created = rowsOf(collector.getOpsOfType("create-element"));
      assertEquals(
        created.length,
        1,
        "only the appended row is created; the first two are reused",
      );
      // Naming the ids pins reuse rather than a coincidence of counts: the two
      // original rows would fail this if they were rebuilt under fresh ids.
      const appendedIds = created.map((op) => "nodeId" in op ? op.nodeId : -1);
      const rowIds = new Set([...keptIds, ...appendedIds]);
      const rowInserts = collector.getOpsOfType("insert-child")
        .filter((op) => "childId" in op && rowIds.has(op.childId))
        .map((op) => "childId" in op ? op.childId : -1);
      assertEquals(
        rowInserts,
        appendedIds,
        "only the appended row is placed; the rows already there do not move",
      );
    },
  );

  await t.step(
    "reuses every row when a child Cell's array is reordered",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const row = (id: string): WorkerVNode => ({
        type: "vnode",
        name: "li",
        props: { "data-row": id },
        children: [id],
      });

      const listCell = new MockCell([row("a"), row("b"), row("c")]);
      const rootCell = new MockCell({
        type: "vnode",
        name: "ul",
        props: {},
        children: [listCell],
      });

      reconciler.mount(rootCell as unknown as Cell<WorkerRenderNode>);
      await t.settle();

      const idOfRow = new Map<string, number>();
      for (const op of collector.getOpsOfType("create-element")) {
        if ("tagName" in op && op.tagName === "li" && "nodeId" in op) {
          // Rows are created in order, so the nth create is the nth row.
          idOfRow.set("abc"[idOfRow.size], op.nodeId);
        }
      }
      assertEquals(idOfRow.size, 3, "three rows render initially");

      collector.clear();
      listCell.set([row("c"), row("b"), row("a")]);
      await t.settle();

      // Reversing keys nothing differently -- each row still hashes to what it
      // did -- so a keyed reconciler moves rows and builds none.
      assertEquals(
        collector.getOpsOfType("create-element").length,
        0,
        "reordering builds no new row",
      );
      assertEquals(
        collector.getOpsOfType("remove-node").length,
        0,
        "reordering removes no row",
      );

      // Reversing three rows needs two moves: one row can hold its place.
      const inserted = collector.getOpsOfType("insert-child");
      assertEquals(inserted.length, 2, "a reversal moves all but one row");
      for (const op of inserted) {
        assertEquals(
          "childId" in op && [...idOfRow.values()].includes(op.childId),
          true,
          "every move names a row that already existed",
        );
      }
    },
  );

  await t.step(
    "leaves a row added to a transcluded list unstamped",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const row = (id: string): WorkerVNode => ({
        type: "vnode",
        name: "li",
        props: { "data-row": id },
        children: [id],
      });

      // A cell of another space transcludes: its wrapper carries the stamp and
      // everything below inherits it.
      const listCell = new MockCell([row("a")]);
      Object.defineProperty(listCell, "space", {
        get: () => "did:key:zOtherSpaceForTransclusion",
      });
      const rootCell = new MockCell({
        type: "vnode",
        name: "ul",
        props: {},
        children: [listCell],
      });

      reconciler.mount(rootCell as unknown as Cell<WorkerRenderNode>);
      await t.settle();

      const wrapperOps = collector.getOpsOfType("create-element").filter((op) =>
        "tagName" in op && op.tagName === "span"
      );
      assertEquals(
        wrapperOps.length === 1 && "space" in wrapperOps[0],
        true,
        "the wrapper carries the stamp for the transcluded subtree",
      );
      assertEquals(
        collector.getOpsOfType("create-element").filter((op) =>
          "tagName" in op && op.tagName === "li"
        ).every((op) => !("space" in op)),
        true,
        "the first row inherits it rather than repeating it",
      );

      collector.clear();
      listCell.set([row("a"), row("b")]);
      await t.settle();

      const appended = collector.getOpsOfType("create-element").filter((op) =>
        "tagName" in op && op.tagName === "li"
      );
      assertEquals(appended.length, 1, "one row is added");
      assertEquals(
        appended.every((op) => !("space" in op)),
        true,
        "a row added later inherits the stamp the same way the first did",
      );
    },
  );

  await t.step(
    "leaves rows in the order the array names them, after any permutation",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const row = (id: string): WorkerVNode => ({
        type: "vnode",
        name: "li",
        props: { "data-row": id },
        children: [id],
      });

      const initial = ["a", "b", "c", "d", "e"];
      const listCell = new MockCell(initial.map(row));
      const rootCell = new MockCell({
        type: "vnode",
        name: "ul",
        props: {},
        children: [listCell],
      });

      reconciler.mount(rootCell as unknown as Cell<WorkerRenderNode>);
      await t.settle();

      // Rows are created in array order, so the nth `li` created is the nth id.
      const nodeIdOf = new Map<string, number>();
      collector.getOpsOfType("create-element")
        .filter((op) => "tagName" in op && op.tagName === "li")
        .forEach((op, i) => {
          if ("nodeId" in op) nodeIdOf.set(initial[i], op.nodeId);
        });
      assertEquals(nodeIdOf.size, 5, "five rows render initially");

      // Skipping an op for a row that need not move is only correct if the
      // rows still land in the named order, which counting ops cannot show.
      for (
        const order of [
          ["e", "d", "c", "b", "a"],
          ["c", "a", "e", "b", "d"],
          ["b", "c", "d", "e", "a"],
          ["a", "b", "c", "d", "e"],
        ]
      ) {
        listCell.set(order.map(row));
        await t.settle();

        const { childrenOf, parentOf } = applyOps(collector.getOps());
        const wrapper = parentOf.get(nodeIdOf.get(order[0])!);
        assertEquals(
          childrenOf.get(wrapper!),
          order.map((id) => nodeIdOf.get(id)!),
          `rows end up ordered ${order.join("")}`,
        );
      }

      assertEquals(
        collector.getOpsOfType("create-element").filter((op) =>
          "tagName" in op && op.tagName === "li"
        ).length,
        5,
        "no permutation builds a row a second time",
      );
    },
  );

  await t.step(
    "drops only the removed row when a child Cell's array shrinks",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const row = (id: string): WorkerVNode => ({
        type: "vnode",
        name: "li",
        props: { "data-row": id },
        children: [id],
      });

      const listCell = new MockCell([row("a"), row("b"), row("c")]);
      const rootCell = new MockCell({
        type: "vnode",
        name: "ul",
        props: {},
        children: [listCell],
      });

      reconciler.mount(rootCell as unknown as Cell<WorkerRenderNode>);
      await t.settle();
      collector.clear();

      listCell.set([row("a"), row("c")]);
      await t.settle();

      assertEquals(
        collector.getOpsOfType("remove-node").length,
        1,
        "only the dropped row is removed",
      );
      assertEquals(
        collector.getOpsOfType("create-element").length,
        0,
        "the surviving rows are reused",
      );
      assertEquals(
        collector.getOpsOfType("insert-child").length,
        0,
        "the survivors were already in order, so none of them move",
      );

      // Emptying the list keeps the wrapper, so refilling it reuses that too.
      collector.clear();
      listCell.set([]);
      await t.settle();
      assertEquals(
        collector.getOpsOfType("remove-node").length,
        2,
        "clearing removes the remaining rows",
      );

      collector.clear();
      listCell.set([row("a")]);
      await t.settle();
      assertEquals(
        collector.getOpsOfType("create-element").filter((op) =>
          "tagName" in op && op.tagName === "span"
        ).length,
        0,
        "refilling an emptied list does not rebuild the wrapper",
      );
    },
  );

  await t.step(
    "replaces an authored element when a child Cell becomes an array",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      // Shares the array wrapper's tag, so only the wrapper marker tells the
      // reconciler this span is the author's element and not a list container.
      const childCell = new MockCell({
        type: "vnode",
        name: "span",
        props: { id: "authored" },
        children: ["one"],
      });
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [childCell],
      });

      reconciler.mount(rootCell as unknown as Cell<WorkerRenderNode>);
      await t.settle();

      const authored = collector.getOpsOfType("create-element").find((op) =>
        "tagName" in op && op.tagName === "span"
      );
      const authoredId = authored && "nodeId" in authored
        ? authored.nodeId
        : -1;

      collector.clear();
      childCell.set([{
        type: "vnode",
        name: "li",
        props: {},
        children: ["a"],
      }]);
      await t.settle();

      assertEquals(
        collector.getOpsOfType("remove-node").some((op) =>
          "nodeId" in op && op.nodeId === authoredId
        ),
        true,
        "an authored span must not be adopted as the array wrapper",
      );
    },
  );

  await t.step(
    "stops treating a wrapper as one once an authored node takes it over",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const childCell = new MockCell([{
        type: "vnode",
        name: "li",
        props: {},
        children: ["a"],
      }]);
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [childCell],
      });

      reconciler.mount(rootCell as unknown as Cell<WorkerRenderNode>);
      await t.settle();

      // The wrapper is a span, so this authored span takes it over in place.
      childCell.set({
        type: "vnode",
        name: "span",
        props: { id: "authored" },
        children: ["one"],
      });
      await t.settle();

      const adopted = collector.getOpsOfType("create-element").find((op) =>
        "tagName" in op && op.tagName === "span"
      );
      const adoptedId = adopted && "nodeId" in adopted ? adopted.nodeId : -1;

      collector.clear();
      childCell.set([{
        type: "vnode",
        name: "li",
        props: {},
        children: ["b"],
      }]);
      await t.settle();

      assertEquals(
        collector.getOpsOfType("remove-node").some((op) =>
          "nodeId" in op && op.nodeId === adoptedId
        ),
        true,
        "a span carrying authored props must not be reused as a wrapper",
      );
    },
  );

  await t.step(
    "updates child Cell VNode in place when tag matches",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      // Child Cell
      const spanVNode: WorkerVNode = {
        type: "vnode",
        name: "span",
        props: { id: "child-span" },
        children: ["Initial"],
      };

      const childCell = new MockCell(spanVNode);

      // Root with child Cell
      const rootVNode: WorkerVNode = {
        type: "vnode",
        name: "div",
        props: {},
        children: [childCell as any],
      };

      const rootCell = new MockCell(rootVNode);

      // Mount
      reconciler.mount(rootCell as unknown as Cell<WorkerRenderNode>);
      await t.settle();

      const createOps = collector.getOpsOfType("create-element");
      const spanCreate = createOps.find((op: any) => op.tagName === "span");

      if (!spanCreate) {
        throw new Error("Span was not created!");
      }

      const spanNodeId = (spanCreate as any).nodeId;
      collector.clear();

      // Update Cell: same tag but different props and children
      childCell.set({
        type: "vnode",
        name: "span",
        props: { id: "child-span-updated" },
        children: ["Updated"],
      } as WorkerVNode);
      await t.settle();

      // VNode in-place update: span element should NOT be removed/recreated
      const removeOps = collector.getOpsOfType("remove-node");
      const spanRemoved = removeOps.some((op: any) => op.nodeId === spanNodeId);
      assertEquals(
        spanRemoved,
        false,
        "Span should NOT be removed (in-place update)",
      );

      const newCreateOps = collector.getOpsOfType("create-element");
      const newSpanCreated = newCreateOps.some((op: any) =>
        op.tagName === "span"
      );
      assertEquals(
        newSpanCreated,
        false,
        "No new span should be created (in-place update)",
      );

      // Props should be updated in place
      const setPropOps = collector.getOpsOfType("set-prop");
      const idUpdate = setPropOps.find((op: any) =>
        op.nodeId === spanNodeId && op.key === "id"
      );
      assertEquals(
        (idUpdate as any)?.value,
        "child-span-updated",
        "Prop should be updated in place",
      );
    },
  );

  await t.step(
    "does not re-emit set-prop for unchanged static props on a reused child VNode (CT-1798)",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const childCell = new MockCell({
        type: "vnode",
        name: "span",
        props: { id: "tab", "data-role": "tab" },
        children: ["A"],
      } as WorkerVNode);
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [childCell as unknown as Cell<WorkerRenderNode>],
      });

      reconciler.mount(rootCell as unknown as Cell<WorkerRenderNode>);
      await t.settle();
      collector.clear();

      // Re-set the reused child VNode with IDENTICAL props but changed children,
      // so the reconcile path (updateChildrenInPlace -> updatePropsInPlace) runs
      // in full. #4366 made this fire on every recompute; unchanged static props
      // should no longer produce worker->main set-prop ops.
      childCell.set({
        type: "vnode",
        name: "span",
        props: { id: "tab", "data-role": "tab" },
        children: ["B"],
      } as WorkerVNode);
      await t.settle();

      const unchangedPropOps = collector.getOpsOfType("set-prop").filter((op) =>
        "key" in op && (op.key === "id" || op.key === "data-role")
      );
      assertEquals(
        unchangedPropOps.length,
        0,
        "unchanged static props should not re-emit set-prop ops",
      );
      // Sanity: the reconcile path actually ran (children changed A -> B).
      assertEquals(
        collector.getOps().length > 0,
        true,
        "child reconcile should still emit ops for the changed children",
      );

      // A genuine prop change must still emit, while a still-unchanged sibling
      // prop stays quiet.
      collector.clear();
      childCell.set({
        type: "vnode",
        name: "span",
        props: { id: "tab-2", "data-role": "tab" },
        children: ["B"],
      } as WorkerVNode);
      await t.settle();

      const idOps = collector.getOpsOfType("set-prop").filter((op) =>
        "key" in op && op.key === "id"
      );
      assertEquals(idOps.length, 1, "changed static prop should re-emit once");
      assertEquals(
        (idOps[0] as any).value,
        "tab-2",
        "changed static prop should carry the new value",
      );
      assertEquals(
        collector.getOpsOfType("set-prop").filter((op) =>
          "key" in op && op.key === "data-role"
        ).length,
        0,
        "still-unchanged static prop should remain quiet",
      );
    },
  );

  await t.step(
    "re-emits DOM-live props (value/checked) on a reused child even when unchanged, so the main thread can repair live-DOM drift (CT-1798 review)",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const liveProps = {
        id: "field",
        value: "hello",
        checked: true,
        scrollTop: 0,
        scrollLeft: 0,
      };
      const childCell = new MockCell({
        type: "vnode",
        name: "input",
        props: { ...liveProps },
        children: [],
      } as WorkerVNode);
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [childCell as unknown as Cell<WorkerRenderNode>],
      });

      reconciler.mount(rootCell as unknown as Cell<WorkerRenderNode>);
      await t.settle();
      collector.clear();

      // Reuse the same input VNode with IDENTICAL props. The worker can't see
      // live DOM drift (user typing, browser-set checked, user scrolling), so
      // the DOM-live props must still re-emit to let setPropDefault repair it;
      // the inert id stays quiet.
      childCell.set({
        type: "vnode",
        name: "input",
        props: { ...liveProps },
        children: [],
      } as WorkerVNode);
      await t.settle();

      const keys = collector.getOpsOfType("set-prop")
        .filter((op) => "key" in op)
        .map((op) => (op as { key: string }).key);
      for (const liveKey of ["value", "checked", "scrollTop", "scrollLeft"]) {
        assertEquals(
          keys.includes(liveKey),
          true,
          `DOM-live \`${liveKey}\` must re-emit so drift can be repaired`,
        );
      }
      assertEquals(
        keys.includes("id"),
        false,
        "inert `id` should still be skipped when unchanged",
      );
    },
  );

  await t.step(
    "re-emits object/array static props on a reused child even with a stable reference (CT-1798 review)",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const styleObj = { color: "red" };
      const childCell = new MockCell({
        type: "vnode",
        name: "span",
        props: { id: "s", style: styleObj },
        children: ["A"],
      } as WorkerVNode);
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [childCell as unknown as Cell<WorkerRenderNode>],
      });

      reconciler.mount(rootCell as unknown as Cell<WorkerRenderNode>);
      await t.settle();
      collector.clear();

      // Same object reference, changed child to force the reconcile. Object
      // props compare by reference (unreliable), so they must never be skipped.
      childCell.set({
        type: "vnode",
        name: "span",
        props: { id: "s", style: styleObj },
        children: ["B"],
      } as WorkerVNode);
      await t.settle();

      const keys = collector.getOpsOfType("set-prop")
        .filter((op) => "key" in op)
        .map((op) => (op as { key: string }).key);
      assertEquals(
        keys.includes("style"),
        true,
        "object/array props must always re-emit",
      );
      assertEquals(
        keys.includes("id"),
        false,
        "inert primitive `id` should still be skipped when unchanged",
      );
    },
  );

  await t.step(
    "re-emits text-integrity props (cf-chat-message name/content) on a reused child even when unchanged (CT-1798 review)",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const childCell = new MockCell({
        type: "vnode",
        name: "cf-chat-message",
        props: { id: "m1", name: "Alice", content: "hi" },
        children: [],
      } as WorkerVNode);
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [childCell as unknown as Cell<WorkerRenderNode>],
      });

      reconciler.mount(rootCell as unknown as Cell<WorkerRenderNode>);
      await t.settle();
      collector.clear();

      // Text-integrity sink props have policy-dependent transforms and must
      // re-run on every reconcile; only inert id may be skipped.
      childCell.set({
        type: "vnode",
        name: "cf-chat-message",
        props: { id: "m1", name: "Alice", content: "hi" },
        children: [],
      } as WorkerVNode);
      await t.settle();

      const keys = collector.getOpsOfType("set-prop")
        .filter((op) => "key" in op)
        .map((op) => (op as { key: string }).key);
      assertEquals(
        keys.includes("name"),
        true,
        "text-integrity `name` must always re-emit",
      );
      assertEquals(
        keys.includes("content"),
        true,
        "text-integrity `content` must always re-emit",
      );
      assertEquals(
        keys.includes("id"),
        false,
        "inert `id` should still be skipped when unchanged",
      );
    },
  );

  await t.step(
    "replaces same-key child Cell when parent supplies a different cell",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const firstChild = new MockCell("first");
      const secondChild = new MockCell("second");
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [firstChild as unknown as Cell<WorkerRenderNode>],
      });

      reconciler.mount(rootCell as unknown as Cell<WorkerRenderNode>);
      await t.settle();
      collector.clear();

      rootCell.set({
        type: "vnode",
        name: "div",
        props: {},
        children: [secondChild as unknown as Cell<WorkerRenderNode>],
      } as WorkerVNode);
      await t.settle();

      assertEquals(
        collector.getOpsOfType("remove-node").length > 0,
        true,
        "old cell child should be removed when the parent supplies a new cell",
      );
      assertEquals(
        collector.getOpsOfType("create-text").some((op) =>
          "text" in op && op.text === "second"
        ),
        true,
        "new cell child should render its current value",
      );
    },
  );

  await t.step(
    "replaces same-key text Cell when parent supplies a literal child",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const oldChild = new MockCell("cell text");
      const rootCell = new MockCell(
        {
          type: "vnode",
          name: "div",
          props: {},
          children: [oldChild as unknown as WorkerRenderNode],
        } satisfies WorkerVNode,
      );

      reconciler.mount(rootCell as unknown as Cell<WorkerRenderNode>);
      await t.settle();
      collector.clear();

      rootCell.set(
        {
          type: "vnode",
          name: "div",
          props: {},
          children: ["literal text"],
        } satisfies WorkerVNode,
      );
      await t.settle();

      assertEquals(
        collector.getOpsOfType("remove-node").length > 0,
        true,
        "old cell-backed text child should be removed",
      );
      assertEquals(
        collector.getOpsOfType("create-text").some((op) =>
          "text" in op && op.text === "literal text"
        ),
        true,
        "literal replacement should render as a new static text node",
      );

      collector.clear();
      oldChild.set("stale cell update");
      await t.settle();

      assertEquals(
        collector.getOps().length,
        0,
        "old cell subscription should be cancelled after literal replacement",
      );
    },
  );

  await t.step(
    "updates cell-backed conditional row children at first middle and last positions",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const voteSpan = (id: string): WorkerVNode => ({
        type: "vnode",
        name: "span",
        props: { "data-vote-swatch-name": id },
        children: [id],
      });

      const firstChildren = new MockCell([]);
      const middleChildren = new MockCell([]);
      const lastChildren = new MockCell([]);

      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [
          {
            type: "vnode",
            name: "div",
            props: { "data-option-id": "first" },
            children: firstChildren,
          },
          {
            type: "vnode",
            name: "div",
            props: { "data-option-id": "middle" },
            children: middleChildren,
          },
          {
            type: "vnode",
            name: "div",
            props: { "data-option-id": "last" },
            children: lastChildren,
          },
        ],
      });

      reconciler.mount(rootCell as unknown as Cell<WorkerRenderNode>);
      await t.settle();
      collector.clear();

      firstChildren.set([voteSpan("Alice")]);
      middleChildren.set([null, voteSpan("Alice")]);
      lastChildren.set([null, null, voteSpan("Alice")]);
      await t.settle();

      const spanCreates = collector.getOpsOfType("create-element").filter(
        (op) => "tagName" in op && op.tagName === "span",
      );
      assertEquals(
        spanCreates.length,
        3,
        "should create one swatch span for each cell-backed row",
      );

      const swatchPropOps = collector.getOpsOfType("set-prop").filter(
        (op) =>
          op.op === "set-prop" && op.key === "data-vote-swatch-name" &&
          op.value === "Alice",
      );
      assertEquals(
        swatchPropOps.length,
        3,
        "each cell-backed swatch span should receive the voter data attribute",
      );
    },
  );

  await t.step(
    "inserts pending mapped child cells when they resolve after parent array update",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const voteSpan = (id: string): WorkerVNode => ({
        type: "vnode",
        name: "span",
        props: { "data-vote-swatch-name": id },
        children: [id],
      });

      const firstMappedResult = new MockCell(undefined);
      const middleMappedResult = new MockCell(undefined);
      const lastMappedResult = new MockCell(undefined);

      const mappedChildren = new MockCell([]);
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: { "data-option-id": "mapped" },
        children: mappedChildren,
      });

      reconciler.mount(rootCell as unknown as Cell<WorkerRenderNode>);
      await t.settle();
      collector.clear();

      mappedChildren.set([
        firstMappedResult,
        middleMappedResult,
        lastMappedResult,
      ]);
      await t.settle();
      collector.clear();

      firstMappedResult.set(voteSpan("Alice"));
      middleMappedResult.set(voteSpan("Alice"));
      lastMappedResult.set(voteSpan("Alice"));
      await t.settle();

      const spanCreates = collector.getOpsOfType("create-element").filter(
        (op) => "tagName" in op && op.tagName === "span",
      );
      assertEquals(
        spanCreates.length,
        3,
        "should create one swatch span for each late-resolving mapped child cell",
      );

      const spanInserts = collector.getOpsOfType("insert-child").filter(
        (op) =>
          op.op === "insert-child" &&
          spanCreates.some((createOp) =>
            "nodeId" in createOp && createOp.nodeId === op.childId
          ),
      );
      assertEquals(
        spanInserts.length,
        3,
        "each late-resolving swatch span should be inserted into the parent row",
      );
    },
  );

  await t.step("replaces child Cell when tag changes", async () => {
    const collector = createOpsCollector();
    const reconciler = new WorkerReconciler({
      onOps: collector.onOps,
    });

    const spanVNode: WorkerVNode = {
      type: "vnode",
      name: "span",
      props: {},
      children: ["Span"],
    };
    const childCell = new MockCell(spanVNode);

    const rootCell = new MockCell({
      type: "vnode",
      name: "div",
      props: {},
      children: [childCell as any],
    });

    reconciler.mount(rootCell as any);
    await t.settle();

    const createSpanOp = collector.getOpsOfType("create-element").find(
      (op: any) => op.tagName === "span",
    );
    const spanNodeId = (createSpanOp as any).nodeId;
    collector.clear();

    // Update child cell to button
    const buttonVNode: WorkerVNode = {
      type: "vnode",
      name: "button", // Different tag
      props: {},
      children: ["Button"],
    };
    childCell.set(buttonVNode);
    await t.settle();

    const removeOps = collector.getOpsOfType("remove-node");
    const spanRemoved = removeOps.some((op: any) => op.nodeId === spanNodeId);
    assertEquals(spanRemoved, true, "Span should be removed when tag changes");

    const newCreateOps = collector.getOpsOfType("create-element");
    const buttonCreated = newCreateOps.some((op: any) =>
      op.tagName === "button"
    );
    assertEquals(buttonCreated, true, "Button should be created");
  });

  await t.step("updates text child Cell in place", async () => {
    const collector = createOpsCollector();
    const reconciler = new WorkerReconciler({
      onOps: collector.onOps,
    });

    const childCell = new MockCell("Hello");
    const rootCell = new MockCell({
      type: "vnode",
      name: "div",
      props: {},
      children: [childCell],
    });

    reconciler.mount(rootCell as any);
    await t.settle();
    collector.clear();

    // Update text
    childCell.set("World");
    await t.settle();

    const removeOps = collector.getOpsOfType("remove-node");
    assertEquals(removeOps.length, 0, "Should not remove text node");

    const updateTextOps = collector.getOpsOfType("update-text");
    assertEquals(updateTextOps.length, 1, "Should emit update-text");
    assertEquals((updateTextOps[0] as any).text, "World");
  });

  await t.step(
    "updates same-shape slotted header cell VNode children",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const header = new MockCell(
        {
          type: "vnode",
          name: "div",
          props: { slot: "header" },
          children: [{
            type: "vnode",
            name: "span",
            props: { "data-poll-summary": "true" },
            children: ["4 joined · 0 options · 0 votes · hosted by Alice"],
          }],
        } satisfies WorkerVNode,
      );

      const rootCell = new MockCell(
        {
          type: "vnode",
          name: "cf-screen",
          props: {},
          children: [header as unknown as WorkerRenderNode],
        } satisfies WorkerVNode,
      );

      reconciler.mount(rootCell as unknown as Cell<unknown>);
      await t.settle();
      const screenCreate = collector.getOpsOfType("create-element").find(
        (op) => "tagName" in op && op.tagName === "cf-screen",
      );
      if (!screenCreate || !("nodeId" in screenCreate)) {
        throw new Error("Expected cf-screen to be created");
      }
      const screenNodeId = screenCreate.nodeId;
      collector.clear();

      header.set(
        {
          type: "vnode",
          name: "div",
          props: { slot: "header" },
          children: [{
            type: "vnode",
            name: "span",
            props: { "data-poll-summary": "true" },
            children: ["4 joined · 1 options · 0 votes · hosted by Alice"],
          }],
        } satisfies WorkerVNode,
      );
      await t.settle();

      const textOps = collector.getOps().filter((op) =>
        (op.op === "update-text" || op.op === "create-text") &&
        "text" in op
      );
      assertEquals(
        textOps.some((op) =>
          "text" in op &&
          op.text === "4 joined · 1 options · 0 votes · hosted by Alice"
        ),
        true,
        "slotted header summary text should update",
      );

      assertEquals(
        collector.getOpsOfType("remove-node").some((op) =>
          "nodeId" in op && op.nodeId === screenNodeId
        ),
        false,
        "slotted header summary update should not remount cf-screen",
      );
    },
  );

  await t.step(
    "updates same-shape split text children from a Cell VNode",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const summary = new MockCell(
        {
          type: "vnode",
          name: "div",
          props: { "data-poll-summary": "true" },
          children: [
            4,
            " joined · ",
            4,
            " options · ",
            1,
            " votes · hosted by Dave",
          ],
        } satisfies WorkerVNode,
      );
      const rootCell = new MockCell(
        {
          type: "vnode",
          name: "div",
          props: {},
          children: [summary as unknown as WorkerRenderNode],
        } satisfies WorkerVNode,
      );

      reconciler.mount(rootCell as unknown as Cell<unknown>);
      await t.settle();
      collector.clear();

      summary.set(
        {
          type: "vnode",
          name: "div",
          props: { "data-poll-summary": "true" },
          children: [
            4,
            " joined · ",
            4,
            " options · ",
            4,
            " votes · hosted by Dave",
          ],
        } satisfies WorkerVNode,
      );
      await t.settle();

      // A text child is keyed by its own content, so the one that changed is a
      // different child rather than the same child holding new text: it is
      // created and the old one removed. The five that did not change are
      // reused, and reuse of an unchanged text child rewrites nothing.
      assertEquals(
        collector.getOpsOfType("update-text").length,
        0,
        "text children that did not change should not be rewritten",
      );
      assertEquals(
        collector.getOps().some((op) =>
          (op.op === "update-text" || op.op === "create-text") &&
          "text" in op && op.text === "4"
        ),
        true,
        "same-shape split vote-count text should be represented",
      );
    },
  );

  await t.step(
    "replaces same-key UI child when rendered root tag changes",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const beforeChild = {
        [UI]: {
          type: "vnode",
          name: "span",
          props: {},
          children: ["Before"],
        } satisfies WorkerVNode,
      } as unknown as WorkerRenderNode;
      const afterChild = {
        [UI]: {
          type: "vnode",
          name: "button",
          props: {},
          children: ["After"],
        } satisfies WorkerVNode,
      } as unknown as WorkerRenderNode;

      const rootCell = new MockCell(
        {
          type: "vnode",
          name: "div",
          props: {},
          children: [beforeChild],
        } satisfies WorkerVNode,
      );

      reconciler.mount(rootCell as unknown as Cell<unknown>);
      await t.settle();

      const spanCreate = collector.getOpsOfType("create-element").find(
        (op) => "tagName" in op && op.tagName === "span",
      );
      if (!spanCreate || !("nodeId" in spanCreate)) {
        throw new Error("Expected span to be created");
      }
      const spanNodeId = spanCreate.nodeId;
      collector.clear();

      rootCell.set(
        {
          type: "vnode",
          name: "div",
          props: {},
          children: [afterChild],
        } satisfies WorkerVNode,
      );
      await t.settle();

      assertEquals(
        collector.getOpsOfType("remove-node").some((op) =>
          "nodeId" in op && op.nodeId === spanNodeId
        ),
        true,
        "same-key UI payload should remove the stale root element",
      );
      assertEquals(
        collector.getOpsOfType("create-element").some((op) =>
          "tagName" in op && op.tagName === "button"
        ),
        true,
        "same-key UI payload should create the replacement root element",
      );
    },
  );

  await t.step(
    "avoids re-emitting set-event when handler is identical (VNode path)",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      // Test event handler identity optimization via direct VNode reconciliation
      // (not Cell child path, which always replaces)
      const handler = () => {};
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [{
          type: "vnode",
          name: "button",
          props: { onClick: handler },
          children: ["Click me"],
        }],
      });

      reconciler.mount(rootCell as any);
      await t.settle();

      const setEventOps = collector.getOpsOfType("set-event");
      assertEquals(setEventOps.length, 1, "Should emit initial set-event");
      collector.clear();

      // Update root with same handler reference on the child VNode
      rootCell.set({
        type: "vnode",
        name: "div",
        props: {},
        children: [{
          type: "vnode",
          name: "button",
          props: { onClick: handler }, // Same reference
          children: ["Click me"],
        }],
      });
      await t.settle();

      const newSetEventOps = collector.getOpsOfType("set-event");
      assertEquals(
        newSetEventOps.length,
        0,
        "Should NOT emit set-event for identical handler",
      );
    },
  );

  await t.step(
    "emits remove-event (not remove-prop) when an event prop is removed",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const rootCell = new MockCell({
        type: "vnode",
        name: "button",
        props: { onClick: () => {} },
        children: ["Click me"],
      });

      reconciler.mount(rootCell as any);
      await t.settle();
      collector.clear();

      rootCell.set({
        type: "vnode",
        name: "button",
        props: {},
        children: ["Click me"],
      });
      await t.settle();

      const removeEventOps = collector.getOpsOfType("remove-event");
      assertEquals(removeEventOps.length, 1, "Should emit remove-event");
      assertEquals(
        (removeEventOps[0] as { eventType: string }).eventType,
        "click",
      );

      const removePropOps = collector.getOpsOfType("remove-prop");
      const hasOnClickRemoveProp = removePropOps.some((op) =>
        (op as { key: string }).key === "onClick"
      );
      assertEquals(
        hasOnClickRemoveProp,
        false,
        "Should not emit remove-prop for onClick",
      );
    },
  );

  await t.step(
    "emits remove-event when event prop value becomes undefined",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const handler = () => {};
      const rootCell = new MockCell({
        type: "vnode",
        name: "button",
        props: { onClick: handler },
        children: ["Click me"],
      });

      reconciler.mount(rootCell as any);
      await t.settle();
      collector.clear();

      rootCell.set({
        type: "vnode",
        name: "button",
        props: { onClick: undefined },
        children: ["Click me"],
      });
      await t.settle();

      const removeEventOps = collector.getOpsOfType("remove-event");
      assertEquals(removeEventOps.length, 1, "Should emit remove-event");
      assertEquals(
        (removeEventOps[0] as { eventType: string }).eventType,
        "click",
      );

      const setEventOps = collector.getOpsOfType("set-event");
      assertEquals(setEventOps.length, 0, "Should not re-register event");
    },
  );

  await t.step(
    "emits remove-event when Cell-backed event handler resolves to undefined",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const handlerCell = new MockCell(() => {});
      const rootCell = new MockCell({
        type: "vnode",
        name: "button",
        props: { onClick: handlerCell },
        children: ["Click me"],
      });

      reconciler.mount(rootCell as any);
      await t.settle();
      collector.clear();

      handlerCell.set(undefined);
      await t.settle();

      const removeEventOps = collector.getOpsOfType("remove-event");
      assertEquals(removeEventOps.length, 1, "Should emit remove-event");
      assertEquals(
        (removeEventOps[0] as { eventType: string }).eventType,
        "click",
      );

      const setEventOps = collector.getOpsOfType("set-event");
      assertEquals(setEventOps.length, 0, "Should not re-register event");
    },
  );

  await t.step(
    "preserves falsy non-null children values from children Cells",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const childrenCell = new MockCell(0);
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: childrenCell,
      });

      reconciler.mount(rootCell as any);
      await t.settle();

      const initialTextOps = collector.getOpsOfType("create-text");
      assertEquals(
        initialTextOps.length > 0,
        true,
        "Should create text node for numeric child 0",
      );
      assertEquals(
        (initialTextOps[0] as { text: string }).text,
        "0",
      );

      collector.clear();
      childrenCell.set("");
      await t.settle();

      const emptyStringTextOps = collector.getOpsOfType("create-text");
      assertEquals(
        emptyStringTextOps.length > 0,
        true,
        "Should keep empty string child instead of dropping it",
      );
      assertEquals(
        (emptyStringTextOps[0] as { text: string }).text,
        "",
      );
    },
  );

  await t.step(
    "normalizes binding key when removing $props",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const valueCell = runtime.getCell(
        signer.did(),
        "binding-removal-cell",
        undefined,
        dummyTx,
      );
      valueCell.set("hello");

      const rootCell = new MockCell({
        type: "vnode",
        name: "cf-input",
        props: { $value: valueCell },
        children: [],
      });

      reconciler.mount(rootCell as any);
      await t.settle();
      collector.clear();

      rootCell.set({
        type: "vnode",
        name: "cf-input",
        props: {},
        children: [],
      });
      await t.settle();

      const removePropOps = collector.getOpsOfType("remove-prop");
      const hasValueRemove = removePropOps.some((op) =>
        (op as { key: string }).key === "value"
      );
      const hasBindingSyntaxRemove = removePropOps.some((op) =>
        (op as { key: string }).key === "$value"
      );

      assertEquals(hasValueRemove, true, "Should remove normalized key");
      assertEquals(
        hasBindingSyntaxRemove,
        false,
        "Should not remove $value literal key",
      );
    },
  );

  await t.step(
    "deduplicates identical values from Cell",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      const childCell = new MockCell("Hello");
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [childCell],
      });

      reconciler.mount(rootCell as any);
      await t.settle();
      collector.clear();

      // Emit exact SAME value
      childCell.set("Hello");
      await t.settle();

      const ops = collector.getOps();
      assertEquals(ops.length, 0, "Should emit NO ops for identical value");

      // Emit DIFFERENT value
      childCell.set("World");
      await t.settle();

      const updateOps = collector.getOpsOfType("update-text");
      assertEquals(
        updateOps.length,
        1,
        "Should emit update-text for new value",
      );
      assertEquals((updateOps[0] as any).text, "World", "Check new value");
    },
  );

  await t.step(
    "skips redundant inserts on stable updates",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
      });

      // Keyed children (using keys in VNode or implicit index?)
      // Reconciler uses index if no keys.
      // Let's use explicit keys to be safe/clear.
      const child1 = {
        type: "vnode",
        name: "div",
        props: { key: "a" },
        children: ["A"],
      };
      const child2 = {
        type: "vnode",
        name: "div",
        props: { key: "b" },
        children: ["B"],
      };

      const rootVNode = {
        type: "vnode",
        name: "div",
        props: {},
        children: [child1, child2],
      };
      const rootCell = new MockCell(rootVNode);

      reconciler.mount(rootCell as any);
      await t.settle();
      collector.clear();

      // Update parent with SAME children order
      const rootVNodeUpdated = {
        type: "vnode",
        name: "div",
        props: {},
        children: [child1, child2], // Same objects, same keys
      };
      rootCell.set(rootVNodeUpdated);
      await t.settle();

      const insertOps = collector.getOpsOfType("insert-child");
      assertEquals(insertOps.length, 0, "Should skip inserts if order is same");

      // Update parent with SWAPPED children
      const rootVNodeSwapped = {
        type: "vnode",
        name: "div",
        props: {},
        children: [child2, child1], // Swap
      };
      rootCell.set(rootVNodeSwapped);
      await t.settle();

      const swapInserts = collector.getOpsOfType("insert-child");
      // Naive reorder: remove/insert or move.
      // With implementation "insert from end", it likely emits inserts.
      // At least 1 insert is expected (to move).
      assertEquals(swapInserts.length > 0, true, "Should insert to re-order");
    },
  );

  await t.step(
    "updates same-key subpatterns and retargets unchanged UI",
    async () => {
      const collector = createOpsCollector();
      // A public-only ceiling, so that the one output labeled confidential
      // below is refused by the real render policy while the unlabeled ones
      // render as before.
      const reconciler = new WorkerReconciler({
        onOps: collector.onOps,
        renderConfidentialityCeiling: { atoms: [] },
      });
      // A subpattern's output reaches the reconciler as a cell, and a cell
      // keys by the link it names rather than by the payload behind it. That
      // is what holds this child's key still while its payload changes, which
      // is the situation under test.
      const subpatternOutput = (node: WorkerVNode): WorkerRenderNode => ({
        [UI]: node,
      } as unknown as WorkerRenderNode);

      const initialOutput = subpatternOutput({
        type: "vnode",
        name: "span",
        props: { "data-row": "same", "data-count": "1" },
        children: ["one"],
      });
      const outputCell = new MockCell(initialOutput);
      let resolvedOutputId = "of:fid1:nested-pattern";
      // The one output the render policy refuses: while the resolved output
      // is this one, it carries a confidentiality label no public-only
      // ceiling admits; otherwise it carries none.
      const deniedOutputId = "of:fid1:retargeted-to-blocked";
      const deniedLabelView: CfcLabelView = {
        version: 1,
        entries: [{ path: [], label: { confidentiality: ["secret"] } }],
      };
      outputCell.getAsNormalizedFullLink = () => ({
        id: "of:fid1:stable-link-container",
        space: signer.did(),
        path: [],
        scope: "space",
      });
      // The resolved output is a cell of its own, which carries the denied
      // label while it is the denied output.
      outputCell.resolveAsCell = () => {
        const resolvedOutputCell = new MockCell(
          undefined,
          resolvedOutputId === deniedOutputId ? deniedLabelView : undefined,
        );
        resolvedOutputCell.getAsNormalizedFullLink = () => ({
          id: resolvedOutputId,
          space: signer.did(),
          path: [],
          scope: "space",
        });
        resolvedOutputCell.getMetaRaw = (field: string) =>
          field === "patternIdentity"
            ? { identity: "nested-pattern", symbol: "default" }
            : undefined;
        return resolvedOutputCell;
      };

      const rootCell = new MockCell(
        {
          type: "vnode",
          name: "div",
          props: {},
          children: [outputCell],
        } as unknown as WorkerVNode,
      );

      reconciler.mount(rootCell as unknown as Cell<unknown>);
      await t.settle();
      const spanCreate = collector.getOps().find((op) =>
        op.op === "create-element" && "tagName" in op &&
        op.tagName === "span"
      );
      if (!spanCreate || !("nodeId" in spanCreate)) {
        throw new Error("Expected initial span to be created");
      }
      const spanNodeId = spanCreate.nodeId;
      const nestedPatternBinding = collector.getOps().find((op) =>
        op.op === "set-piece-boundary" && op.nodeId === spanNodeId
      );
      assertEquals(
        nestedPatternBinding && "cellRef" in nestedPatternBinding
          ? nestedPatternBinding.cellRef.id
          : undefined,
        "of:fid1:nested-pattern",
        "nested pattern root should carry its whole result cell",
      );
      collector.clear();

      resolvedOutputId = "of:fid1:retargeted-with-same-ui";
      outputCell.set(initialOutput);
      await t.settle();

      const unchangedUiBinding = collector.getOps().find((op) =>
        op.op === "set-piece-boundary" && op.nodeId === spanNodeId
      );
      assertEquals(
        unchangedUiBinding && "cellRef" in unchangedUiBinding
          ? unchangedUiBinding.cellRef.id
          : undefined,
        "of:fid1:retargeted-with-same-ui",
        "an unchanged UI object should still follow a changed result cell",
      );
      assertEquals(
        collector.getOps().some((op) =>
          op.op === "create-element" || op.op === "remove-node"
        ),
        false,
        "retargeting unchanged UI should keep its existing element",
      );

      collector.clear();
      resolvedOutputId = "of:fid1:retargeted-nested-pattern";

      outputCell.set(
        subpatternOutput({
          type: "vnode",
          name: "span",
          props: { "data-row": "same", "data-count": "2" },
          children: ["two"],
        }),
      );
      await t.settle();

      const retargetedBinding = collector.getOps().find((op) =>
        op.op === "set-piece-boundary" && op.nodeId === spanNodeId
      );
      assertEquals(
        retargetedBinding && "cellRef" in retargetedBinding
          ? retargetedBinding.cellRef.id
          : undefined,
        "of:fid1:retargeted-nested-pattern",
        "a reused pattern root should follow a changed result-cell target",
      );

      assertEquals(
        collector.getOpsOfType("create-element").some((op) =>
          "tagName" in op && op.tagName === "span"
        ),
        false,
        "same-key child update should not recreate the element",
      );
      assertEquals(
        collector.getOpsOfType("remove-node").some((op) =>
          "nodeId" in op && op.nodeId === spanNodeId
        ),
        false,
        "same-key child update should not remove the element",
      );
      assertEquals(
        collector.getOpsOfType("set-prop").some((op) =>
          "key" in op && op.key === "data-count" &&
          "value" in op && op.value === "2"
        ),
        true,
        "same-key child prop should update",
      );
      assertEquals(
        collector.getOps().some((op) =>
          (op.op === "update-text" || op.op === "create-text") &&
          "text" in op && op.text === "two"
        ),
        true,
        "same-key child text should update",
      );

      collector.clear();
      outputCell.set(
        {
          type: "vnode",
          name: "span",
          props: { "data-row": "plain" },
          children: ["plain vnode"],
        } satisfies WorkerVNode,
      );
      await t.settle();
      assertEquals(
        collector.getOps().some((op) =>
          op.op === "clear-piece-boundary" && op.nodeId === spanNodeId
        ),
        true,
        "the marker should leave a reused root when it stops being a pattern",
      );

      const blockedCandidate = subpatternOutput({
        type: "vnode",
        name: "cf-cfc-blocked",
        props: { "data-row": "blocked" },
        children: ["blocked"],
      });
      resolvedOutputId = deniedOutputId;
      outputCell.set(blockedCandidate);
      await t.settle();

      resolvedOutputId = "of:fid1:allowed-after-block";
      outputCell.set(blockedCandidate);
      await t.settle();
      collector.clear();

      resolvedOutputId = deniedOutputId;
      outputCell.set(blockedCandidate);
      await t.settle();

      assertEquals(
        collector.hasOp("set-piece-boundary"),
        false,
        "a blocked placeholder should not carry the hidden piece boundary",
      );
      assertEquals(
        collector.getOpsOfType("set-prop").some((op) =>
          "key" in op && op.key === "data-cfc-blocked" &&
          "value" in op && op.value === "true"
        ),
        true,
        "a same-UI retarget should still re-run the render policy",
      );
    },
  );

  await t.step(
    "does not mark an ordinary UI-shaped computed cell as a piece",
    async () => {
      const collector = createOpsCollector();
      const reconciler = new WorkerReconciler({ onOps: collector.onOps });
      const uiShapedDataCell = new MockCell({
        [UI]: {
          type: "vnode",
          name: "span",
          props: {},
          children: ["ordinary data"],
        },
      });
      uiShapedDataCell.getAsNormalizedFullLink = () => ({
        id: "of:fid1:ordinary-ui-shaped-data",
        space: signer.did(),
        path: [],
        scope: "space",
      });
      const rootCell = new MockCell({
        type: "vnode",
        name: "div",
        props: {},
        children: [uiShapedDataCell],
      } as unknown as WorkerVNode);

      reconciler.mount(rootCell as unknown as Cell<unknown>);
      await t.settle();

      assertEquals(
        collector.hasOp("set-piece-boundary"),
        false,
        "UI-shaped data without pattern provenance is not a piece",
      );
    },
  );

  await t.step("replaces same-key child when tag changes", async () => {
    const collector = createOpsCollector();
    const reconciler = new WorkerReconciler({
      onOps: collector.onOps,
    });

    const rootCell = new MockCell(
      {
        type: "vnode",
        name: "div",
        props: {},
        children: [{
          type: "vnode",
          name: "span",
          props: { key: "stable" },
          children: ["old"],
        }],
      } satisfies WorkerVNode,
    );

    reconciler.mount(rootCell as unknown as Cell<unknown>);
    await t.settle();
    const spanCreate = collector.getOpsOfType("create-element").find((op) =>
      "tagName" in op && op.tagName === "span"
    );
    if (!spanCreate || !("nodeId" in spanCreate)) {
      throw new Error("Expected initial keyed span");
    }
    const spanNodeId = spanCreate.nodeId;
    collector.clear();

    rootCell.set(
      {
        type: "vnode",
        name: "div",
        props: {},
        children: [{
          type: "vnode",
          name: "button",
          props: { key: "stable" },
          children: ["new"],
        }],
      } satisfies WorkerVNode,
    );
    await t.settle();

    assertEquals(
      collector.getOpsOfType("remove-node").some((op) =>
        "nodeId" in op && op.nodeId === spanNodeId
      ),
      true,
      "same-key tag change should remove the old child",
    );
    assertEquals(
      collector.getOpsOfType("create-element").some((op) =>
        "tagName" in op && op.tagName === "button"
      ),
      true,
      "same-key tag change should create the replacement child",
    );
  });
});
