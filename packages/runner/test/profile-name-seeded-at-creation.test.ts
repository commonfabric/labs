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
      expect((await tx1.commit()).error).toBeUndefined();
      await r1.pull();

      const tx2 = rt1.edit();
      r1.withTx(tx2).key("createProfile").send(createEvent("Ada"));
      rt1.prepareTxForCommit(tx2);
      expect((await tx2.commit()).error).toBeUndefined();
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
      expect((await tx3.commit()).error).toBeUndefined();
      await rt2.idle();
      await name.pull();
      expect(name.get()).toBe("Saved name");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
