/**
 * Renders the system profile pattern through the worker reconciler after Loom
 * assertions are published to it, and checks what reaches the document: the
 * human-facing assertion is shown with a badge bound to the assertion's own
 * integrity-bearing `value`, while a stable machine identifier and an
 * assertion outside the 48-hour freshness window are not shown.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { type JSONSchema, Runtime, UI } from "@commonfabric/runner";
import { cfcLabelViewForCell } from "@commonfabric/runner/cfc";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";

const INTEGRITY = "loom-verified-external-identity";
const signer = await Identity.fromPassphrase(
  "profile-home verified identity render",
);
const space = signer.did();
const PROGRAM = {
  main: "/profile-home.tsx",
  files: [{
    name: "/profile-home.tsx",
    contents: Deno.readTextFileSync(
      new URL("../../patterns/system/profile-home.tsx", import.meta.url),
    ),
  }],
};

const labeledAssertionSchema: JSONSchema = {
  type: "object",
  properties: {
    type: { type: "string", ifc: { addIntegrity: [INTEGRITY] } },
    value: { type: "string", ifc: { addIntegrity: [INTEGRITY] } },
    verifiedAt: { type: "string", ifc: { addIntegrity: [INTEGRITY] } },
  },
  required: ["type", "value", "verifiedAt"],
  ifc: { addIntegrity: [INTEGRITY] },
};

// Plain `Deno.test`, as the other reconciler tests here are written, because
// the package's clock preload attaches `t.settle()` to its context.
Deno.test("profile-home shows a human-facing verified identity with a badge bound to its labeled value", async (t) => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
      tx,
    });
    const result = runtime.run(
      tx,
      // deno-lint-ignore no-explicit-any
      pattern as any,
      { initialName: "Ada Lovelace" },
      runtime.getCell(space, "profile-home verified render", undefined, tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();

    const freshVerifiedAt = new Date().toISOString();
    const assertionTx = runtime.edit();
    const login = runtime.getCell(
      space,
      "loom github login",
      labeledAssertionSchema,
      assertionTx,
    );
    login.set({
      type: "github.login",
      value: "ada",
      verifiedAt: freshVerifiedAt,
    });
    const nodeId = runtime.getCell(
      space,
      "loom github node id",
      labeledAssertionSchema,
      assertionTx,
    );
    nodeId.set({
      type: "github.node_id",
      value: "MDQ6VXNlcjE=",
      verifiedAt: freshVerifiedAt,
    });
    const staleLogin = runtime.getCell(
      space,
      "loom stale github login",
      labeledAssertionSchema,
      assertionTx,
    );
    staleLogin.set({
      type: "github.login",
      value: "stale-ada",
      verifiedAt: "2020-01-01T00:00:00.000Z",
    });
    runtime.prepareTxForCommit(assertionTx);
    expect((await assertionTx.commit()).error).toBeUndefined();

    const publishTx = runtime.edit();
    result.withTx(publishTx).key("publishVerifiedIdentities").send({
      identities: [
        login.withTx(publishTx),
        nodeId.withTx(publishTx),
        staleLogin.withTx(publishTx),
      ],
    });
    runtime.prepareTxForCommit(publishTx);
    expect((await publishTx.commit()).error).toBeUndefined();
    await runtime.idle();

    const ops: VDomOp[] = [];
    const reconciler = new WorkerReconciler({
      onOps: (batch) => ops.push(...batch),
    });
    const cancel = reconciler.mount(
      result.key(UI).asSchema(rendererVDOMSchema),
    );
    try {
      await runtime.idle();
      await t.settle();

      const texts = ops.flatMap((op) =>
        op.op === "create-text" || op.op === "update-text" ? [op.text] : []
      );
      expect(texts).toContain("GitHub");
      expect(texts).toContain("ada");
      expect(texts).not.toContain("MDQ6VXNlcjE=");
      expect(texts).not.toContain("stale-ada");

      // The presentation renders more than once while the profile settles,
      // so each render's badge is checked rather than a count of them.
      const labelIds = ops.flatMap((op) =>
        op.op === "create-element" && op.tagName === "cf-cfc-label"
          ? [op.nodeId]
          : []
      );
      expect(labelIds.length).toBeGreaterThan(0);
      for (const labelId of labelIds) {
        const props = Object.fromEntries(
          ops.flatMap((op) =>
            op.op === "set-prop" && op.nodeId === labelId
              ? [[op.key, op.value]]
              : []
          ),
        );
        expect(props).toEqual({ atom: INTEGRITY, variant: "badge" });

        const bindings = ops.flatMap((op) =>
          op.op === "set-binding" && op.nodeId === labelId ? [op] : []
        );
        expect(bindings.map((op) => op.propName)).toEqual(["value"]);
        const bound = runtime.getCellFromLink(bindings[0].cellRef);
        expect(bound.get()).toBe("ada");
        const atoms = (cfcLabelViewForCell(bound)?.entries ?? []).flatMap(
          (entry) => entry.label.integrity ?? [],
        );
        expect(atoms).toContain(INTEGRITY);
      }
    } finally {
      cancel();
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
