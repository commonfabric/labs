/**
 * An attribute read through a link that declares only a reference.
 *
 * The map builtin hands each element to its callback through a link carrying
 * the list's item schema, which is `{type: "unknown"}` once a generic lift has
 * forwarded the elements as references, so `data-key={thread.key}` reaches the
 * reconciler as an opaque reference to the key. A DOM attribute can hold only
 * the value, so the renderer reads the scalar the reference names rather than
 * handing the DOM the `[object Object]` the reference coerces to, and reading
 * it touches that one field of the record.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { type Cell, type JSONSchema, Runtime } from "@commonfabric/runner";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { CellLinkRefPayload } from "../../runner/src/sigil-types.ts";
import { DomApplicator } from "../src/main/applicator.ts";
import { MockDoc } from "../src/mock-doc.ts";
import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";

const signer = await Identity.fromPassphrase(
  "in-process reference attributes",
);
const space = signer.did();

const recordSchema = {
  type: "object",
  properties: { key: { type: "string" }, title: { type: "string" } },
  required: ["key", "title"],
} as const satisfies JSONSchema;

/**
 * A stored link to `cell` carrying `schema`, a redirect when `overwrite` says
 * so. Built rather than minted, so the schema it carries is the one the test
 * chose rather than the one the cell knows.
 */
const linkCarrying = (
  cell: Cell<unknown>,
  schema: JSONSchema,
  overwrite?: "redirect",
) => {
  const link = cell.getAsNormalizedFullLink();
  return linkRefFrom<CellLinkRefPayload>({
    id: link.id,
    space: link.space,
    scope: link.scope,
    path: [...link.path],
    schema,
    ...(overwrite !== undefined && { overwrite }),
  });
};

describe("in-process-reference-attributes", () => {
  it("renders the record's field, follows its edits, and reads nothing else of the record", async () => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
    });
    const mock = new MockDoc('<div id="root"></div>');
    const container = mock.document.getElementById("root")!;
    const applicator = new DomApplicator({
      document: mock.document,
      setProp: mock.renderOptions.setProp,
      onEvent: () => {},
    });
    applicator.setContainer(container);
    const ops: VDomOp[] = [];
    let batchId = 0;
    const reconciler = new WorkerReconciler({
      onOps: (batch) => {
        for (const op of batch) ops.push(op);
        applicator.applyBatch({ batchId: batchId++, ops: batch });
        return batchId;
      },
    });
    try {
      const rows = runtime.getCell(space, "rows", {
        type: "array",
        items: recordSchema,
      });
      // The map callback's argument: its `element` is the list element,
      // reached through the link the map builtin writes, which carries the
      // list's item schema.
      const argument = runtime.getCell(space, "argument", undefined);
      const view = runtime.getCell(space, "view", undefined);
      const field = (name: string) =>
        linkCarrying(
          argument.key("element").key(name),
          { type: "string" },
          "redirect",
        );
      await runtime.editWithRetry((tx) => {
        rows.withTx(tx).set([{ key: "thread-a", title: "A" }]);
        argument.withTx(tx).setRaw({
          element: linkCarrying(rows.key(0), { type: "unknown" }),
        });
        view.withTx(tx).setRaw({
          $UI: {
            type: "vnode",
            name: "button",
            props: { "data-key": field("key"), "data-title": field("title") },
            children: [field("title")],
          },
        });
      });
      reconciler.mount(view.asSchema(rendererVDOMSchema));
      await runtime.idle();
      await runtime.storageManager.synced();
      await runtime.idle();
      reconciler.flush();
      const keyValues = () =>
        ops.flatMap((op) =>
          op.op === "set-prop" && op.key === "data-key" ? [op.value] : []
        );
      expect(container.innerHTML).toBe(
        '<button data-key="thread-a" data-title="A">A</button>',
      );
      expect(keyValues()).toEqual(["thread-a"]);
      const button = container.firstChild;

      // The subscription rests on the record's field, so an edit there
      // reaches the same element.
      ops.length = 0;
      await runtime.editWithRetry((tx) =>
        rows.withTx(tx).key(0).key("key").set("thread-b")
      );
      await runtime.idle();
      reconciler.flush();
      expect(container.firstChild).toBe(button);
      expect(container.innerHTML).toBe(
        '<button data-key="thread-b" data-title="A">A</button>',
      );
      expect(keyValues()).toEqual(["thread-b"]);
      expect(ops.some((op) => op.op === "create-element")).toBe(false);

      // Rendering the key read the key, not the record: a sibling field's
      // edit re-renders what reads that field and nothing else.
      ops.length = 0;
      await runtime.editWithRetry((tx) =>
        rows.withTx(tx).key(0).key("title").set("B")
      );
      await runtime.idle();
      reconciler.flush();
      expect(container.innerHTML).toBe(
        '<button data-key="thread-b" data-title="B">B</button>',
      );
      expect(keyValues()).toEqual([]);
    } finally {
      reconciler.unmount();
      applicator.dispose();
      await runtime.dispose();
    }
  });

  it("renders the field behind a prop link that itself declares only a reference", async () => {
    // Nothing on the way declares the string: the prop's own link says
    // `unknown`, the way a field the pattern typed `unknown` does. A
    // redirect, as a pattern's alias is: a plain value link under an
    // agnostic reader takes the schema-less proxy path and never projects
    // a reference at all.
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
    });
    const mock = new MockDoc('<div id="root"></div>');
    const container = mock.document.getElementById("root")!;
    const applicator = new DomApplicator({
      document: mock.document,
      setProp: mock.renderOptions.setProp,
      onEvent: () => {},
    });
    applicator.setContainer(container);
    let batchId = 0;
    const reconciler = new WorkerReconciler({
      onOps: (batch) => {
        applicator.applyBatch({ batchId: batchId++, ops: batch });
        return batchId;
      },
    });
    try {
      const rows = runtime.getCell(space, "rows-reference", {
        type: "array",
        items: recordSchema,
      });
      const view = runtime.getCell(space, "view-reference", undefined);
      await runtime.editWithRetry((tx) => {
        rows.withTx(tx).set([{ key: "thread-a", title: "A" }]);
        view.withTx(tx).setRaw({
          $UI: {
            type: "vnode",
            name: "button",
            props: {
              "data-key": linkCarrying(
                rows.key(0).key("key"),
                { type: "unknown" },
                "redirect",
              ),
            },
            children: [],
          },
        });
      });
      reconciler.mount(view.asSchema(rendererVDOMSchema));
      await runtime.idle();
      await runtime.storageManager.synced();
      await runtime.idle();
      reconciler.flush();
      expect(container.innerHTML).toBe('<button data-key="thread-a"></button>');

      await runtime.editWithRetry((tx) =>
        rows.withTx(tx).key(0).key("key").set("thread-b")
      );
      await runtime.idle();
      reconciler.flush();
      expect(container.innerHTML).toBe('<button data-key="thread-b"></button>');
    } finally {
      reconciler.unmount();
      applicator.dispose();
      await runtime.dispose();
    }
  });
});
