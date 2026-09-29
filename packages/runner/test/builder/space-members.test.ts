import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { ACLManager } from "../../src/acl-manager.ts";
import { Runtime } from "../../src/runtime.ts";
import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import {
  loadSpaceMembership,
  spaceAccess,
} from "../../src/builder/space-members.ts";

/** An access verdict can change while the replicated ACL remains identical. */
describe("space-members", () => {
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
      const states: string[] = [];
      cancel = runtime.scheduler.subscribe(async (tx) => {
        await loadSpaceMembership(runtime, space);
        const frame = pushFrame({ runtime, tx, space });
        try {
          states.push(spaceAccess());
        } finally {
          popFrame(frame);
        }
      }, { isEffect: true });
      await runtime.settled();
      expect(states.at(-1)).toBe("member");
      accessError = Object.assign(new Error("revoked"), {
        spaceAccessDenied: true,
      });
      changed!(space);
      await runtime.settled();
      expect(states.at(-1)).toBe("not-member");
      accessError = undefined;
      changed!(space);
      await runtime.settled();
      expect(states.at(-1)).toBe("member");
      expect(acl.get()).toEqual({ [space]: "OWNER" });
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
