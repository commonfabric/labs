import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

/** One roster entry: a profile that loads, or one whose load fails. */
type Entry = "readable" | "failing";

type Roster = {
  entries: Entry[];
  defaultIndex?: number;
  mruIndices?: number[];
};

/**
 * Builds a home roster with each profile in its own space. A failing profile
 * is never written and its space's provider returns a load error for it.
 */
async function makeRoster(label: string, roster: Roster) {
  const signer = await Identity.fromPassphrase(`profile unavailable ${label}`);
  const manager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: manager,
  });
  const restores: (() => void)[] = [];
  const profiles: Cell<unknown>[] = [];
  for (const [index, entry] of roster.entries.entries()) {
    const space = (await Identity.fromPassphrase(
      `profile unavailable ${label} space ${index}`,
    )).did();
    if (entry === "readable") {
      const tx = runtime.edit();
      const cell = runtime.getCell(space, "profile", undefined, tx);
      cell.set(profileValue(`Profile ${index}`));
      expect((await tx.commit()).error).toBeUndefined();
      profiles.push(cell);
      continue;
    }
    const cell = runtime.getCell(space, "profile");
    const provider = manager.open(space);
    const originalSync = provider.sync.bind(provider);
    const failingId = cell.getAsNormalizedFullLink().id;
    provider.sync = (id, ...options) =>
      id === failingId
        ? Promise.resolve({ error: new Error("Profile load failed") })
        : originalSync(id, ...options);
    restores.push(() => provider.sync = originalSync);
    profiles.push(cell);
  }

  const home = runtime.edit();
  const defaultPattern: Record<string, unknown> = { profiles };
  if (roster.defaultIndex !== undefined) {
    defaultPattern.defaultProfile = profiles[roster.defaultIndex];
  }
  if (roster.mruIndices !== undefined) {
    defaultPattern.mru = roster.mruIndices.map((index) => profiles[index]);
  }
  runtime.getHomeSpaceCell(home).key("defaultPattern").set(defaultPattern);
  expect((await home.commit()).error).toBeUndefined();

  const cancels: (() => void)[] = [];
  return {
    runtime,
    profiles,
    async wish(query: string, scope?: ("~" | "." | "profile")[]) {
      const { commonfabric } = createTrustedBuilder(runtime);
      const pattern = commonfabric.pattern(() => ({
        found: commonfabric.wish({
          query,
          headless: true,
          ...(scope ? { scope } : {}),
        }),
      }));
      const run = runtime.edit();
      const result = runtime.run(
        run,
        pattern,
        {},
        runtime.getCell(signer.did(), `consumer ${query}`, undefined, run),
      );
      expect((await run.commit()).error).toBeUndefined();
      const found = result.key("found").resolveAsCell();
      cancels.push(found.sink(() => {}));
      await result.pull();
      await manager.crossSpaceSettled();
      await settle(runtime);
      return found;
    },
    async dispose() {
      cancels.forEach((cancel) => cancel());
      restores.forEach((restore) => restore());
      await runtime.dispose({ closeStorage: false });
      await manager.close();
    },
  };
}

function profileValue(name: string) {
  return {
    name,
    initialNameApplied: name,
    avatar: "",
    bio: "",
    elements: [],
  };
}

/** Moves logical time past the wish debounce and drains the scheduler. */
async function settle(runtime: Runtime): Promise<void> {
  await clock.tick(100);
  await runtime.idle();
}

const nameOf = (found: Cell<unknown>) =>
  found.key("result").asSchema<{ name: string }>({
    type: "object",
    properties: { name: { type: "string" } },
  }).key("name").get();

const errorOf = (found: Cell<unknown>) =>
  found.key("error").asSchema({ type: "string" }).get();

describe("wish-profile-unavailable", () => {
  const selects: [string, Roster, string][] = [
    ["a failed non-default", {
      entries: ["readable", "failing"],
      defaultIndex: 0,
    }, "Profile 0"],
    ["a failed profile behind the MRU head", {
      entries: ["failing", "readable"],
      mruIndices: [1],
    }, "Profile 1"],
    ["a failed profile later in list order", {
      entries: ["readable", "failing"],
    }, "Profile 0"],
  ];
  for (const [label, roster, selected] of selects) {
    it(`skips ${label} and keeps the selected profile`, async () => {
      const fixture = await makeRoster(label, roster);
      try {
        const found = await fixture.wish("#profile");
        expect(errorOf(found)).toBeUndefined();
        expect(nameOf(found)).toBe(selected);
        expect(found.key("candidates").get()).toHaveLength(1);
      } finally {
        await fixture.dispose();
      }
    });
  }

  const reports: [string, Roster][] = [
    ["the failed default", {
      entries: ["failing", "readable"],
      defaultIndex: 0,
    }],
    ["the failed MRU head", {
      entries: ["readable", "failing"],
      mruIndices: [1],
    }],
    ["the failed first entry", { entries: ["failing", "readable"] }],
  ];
  for (const [label, roster] of reports) {
    it(`reports ${label} rather than switching profile`, async () => {
      const fixture = await makeRoster(label, roster);
      try {
        const found = await fixture.wish("#profile");
        expect(errorOf(found)).toContain("Could not load document");
        expect(found.key("result").get()).toBeUndefined();
      } finally {
        await fixture.dispose();
      }
    });
  }

  it("reports a lone failed profile instead of offering creation", async () => {
    const fixture = await makeRoster("lone", { entries: ["failing"] });
    try {
      const found = await fixture.wish("#profile");
      expect(errorOf(found)).toContain("Could not load document");
      expect(errorOf(found)).not.toContain("No profile exists yet");
    } finally {
      await fixture.dispose();
    }
  });

  it("resolves profile fields past a failed non-default", async () => {
    const fixture = await makeRoster("fields", {
      entries: ["readable", "failing"],
      defaultIndex: 0,
    });
    try {
      const found = await fixture.wish("#profileName");
      expect(errorOf(found)).toBeUndefined();
      expect(found.key("result").get()).toBe("Profile 0");
    } finally {
      await fixture.dispose();
    }
  });

  it("does not report a skipped profile as a profile-search failure", async () => {
    const fixture = await makeRoster("search", {
      entries: ["readable", "failing"],
      defaultIndex: 0,
    });
    try {
      const found = await fixture.wish("#resources", ["profile"]);
      expect(errorOf(found)).toContain(
        'No profile found matching "#resources"',
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("restores a failed profile to the live roster when it arrives", async () => {
    const fixture = await makeRoster("recovery", {
      entries: ["readable", "failing"],
      defaultIndex: 0,
    });
    try {
      const found = await fixture.wish("#profile");
      expect(found.key("candidates").get()).toHaveLength(1);

      const arrive = fixture.runtime.edit();
      fixture.profiles[1].withTx(arrive).set(profileValue("Profile 1"));
      expect((await arrive.commit()).error).toBeUndefined();
      await settle(fixture.runtime);
      expect(found.key("candidates").get()).toHaveLength(2);
      expect(nameOf(found)).toBe("Profile 0");
    } finally {
      await fixture.dispose();
    }
  });
});
