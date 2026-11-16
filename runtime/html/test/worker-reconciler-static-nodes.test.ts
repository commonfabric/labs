/**
 * How the worker reconciler renders a static tree, one mounted as a plain
 * value rather than through a cell: the shapes a render node can take, the
 * nodes it refuses, and the handlers it registers along the way. A root cell
 * holding something that is not a render node at all is refused too.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { Runtime, UI } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type { WorkerRenderNode, WorkerVNode } from "../src/worker/types.ts";

/** A pattern output, an object whose `[UI]` names what renders for it. */
const withUI = (inner: unknown): WorkerRenderNode =>
  ({ [UI]: inner }) as unknown as WorkerRenderNode;

const vnode = (
  name: string,
  children: WorkerVNode["children"] = [],
  props: WorkerVNode["props"] = {},
): WorkerVNode => ({ type: "vnode", name, props, children });

/** Mounts `root`, flushes, and returns the ops and errors it produced. */
function mount(root: WorkerVNode) {
  const ops: VDomOp[] = [];
  const errors: Error[] = [];
  const reconciler = new WorkerReconciler({
    onOps: (batch) => {
      for (const op of batch) ops.push(op);
    },
    onError: (error) => errors.push(error),
  });
  reconciler.mount(root);
  reconciler.flush();
  return { reconciler, ops, errors };
}

/** The tag of every element `ops` creates, in order. */
const tags = (ops: VDomOp[]) =>
  ops.flatMap((op) => op.op === "create-element" ? [op.tagName] : []);

/** The text of every text node `ops` creates, in order. */
const texts = (ops: VDomOp[]) =>
  ops.flatMap((op) => op.op === "create-text" ? [op.text] : []);

describe("reconciler", () => {
  describe("a child carrying `[UI]`", () => {
    it("renders the text its chain ends at", () => {
      const { ops } = mount(
        vnode("div", [withUI(withUI("hello")), withUI(7)]),
      );

      expect(tags(ops)).toEqual(["div"]);
      expect(texts(ops)).toEqual(["hello", "7"]);
    });

    it("renders the elements of an array its chain ends at", () => {
      const { ops } = mount(
        vnode("div", [withUI([vnode("b"), vnode("i")])]),
      );

      expect(tags(ops)).toEqual(["div", "cf-fragment", "b", "i"]);
    });

    it("renders nothing for a chain ending at `null` or a boolean", () => {
      const { ops } = mount(vnode("div", [withUI(withUI(null))]));
      const { ops: boolOps } = mount(vnode("div", [withUI(withUI(true))]));

      expect(tags(ops)).toEqual(["div"]);
      expect(texts(ops)).toEqual([]);
      expect(tags(boolOps)).toEqual(["div"]);
      expect(texts(boolOps)).toEqual([]);
    });

    it("renders a cycle placeholder for a chain that loops", () => {
      const looping: Record<PropertyKey, unknown> = {};
      looping[UI] = { [UI]: looping };

      const { ops } = mount(
        vnode("div", [looping as unknown as WorkerRenderNode]),
      );

      expect(tags(ops)).toEqual(["div", "span"]);
      expect(ops).toContainEqual(
        expect.objectContaining({
          op: "set-prop",
          key: "title",
          value: "Circular reference detected",
        }),
      );
    });
  });

  describe("sanitizing", () => {
    it("renders a cycle placeholder where a node contains itself", () => {
      const parent = vnode("section");
      const child = withUI(parent);
      (parent.children as WorkerRenderNode[]).push(child);

      const { ops } = mount(vnode("div", [parent]));

      expect(tags(ops)).toEqual(["div", "section", "span"]);
    });

    it("drops a `script` element and keeps its siblings", () => {
      const { ops } = mount(
        vnode("div", [
          vnode("script", ["alert(1)"]),
          withUI(vnode("script", ["alert(2)"])),
          vnode("p"),
        ]),
      );

      expect(tags(ops)).toEqual(["div", "p"]);
      expect(texts(ops)).toEqual([]);
    });

    it("renders a nameless node as a fragment, ignoring malformed props and children", () => {
      const malformed = {
        type: "vnode",
        name: "",
        props: "title=x",
        children: "text",
      } as unknown as WorkerVNode;

      const { ops, errors } = mount(vnode("div", [malformed]));

      expect(tags(ops)).toEqual(["div", "cf-fragment"]);
      expect(texts(ops)).toEqual([]);
      expect(ops.some((op) => op.op === "set-prop")).toBe(false);
      expect(errors).toEqual([]);
    });

    it("drops a node reached through `[UI]` that is not a vnode", () => {
      const { ops } = mount(
        vnode("div", [withUI({ type: "other", name: "p" }), vnode("i")]),
      );

      expect(tags(ops)).toEqual(["div", "i"]);
    });
  });

  describe("dispatchEvent()", () => {
    const button = (onClick: (event: unknown) => void) => {
      const { reconciler, ops, errors } = mount(
        vnode("button", [], { onClick }),
      );
      const event = ops.find((op) => op.op === "set-event");
      if (event?.op !== "set-event") throw new Error("No handler registered");
      return { reconciler, errors, handlerId: event.handlerId };
    };

    it("runs the registered handler and reports that it found one", () => {
      const heard: unknown[] = [];
      const { reconciler, errors, handlerId } = button((event) =>
        heard.push(event)
      );

      expect(reconciler.dispatchEvent(handlerId, { type: "click" })).toBe(
        true,
      );
      expect(heard).toEqual([{ type: "click" }]);
      expect(errors).toEqual([]);
    });

    it("reports a handler's error through `onError`", () => {
      const thrown = new Error("handler failed");
      const { reconciler, errors, handlerId } = button(() => {
        throw thrown;
      });

      expect(reconciler.dispatchEvent(handlerId, { type: "click" })).toBe(
        true,
      );
      expect(errors).toEqual([thrown]);
    });

    it("wraps a thrown value that is not an `Error`", () => {
      const { reconciler, errors, handlerId } = button(() => {
        throw "plain text";
      });

      reconciler.dispatchEvent(handlerId, { type: "click" });

      expect(errors.map((error) => error.message)).toEqual(["plain text"]);
    });

    it("reports that no handler has an unknown id", () => {
      const { reconciler, handlerId } = button(() => {});

      expect(reconciler.dispatchEvent(handlerId + 1, { type: "click" })).toBe(
        false,
      );
    });
  });

  describe("an authorship boundary's flags written as strings", () => {
    // A flag reaches the boundary as an attribute would: the empty string and
    // "true", in any case, turn it on, "false" turns it off, and any other
    // string says nothing, which leaves the next spelling to decide.

    const shown = (props: Record<string, string>) =>
      texts(
        mount(vnode("cf-cfc-authorship", ["literal words"], props)).ops,
      );
    const hidden = ["Content hidden by integrity policy"];

    it("verifies text for an empty or `true` flag", () => {
      expect(shown({ verifyTextIntegrity: "" })).toEqual(hidden);
      expect(shown({ "verify-text-integrity": "TRUE" })).toEqual(hidden);
    });

    it("does not verify text for a `false` flag, whatever a later spelling says", () => {
      expect(
        shown({ verifyTextIntegrity: "False", "verify-text-integrity": "" }),
      ).toEqual(["literal words"]);
    });

    it("reads past a string that is neither", () => {
      expect(
        shown({ verifyTextIntegrity: "maybe", "verify-text-integrity": "" }),
      ).toEqual(hidden);
      expect(shown({ verifyTextIntegrity: "maybe" })).toEqual([
        "literal words",
      ]);
    });

    it("admits literal text under a `true` allowance", () => {
      expect(
        shown({ verifyTextIntegrity: "true", allowLiteralText: "true" }),
      ).toEqual(["literal words"]);
    });
  });

  describe("a root cell", () => {
    const signer = Identity.fromPassphrase("test static nodes root");

    /**
     * Mounts the cell `id` holding `value`, then mounts each of `next` in
     * turn, writing `after` to `id` once they are mounted, and returns the ops
     * and errors produced along the way.
     */
    const mountCell = async (
      id: string,
      value: unknown,
      { next = [], after }: { next?: WorkerVNode[]; after?: unknown } = {},
    ) => {
      const identity = await signer;
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: StorageManager.emulate({ as: identity }),
      });
      try {
        const root = runtime.getCell<unknown>(identity.did(), id);
        const write = async (content: unknown) => {
          const tx = runtime.edit();
          root.withTx(tx).set(content);
          await tx.commit().settled;
          await runtime.idle();
        };
        await write(value);
        const ops: VDomOp[] = [];
        const errors: Error[] = [];
        const reconciler = new WorkerReconciler({
          onOps: (batch) => {
            for (const op of batch) ops.push(op);
          },
          onError: (error) => errors.push(error),
        });

        reconciler.mount(root);
        await runtime.idle();
        reconciler.flush();
        for (const tree of next) reconciler.mount(tree);
        reconciler.flush();
        const before = ops.length;
        if (after !== undefined) await write(after);
        reconciler.flush();
        reconciler.unmount();
        return { ops, errors, afterOps: ops.slice(before) };
      } finally {
        await runtime.dispose();
      }
    };

    it("reports content that is not a render node, and renders nothing", async () => {
      const { ops, errors } = await mountCell("not a node", {
        heading: "no name, no [UI]",
      });

      expect(errors.map((error) => error.message)).toEqual([
        "Invalid VDOM content: expected WorkerVNode, string, or number, got object",
      ]);
      expect(tags(ops)).toEqual([]);
    });

    it("renders nothing, and reports nothing, for a boolean", async () => {
      const { ops, errors } = await mountCell("a boolean", true);

      expect(errors).toEqual([]);
      expect(tags(ops)).toEqual([]);
      expect(texts(ops)).toEqual([]);
    });

    it("renders what a `$UI` it holds names", async () => {
      const { ops, errors } = await mountCell("an output", {
        $UI: vnode("article", ["body"]),
      });

      expect(errors).toEqual([]);
      expect(tags(ops)).toEqual(["article"]);
      expect(texts(ops)).toEqual(["body"]);
    });

    it("stops following a cell once another tree is mounted in its place", async () => {
      const { ops, afterOps } = await mountCell("replaced", vnode("h1"), {
        next: [vnode("h2")],
        after: vnode("h3"),
      });

      expect(tags(ops)).toEqual(["h1", "h2"]);
      expect(tags(afterOps)).toEqual([]);
    });
  });
});
