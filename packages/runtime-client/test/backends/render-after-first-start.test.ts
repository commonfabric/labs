/**
 * Renders a piece for a participant who did not set it up, on that
 * participant's first start, through the worker's renderer under the shell's
 * display ceiling.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { VDomOp } from "@commonfabric/html/vdom-ops";
import { WorkerReconciler } from "@commonfabric/html/worker";
import { Identity } from "@commonfabric/identity";
import { defaultRenderConfidentialityCeiling } from "@commonfabric/lib-shell/runtime";
import { Runtime } from "@commonfabric/runner";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { EmulatedStorageManager } from "../../../runner/src/storage/v2-emulate.ts";
import { newSharedServer } from "../../../runner/test/memory-v2-test-utils.ts";

import {
  renderConfidentialityResolverFor,
  renderMembershipProviderFor,
  renderModulePolicySourceFor,
  renderSpaceAccessProviderFor,
} from "@/backends/runtime-processor.ts";

const owner = await Identity.fromPassphrase("render after first start owner");
const visitor = await Identity.fromPassphrase(
  "render after first start visitor",
);
const space = owner.did();

// The piece hands a cell labeled with its module policy and an unlabeled
// origin cell to a part it instantiates per participant. The part binds the
// origin to an element, so the renderer reads the binding through the part's
// instance, which also holds the link to the labeled cell.
const program = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
      import {
        Confidential, pattern, UI, type VNode, Writable,
      } from "commonfabric";
      import type { PolicyOf } from "commonfabric/cfc";
      import {
        cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
      } from "commonfabric/cfc";
      export const release = exchangeRule({
        appliesTo: THIS_POLICY,
        pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
        post: { addAlternatives: [cfcPattern.user(v("user"))] },
      });
      export const rules = exchangeRules([release]);
      type Brief = Confidential<string, [PolicyOf<typeof rules>]>;
      type Origin = { name: string };
      const Part = pattern<{ brief: Brief; origin: Origin }, { [UI]: VNode }>(
        ({ origin }) => {
          const seen = new Writable.perUser<boolean | null>(null);
          return {
            [UI]: <div><cf-owner-view $originator={origin} $result={seen} /></div>,
          };
        },
      );
      export default pattern<Record<string, never>, { [UI]: VNode }>(() => {
        const brief = new Writable.perSpace<Brief>("the brief");
        const origin = new Writable.perSpace<Origin>({ name: "origin" });
        const part = Part.asScope("user")({ brief, origin });
        return { [UI]: part[UI] };
      });
    `,
  }],
};

describe("render-after-first-start", () => {
  it("binds the element the part's instance carries", async () => {
    // This participant's first start writes its instance of the part, whose
    // link to the labeled cell requires the policy manifest the owner's
    // setup installed. The element bound to the unlabeled origin, read
    // through that instance, ends with its binding, which the shell's
    // display ceiling admits for this participant.

    const server = newSharedServer();
    const ownerStorage = EmulatedStorageManager.connectTo(server, {
      as: owner,
    });
    const ownerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: ownerStorage,
    });
    const storage = EmulatedStorageManager.connectTo(server, { as: visitor });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const compiled = await ownerRuntime.patternManager.compilePattern(
        program,
        { space },
      );
      const tx = ownerRuntime.edit();
      const setUp = ownerRuntime.getCell(space, "piece", undefined, tx);
      await setUp.sync();
      ownerRuntime.run(tx, compiled, {}, setUp);
      ownerRuntime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await ownerRuntime.idle();
      await ownerStorage.synced();

      const failures: unknown[] = [];
      runtime.pieceStartCommitFailureObserver = ({ error }) =>
        failures.push(error);
      const ceiling = defaultRenderConfidentialityCeiling(visitor.did());
      const membershipProvider = renderMembershipProviderFor(
        runtime,
        visitor,
        ceiling,
      );
      const modulePolicySource = renderModulePolicySourceFor(runtime, ceiling);
      const ops: VDomOp[] = [];
      const reconciler = new WorkerReconciler({
        renderDeclassificationPolicy: "deny",
        renderConfidentialityCeiling: ceiling,
        resolveRenderConfidentiality: renderConfidentialityResolverFor(
          runtime,
          visitor,
          ceiling,
          visitor.did(),
          membershipProvider,
          modulePolicySource,
        ),
        membershipProvider,
        modulePolicySource,
        spaceAccess: renderSpaceAccessProviderFor(runtime),
        onOps: (batch) => {
          for (const op of batch) ops.push(op);
          return ops.length;
        },
      });
      const piece = runtime.getCell(space, "piece");
      await piece.sync();
      // Mounted as the start resolves, which is before its commit's verdict.
      await runtime.start(piece);
      const unmount = reconciler.mount(piece.asSchema(rendererVDOMSchema));
      await runtime.idle();
      await runtime.runner.idlePieceInstantiationSettlements();
      await storage.synced();
      await runtime.idle();
      reconciler.flush();
      unmount();

      expect(failures).toEqual([]);
      const created = ops.find((op) =>
        op.op === "create-element" && op.tagName === "cf-owner-view"
      );
      if (created?.op !== "create-element") {
        throw new Error("the part's element was not rendered");
      }
      // Whether the element's `originator` is bound once every op is applied.
      let bound = false;
      for (const op of ops) {
        if (
          op.op === "set-binding" && op.nodeId === created.nodeId &&
          op.propName === "originator"
        ) {
          bound = true;
        } else if (
          op.op === "remove-prop" && op.nodeId === created.nodeId &&
          op.key === "originator"
        ) {
          bound = false;
        }
      }
      expect(bound).toBe(true);
    } finally {
      await storage.synced();
      await runtime.dispose();
      await ownerRuntime.dispose();
      await storage.close();
      await ownerStorage.close();
      await server.close();
    }
  });
});
