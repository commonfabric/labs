import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { defer } from "@commonfabric/utils/defer";

import { NAME } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

/** Discovery collections with reference-based candidate lists. */
type DiscoveryMode =
  | "favorites"
  | "legacy"
  | "profile"
  | "current-mentionables"
  | "did-mentionables";

/** Builds a collection whose first match has no backing document. */
async function makeFixture(
  mode: DiscoveryMode,
  includePresent = true,
  includeAbsent = false,
) {
  const signer = await Identity.fromPassphrase(`unavailable candidate ${mode}`);
  const space = signer.did();
  const manager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: manager,
  });
  const discoverySpace = mode === "did-mentionables"
    ? (await Identity.fromPassphrase("discovery mentionables")).did()
    : space;
  const unavailable = runtime.getCell(discoverySpace, "unavailable candidate");
  const present = runtime.getCell(discoverySpace, "present candidate");
  const setup = runtime.edit();
  present.withTx(setup).set({
    version: 1,
    name: "Present provider",
    [NAME]: "resources",
  });
  expect((await setup.commit()).error).toBeUndefined();

  const cells = includePresent ? [unavailable, present] : [unavailable];
  if (includeAbsent) {
    cells.push(runtime.getCell(discoverySpace, "absent candidate"));
  }
  const home = runtime.edit();
  if (mode === "profile") {
    const profileSpace = (await Identity.fromPassphrase("discovery profile"))
      .did();
    const profileTx = runtime.edit();
    const profile = runtime.getCell(
      profileSpace,
      "profile",
      undefined,
      profileTx,
    );
    profile.set({
      name: "Discovery profile",
      initialNameApplied: "Discovery profile",
      avatar: "",
      elements: cells.map((cell) => ({ cell, tag: "#resources" })),
    });
    expect((await profileTx.commit()).error).toBeUndefined();
    runtime.getHomeSpaceCell(home).key("defaultPattern").set({
      profiles: [profile],
    });
  } else if (
    mode === "current-mentionables" || mode === "did-mentionables"
  ) {
    runtime.getCell(discoverySpace, discoverySpace, undefined, home)
      .key("defaultPattern").set({
        backlinksIndex: { mentionable: cells },
      });
  } else {
    runtime.getHomeSpaceCell(home).key("defaultPattern").set({
      favorites: cells.map((cell) => ({ cell, tags: ["resources"] })),
    });
  }
  expect((await home.commit()).error).toBeUndefined();

  const cancels: (() => void)[] = [];
  return {
    runtime,
    manager,
    unavailable,
    async launch() {
      const { commonfabric } = createTrustedBuilder(runtime);
      const pattern = commonfabric.pattern(() => ({
        found: commonfabric.wish({
          query: mode === "legacy" ? "#favorites/res" : "#resources",
          scope: mode === "profile"
            ? ["profile"]
            : mode === "current-mentionables"
            ? ["."]
            : mode === "did-mentionables"
            ? [discoverySpace]
            : ["~"],
          headless: true,
        }),
      }));
      const run = runtime.edit();
      const result = runtime.run(
        run,
        pattern,
        {},
        runtime.getCell(space, "discovery consumer", undefined, run),
      );
      expect((await run.commit()).error).toBeUndefined();
      const found = result.key("found").resolveAsCell();
      cancels.push(found.sink(() => {}));
      const selected = found.key("result").asSchema<{ name: string }>({
        type: "object",
        properties: { name: { type: "string" } },
      });
      return { found, selected, pulling: result.pull() };
    },
    async dispose() {
      cancels.forEach((cancel) => cancel());
      await runtime.dispose({ closeStorage: false });
      await manager.close();
    },
  };
}

describe("wish-unavailable-candidate", () => {
  for (
    const mode of [
      "legacy",
      "profile",
      "current-mentionables",
      "did-mentionables",
    ] as const
  ) {
    it(`selects a present ${mode} match after a confirmed missing match`, async () => {
      const fixture = await makeFixture(mode);
      try {
        const { found, selected, pulling } = await fixture.launch();
        await pulling;
        await fixture.manager.crossSpaceSettled();
        await fixture.runtime.idle();
        expect(found.key("candidates").get()).toHaveLength(1);
        expect(selected.key("name").get()).toBe("Present provider");
      } finally {
        await fixture.dispose();
      }
    });

    it(`reports no match when every ${mode} candidate is confirmed missing`, async () => {
      const fixture = await makeFixture(mode, false);
      try {
        const { found, pulling } = await fixture.launch();
        await pulling;
        await fixture.manager.crossSpaceSettled();
        await fixture.runtime.idle();
        expect(found.key("error").asSchema({ type: "string" }).get())
          .toContain("No ");
        expect(found.key("candidates").get()).toHaveLength(0);
      } finally {
        await fixture.dispose();
      }
    });
  }

  for (
    const mode of [
      "favorites",
      "legacy",
      "profile",
      "current-mentionables",
      "did-mentionables",
    ] as const
  ) {
    for (const includePresent of [true, false]) {
      it(`waits for a ${mode} candidate's load, then ${includePresent ? "selects a readable match and recovers the failed match live" : "reports the load failure when no readable match remains"}`, async () => {
        const fixture = await makeFixture(mode, includePresent);
        const requested = defer<void>();
        const released = defer<void>();
        const provider = fixture.manager.open(fixture.unavailable.space);
        const originalSync = provider.sync.bind(provider);
        const unavailableId = fixture.unavailable.getAsNormalizedFullLink().id;
        provider.sync = async (id, ...options) => {
          if (id === unavailableId) {
            requested.resolve();
            await released.promise;
            return { error: new Error("Candidate load failed") };
          }
          return originalSync(id, ...options);
        };
        try {
          const { found, selected, pulling } = await fixture.launch();
          await requested.promise;
          expect(found.key("error").get()).toBeUndefined();
          expect(found.key("candidates").get()).toBeUndefined();
          released.resolve();
          await pulling;
          await fixture.manager.crossSpaceSettled();
          await waitForCellValue(
            fixture.runtime,
            found.key("candidates"),
            (value) => value !== undefined,
          );
          if (includePresent) {
            expect(found.key("candidates").get()).toHaveLength(1);
            expect(selected.key("name").get()).toBe("Present provider");
            expect(found.key("error").get()).toBeUndefined();

            const restore = fixture.runtime.edit();
            fixture.unavailable.withTx(restore).set({
              version: 1,
              name: "Restored provider",
              [NAME]: "resources",
            });
            expect((await restore.commit()).error).toBeUndefined();
            await waitForCellValue<string>(
              fixture.runtime,
              selected.key("name"),
              (value) => value === "Restored provider",
            );
            expect(selected.key("name").get()).toBe("Restored provider");
            expect(found.key("candidates").get()).toHaveLength(
              mode === "legacy" ? 1 : 2,
            );
          } else {
            expect(found.key("error").asSchema({ type: "string" }).get())
              .toContain("Could not load document");
            expect(found.key("candidates").get()).toHaveLength(0);
          }
        } finally {
          released.resolve();
          provider.sync = originalSync;
          await fixture.dispose();
        }
      });
    }

    it(`reports a load error for absent and failed ${mode} candidates without a readable match`, async () => {
      const fixture = await makeFixture(mode, false, true);
      const provider = fixture.manager.open(fixture.unavailable.space);
      const originalSync = provider.sync.bind(provider);
      const unavailableId = fixture.unavailable.getAsNormalizedFullLink().id;
      provider.sync = (id, ...options) =>
        id === unavailableId
          ? Promise.resolve({ error: new Error("Candidate load failed") })
          : originalSync(id, ...options);
      try {
        const { found, pulling } = await fixture.launch();
        await pulling;
        await fixture.manager.crossSpaceSettled();
        await fixture.runtime.idle();
        expect(found.key("error").asSchema({ type: "string" }).get())
          .toContain("Could not load document");
        expect(found.key("candidates").get()).toHaveLength(0);
      } finally {
        provider.sync = originalSync;
        await fixture.dispose();
      }
    });
  }
});
