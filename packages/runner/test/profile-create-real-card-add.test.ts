import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

// GOLD-STANDARD end-to-end repro of the profile card-add flow using the REAL
// shipped patterns (profile-create.tsx + profile-home.tsx) — no synthetic
// child. Session A runs profile-create and fires `createProfile`, which seeds a
// ProfileHome in its OWN inSpace space (the real cross-space create). A FRESH
// session B then loads that ProfileHome standalone and fires the exported
// `addElement` stream — the card-add write onto the owner-protected `elements`
// list (the single non-exported `mutateElements` writer).
//
// This is the definitive test of CT-1740: post-#4158 (moduleIdentity over
// authored source) the seed-time and write-time writeAuthorizedBy stamps must
// agree across the two compile contexts, so the commit must NOT be rejected
// with "writeAuthorizedBy must remain stable at /". Pre-#4158 data (seeded with
// the injected-form stamp) is a migration boundary, not exercised here.
const signer = await Identity.fromPassphrase("profile-create-real-card-add");
const spaceA = signer.did();

const sysDir = fromFileUrl(
  new URL("../../patterns/system/", import.meta.url),
);
const read = (n: string) => Deno.readTextFileSync(sysDir + n);

// A tiny wrapper that owns the home `profiles` list and embeds the REAL
// profile-create pattern, exposing its `createProfile` stream. The seed push
// targets this plain list; the owner-protected surface under test lives in the
// ProfileHome child that `submitProfileCreation` creates via inSpace.
const WRAPPER_SRC = [
  "import ProfileCreate from './profile-create.tsx';",
  "import { pattern, Writable } from 'commonfabric';",
  "import type { ProfileHomeOutput } from './profile-home.tsx';",
  "",
  "export default pattern(() => {",
  "  const profiles = new Writable<ProfileHomeOutput[]>([]).for('profiles');",
  "  const created = ProfileCreate({ profiles });",
  "  return { profiles, createProfile: created.createProfile };",
  "});",
].join("\n");

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: WRAPPER_SRC },
    { name: "/profile-create.tsx", contents: read("profile-create.tsx") },
    { name: "/profile-home.tsx", contents: read("profile-home.tsx") },
  ],
};

const RESULT_CAUSE = "profile-create real card add";

const profileLinkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

const elementsListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

describe("profile-create real card-add (REAL patterns, cross-space)", () => {
  let server: MemoryV2Server.Server;
  let managerA: EmulatedStorageManager;
  let managerB: EmulatedStorageManager;

  beforeEach(() => {
    server = newSharedServer();
    managerA = EmulatedStorageManager.connectTo(server, { as: signer });
    managerB = EmulatedStorageManager.connectTo(server, { as: signer });
  });
  afterEach(async () => {
    await managerA?.close();
    await managerB?.close();
    await server?.close();
  });

  it("a fresh session adds a card to a freshly-created profile", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerA,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerB,
    });
    try {
      // Session A: run profile-create's host and create a profile.
      const tx1 = rt1.edit();
      const parent = await rt1.patternManager.compilePattern(PROGRAM, {
        space: spaceA,
        tx: tx1,
      });
      const resultCell1 = rt1.getCell<Record<string, unknown>>(
        spaceA,
        RESULT_CAUSE,
        undefined,
        tx1,
      );
      // deno-lint-ignore no-explicit-any
      const r1 = rt1.run(tx1, parent as any, {}, resultCell1);
      rt1.prepareTxForCommit(tx1);
      const commit1 = await tx1.commit().settled;
      expect(commit1.error).toBeUndefined();
      await r1.pull();

      const tx2 = rt1.edit();
      r1.withTx(tx2).key("createProfile").send({ name: "AdaTest" });
      const commit2 = await tx2.commit().settled;
      expect(commit2.error).toBeUndefined();
      await r1.pull();
      await rt1.idle();
      await r1.pull();

      const profiles = r1.key("profiles").asSchema(profileLinkListSchema)
        // deno-lint-ignore no-explicit-any
        .get() as any[];
      expect(profiles.length).toBe(1);
      const profileLink = profiles[0].getAsNormalizedFullLink();
      // The profile lives in its OWN space (inSpace), not the home space.
      expect(profileLink.space).not.toBe(spaceA);

      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();
      await rt1.idle();
      await rt1.storageManager.synced();

      // Session B (own replicas, warm/cached STANDALONE ProfileHome load).
      const profileCell = rt2.getCellFromLink(profileLink);
      await profileCell.sync();
      const started = await rt2.start(profileCell);
      expect(started).toBe(true);
      await rt2.idle();

      // THE card-add write: the exported addElement stream (an instance of the
      // non-exported mutateElements writer, mode "add"). Catalog card (no url).
      const writeTx = rt2.edit();
      profileCell.withTx(writeTx).key("addElement").send({
        title: "My Card",
      });
      // A manual test tx prepares the way the runtime's own commit paths do:
      // an enforcing rung refuses a relevant transaction that arrives
      // unprepared.
      rt2.prepareTxForCommit(writeTx);
      const writeCommit = await writeTx.commit().settled;
      // The regression site. Pre-fix: "writeAuthorizedBy must remain stable".
      expect(writeCommit.error).toBeUndefined();
      await profileCell.pull();
      await rt2.idle();
      await profileCell.pull();

      const elementsCell = profileCell.key("elements").asSchema(
        elementsListSchema,
      );
      await elementsCell.sync();
      await elementsCell.pull();
      // deno-lint-ignore no-explicit-any
      const elements = elementsCell.get() as any[];
      expect(elements.length).toBe(1);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
