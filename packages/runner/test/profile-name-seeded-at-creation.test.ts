/**
 * A profile created through the trusted create path holds its creation name
 * in the stored `name` cell from the start. `profile-home.tsx` initializes
 * `name` statically (so the cell keeps its identity across releases), and the
 * create handler in `profile-create.tsx` seeds it through `setName`, the
 * owner-protected writer. Every `#profile` reader — Topics, `cf profile
 * show`, the loom lobby — reads `name` and runs nothing, so the seed has to be
 * in storage before anything opens the profile.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("profile name seeded at creation");
const home = signer.did();

const sysDir = fromFileUrl(new URL("../../patterns/system/", import.meta.url));
const read = (n: string) => Deno.readTextFileSync(sysDir + n);

// A host that owns the home `profiles` list and embeds the REAL create
// pattern (the shape of profile-space-identity-collision-support.ts).
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import ProfileCreate from './profile-create.tsx';",
        "import { pattern, Writable } from 'commonfabric';",
        "import type { ProfileHomeOutput } from './profile-home.tsx';",
        "",
        "export default pattern(() => {",
        "  const profiles = new Writable<ProfileHomeOutput[]>([]).for('profiles');",
        "  const created = ProfileCreate({ profiles });",
        "  return { profiles, createProfile: created.createProfile };",
        "});",
      ].join("\n"),
    },
    { name: "/profile-create.tsx", contents: read("profile-create.tsx") },
    { name: "/profile-home.tsx", contents: read("profile-home.tsx") },
  ],
};

// A host that wires the create surface's two steps itself. Besides the
// `profiles` list the create appends to, the seed step is handed one the
// append never reaches: the list as a seed step finds it when it runs before
// the create's append is visible to it. The seed step is returned too, for a
// test to send to directly.
const UNAPPENDED_LIST_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { seedProfileName, submitProfileCreation } from './profile-create.tsx';",
        "import { pattern, Writable } from 'commonfabric';",
        "import type { ProfileHomeOutput } from './profile-home.tsx';",
        "",
        "export default pattern(() => {",
        "  const profiles = new Writable<ProfileHomeOutput[]>([]).for('profiles');",
        "  const unappended = new Writable<ProfileHomeOutput[]>([]).for('unappended');",
        "  const seedName = seedProfileName({ profiles: unappended } as any);",
        "  const createProfile = submitProfileCreation({",
        "    profiles: profiles as any,",
        "    seedName,",
        "  });",
        "  return { profiles, unappended, createProfile, seedName };",
        "});",
      ].join("\n"),
    },
    { name: "/profile-create.tsx", contents: read("profile-create.tsx") },
    { name: "/profile-home.tsx", contents: read("profile-home.tsx") },
  ],
};

const RESULT_CAUSE = "profile name seeded at creation host";

const profileLinkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

/** The create event as the create surface's submit click sends it. */
function createEvent(name: string): { name: string } {
  const event = {
    name,
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "ProfileCreateSurface",
        eventIntegrity: ["ProfileCreateSurface"],
        uiContractDataset: { uiAction: "CreateProfile" },
      },
    },
  };
  markRendererTrustedEvent(event);
  return event;
}

/**
 * Runs `program` as a host in `home`, in `runtime`, and returns its result
 * cell once the run has committed.
 */
async function startHost(
  runtime: Runtime,
  program: RuntimeProgram,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const tx = runtime.edit();
  const host = await runtime.patternManager.compilePattern(program, {
    space: home,
    tx,
  });
  const resultCell = runtime.getCell<Record<string, unknown>>(
    home,
    RESULT_CAUSE,
    undefined,
    tx,
  );
  // deno-lint-ignore no-explicit-any
  const result = runtime.run(tx, host as any, {}, resultCell);
  runtime.prepareTxForCommit(tx);
  expect((await tx.commit().settled).error).toBeUndefined();
  await result.pull();
  return result;
}

describe("a profile's name is seeded at creation", () => {
  let server: MemoryV2Server.Server;
  let managerA: EmulatedStorageManager;
  let managerB: EmulatedStorageManager;

  beforeEach(() => {
    server = newSharedServer();
    managerA = EmulatedStorageManager.connectTo(server, { as: signer });
    managerB = EmulatedStorageManager.connectTo(server, { as: signer });
  });

  // Each runtime's `dispose()` closes its own manager; only the shared
  // server is this hook's to close.
  afterEach(async () => {
    await server?.close();
  });

  it("a fresh session reads the creation name from the stored cell, and a rename after it", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerA,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerB,
    });
    try {
      const tx1 = rt1.edit();
      const host = await rt1.patternManager.compilePattern(PROGRAM, {
        space: home,
        tx: tx1,
      });
      const resultCell = rt1.getCell<Record<string, unknown>>(
        home,
        RESULT_CAUSE,
        undefined,
        tx1,
      );
      // deno-lint-ignore no-explicit-any
      const r1 = rt1.run(tx1, host as any, {}, resultCell);
      rt1.prepareTxForCommit(tx1);
      expect((await tx1.commit().settled).error).toBeUndefined();
      await r1.pull();

      const tx2 = rt1.edit();
      r1.withTx(tx2).key("createProfile").send(createEvent("Ada"));
      rt1.prepareTxForCommit(tx2);
      expect((await tx2.commit().settled).error).toBeUndefined();
      await r1.pull();
      await rt1.idle();
      await r1.pull();

      const links = r1.key("profiles").asSchema(profileLinkListSchema)
        // deno-lint-ignore no-explicit-any
        .get() as any[];
      expect(links.length).toBe(1);
      const profileLink = links[0].getAsNormalizedFullLink();
      expect(profileLink.space).not.toBe(home);

      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();
      await rt1.idle();
      await rt1.storageManager.synced();

      // Session 2 (own replicas): the stored `name` reads as the creation
      // name without running the profile — what `#profile` readers do.
      const profile = rt2.getCellFromLink(profileLink);
      await profile.sync();
      const name = profile.key("name").asSchema<string>({ type: "string" });
      await name.sync();
      await name.pull();
      expect(name.get()).toBe("Ada");

      // A rename through the owner-protected writer still lands, and wins.
      expect(await rt2.start(profile)).toBe(true);
      await rt2.idle();
      const tx3 = rt2.edit();
      profile.withTx(tx3).key("setName").send({ name: "Saved name" });
      rt2.prepareTxForCommit(tx3);
      expect((await tx3.commit().settled).error).toBeUndefined();
      await rt2.idle();
      await name.pull();
      expect(name.get()).toBe("Saved name");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("stores the creation name when every list the seed step could read lacks the create's append", async () => {
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerA,
    });
    try {
      const r = await startHost(rt, UNAPPENDED_LIST_PROGRAM);
      const tx = rt.edit();
      r.withTx(tx).key("createProfile").send(createEvent("Ada"));
      rt.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await rt.idle();
      await rt.storageManager.synced();
      await r.pull();

      const unappended = r.key("unappended").asSchema(profileLinkListSchema)
        // deno-lint-ignore no-explicit-any
        .get() as any[];
      expect(unappended).toHaveLength(0);
      const links = r.key("profiles").asSchema(profileLinkListSchema)
        // deno-lint-ignore no-explicit-any
        .get() as any[];
      expect(links).toHaveLength(1);
      const profile = rt.getCellFromLink(links[0].getAsNormalizedFullLink());
      const name = profile.key("name").asSchema<string>({ type: "string" });
      await name.sync();
      await name.pull();
      expect(name.get()).toBe("Ada");
    } finally {
      await rt.dispose();
    }
  });

  it("fails the seed step loudly when its event names no profile", async () => {
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerA,
    });
    try {
      const r = await startHost(rt, UNAPPENDED_LIST_PROGRAM);
      const errors: Error[] = [];
      rt.scheduler.onError((error) => {
        errors.push(error);
      });

      const tx = rt.edit();
      r.withTx(tx).key("seedName").send({ name: "Ada" });
      rt.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await rt.idle();
      await rt.scheduler.idleWithPendingCommits();

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Cannot seed a profile's name");
    } finally {
      await rt.dispose();
    }
  });
});
