/**
 * Creates a profile through the real create pattern on a memory server that
 * enforces access-control lists, then runs that profile from a second user's
 * runtime. A runtime showing a profile writes into the profile's space, so
 * what the space grants a visitor decides whether the visit works at all, and
 * what the visitor's writes reach decides what the owner sees afterwards.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import type { Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as Engine from "@commonfabric/memory/v2/engine";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";

import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace, URI } from "../src/storage/interface.ts";
import type { SessionFactory } from "../src/storage/v2.ts";
import { TestStorageManager } from "./memory-v2-test-utils.ts";

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

/** Opens each session as the principal its signer is, over one server. */
class PrincipalSessionFactory implements SessionFactory {
  /** Always `true`: the loopback server takes a genesis access list. */
  readonly supportsAclBootstrap = true;

  readonly #server: MemoryV2Server.Server;

  /** Constructs an instance which opens its sessions on `server`. */
  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }

  /** @inheritDoc */
  async create(
    space: MemorySpace,
    signer?: Signer,
    requested: MemoryV2Client.MountOptions = {},
  ) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.#server),
    });
    try {
      const session = await client.mount(
        space,
        requested,
        (_space, _session, context) => ({
          invocation: {
            aud: context.audience,
            challenge: context.challenge.value,
          },
          authorization: { principal: signer?.did() },
        }),
      );
      return { client, session };
    } catch (error) {
      await client.close();
      throw error;
    }
  }
}

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
  it("creates a profile space a visitor's runtime can write to, keeping the visitor's view state out of the owner's", async () => {
    const server = new MemoryV2Server.Server({
      store: new URL("memory://profile-space-access"),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: "did:key:z6Mk-profile-space-access" },
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
    });
    const factory = new PrincipalSessionFactory(server);
    const memoryHost = new URL("memory://");
    const runtimeAs = (as: Identity) =>
      new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: TestStorageManager.create({ as, memoryHost }, factory),
      });
    const ownerRuntime = runtimeAs(owner);
    const visitorRuntime = runtimeAs(visitor);
    const readerRuntime = runtimeAs(owner);
    let ownerDisposed = false;
    const disposeOwner = async () => {
      if (ownerDisposed) return;
      ownerDisposed = true;
      await ownerRuntime.dispose();
    };
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
      // The owner's runtime is gone before the visitor arrives, so every
      // commit the profile space takes from here on is the visitor's.
      await disposeOwner();
      const profileEngine = await server.engineForSpace(profileSpace);
      const seqBeforeVisit = Engine.serverSeq(profileEngine);

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
      const visitorIsEditing = visited.key("isEditing").asSchema<boolean>(
        booleanSchema,
      );
      expect(await visitorIsEditing.pull()).toBe(true);
      await visitorRuntime.idle();
      await visitorRuntime.storageManager.synced();
      expect(Engine.serverSeq(profileEngine)).toBeGreaterThan(seqBeforeVisit);

      // The view state the visitor flipped is the visitor's own, and so is
      // `isEditing`, which is computed from it: a runtime of the owner's that
      // has run nothing holds no value for either, and reads the profile as
      // not being edited through the default the profile declares.
      const ownerIsEditing = readerRuntime.getCellFromLink(profileLink)
        .key("isEditing").asSchema<boolean>({
          ...booleanSchema,
          default: false,
        });
      await ownerIsEditing.sync();
      expect(ownerIsEditing.get()).toBe(false);
    } finally {
      await readerRuntime.dispose();
      await visitorRuntime.dispose();
      await disposeOwner();
      await server.close();
    }
  });
});
