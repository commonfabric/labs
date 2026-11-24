/**
 * `Runner.settlePointerCommits()`, which `Runtime.dispose()` awaits before it
 * closes storage: it settles the commit that rolls an unloadable pattern
 * pointer back to the running pattern.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { getPatternIdentityRef, resolveEntryIdentity } from "../src/index.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("runner-cov-b pointer commits");
const space = signer.did();

const source = (marker: string) =>
  [
    "import { pattern } from 'commonfabric';",
    "export default pattern<Record<string, never>, { marker: string }>(() => {",
    `  return { marker: '${marker}' };`,
    "});",
    "",
  ].join("\n");

const V1: RuntimeProgram = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: source("v1") }],
};

// The content identity of a source no store holds.
const unloadableIdentity = await resolveEntryIdentity(
  "/main.tsx",
  (name) =>
    name === "/main.tsx"
      ? Promise.resolve(source("nowhere"))
      : Promise.reject(new Error(`not found: ${name}`)),
);

describe("Runner", () => {
  describe("settlePointerCommits()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let rt: Runtime;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      rt = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    });

    afterEach(async () => {
      await rt.runner.idlePointerMaintenance();
      await rt.dispose();
      await storageManager.close();
    });

    it("returns once the roll-forward of an unloadable pointer has settled", async () => {
      const tx = rt.edit();
      const v1 = await rt.patternManager.compilePattern(V1, { space, tx });
      const v1Ref = rt.patternManager.getArtifactEntryRef(v1)!;
      const cell = rt.getCell<{ marker: string }>(
        space,
        "piece",
        undefined,
        tx,
      );
      const running = rt.run(tx, v1, {}, cell);
      expect((await tx.commit().settled).error).toBeUndefined();
      await running.pull();

      // Nothing is in flight yet.
      await rt.runner.settlePointerCommits();

      // The roll-forward is the `editWithRetry()` whose callback writes the
      // running identity back; its outcome is held until released.
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const editWithRetry = rt.editWithRetry.bind(rt);
      rt.editWithRetry = ((fn, ...rest) => {
        let rollsForward = false;
        const outcome = editWithRetry((attempt) => {
          const result = fn(attempt);
          const pointer = cell.withTx(attempt).getMetaRaw(
            "patternIdentity",
          ) as { identity?: string } | undefined;
          rollsForward ||= pointer?.identity === v1Ref.identity;
          return result;
        }, ...rest);
        if (!rollsForward) return outcome;
        entered.resolve();
        return release.promise.then(() => outcome);
      }) as typeof rt.editWithRetry;

      const repoint = rt.edit();
      cell.withTx(repoint).setMetaRaw("patternIdentity", {
        identity: unloadableIdentity,
        symbol: "default",
      }, rawMetaWriteAuthorization);
      expect((await repoint.commit().settled).error).toBeUndefined();
      await entered.promise;

      let settled = false;
      const settling = rt.runner.settlePointerCommits().then(() => {
        settled = true;
      });
      await rt.idle();
      expect(settled).toBe(false);

      release.resolve();
      await settling;
      rt.editWithRetry = editWithRetry;
      expect(getPatternIdentityRef(cell)).toEqual(v1Ref);
    });
  });
});
