/**
 * Exercises the follow command's confirmation against a real controller and
 * the deployed profile pattern, starting from the legacy inbox contract.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  getPatternIdentityRef,
  getPatternSource,
  resolveEntryIdentity,
  Runtime,
} from "@commonfabric/runner";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "@commonfabric/piece/ops";
import { followPieceSource } from "../lib/piece.ts";

// Frozen source from the parent of #7730 (a909b4660^), so the test keeps
// the actual stored-name and inbox contracts when the live pattern changes.
const LEGACY_PROFILE = Deno.readTextFileSync(
  new URL(
    "./fixtures/profile-home-legacy-inbox.tsx.txt",
    import.meta.url,
  ),
);

const path = "/api/patterns/system/profile-home.tsx";
const source = Deno.readTextFileSync(
  new URL("../../patterns/system/profile-home.tsx", import.meta.url),
);

describe("profile-follow-migration", () => {
  it("requires explicit acceptance and preserves the saved name when attaching the current profile source", async () => {
    const signer = await Identity.fromPassphrase("profile follow migration");
    const space = signer.did();
    let servedSource = source;
    let servedIdentity = await resolveEntryIdentity(
      path,
      () => Promise.resolve(servedSource),
    );
    const manager = EmulatedStorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://profile.test"),
      storageManager: manager,
      fetch: (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        return Promise.resolve(
          new Response(
            url.pathname === path
              ? (url.searchParams.has("identity")
                ? servedIdentity
                : servedSource)
              : "not found",
            {
              status: url.pathname === path ? 200 : 404,
            },
          ),
        );
      },
    });
    const pieces = new PiecesController({ as: signer, space }, runtime, {
      deferSpaceCellSync: true,
    });
    try {
      const tx = runtime.edit();
      const pattern = await runtime.patternManager.compilePattern({
        main: path,
        files: [{ name: path, contents: LEGACY_PROFILE }],
      }, { space, tx });
      const cell = runtime.getCell<Record<string, unknown>>(
        space,
        "legacy profile",
        undefined,
        tx,
      );
      runtime.run(tx, pattern, { initialName: "Setup name" }, cell);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      const profile = cell.withTx();
      await profile.pull();
      profile.key("setName").send({ name: "Saved name" });
      await runtime.idle();
      expect(profile.key("name").get()).toBe("Saved name");
      await runtime.patternManager.flushCompileCacheWrites();
      const config = {
        apiUrl: "https://profile.test",
        identity: "/unused.key",
        space,
        piece: profile.getAsNormalizedFullLink().id,
      };
      const deps = { loadPieces: () => Promise.resolve(pieces) };
      const before = getPatternIdentityRef(profile);
      const refused = await followPieceSource(
        config,
        "system:system/profile-home.tsx",
        {},
        deps,
      );
      expect(refused.status).toBe("incompatible");
      if (refused.status === "incompatible") {
        expect(refused.message).toContain("inbox.space");
      }
      expect(getPatternSource(profile)).toBeUndefined();
      expect(getPatternIdentityRef(profile)).toEqual(before);
      const applied = await followPieceSource(
        config,
        "system:system/profile-home.tsx",
        {
          dangerouslyAllowIncompatibleSchema: true,
        },
        deps,
      );
      expect(applied.status).toBe("applied");
      expect(getPatternSource(profile)).toBe("system:system/profile-home.tsx");
      expect(getPatternIdentityRef(profile)).not.toEqual(before);
      await profile.pull();
      expect(profile.key("name").get()).toBe("Saved name");
      const inboxTx = runtime.edit();
      const inbox = runtime.getCell(space, "share inbox", undefined, inboxTx);
      const inboxPattern = await runtime.patternManager.compilePattern({
        main: "/inbox.tsx",
        files: [{
          name: "/inbox.tsx",
          contents: `
import { handler, pattern } from 'commonfabric';
const receive = handler<unknown, Record<string, never>>(() => {});
export default pattern(() => ({ receive: receive({}) }));
`,
        }],
      }, { space, tx: inboxTx });
      runtime.run(inboxTx, inboxPattern, {}, inbox);
      runtime.prepareTxForCommit(inboxTx);
      expect((await inboxTx.commit()).error).toBeUndefined();
      await inbox.withTx().pull();
      profile.key("setInbox").send({ inbox: inbox.withTx() });
      await runtime.idle();
      const storedInbox = () =>
        profile.key("inbox").key("piece").resolveAsCell()
          .getAsNormalizedFullLink();
      expect(storedInbox().id).toBe(inbox.getAsNormalizedFullLink().id);
      expect(storedInbox().space).toBe(space);
      const attached = getPatternIdentityRef(profile);
      servedSource = source + "\n// Next deployment.\n";
      servedIdentity = await resolveEntryIdentity(
        path,
        () => Promise.resolve(servedSource),
      );
      expect(await runtime.sourceReconciler.reconcile(profile)).toBe("updated");
      await profile.pull();
      expect(getPatternIdentityRef(profile)).not.toEqual(attached);
      expect(getPatternSource(profile)).toBe("system:system/profile-home.tsx");
      expect(profile.key("name").get()).toBe("Saved name");
      expect(storedInbox().id).toBe(inbox.getAsNormalizedFullLink().id);
    } finally {
      await runtime.dispose({ closeStorage: false });
      await manager.close();
    }
  });
});
