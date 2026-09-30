/**
 * Drives a release of `profile-home.tsx` through the reconciler onto a
 * profile that follows the `system:` origin and holds an owner-protected
 * field its own handler wrote. A release re-mints every handler identity in
 * the file, so the stored field's stamp names a handler the release no longer
 * has; without writer inheritance the successor cannot write it and the
 * update cannot commit.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import {
  getPatternIdentityRef,
  getPieceSourceRevisions,
  resolveEntryIdentity,
  Runtime,
  type RuntimeProgram,
  systemPatternSource,
} from "../src/index.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const origin = systemPatternSource("system/profile-home.tsx");
const route = "/api/patterns/system/profile-home.tsx";
const current = Deno.readTextFileSync(
  new URL("../../patterns/system/profile-home.tsx", import.meta.url),
);
// The release the profile was made from: the same file, one byte apart,
// which is enough to re-mint every handler identity in it.
const previous = `${current}\n// a release behind\n`;

/**
 * A `setAvatar` event as the profile's own edit surface sends it: the field
 * is owner-protected behind that surface's UI contract, so the write needs
 * the renderer-trusted mark and the surface's provenance.
 */
function setAvatarEvent(avatar: string): { avatar: string } {
  const event = {
    avatar,
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "ProfileHome",
        eventIntegrity: ["ProfileHome"],
        uiContractDataset: { uiAction: "EditProfile" },
      },
    },
  };
  markRendererTrustedEvent(event);
  return event;
}

async function identityOf(contents: string): Promise<string> {
  return await resolveEntryIdentity(route, () => Promise.resolve(contents));
}

describe("a system release reaching a followed profile", () => {
  it("adopts the release, keeps the field the predecessor's handler wrote, and lets the successor write it", async () => {
    const signer = await Identity.fromPassphrase("reconciler authority");
    const manager = StorageManager.emulate({ as: signer });
    const previousIdentity = await identityOf(previous);
    const currentIdentity = await identityOf(current);
    let served = { contents: previous, identity: previousIdentity };
    const runtime = new Runtime({
      apiUrl: new URL("https://profile.test"),
      storageManager: manager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
      fetch: (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname !== route) {
          return Promise.resolve(new Response("not found", { status: 404 }));
        }
        return Promise.resolve(
          new Response(
            url.searchParams.has("identity")
              ? served.identity
              : served.contents,
          ),
        );
      },
    });
    try {
      const program: RuntimeProgram = {
        main: route,
        files: [{ name: route, contents: previous }],
      };
      const tx = runtime.edit();
      const pattern = await runtime.patternManager.compilePattern(program, {
        space: signer.did(),
        tx,
      });
      const profile = runtime.getCell(signer.did(), "followed-profile");
      runtime.runner.run(tx, pattern, { initialName: "Ada" }, profile, {
        sourceOrigin: origin,
      });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await profile.pull();

      const edit = runtime.edit();
      profile.withTx(edit).key("setAvatar").send(setAvatarEvent("🦊"));
      runtime.prepareTxForCommit(edit);
      expect((await edit.commit()).error).toBeUndefined();
      await profile.pull();
      await runtime.idle();
      await profile.pull();
      const avatar = profile.key("avatar").asSchema<string>({ type: "string" });
      await avatar.pull();
      expect(avatar.get()).toBe("🦊");
      expect(getPatternIdentityRef(profile)?.identity).toBe(previousIdentity);

      served = { contents: current, identity: currentIdentity };
      expect(await runtime.sourceReconciler.reconcile(profile)).toBe("updated");
      await runtime.runner.idlePointerMaintenance();
      await profile.pull();
      await avatar.pull();
      expect(avatar.get()).toBe("🦊");
      expect(getPatternIdentityRef(profile)?.identity).toBe(currentIdentity);
      expect(getPieceSourceRevisions(profile).map((entry) => entry.operation))
        .toEqual(["create", "origin-update"]);

      const again = runtime.edit();
      profile.withTx(again).key("setAvatar").send(setAvatarEvent("🐙"));
      runtime.prepareTxForCommit(again);
      expect((await again.commit()).error).toBeUndefined();
      await profile.pull();
      await runtime.idle();
      await profile.pull();
      await avatar.pull();
      expect(avatar.get()).toBe("🐙");
    } finally {
      await runtime.sourceReconciler.idle();
      await runtime.patternManager.flushCompileCacheWrites();
      await runtime.dispose();
    }
  });
});
