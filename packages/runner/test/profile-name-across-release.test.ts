/**
 * Follows a profile from one release of `profile-home.tsx` to the next and
 * reads its saved name on the other side. The name is stored through the
 * profile's own protected setter, so what the release must keep is a cell a
 * handler wrote — not a default the pattern re-derives.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import {
  getPatternIdentityRef,
  resolveEntryIdentity,
  Runtime,
  systemPatternSource,
} from "../src/index.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const origin = systemPatternSource("system/profile-home.tsx");
const route = "/api/patterns/system/profile-home.tsx";
const current = Deno.readTextFileSync(
  new URL("../../patterns/system/profile-home.tsx", import.meta.url),
);
// The release the profile was made from: one byte apart, which is enough to
// give every cell the pattern derives a new identity.
const previous = `${current}\n// a release behind\n`;

/** A `setName` event as the profile's edit surface sends it. */
function setNameEvent(name: string): { name: string } {
  const event = {
    name,
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

describe("a profile's saved name across a release", () => {
  it("is the name on the other side, and the creation name only until one is saved", async () => {
    const signer = await Identity.fromPassphrase("profile name across release");
    const manager = StorageManager.emulate({ as: signer });
    const previousIdentity = await resolveEntryIdentity(
      route,
      () => Promise.resolve(previous),
    );
    const currentIdentity = await resolveEntryIdentity(
      route,
      () => Promise.resolve(current),
    );
    let served = { contents: previous, identity: previousIdentity };
    const runtime = new Runtime({
      apiUrl: new URL("https://profile.test"),
      storageManager: manager,
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
      const tx = runtime.edit();
      const pattern = await runtime.patternManager.compilePattern({
        main: route,
        files: [{ name: route, contents: previous }],
      }, { space: signer.did(), tx });
      const profile = runtime.getCell(signer.did(), "named-profile");
      runtime.runner.run(tx, pattern, { initialName: "Ada" }, profile, {
        sourceOrigin: origin,
      });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await profile.pull();
      const shown = profile.key("initialNameApplied").asSchema<string>({
        type: "string",
      });
      await shown.pull();
      expect(shown.get()).toBe("Ada");

      const edit = runtime.edit();
      profile.withTx(edit).key("setName").send(setNameEvent("Saved name"));
      runtime.prepareTxForCommit(edit);
      expect((await edit.commit()).error).toBeUndefined();
      await profile.pull();
      await runtime.idle();
      await profile.pull();
      const name = profile.key("name").asSchema<string>({ type: "string" });
      await name.pull();
      expect(name.get()).toBe("Saved name");
      expect(getPatternIdentityRef(profile)?.identity).toBe(previousIdentity);

      served = { contents: current, identity: currentIdentity };
      expect(await runtime.sourceReconciler.reconcile(profile)).toBe("updated");
      await runtime.runner.idlePointerMaintenance();
      // The swap's outputs recompute on the scheduler; the assertions read
      // after it has settled, not in a race with it.
      await runtime.idle();
      await profile.pull();
      expect(getPatternIdentityRef(profile)?.identity).toBe(currentIdentity);
      const after = profile.key("name").asSchema<string>({ type: "string" });
      await after.pull();
      expect(after.get()).toBe("Saved name");
      await shown.pull();
      expect(shown.get()).toBe("Saved name");
    } finally {
      await runtime.sourceReconciler.idle();
      await runtime.patternManager.flushCompileCacheWrites();
      await runtime.dispose();
    }
  });
});
