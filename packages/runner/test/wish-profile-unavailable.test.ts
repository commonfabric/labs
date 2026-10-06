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

  /**
   * What `defaultProfile` and `mru` link to: the roster's own document, or a
   * distinct document in the same profile space (the picker stores the
   * profile's result cell while the roster stores its pattern cell).
   */
  references?: "roster" | "distinct";
};

/**
 * Builds a home roster with each profile in its own space. A failing profile's
 * space is unavailable: nothing in it is written, and every load fails.
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
  const references: Cell<unknown>[] = [];
  const distinct = roster.references === "distinct";
  for (const [index, entry] of roster.entries.entries()) {
    const space = (await Identity.fromPassphrase(
      `profile unavailable ${label} space ${index}`,
    )).did();
    if (entry === "readable") {
      const tx = runtime.edit();
      const cell = runtime.getCell(space, "profile", undefined, tx);
      cell.set(profileValue(`Profile ${index}`));
      const reference = distinct
        ? runtime.getCell(space, "profile result", undefined, tx)
        : cell;
      if (distinct) reference.set(profileValue(`Profile ${index}`));
      expect((await tx.commit().settled).error).toBeUndefined();
      profiles.push(cell);
      references.push(reference);
      continue;
    }
    const provider = manager.open(space);
    const originalSync = provider.sync.bind(provider);
    provider.sync = () =>
      Promise.resolve({ error: new Error("Profile space unavailable") });
    restores.push(() => provider.sync = originalSync);
    const cell = runtime.getCell(space, "profile");
    profiles.push(cell);
    references.push(distinct ? runtime.getCell(space, "profile result") : cell);
  }

  const home = runtime.edit();
  const defaultPattern: Record<string, unknown> = { profiles };
  if (roster.defaultIndex !== undefined) {
    // Home keeps its default under `profile` in a slot (see wish.ts's
    // homeHasDefaultProfileSlot).
    defaultPattern.defaultProfile = {
      profile: references[roster.defaultIndex],
    };
  }
  if (roster.mruIndices !== undefined) {
    defaultPattern.mru = roster.mruIndices.map((index) => references[index]);
  }
  runtime.getHomeSpaceCell(home).key("defaultPattern").set(defaultPattern);
  expect((await home.commit().settled).error).toBeUndefined();

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
      expect((await run.commit().settled).error).toBeUndefined();
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
        expect(found.key("result").get()).toMatchObject({
          reason: "error",
          errorKind: "general",
        });
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

  // The MRU names a different document in the failed profile's space, so
  // resolving it starts a load of its own that fails with the space.
  const distinctReferences: Roster = {
    entries: ["readable", "failing"],
    defaultIndex: 0,
    mruIndices: [1],
    references: "distinct",
  };
  for (const query of ["#profile", "#profileName"]) {
    it(`resolves ${query} when a skipped profile's MRU reference is a separate document`, async () => {
      const fixture = await makeRoster(`distinct ${query}`, distinctReferences);
      try {
        const found = await fixture.wish(query);
        expect(errorOf(found)).toBeUndefined();
        const result = found.key("result").get();
        expect(typeof result === "string" ? result : nameOf(found))
          .toBe("Profile 0");
      } finally {
        await fixture.dispose();
      }
    });
  }

  it("keeps a profile search past a skipped profile's separate MRU reference", async () => {
    const fixture = await makeRoster("distinct search", distinctReferences);
    try {
      const found = await fixture.wish("#resources", ["profile"]);
      expect(errorOf(found)).toContain(
        'No profile found matching "#resources"',
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("reports a failed MRU head named by a separate document", async () => {
    const fixture = await makeRoster("distinct head", {
      entries: ["readable", "failing"],
      mruIndices: [1],
      references: "distinct",
    });
    try {
      const found = await fixture.wish("#profile");
      expect(errorOf(found)).toContain("Could not load document");
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
      expect((await arrive.commit().settled).error).toBeUndefined();
      await settle(fixture.runtime);
      expect(found.key("candidates").get()).toHaveLength(2);
      expect(nameOf(found)).toBe("Profile 0");
    } finally {
      await fixture.dispose();
    }
  });
});
