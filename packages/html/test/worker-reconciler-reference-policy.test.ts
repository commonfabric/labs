import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { cfcLabelViewForCell } from "@commonfabric/runner/cfc";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { deriveFlowJoin } from "../../runner/src/cfc/prepare.ts";

import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";

describe("worker reconciler reference policy", () => {
  it("keeps the demo controls public across a cold mount after disclosure", async () => {
    const signer = await Identity.fromPassphrase("render-demo-cold-reference");
    const storage = StorageManager.emulate({ as: signer });
    const runtimes: Runtime[] = [];
    const errors: unknown[] = [];
    const cancellations: Array<() => void> = [];
    const createRuntime = () => {
      const runtime = new Runtime({
        storageManager: storage,
        apiUrl: new URL("https://example.com"),
        cfcFlowLabels: "persist",
        errorHandlers: [(error) => errors.push(error)],
      });
      runtimes.push(runtime);
      return runtime;
    };
    try {
      const owner = createRuntime();
      const program = await resolveLocalProgram(
        (request) => owner.harness.resolve(request),
        {
          main: fromFileUrl(
            new URL(
              "../../patterns/cfc-render-policy-demo/main.tsx",
              import.meta.url,
            ),
          ),
          root: fromFileUrl(new URL("../../patterns/", import.meta.url)),
        },
      );
      const pattern = await owner.patternManager.compilePattern(program, {
        space: signer.did(),
      });
      const setup = owner.edit();
      const result = owner.getCell(signer.did(), "demo", undefined, setup);
      owner.run(setup, pattern, {}, result);
      expect((await setup.commit()).error).toBeUndefined();
      await result.pull();
      cancellations.push(result.sink(() => {}));

      // An active owner and a restarted viewer both execute initialization.
      // Neither reads the health record's protected content to find its handle.
      const warm = createRuntime();
      const warmResult = warm.getCellFromLink(result.getAsNormalizedFullLink());
      await warm.start(warmResult);
      await warmResult.pull();
      const warmRenderer = new WorkerReconciler({
        onOps: () => {},
        onError: (error) => errors.push(error),
      });
      const cancelWarm = warmRenderer.mount(
        warmResult.asSchema(rendererVDOMSchema),
      );
      cancellations.push(cancelWarm);
      await warm.idle();
      warmResult.key("reveal").send({});
      await warm.idle();
      await owner.idle();
      expect(warmResult.key("revealSensitive").get()).toBe(true);
      cancelWarm();
      warm.runner.stop(warmResult);

      const cold = createRuntime();
      const coldResult = cold.getCellFromLink(result.getAsNormalizedFullLink());
      await cold.start(coldResult);
      await coldResult.pull();
      const ops: VDomOp[] = [];
      const coldRenderer = new WorkerReconciler({
        onOps: (next) => ops.push(...next),
        onError: (error) => errors.push(error),
        renderConfidentialityCeiling: { atoms: [] },
        renderDeclassificationPolicy: "deny",
      });
      cancellations.push(coldRenderer.mount(
        coldResult.asSchema(rendererVDOMSchema),
      ));
      await cold.idle();
      await owner.idle();
      coldRenderer.flush();
      const text = ops.filter((op) => op.op === "create-text")
        .map((op) => op.text);
      expect(text).toContain("Render-time confidentiality");
      expect(text).toContain("Untrusted direct render attempt");
      expect(text).toContain("Trusted shoulder-surfing control");
      expect(text).toContain("Hide sensitive health data");
      expect(text).toContain("Reset to private");
      expect(text).toContain("Content hidden by policy");
      expect(text.some((value) => value.includes("migraine treatment plan")))
        .toBe(false);
      expect(errors).toEqual([]);
    } finally {
      for (const cancel of cancellations) cancel();
      await storage.synced();
      for (const runtime of runtimes.reverse()) await runtime.dispose();
      await storage.close();
    }
  });

  it("inspects an existing public array item without acquiring unrelated history", async () => {
    const signer = await Identity.fromPassphrase("render-reference-policy");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      storageManager,
      apiUrl: new URL("https://example.com"),
      cfcFlowLabels: "persist",
    });
    const ops: VDomOp[] = [];
    const reconciler = new WorkerReconciler({
      onOps: (next) => ops.push(...next),
      renderConfidentialityCeiling: { atoms: [] },
    });
    let cancel: (() => void) | undefined;
    try {
      const setup = runtime.edit();
      const secret = runtime.getCell(signer.did(), "secret", {
        type: "string",
        ifc: { confidentiality: ["private"] },
      }, setup);
      secret.set("secret content");
      const nestedSecret = runtime.getCell(signer.did(), "nested secret", {
        type: "object",
        properties: {
          text: {
            type: "string",
            ifc: { confidentiality: ["private"] },
          },
        },
      }, setup);
      nestedSecret.set({ text: "secret content" });
      const publicNodes = runtime.getCell(
        signer.did(),
        "public nodes",
        undefined,
        setup,
      );
      const publicNode = {
        type: "vnode",
        name: "div",
        props: {},
        children: ["public control"],
      };
      publicNodes.setRawUntyped([publicNode]);
      expect((await setup.commit()).error).toBeUndefined();
      await publicNodes.sync();

      const labelRead = runtime.edit();
      expect(
        cfcLabelViewForCell(nestedSecret.withTx(labelRead).key("text"))
          ?.entries.some((entry) =>
            entry.label.confidentiality?.includes("private")
          ),
      ).toBe(true);
      expect(deriveFlowJoin(labelRead).confidentiality).toEqual([]);
      labelRead.abort();

      const inspection = runtime.edit();
      expect(secret.withTx(inspection).get()).toBe("secret content");
      const publicItem = publicNodes.withTx(inspection).key(0).asSchema(
        rendererVDOMSchema,
      );
      cancel = reconciler.mount(publicItem);
      await runtime.idle();
      reconciler.flush();
      expect(
        ops.some((op) =>
          op.op === "create-text" && op.text === "public control"
        ),
      ).toBe(true);
      cancel();
      cancel = undefined;

      // Authored construction in the same private computation must retain
      // its selection history, including after the attempt ends.
      const selected = runtime.getImmutableCell(
        signer.did(),
        publicNode,
        rendererVDOMSchema,
        inspection,
      ).withTx(undefined);
      inspection.abort();
      ops.length = 0;
      cancel = reconciler.mount(selected);
      await runtime.idle();
      reconciler.flush();
      expect(
        ops.some((op) =>
          op.op === "create-text" && op.text === "public control"
        ),
      ).toBe(false);
      expect(
        ops.some((op) =>
          op.op === "create-text" && op.text === "Content hidden by policy"
        ),
      ).toBe(true);
      cancel();
      cancel = undefined;

      ops.length = 0;
      cancel = reconciler.mount(
        secret.withTx(undefined).asSchema(rendererVDOMSchema),
      );
      await runtime.idle();
      reconciler.flush();
      expect(
        ops.some((op) =>
          op.op === "create-text" && op.text === "secret content"
        ),
      ).toBe(false);
      expect(
        ops.some((op) =>
          op.op === "create-text" && op.text === "Content hidden by policy"
        ),
      ).toBe(true);
    } finally {
      cancel?.();
      await storageManager.synced();
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
