/**
 * Creates a profile through the real create pattern on a memory server that
 * enforces access-control lists, then runs that profile from a second user's
 * runtime. A runtime showing a profile writes into the profile's space, so
 * what the space grants a visitor decides whether the visit works at all.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";

import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace, URI } from "../src/storage/interface.ts";
import { TestStorageManager } from "./memory-v2-test-utils.ts";
import { RecordingSessionFactory } from "./support/recording-session-factory.ts";

const owner = await Identity.fromPassphrase("profile space access owner");
const visitor = await Identity.fromPassphrase("profile space access visitor");
const home = owner.did();

const sysDir = fromFileUrl(new URL("../../patterns/system/", import.meta.url));
const read = (n: string) => Deno.readTextFileSync(sysDir + n);

// A host that owns the home `profiles` list and embeds the real create
// pattern.
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

describe("profile-space-access", () => {
  it("creates a profile space whose visitors can run the profile and write to it", async () => {
    const server = new MemoryV2Server.Server({
      store: new URL("memory://profile-space-access"),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: "did:key:z6Mk-profile-space-access" },
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
    });
    const factory = new RecordingSessionFactory(server);
    const memoryHost = new URL("memory://");
    const runtimeAs = (as: Identity) =>
      new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: TestStorageManager.create({ as, memoryHost }, factory),
      });
    const ownerRuntime = runtimeAs(owner);
    const visitorRuntime = runtimeAs(visitor);
    const readerRuntime = runtimeAs(owner);
    try {
      const setupTx = ownerRuntime.edit();
      const host = await ownerRuntime.patternManager.compilePattern(PROGRAM, {
        space: home,
        tx: setupTx,
      });
      const result = ownerRuntime.run(
        setupTx,
        // deno-lint-ignore no-explicit-any
        host as any,
        {},
        ownerRuntime.getCell<Record<string, unknown>>(
          home,
          "profile space access host",
          undefined,
          setupTx,
        ),
      );
      ownerRuntime.prepareTxForCommit(setupTx);
      expect((await setupTx.commit()).error).toBeUndefined();
      await result.pull();

      const createTx = ownerRuntime.edit();
      result.withTx(createTx).key("createProfile").send(createEvent("Ada"));
      ownerRuntime.prepareTxForCommit(createTx);
      expect((await createTx.commit()).error).toBeUndefined();
      await result.pull();
      await ownerRuntime.idle();
      await result.pull();

      const links = result.key("profiles").asSchema(profileLinkListSchema)
        // deno-lint-ignore no-explicit-any
        .get() as any[];
      expect(links.length).toBe(1);
      const profileLink = links[0].getAsNormalizedFullLink();
      const profileSpace = profileLink.space as MemorySpace;
      expect(profileSpace).not.toBe(home);
      expect(
        (await server.readDocument(profileSpace, aclDocId(profileSpace) as URI))
          ?.value,
      ).toEqual({ "*": "WRITE", [owner.did()]: "OWNER" });

      await ownerRuntime.patternManager.flushCompileCacheWrites();
      await ownerRuntime.storageManager.synced();
      await ownerRuntime.idle();
      await ownerRuntime.storageManager.synced();

      // The visitor runs the profile and flips its view mode, the one stream
      // of the profile a visitor is free to send to.
      const visited = visitorRuntime.getCellFromLink(profileLink);
      await visited.sync();
      expect(await visitorRuntime.start(visited)).toBe(true);
      await visitorRuntime.idle();
      const toggleTx = visitorRuntime.edit();
      visited.withTx(toggleTx).key("toggleEditing").send(undefined);
      visitorRuntime.prepareTxForCommit(toggleTx);
      expect((await toggleTx.commit()).error).toBeUndefined();
      await visitorRuntime.idle();
      const booleanSchema = { type: "boolean" } as const;
      await visited.key("isEditing").asSchema<boolean>(booleanSchema).pull();
      await visitorRuntime.idle();
      await visitorRuntime.storageManager.synced();

      // A runtime that has run nothing reads what the visitor's runtime stored.
      const isEditing = readerRuntime.getCellFromLink(profileLink)
        .key("isEditing").asSchema<boolean>(booleanSchema);
      await isEditing.sync();
      expect(isEditing.get()).toBe(true);
    } finally {
      await readerRuntime.dispose();
      await visitorRuntime.dispose();
      await ownerRuntime.dispose();
      await server.close();
    }
  });
});
