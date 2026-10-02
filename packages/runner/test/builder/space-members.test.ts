import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { aclDocId } from "@commonfabric/memory/acl";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { ACLManager } from "../../src/acl-manager.ts";
import { Runtime } from "../../src/runtime.ts";
import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import {
  loadSpaceMembership,
  spaceMembers,
} from "../../src/builder/space-members.ts";

/** An access verdict can change while the replicated ACL remains identical. */
describe("space-members", () => {
  it("loads membership in a served computation without an event actor", async () => {
    const identity = await Identity.fromPassphrase("membership-served-test");
    const storage = StorageManager.emulate({ as: identity });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      servingPosture: true,
    });
    try {
      await new ACLManager(runtime, identity.did()).set(
        identity.did(),
        "OWNER",
      );
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
            import { computed, pattern, spaceMembers } from "commonfabric";
            export default pattern(() => ({
              members: computed(() => spaceMembers()),
            }));
          `,
        }],
      }, { space: identity.did() });
      const result = runtime.getCell<{ members: Record<string, string> }>(
        identity.did(),
        "served-membership",
        compiled.resultSchema,
      );
      await runtime.runSynced(result, compiled, {});
      await waitForCellValue<Record<string, string>>(
        runtime,
        result.key("members"),
        (value) => value?.[identity.did()] === "OWNER",
      );
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });

  it("recomputes access on denial and recovery without an ACL write", async () => {
    const identity = await Identity.fromPassphrase("membership-verdict-test");
    const space = identity.did();
    const storage = StorageManager.emulate({ as: identity });
    let changed: ((space: MemorySpace) => void) | undefined;
    let accessError: Error | undefined;
    let canceled = false;
    const observe = stub(storage, "subscribeSpaceAccessChange", (callback) => {
      changed = callback;
      return () => {
        canceled = true;
      };
    });
    const snapshot = stub(storage, "spaceAccessError", () => accessError);
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
    });
    let cancel: (() => void) | undefined;
    try {
      const acl = runtime.getCellFromLink({
        space,
        id: aclDocId(space) as URI,
        path: [],
      });
      await new ACLManager(runtime, space).set(space, "OWNER");
      const available: boolean[] = [];
      cancel = runtime.scheduler.subscribe(async (tx) => {
        await loadSpaceMembership(runtime, space);
        const frame = pushFrame({ runtime, tx, space, frameKind: "lift" });
        try {
          available.push(spaceMembers() !== undefined);
          expect(tx.getNarrowestReadScope()).toBe("user");
        } finally {
          popFrame(frame);
        }
      }, { isEffect: true });
      await runtime.settled();
      expect(available.at(-1)).toBe(true);
      accessError = Object.assign(new Error("revoked"), {
        name: "AuthorizationError",
      });
      changed!(space);
      await runtime.settled();
      expect(available.at(-1)).toBe(false);
      accessError = undefined;
      changed!(space);
      await runtime.settled();
      expect(available.at(-1)).toBe(true);
      expect(acl.get()).toEqual({ [space]: "OWNER" });
      expect(available).toEqual([true, false, true]);
    } finally {
      cancel?.();
      await runtime.dispose();
      expect(canceled).toBe(true);
      observe.restore();
      snapshot.restore();
      await storage.close();
    }
  });
});
