import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/logger";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getPatternIdentityRef, resolveEntryIdentity } from "../src/index.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("runner pointer roll-forward");
const space = signer.did();

const V1: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<Record<string, never>, { marker: string }>(() => {",
      "  return { marker: 'v1' };",
      "});",
      "",
    ].join("\n"),
  }],
};

// The content identity of a source no store holds.
const unloadableIdentity = await resolveEntryIdentity(
  "/main.tsx",
  (name) =>
    name === "/main.tsx"
      ? Promise.resolve([
        "import { pattern } from 'commonfabric';",
        "export default pattern<Record<string, never>, { marker: string }>(() => {",
        "  return { marker: 'nowhere' };",
        "});",
        "",
      ].join("\n"))
      : Promise.reject(new Error(`not found: ${name}`)),
);

const logged = (name: string, level: "warn" | "error"): number =>
  getLoggerCountsBreakdown().runner?.[name]?.[level] ?? 0;

describe("runner", () => {
  describe("pattern watcher following a pointer it cannot load", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let rt: Runtime;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
    });

    afterEach(async () => {
      await rt.runner.idlePointerMaintenance();
      await rt.dispose();
      await storageManager.close();
    });

    /** Runs `V1` as the piece `cause`, returning it and its identity. */
    const runV1 = async (cause: string) => {
      const tx = rt.edit();
      const v1 = await rt.patternManager.compilePattern(V1, { space, tx });
      const v1Ref = rt.patternManager.getArtifactEntryRef(v1)!;
      const cell = rt.getCell<{ marker: string }>(space, cause, undefined, tx);
      const running = rt.run(tx, v1, {}, cell);
      expect((await tx.commit().settled).error).toBeUndefined();
      await running.pull();
      expect(cell.get().marker).toBe("v1");
      return { cell, v1Ref };
    };

    /** Points the piece at `identity` and settles what the watcher does. */
    const repointTo = async (
      cell: ReturnType<Runtime["getCell"]>,
      identity: string,
    ) => {
      const tx = rt.edit();
      cell.withTx(tx).setMetaRaw("patternIdentity", {
        identity,
        symbol: "default",
      }, rawMetaWriteAuthorization);
      expect((await tx.commit().settled).error).toBeUndefined();
      await rt.idle();
      await rt.runner.idlePointerMaintenance();
      await rt.idle();
      await rt.runner.idlePointerMaintenance();
    };

    it("logs `unloadable-pointer-rolled-forward` when it writes the running identity back", async () => {
      rt = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
      const { cell, v1Ref } = await runV1("rolled-forward");
      const before = logged("unloadable-pointer-rolled-forward", "warn");

      await repointTo(cell, unloadableIdentity);

      expect(getPatternIdentityRef(cell)).toEqual(v1Ref);
      expect(logged("unloadable-pointer-rolled-forward", "warn")).toBe(
        before + 1,
      );
      expect(cell.get().marker).toBe("v1");
    });

    it("logs no roll-forward, and leaves the pointer, with CFC enforcement disabled", async () => {
      rt = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcEnforcementMode: "disabled",
      });
      const { cell } = await runV1("not-rolled-forward");
      const before = logged("unloadable-pointer-rolled-forward", "warn");

      await repointTo(cell, unloadableIdentity);

      expect(getPatternIdentityRef(cell)?.identity).toBe(unloadableIdentity);
      expect(logged("unloadable-pointer-rolled-forward", "warn")).toBe(before);
    });

    it("writes nothing, and logs no roll-forward, when the pointer moves again before the rollback runs", async () => {
      rt = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
      const { cell, v1Ref } = await runV1("moved-before-rollback");
      const editWithRetry = rt.editWithRetry.bind(rt);
      let moved = false;
      rt.editWithRetry = async <T = void>(
        fn: (tx: IExtendedStorageTransaction) => T,
        maxRetries?: number,
        options?: Parameters<Runtime["editWithRetry"]>[2],
      ) => {
        if (!moved) {
          moved = true;
          const tx = rt.edit();
          cell.withTx(tx).setMetaRaw(
            "patternIdentity",
            v1Ref,
            rawMetaWriteAuthorization,
          );
          expect((await tx.commit().settled).error).toBeUndefined();
        }
        return await editWithRetry(fn, maxRetries, options);
      };
      const before = logged("unloadable-pointer-rolled-forward", "warn");

      await repointTo(cell, unloadableIdentity);

      expect(moved).toBe(true);
      expect(getPatternIdentityRef(cell)).toEqual(v1Ref);
      expect(logged("unloadable-pointer-rolled-forward", "warn")).toBe(before);
      expect(cell.get().marker).toBe("v1");
    });

    it("logs `unloadable-pointer-roll-forward-failed`, and leaves the pointer, when the rollback rejects", async () => {
      rt = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
      const { cell } = await runV1("rollback-rejects");
      rt.editWithRetry = () =>
        Promise.reject(new Error("The rollback cannot commit"));
      const failed = logged("unloadable-pointer-roll-forward-failed", "warn");
      const rolled = logged("unloadable-pointer-rolled-forward", "warn");

      await repointTo(cell, unloadableIdentity);

      expect(logged("unloadable-pointer-roll-forward-failed", "warn")).toBe(
        failed + 1,
      );
      expect(logged("unloadable-pointer-rolled-forward", "warn")).toBe(rolled);
      expect(getPatternIdentityRef(cell)?.identity).toBe(unloadableIdentity);
      expect(cell.get().marker).toBe("v1");
    });

    it("logs `pattern-load-error`, and leaves the pointer, when the load throws", async () => {
      // A thrown load may be transient, so it is no verdict that the pointer
      // is dead, and nothing rolls it back.

      rt = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
      const { cell } = await runV1("load-throws");
      const manager = rt.patternManager;
      const load = manager.loadPatternByIdentity.bind(manager);
      manager.loadPatternByIdentity = (identity, symbol, inSpace, options) =>
        identity === unloadableIdentity
          ? Promise.reject(new Error("The store is unreachable"))
          : load(identity, symbol, inSpace, options);
      const errors = logged("pattern-load-error", "error");
      const rolled = logged("unloadable-pointer-rolled-forward", "warn");

      await repointTo(cell, unloadableIdentity);

      expect(logged("pattern-load-error", "error")).toBe(errors + 1);
      expect(logged("unloadable-pointer-rolled-forward", "warn")).toBe(rolled);
      expect(getPatternIdentityRef(cell)?.identity).toBe(unloadableIdentity);
      expect(cell.get().marker).toBe("v1");
    });
  });
});
