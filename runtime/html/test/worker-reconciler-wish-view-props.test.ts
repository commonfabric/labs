import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime, UI } from "@commonfabric/runner";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../../runner/src/builder/types.ts";
import { vnodeSchema } from "../../runner/src/schemas.ts";
import { seedProfileOwner } from "../../runner/test/cfc-seed-envelope.ts";
import { createTrustedBuilder } from "../../runner/test/support/trusted-builder.ts";
import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";

Deno.test("worker reconciler over the props of the view a wish shows", async (t) => {
  // A wish holds the view it shows as an opaque handle, and the reconciler
  // reads an object or array prop under the schema `true`, which takes its
  // shape from the references it crosses. The values below are the ones that
  // read would lose if it took the handle's.
  //
  // `Deno.test` rather than `describe`/`it`: this package installs its fake
  // clock in freeze-all mode, which hangs `settle()` off `Deno.TestContext`,
  // and a `@std/testing/bdd` `it()` callback never receives that context.

  const owner = await Identity.fromPassphrase("wish view props owner");
  const patternSpace = (await Identity.fromPassphrase(
    "wish view props pattern space",
  )).did();
  const profileSpace = (await Identity.fromPassphrase(
    "wish view props profile space",
  )).did();
  const storageManager = StorageManager.emulate({ as: owner });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });
  const { pattern, wish, h } = createTrustedBuilder(runtime).commonfabric;

  // The schema a typed wish for a piece asks with.
  const pieceSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      [UI]: { $ref: "#/$defs/VNode" },
    },
    $defs: vnodeSchema.$defs,
  } as const satisfies JSONSchema;

  /** The value of each prop set on an element named `tagName`. */
  const propsSetOn = (ops: VDomOp[], tagName: string) => {
    const created = ops.flatMap((op) =>
      op.op === "create-element" && op.tagName === tagName ? [op.nodeId] : []
    );
    return Object.fromEntries(
      ops.flatMap((op) =>
        op.op === "set-prop" && created.includes(op.nodeId)
          ? [[op.key, op.value]]
          : []
      ),
    );
  };

  try {
    // A piece whose view holds object, array and linked props on its root
    // element, on an element inline beneath it, and on a child that is a
    // document of its own.
    const pieceTx = runtime.edit();
    const linkedValue = runtime.getCell(
      profileSpace,
      "linked-value",
      undefined,
      pieceTx,
    );
    linkedValue.set({ text: "from another document" });
    const childView = runtime.getCell(
      profileSpace,
      "child-view",
      undefined,
      pieceTx,
    );
    childView.set({
      type: "vnode",
      name: "cf-child",
      props: { options: ["first", "second"] },
      children: [],
    });
    const piece = runtime.getCell(profileSpace, "piece", undefined, pieceTx);
    piece.set({
      title: "Props",
      [UI]: {
        type: "vnode",
        name: "cf-root",
        props: {
          config: { mode: "dark", nested: { depth: 2 } },
          items: ["a", "b"],
          linked: linkedValue,
        },
        children: [
          {
            type: "vnode",
            name: "cf-inner",
            props: { settings: { inner: true } },
            children: [],
          },
          childView,
        ],
      },
    });
    const profile = runtime.getCell(
      profileSpace,
      "profile",
      undefined,
      pieceTx,
    );
    profile.set({
      name: "Ada",
      initialNameApplied: "Ada",
      avatar: "",
      elements: [{ cell: piece, tag: "#props", userTags: [], title: "props" }],
    });
    seedProfileOwner(pieceTx, profile.getAsNormalizedFullLink(), owner.did());
    expect((await pieceTx.commit().settled).error).toBeUndefined();
    const homeTx = runtime.edit();
    const homeDefault = runtime.getCell(
      owner.did(),
      "home-default",
      undefined,
      homeTx,
    );
    homeDefault.key("profiles").set([profile]);
    runtime.getHomeSpaceCell(homeTx).key("defaultPattern").set(homeDefault);
    expect((await homeTx.commit().settled).error).toBeUndefined();

    // A wisher that keeps the wish, and shows the wish's view inside its own.
    const wisherTx = runtime.edit();
    const wisher = runtime.run(
      wisherTx,
      pattern(() => {
        const found = wish(
          { query: "#props", scope: ["profile"] },
          pieceSchema,
        );
        return { found, [UI]: h("div", {}, found[UI]) };
      }),
      {},
      runtime.getCell<Record<string | symbol, unknown>>(
        patternSpace,
        "wisher",
        undefined,
        wisherTx,
      ),
    );
    expect((await wisherTx.commit().settled).error).toBeUndefined();
    await wisher.pull();
    await t.settle();

    const mounts: Array<[string, Cell<unknown>]> = [
      ["mounted alone", wisher.key("found").key(UI)],
      ["inside the wisher's view", wisher.key(UI)],
    ];
    for (const [where, view] of mounts) {
      await t.step(
        `emits the object, array and linked props of the found view ${where}`,
        async () => {
          const ops: VDomOp[] = [];
          const cancel = new WorkerReconciler({
            onOps: (batch) => {
              for (const op of batch) ops.push(op);
            },
          }).mount(view.asSchema(rendererVDOMSchema));
          try {
            await t.settle();

            expect(propsSetOn(ops, "cf-root")).toEqual({
              config: { mode: "dark", nested: { depth: 2 } },
              items: ["a", "b"],
              linked: { text: "from another document" },
            });
            expect(propsSetOn(ops, "cf-inner")).toEqual({
              settings: { inner: true },
            });
            expect(propsSetOn(ops, "cf-child")).toEqual({
              options: ["first", "second"],
            });
          } finally {
            cancel();
          }
        },
      );
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
