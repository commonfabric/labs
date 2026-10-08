/**
 * Creates a profile through the real create pattern on a memory server that
 * enforces access-control lists, then runs that profile from a second user's
 * runtime. A runtime showing a profile writes into the profile's space, so
 * what the space grants a visitor decides whether the visit works at all, and
 * what the visitor's writes reach decides what the owner sees afterwards.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import type { Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as Engine from "@commonfabric/memory/v2/engine";
import { readGenesisRoot } from "@commonfabric/memory/v2/genesis-root";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";

import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { principalOf } from "../src/builder/principal-of.ts";
import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import { resolveSpaceRootPattern } from "../src/ensure-space-root.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { IN_SPACE_ROOT_CAUSE } from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace, URI } from "../src/storage/interface.ts";
import type { SessionFactory } from "../src/storage/v2.ts";
import { TestStorageManager } from "./memory-v2-test-utils.ts";

const owner = await Identity.fromPassphrase("profile space access owner");
const visitor = await Identity.fromPassphrase("profile space access visitor");

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
  let server: MemoryV2Server.Server;
  let serverCount = 0;
  const factory = () => new PrincipalSessionFactory(server);
  const memoryHost = new URL("memory://");
  const runtimeAs = (as: Identity) =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: TestStorageManager.create(
        { as, memoryHost },
        factory(),
      ),
    });

  beforeEach(() => {
    server = new MemoryV2Server.Server({
      store: new URL(`memory://profile-space-access-${++serverCount}`),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: "did:key:z6Mk-profile-space-access" },
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
    });
  });

  afterEach(async () => {
    await server.close();
  });

  /**
   * Creates a profile named `name` through the real create pattern, run by
   * `runtime` in its user's home space, and returns the link to it.
   */
  const createProfile = async (runtime: Runtime, name: string) => {
    const space = runtime.userIdentityDID as MemorySpace;
    const setupTx = runtime.edit();
    const host = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
      tx: setupTx,
    });
    const result = runtime.run(
      setupTx,
      // deno-lint-ignore no-explicit-any
      host as any,
      {},
      runtime.getCell<Record<string, unknown>>(
        space,
        "profile space access host",
        undefined,
        setupTx,
      ),
    );
    runtime.prepareTxForCommit(setupTx);
    expect((await setupTx.commit().settled).error).toBeUndefined();
    await result.pull();

    const createTx = runtime.edit();
    result.withTx(createTx).key("createProfile").send(createEvent(name));
    runtime.prepareTxForCommit(createTx);
    expect((await createTx.commit().settled).error).toBeUndefined();
    await result.pull();
    await runtime.idle();
    await result.pull();

    const links = result.key("profiles").asSchema(profileLinkListSchema)
      // deno-lint-ignore no-explicit-any
      .get() as any[];
    expect(links.length).toBe(1);
    const profileLink = links[0].getAsNormalizedFullLink();
    expect(profileLink.space).not.toBe(space);

    await runtime.patternManager.flushCompileCacheWrites();
    await runtime.storageManager.synced();
    await runtime.idle();
    await runtime.storageManager.synced();
    return profileLink;
  };

  it("creates a profile space a visitor's runtime can write to, keeping the visitor's view state out of the owner's", async () => {
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
      const profileLink = await createProfile(ownerRuntime, "Ada");
      const profileSpace = profileLink.space as MemorySpace;
      expect(
        (await server.readDocument(profileSpace, aclDocId(profileSpace) as URI))
          ?.value,
      ).toEqual({ "*": "WRITE", [owner.did()]: "OWNER" });

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
      expect((await toggleTx.commit().settled).error).toBeUndefined();
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
    }
  });

  it("makes the profile its space's root, which a visitor's runtime finds from the space's DID alone", async () => {
    const ownerRuntime = runtimeAs(owner);
    const visitorRuntime = runtimeAs(visitor);
    try {
      const profileLink = await createProfile(ownerRuntime, "Ada");
      const profileSpace = profileLink.space as MemorySpace;

      // The link in Home's list names the profile through a slot that links
      // on to it, and a host holding that link resolves it there.
      const listed = visitorRuntime.getCellFromLink(profileLink);
      await listed.sync();
      const profile = listed.resolveAsCell().getAsNormalizedFullLink();

      // What the visitor holds here is the space's DID and nothing else. The
      // space's genesis commit reserved the root's address, and the space
      // cell links the profile, at that address, as the root.
      const root = await resolveSpaceRootPattern(visitorRuntime, profileSpace);
      expect(root?.getAsNormalizedFullLink()).toMatchObject({
        space: profileSpace,
        id: profile.id,
        path: [],
      });
      expect(profile.id).toBe(
        visitorRuntime.getCell(profileSpace, IN_SPACE_ROOT_CAUSE)
          .getAsNormalizedFullLink().id,
      );
      expect(
        readGenesisRoot(await server.engineForSpace(profileSpace)),
      ).toEqual({ cause: IN_SPACE_ROOT_CAUSE });

      // The profile reached that way still says whom it represents, which is
      // what a host checks before taking it for its owner's.
      await root!.sync();
      const tx = visitorRuntime.edit();
      const frame = pushFrame({
        runtime: visitorRuntime,
        tx,
        space: visitor.did(),
        frameKind: "handler",
        inHandler: true,
      });
      try {
        expect(principalOf(root, "represents-principal")).toBe(owner.did());
      } finally {
        popFrame(frame);
        tx.abort();
      }
    } finally {
      await visitorRuntime.dispose();
      await ownerRuntime.dispose();
    }
  });
});
