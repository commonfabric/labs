import { FabricLink } from "@commonfabric/data-model/fabric-instances";
import { readGenesisRoot } from "@commonfabric/memory/v2/genesis-root";
import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  selectCommitsSince,
  selectDocHead,
} from "@commonfabric/memory/v2/engine";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";

const TEST_AUDIENCE = "did:key:z6Mk-runner-acl-bootstrap-audience";

class RecordingLoopbackSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;
  readonly principals: string[] = [];
  readonly sessions: Array<{
    space: MemorySpace;
    requested: MemoryV2Client.MountOptions;
    actualSessionId: string;
  }> = [];

  readonly #server: MemoryV2Server.Server;

  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }

  async create(
    space: MemorySpace,
    signer?: Signer,
    requested: MemoryV2Client.MountOptions = {},
  ) {
    this.principals.push(signer?.did() ?? "<anonymous>");
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.#server),
    });
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
    this.sessions.push({
      space,
      requested: { ...requested },
      actualSessionId: session.sessionId,
    });
    return { client, session };
  }
}

class TestStorageManager extends StorageManager {
  static overServer(
    options: Omit<Options, "memoryHost">,
    factory: SessionFactory,
  ): TestStorageManager {
    return new TestStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      factory,
    );
  }
}

const createServer = (
  label: string,
  options: {
    store?: URL;
    mode?: "off" | "observe" | "enforce";
  } = {},
): MemoryV2Server.Server =>
  new MemoryV2Server.Server({
    store: options.store ?? new URL(`memory://${label}`),
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: { audience: TEST_AUDIENCE },
    acl: { mode: options.mode ?? "enforce" },
    subscriptionRefreshDelayMs: 0,
  });

Deno.test("storage manager uses one session id across spaces and isolates managers", async () => {
  const alice = await Identity.fromPassphrase("manager session alice");
  const bob = await Identity.fromPassphrase("manager session bob");
  const firstSpace = "did:key:z6Mk-manager-session-first" as MemorySpace;
  const secondSpace = "did:key:z6Mk-manager-session-second" as MemorySpace;
  const server = createServer("runner-manager-session-id", { mode: "off" });
  const aliceFactory = new RecordingLoopbackSessionFactory(server);
  const bobFactory = new RecordingLoopbackSessionFactory(server);
  const aliceManager = TestStorageManager.overServer(
    { as: alice },
    aliceFactory,
  );
  const bobManager = TestStorageManager.overServer({ as: bob }, bobFactory);

  try {
    assert(aliceManager.id !== bobManager.id);
    for (const targetSpace of [firstSpace, secondSpace]) {
      const sync = await aliceManager.open(targetSpace).sync(
        "of:manager-session-probe" as URI,
      );
      assert(!sync.error, sync.error?.message);
    }
    const bobSync = await bobManager.open(firstSpace).sync(
      "of:manager-session-probe" as URI,
    );
    assert(!bobSync.error, bobSync.error?.message);

    assertEquals(
      aliceFactory.sessions.map((entry) => ({
        space: entry.space,
        requestedSessionId: entry.requested.sessionId,
        actualSessionId: entry.actualSessionId,
      })),
      [firstSpace, secondSpace].map((targetSpace) => ({
        space: targetSpace,
        requestedSessionId: aliceManager.id,
        actualSessionId: aliceManager.id,
      })),
    );
    assertEquals(bobFactory.sessions, [{
      space: firstSpace,
      requested: { sessionId: bobManager.id },
      actualSessionId: bobManager.id,
    }]);

    await aliceManager.close();
    for (const targetSpace of [firstSpace, secondSpace]) {
      const sync = await aliceManager.open(targetSpace).sync(
        "of:manager-session-reopen-probe" as URI,
      );
      assert(!sync.error, sync.error?.message);
    }
    const reopenedSessions = aliceFactory.sessions.slice(2);
    assertEquals(reopenedSessions.length, 2);
    assert(
      reopenedSessions[0].actualSessionId !== aliceManager.id,
      "a closed manager lifecycle must not reuse its invalidated session id",
    );
    assertEquals(
      reopenedSessions[1].actualSessionId,
      reopenedSessions[0].actualSessionId,
    );
  } finally {
    await aliceManager.close();
    await bobManager.close();
    await server.close();
  }
});

Deno.test("storage ACL bootstrap uses the named-space identity then returns to the user", async () => {
  const user = await Identity.fromPassphrase("acl bootstrap user");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl bootstrap named space",
  );
  const space = spaceIdentity.did();
  const server = createServer("runner-acl-bootstrap-named");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer(
    { as: user, spaceIdentity },
    factory,
  );
  try {
    const sync = await manager.open(space).sync(`of:${space}` as URI);
    assert(!sync.error, sync.error?.message);

    const acl = await server.readDocument(space, `of:${space}`);
    assertEquals(acl?.value, {
      [user.did()]: "OWNER",
      "*": "WRITE",
    });
    assertEquals(factory.principals, [
      user.did(),
      spaceIdentity.did(),
      user.did(),
    ]);
    assertEquals(factory.sessions.length, 3);
    assertEquals(factory.sessions[0].actualSessionId, manager.id);
    assertEquals(factory.sessions[0].requested, { sessionId: manager.id });
    assert(factory.sessions[1].actualSessionId !== manager.id);
    assertEquals(
      factory.sessions[1].requested.sessionId,
      factory.sessions[1].actualSessionId,
    );
    assertEquals(factory.sessions[2].actualSessionId, manager.id);
    assertEquals(factory.sessions[2].requested.sessionId, manager.id);
    assertExists(factory.sessions[2].requested.sessionToken);

    const guest = await Identity.fromPassphrase("acl bootstrap named guest");
    const guestConnection = await new RecordingLoopbackSessionFactory(server)
      .create(space, guest);
    try {
      await guestConnection.session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:guest-write",
          value: { value: { public: true } },
        }],
      });
      assertEquals(
        (await server.readDocument(space, "of:guest-write"))?.value,
        { public: true },
      );
    } finally {
      await guestConnection.client.close();
    }
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("storage ACL bootstrap accepts multiple runtime-derived space identities", async () => {
  const user = await Identity.fromPassphrase("acl bootstrap multi user");
  const first = await Identity.fromPassphrase("acl bootstrap multi first");
  const second = await Identity.fromPassphrase("acl bootstrap multi second");
  const server = createServer("runner-acl-bootstrap-multi");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  manager.registerSpaceIdentity(first);
  manager.registerSpaceIdentity(second);
  try {
    for (const identity of [first, second]) {
      const space = identity.did();
      const sync = await manager.open(space).sync(`of:${space}` as URI);
      assert(!sync.error, sync.error?.message);
      assertEquals(
        (await server.readDocument(space, `of:${space}`))?.value,
        { [user.did()]: "OWNER", "*": "WRITE" },
      );
    }
    assertEquals(factory.principals, [
      user.did(),
      first.did(),
      user.did(),
      user.did(),
      second.did(),
      user.did(),
    ]);
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("concurrent named-space bootstrap has one owner and both sessions succeed", async () => {
  const alice = await Identity.fromPassphrase("acl bootstrap race alice");
  const bob = await Identity.fromPassphrase("acl bootstrap race bob");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl bootstrap race named space",
  );
  const space = spaceIdentity.did();
  const server = createServer("runner-acl-bootstrap-race");
  const aliceManager = TestStorageManager.overServer(
    { as: alice, spaceIdentity },
    new RecordingLoopbackSessionFactory(server),
  );
  const bobManager = TestStorageManager.overServer(
    { as: bob, spaceIdentity },
    new RecordingLoopbackSessionFactory(server),
  );
  try {
    const results = await Promise.all([
      aliceManager.open(space).sync("of:race-alice" as URI),
      bobManager.open(space).sync("of:race-bob" as URI),
    ]);
    // One ACL genesis wins. The losing initializer can still reopen and write
    // through the winner's rollout-default wildcard WRITE grant.
    assertEquals(
      results.filter((result) => result.error === undefined).length,
      2,
    );

    const acl = (await server.readDocument(space, `of:${space}`))?.value;
    assert(isObjectNotArray(acl));
    const grants = acl as Record<string, unknown>;
    assertEquals(grants["*"], "WRITE");
    assertEquals(
      [alice.did(), bob.did()].filter((did) => grants[did] === "OWNER")
        .length,
      1,
    );
    assertEquals(Object.keys(grants).length, 2);
  } finally {
    await aliceManager.close();
    await bobManager.close();
    await server.close();
  }
});

Deno.test("storage ACL bootstrap claims a fresh home space privately", async () => {
  const user = await Identity.fromPassphrase("acl bootstrap home user");
  const space = user.did();
  const server = createServer("runner-acl-bootstrap-home");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  try {
    const sync = await manager.open(space).sync(`of:${space}` as URI);
    assert(!sync.error, sync.error?.message);

    const acl = await server.readDocument(space, `of:${space}`);
    assertEquals(acl?.value, { [space]: "OWNER" });
    assertEquals(factory.principals, [space, space, space]);
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("storage ACL bootstrap privatizes a populated legacy home space", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "runner-acl-bootstrap-home-legacy-",
  });
  const store = toFileUrl(`${directory}/`);
  const user = await Identity.fromPassphrase(
    "acl bootstrap populated home user",
  );
  const space = user.did();
  try {
    const seedServer = createServer("unused", { store, mode: "off" });
    try {
      await seedServer.writeDocument(space, "of:legacy-home", {
        legacy: true,
      });
    } finally {
      await seedServer.close();
    }

    const server = createServer("unused", { store });
    const factory = new RecordingLoopbackSessionFactory(server);
    const manager = TestStorageManager.overServer({ as: user }, factory);
    try {
      const sync = await manager.open(space).sync("of:legacy-home" as URI);
      assert(!sync.error, sync.error?.message);
      assertEquals(
        (await server.readDocument(space, `of:${space}`))?.value,
        { [space]: "OWNER" },
      );
      assertEquals(factory.principals, [space, space, space]);
    } finally {
      await manager.close();
      await server.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("storage ACL bootstrap does not recreate a retracted home ACL", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "runner-acl-bootstrap-home-retracted-",
  });
  const store = toFileUrl(`${directory}/`);
  const user = await Identity.fromPassphrase(
    "acl bootstrap retracted home user",
  );
  const space = user.did();
  const aclId = `of:${space}` as URI;
  try {
    const seedServer = createServer("unused", { store, mode: "off" });
    try {
      await seedServer.writeDocument(space, aclId, {
        [space]: "OWNER",
      });
      const seeded = await new RecordingLoopbackSessionFactory(seedServer)
        .create(space, user);
      try {
        await seeded.session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "delete", id: aclId }],
        });
      } finally {
        await seeded.client.close();
      }
      assertEquals(await seedServer.readDocument(space, aclId), null);
    } finally {
      await seedServer.close();
    }

    const server = createServer("unused", { store });
    const factory = new RecordingLoopbackSessionFactory(server);
    const manager = TestStorageManager.overServer({ as: user }, factory);
    try {
      const sync = await manager.open(space).sync(aclId);
      assert(!sync.error, sync.error?.message);
      assertEquals(await server.readDocument(space, aclId), null);
      assertEquals(factory.principals, [space]);
    } finally {
      await manager.close();
      await server.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("storage ACL bootstrap leaves populated named spaces public", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "runner-acl-bootstrap-named-legacy-",
  });
  const store = toFileUrl(`${directory}/`);
  const user = await Identity.fromPassphrase(
    "acl bootstrap populated named user",
  );
  const spaceIdentity = await Identity.fromPassphrase(
    "acl bootstrap populated named space",
  );
  const space = spaceIdentity.did();
  try {
    const seedServer = createServer("unused", { store, mode: "off" });
    try {
      await seedServer.writeDocument(space, "of:legacy-named", {
        legacy: true,
      });
    } finally {
      await seedServer.close();
    }

    const server = createServer("unused", { store });
    const factory = new RecordingLoopbackSessionFactory(server);
    const manager = TestStorageManager.overServer(
      { as: user, spaceIdentity },
      factory,
    );
    try {
      const sync = await manager.open(space).sync("of:legacy-named" as URI);
      assert(!sync.error, sync.error?.message);
      assertEquals(await server.readDocument(space, `of:${space}`), null);
      assertEquals(factory.principals, [user.did()]);
    } finally {
      await manager.close();
      await server.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

//
// OW31 (RULED 2026-08-18; verification-coverage.md): a PROVISIONED
// space's genesis is signed by the space's own keys and names the ACTING
// USER as OWNER in that same first commit — the serving identity appears
// nowhere in the ACL. The client shape (no owner supplied → the signer,
// i.e. the active user) is pinned byte-for-byte by the named-space tests
// above.
//

Deno.test("storage ACL bootstrap names the supplied genesis owner, not the signer (OW31)", async () => {
  const service = await Identity.fromPassphrase("acl bootstrap ow31 service");
  const alice = await Identity.fromPassphrase("acl bootstrap ow31 alice");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl bootstrap ow31 provisioned",
  );
  const space = spaceIdentity.did();
  const server = createServer("runner-acl-bootstrap-ow31-owner");
  const factory = new RecordingLoopbackSessionFactory(server);
  // The serving posture: the manager authenticates as the SERVICE, and
  // the space identity is registered with the ACTING user as genesis
  // owner (threaded from the serving-side resolveSpaceName).
  const manager = TestStorageManager.overServer({ as: service }, factory);
  // Red-first witnessed: without the owner option this minted
  // { [service]: "OWNER", "*": "WRITE" } (the OW31 defect, observed in
  // this test's red run).
  manager.registerSpaceIdentity(spaceIdentity, { owner: alice.did() });
  try {
    const sync = await manager.open(space).sync(`of:${space}` as URI);
    assert(!sync.error, sync.error?.message);

    // ACL owner = the acting user; the service principal appears NOWHERE.
    const acl = await server.readDocument(space, `of:${space}`);
    assertEquals(acl?.value, {
      [alice.did()]: "OWNER",
      "*": "WRITE",
    });
    assert(
      !(service.did() in (acl?.value as Record<string, unknown>)),
      "the service principal must appear nowhere in the genesis ACL",
    );

    // Genesis actor = the space DID (the bootstrap session signs as the
    // space; owner ≠ signer): normal mount, bootstrap mount, resume.
    assertEquals(factory.principals, [
      service.did(),
      spaceIdentity.did(),
      service.did(),
    ]);

    // The space's commit #1 IS the ACL commit.
    const engine = await server.engineForSpace(space);
    assertEquals(
      selectDocHead(engine, { id: `of:${space}`, scopeKey: "space" }),
      1,
      "the genesis ACL must be the space's first commit",
    );
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("storage without the space signer cannot initialize a foreign space", async () => {
  const user = await Identity.fromPassphrase("acl bootstrap foreign user");
  const space = "did:key:z6Mk-runner-acl-foreign" as MemorySpace;
  const server = createServer("runner-acl-bootstrap-foreign");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  try {
    const sync = await manager.open(space).sync("of:foreign-probe" as URI);
    assert(!sync.error, sync.error?.message);
    assertEquals(await server.readDocument(space, `of:${space}`), null);
    assertEquals(factory.principals, [user.did()]);

    const replica = manager.open(space).replica;
    assertExists(replica.commitNative);
    const write = await replica.commitNative({
      operations: [{
        op: "set",
        id: "of:foreign-write" as URI,
        type: "application/json",
        value: { denied: true },
      }],
    });
    assertExists(write.error, "ordinary writes must not create the space");
  } finally {
    await manager.close();
    await server.close();
  }
});

//
// Genesis-supplied ACL: a caller that holds the space key may name the
// exact document a fresh space is born with, so the space is never in a
// world-writable state it did not ask for. Absent, the rollout default
// (owner + wildcard WRITE — the tests above) is the fallback. Outside true
// genesis the option fails closed rather than going inert: a populated
// ACL-less space and a lost race refuse the open, a retracted ACL is
// refused by the server before the client can act, and the home arm never
// consults the document.
//

Deno.test("a supplied genesis ACL is the space's first and only commit — no wildcard row ever existed", async () => {
  const daemon = await Identity.fromPassphrase("acl genesis supplied daemon");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis supplied space",
  );
  const space = spaceIdentity.did();
  const aclId = `of:${space}` as URI;
  const server = createServer("runner-acl-genesis-supplied");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: daemon }, factory);
  // The downstream shape Loom's share mint wants: the space key is the only
  // OWNER, the minting daemon is a WRITE principal, nobody else is named.
  const supplied = {
    [space]: "OWNER" as const,
    [daemon.did()]: "WRITE" as const,
  };
  manager.registerSpaceIdentity(spaceIdentity, { genesisAcl: supplied });
  try {
    const sync = await manager.open(space).sync(aclId);
    assert(!sync.error, sync.error?.message);

    // The server's stored history, not the client's belief: seq 1 is the
    // ACL, it is the only commit, and its value is exactly the document.
    const engine = await server.engineForSpace(space);
    assertEquals(
      selectDocHead(engine, { id: aclId, scopeKey: "space" }),
      1,
      "the supplied ACL must be the space's first commit",
    );
    assertEquals(
      selectCommitsSince(engine, { fromSeq: 0 }).map((commit) => commit.seq),
      [1],
      "genesis must be the only commit — no intermediate default was written",
    );
    const stored = (await server.readDocument(space, aclId))?.value as
      | Record<string, unknown>
      | undefined;
    assertEquals(stored, supplied);
    assert(stored !== undefined && !("*" in stored), "no wildcard row");
    assertEquals(factory.principals, [
      daemon.did(),
      spaceIdentity.did(),
      daemon.did(),
    ]);

    // Behavioral proof the wildcard never applied: a stranger's write is
    // refused where the rollout default would have admitted it.
    const stranger = await Identity.fromPassphrase(
      "acl genesis supplied stranger",
    );
    const strangerFactory = new RecordingLoopbackSessionFactory(server);
    await assertRejects(
      () => strangerFactory.create(space, stranger),
      Error,
      undefined,
      "an unnamed principal must not even open a sealed space",
    );
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("a supplied genesis ACL without a concrete OWNER is refused by the server and the space stays uninitialized", async () => {
  const daemon = await Identity.fromPassphrase("acl genesis unowned daemon");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis unowned space",
  );
  const space = spaceIdentity.did();
  const aclId = `of:${space}` as URI;
  const server = createServer("runner-acl-genesis-unowned");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: daemon }, factory);
  // Structurally a valid ACL, but its only OWNER is the wildcard — the
  // server's existing genesis check refuses it; the client adds no check.
  manager.registerSpaceIdentity(spaceIdentity, {
    genesisAcl: { "*": "OWNER", [daemon.did()]: "WRITE" },
  });
  try {
    await assertRejects(
      () => manager.ensureSpaceInitialized(space),
      Error,
      "concrete OWNER",
    );
    // Uninitialized: no ACL, no commits, and ordinary writes still need
    // genesis (the client could not mint an unowned space).
    assertEquals(await server.readDocument(space, aclId), null);
    const engine = await server.engineForSpace(space);
    assertEquals(selectCommitsSince(engine, { fromSeq: 0 }), []);
    assertEquals(factory.principals, [daemon.did(), spaceIdentity.did()]);
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("registerSpaceIdentity refuses a genesis ACL together with an owner, and snapshots the document", async () => {
  const user = await Identity.fromPassphrase("acl genesis both user");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis both space",
  );
  const space = spaceIdentity.did();
  const server = createServer("runner-acl-genesis-both");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  try {
    // Two descriptions of one document: refused rather than silently
    // preferring one.
    assertThrows(
      () =>
        manager.registerSpaceIdentity(spaceIdentity, {
          owner: user.did(),
          genesisAcl: { [user.did()]: "OWNER" },
        }),
      Error,
      "genesisAcl",
    );
    // The document is copied at registration: a caller mutating their
    // object afterwards cannot change what genesis writes.
    const supplied: Record<string, "READ" | "WRITE" | "OWNER"> = {
      [user.did()]: "OWNER",
    };
    manager.registerSpaceIdentity(spaceIdentity, { genesisAcl: supplied });
    supplied["*"] = "WRITE";
    const sync = await manager.open(space).sync(`of:${space}` as URI);
    assert(!sync.error, sync.error?.message);
    assertEquals((await server.readDocument(space, `of:${space}`))?.value, {
      [user.did()]: "OWNER",
    });
  } finally {
    await manager.close();
    await server.close();
  }
});

/** Open `space` on a fresh manager over `store`, with or without a supplied
 * genesis ACL, and report what the server holds afterwards. The two arms of
 * an "inert outside genesis" test must agree on every field. */
const observeOpen = async (
  store: URL,
  user: Signer,
  spaceIdentity: Signer,
  probe: URI,
  genesisAcl?: Record<string, "READ" | "WRITE" | "OWNER">,
) => {
  const space = spaceIdentity.did() as MemorySpace;
  const server = createServer("unused", { store });
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  manager.registerSpaceIdentity(
    spaceIdentity,
    genesisAcl !== undefined ? { genesisAcl } : undefined,
  );
  try {
    const sync = await manager.open(space).sync(probe);
    const engine = await server.engineForSpace(space);
    return {
      syncFailed: sync.error !== undefined,
      acl: (await server.readDocument(space, `of:${space}`))?.value ?? null,
      commits: selectCommitsSince(engine, { fromSeq: 0 }).map((c) => c.seq),
      principals: [...factory.principals],
    };
  } finally {
    await manager.close();
    await server.close();
  }
};

Deno.test("a supplied genesis ACL on a populated ACL-less named space is refused, and the space is not claimed", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "runner-acl-genesis-legacy-",
  });
  const store = toFileUrl(`${directory}/`);
  const user = await Identity.fromPassphrase("acl genesis legacy user");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis legacy space",
  );
  const space = spaceIdentity.did();
  try {
    const seedServer = createServer("unused", { store, mode: "off" });
    try {
      await seedServer.writeDocument(space, "of:legacy-named", {
        legacy: true,
      });
    } finally {
      await seedServer.close();
    }
    // Without a document the legacy-public rule stands, as before.
    const without = await observeOpen(
      store,
      user,
      spaceIdentity,
      "of:legacy-named" as URI,
    );
    assertEquals(without.syncFailed, false, "legacy-public reads succeed");
    assertEquals(without.acl, null, "the legacy space must not be claimed");
    assertEquals(without.principals, [user.did()], "no bootstrap session");
    // Red-first witnessed: with a document the open SUCCEEDED and the
    // sealer was handed the legacy-public space with no error. The space
    // is not the one the caller asked for; fail closed.
    const withAcl = await observeOpen(
      store,
      user,
      spaceIdentity,
      "of:legacy-named" as URI,
      { [space]: "OWNER" },
    );
    assertEquals(withAcl.syncFailed, true, "the sealer is refused");
    assertEquals(withAcl.acl, null, "still not claimed");
    assertEquals(withAcl.commits, without.commits, "nothing written");
    assertEquals(withAcl.principals, [user.did()], "no bootstrap session");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

// A retracted ACL fails closed at the SERVER before any bootstrap session
// can act, in both arms, so this pins that the option changes no
// observable outcome there rather than exercising a client guard.
Deno.test("a supplied genesis ACL is inert on a retracted named ACL (a tombstone is never recreated)", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "runner-acl-genesis-retracted-",
  });
  const store = toFileUrl(`${directory}/`);
  const user = await Identity.fromPassphrase("acl genesis retracted user");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis retracted space",
  );
  const space = spaceIdentity.did();
  const aclId = `of:${space}` as URI;
  try {
    const seedServer = createServer("unused", { store, mode: "off" });
    try {
      await seedServer.writeDocument(space, aclId, { [user.did()]: "OWNER" });
      const seeded = await new RecordingLoopbackSessionFactory(seedServer)
        .create(space, user);
      try {
        await seeded.session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "delete", id: aclId }],
        });
      } finally {
        await seeded.client.close();
      }
      assertEquals(await seedServer.readDocument(space, aclId), null);
    } finally {
      await seedServer.close();
    }
    const without = await observeOpen(store, user, spaceIdentity, aclId);
    const withAcl = await observeOpen(store, user, spaceIdentity, aclId, {
      [space]: "OWNER",
    });
    assertEquals(withAcl, without);
    assertEquals(without.syncFailed, true, "a retracted ACL fails closed");
    assertEquals(without.acl, null, "the tombstone must stand");
    assertEquals(without.commits, [1, 2], "no third commit");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a genesis ACL registered under the home identity does not reach the home arm", async () => {
  const user = await Identity.fromPassphrase("acl genesis home user");
  const space = user.did();
  const server = createServer("runner-acl-genesis-home");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  // The home arm is not generalized over: it claims owner-only regardless.
  manager.registerSpaceIdentity(user, {
    genesisAcl: { "*": "WRITE", [space]: "OWNER" },
  });
  try {
    const sync = await manager.open(space).sync(`of:${space}` as URI);
    assert(!sync.error, sync.error?.message);
    assertEquals((await server.readDocument(space, `of:${space}`))?.value, {
      [space]: "OWNER",
    });
    // The home arm's own three-session dance, every one as the home identity.
    assertEquals(factory.principals, [space, space, space]);
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("runtime.resolveSpaceName threads a supplied genesis ACL to the named space's first commit", async () => {
  const user = await Identity.fromPassphrase("acl genesis resolve user");
  const member = await Identity.fromPassphrase("acl genesis resolve member");
  const server = createServer("runner-acl-genesis-resolve");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: manager,
  });
  try {
    const supplied = {
      [user.did()]: "OWNER" as const,
      [member.did()]: "WRITE" as const,
    };
    // The public seam: the name resolves to a DID and registers the derived
    // space key with the document, and the first open writes it verbatim.
    const space = await runtime.resolveSpaceName("genesis-acl-probe", {
      genesisAcl: supplied,
    });
    await manager.ensureSpaceInitialized(space);
    const engine = await server.engineForSpace(space);
    assertEquals(
      selectCommitsSince(engine, { fromSeq: 0 }).map((commit) => commit.seq),
      [1],
    );
    assertEquals(
      (await server.readDocument(space, `of:${space}`))?.value,
      supplied,
    );
  } finally {
    await runtime.dispose();
    await manager.close();
    await server.close();
  }
});

Deno.test("a serving runtime refuses a supplied genesis ACL explicitly (OW31 provisioning names the acting user, not a document)", async () => {
  const service = await Identity.fromPassphrase("acl genesis serving service");
  const alice = await Identity.fromPassphrase("acl genesis serving alice");
  const server = createServer("runner-acl-genesis-serving");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer(
    { as: service, servingHomeSpace: service.did() },
    factory,
  );
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: manager,
    servingPosture: true,
    experimental: { serverExecution: true },
  });
  try {
    // Red-first witnessed: before the explicit refusal, a document alone
    // hit OW31's owner-required refusal (whose message wrongly says the
    // genesis "would name the SERVICE as owner"), and a document plus an
    // owner hit registerSpaceIdentity's not-both refusal — a closed door
    // by accident rather than by decision.
    await assertRejects(
      () =>
        runtime.resolveSpaceName("genesis-acl-serving", {
          genesisAcl: { [alice.did()]: "OWNER" },
        }),
      Error,
      "serving runtime does not accept genesisAcl",
    );
    // With an owner beside it, the not-both refusal comes first — the same
    // precedence as registerSpaceIdentity, on every runtime.
    await assertRejects(
      () =>
        runtime.resolveSpaceName("genesis-acl-serving", {
          owner: alice.did(),
          genesisAcl: { [alice.did()]: "OWNER" },
        }),
      Error,
      "not both",
    );
    assertEquals(
      runtime.resolveSpaceNameSync("genesis-acl-serving"),
      undefined,
    );
    assertEquals(factory.principals, [], "no session was ever opened");
  } finally {
    await runtime.dispose();
    await manager.close();
    await server.close();
  }
});

/** A bootstrap-capable factory whose SPACE-identity session holds its
 * transact at a gate the test opens, so a concurrent initializer can land
 * between the sealer's recheck and its commit — the interleaving the
 * ConflictError swallow exists for. No timers: the runner's test clock
 * freezes wall-clock sleeps armed from test files. */
class GatedGenesisSessionFactory extends RecordingLoopbackSessionFactory {
  readonly #space: string;
  readonly #gate: Promise<void>;
  readonly #method: "transact" | "queryGraph";
  /** Resolves once the gated call has been entered. */
  readonly held: Promise<void>;
  #markHeld!: () => void;
  constructor(
    server: MemoryV2Server.Server,
    space: string,
    gate: Promise<void>,
    method: "transact" | "queryGraph" = "transact",
  ) {
    super(server);
    this.#space = space;
    this.#gate = gate;
    this.#method = method;
    this.held = new Promise<void>((resolve) => {
      this.#markHeld = resolve;
    });
  }
  override async create(
    space: MemorySpace,
    signer?: Signer,
    requested: MemoryV2Client.MountOptions = {},
  ) {
    const opened = await super.create(space, signer, requested);
    if (signer?.did() === this.#space) {
      const session = opened.session as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;
      const original = session[this.#method].bind(session);
      session[this.#method] = async (...args: unknown[]) => {
        this.#markHeld();
        await this.#gate;
        return await original(...args);
      };
    }
    return opened;
  }
}

const gate = (): { opened: Promise<void>; open: () => void } => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

Deno.test("a sealer that loses the genesis race to a different document is told, not silently admitted under the winner's wildcard", async () => {
  const alice = await Identity.fromPassphrase("acl genesis race alice");
  const bob = await Identity.fromPassphrase("acl genesis race bob");
  const spaceIdentity = await Identity.fromPassphrase("acl genesis race space");
  const space = spaceIdentity.did();
  const aclId = `of:${space}` as URI;
  const server = createServer("runner-acl-genesis-race");
  // Alice seals; her bootstrap commit is held until Bob's default genesis
  // has landed.
  const aliceGate = gate();
  const aliceFactory = new GatedGenesisSessionFactory(
    server,
    space,
    aliceGate.opened,
  );
  const aliceManager = TestStorageManager.overServer(
    { as: alice },
    aliceFactory,
  );
  const bobManager = TestStorageManager.overServer(
    { as: bob, spaceIdentity },
    new RecordingLoopbackSessionFactory(server),
  );
  const sealed = { [space]: "OWNER" as const, [alice.did()]: "WRITE" as const };
  aliceManager.registerSpaceIdentity(spaceIdentity, { genesisAcl: sealed });
  try {
    const aliceOpen = aliceManager.ensureSpaceInitialized(space);
    await aliceFactory.held;
    const bobSync = await bobManager.open(space).sync("of:race-bob" as URI);
    assert(!bobSync.error, bobSync.error?.message);
    aliceGate.open();
    // Red-first witnessed: the swallow let Alice's open SUCCEED — the
    // winner's wildcard granted her access — with her document discarded
    // and nothing reported.
    await assertRejects(() => aliceOpen, Error, "different ACL");
    // The winner's document stands; Alice's was never applied.
    assertEquals((await server.readDocument(space, aclId))?.value, {
      [bob.did()]: "OWNER",
      "*": "WRITE",
    });
  } finally {
    await aliceManager.close();
    await bobManager.close();
    await server.close();
  }
});

Deno.test("two sealers racing with the SAME document both succeed (the conflict is benign)", async () => {
  const alice = await Identity.fromPassphrase("acl genesis same-doc alice");
  const bob = await Identity.fromPassphrase("acl genesis same-doc bob");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis same-doc space",
  );
  const space = spaceIdentity.did();
  const server = createServer("runner-acl-genesis-same-doc");
  const sealed = {
    [space]: "OWNER" as const,
    [alice.did()]: "WRITE" as const,
    [bob.did()]: "WRITE" as const,
  };
  const aliceGate = gate();
  const aliceFactory = new GatedGenesisSessionFactory(
    server,
    space,
    aliceGate.opened,
  );
  const aliceManager = TestStorageManager.overServer(
    { as: alice },
    aliceFactory,
  );
  const bobManager = TestStorageManager.overServer(
    { as: bob },
    new RecordingLoopbackSessionFactory(server),
  );
  aliceManager.registerSpaceIdentity(spaceIdentity, { genesisAcl: sealed });
  bobManager.registerSpaceIdentity(spaceIdentity, { genesisAcl: sealed });
  try {
    const aliceOpen = aliceManager.ensureSpaceInitialized(space);
    await aliceFactory.held;
    await bobManager.ensureSpaceInitialized(space);
    aliceGate.open();
    await aliceOpen;
    assertEquals(
      (await server.readDocument(space, `of:${space}`))?.value,
      sealed,
    );
    const engine = await server.engineForSpace(space);
    assertEquals(
      selectCommitsSince(engine, { fromSeq: 0 }).map((commit) => commit.seq),
      [1],
    );
  } finally {
    await aliceManager.close();
    await bobManager.close();
    await server.close();
  }
});

Deno.test("a refused genesis does not wedge the space: retries surface the real error and a corrected document recovers", async () => {
  const daemon = await Identity.fromPassphrase("acl genesis recover daemon");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis recover space",
  );
  const space = spaceIdentity.did();
  const aclId = `of:${space}` as URI;
  const server = createServer("runner-acl-genesis-recover");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: daemon }, factory);
  manager.registerSpaceIdentity(spaceIdentity, {
    genesisAcl: { "*": "OWNER", [daemon.did()]: "WRITE" },
  });
  try {
    await assertRejects(
      () => manager.ensureSpaceInitialized(space),
      Error,
      "concrete OWNER",
    );
    // Red-first witnessed: the second attempt failed with "resume token is
    // no longer valid" — the manager-wide session had been detached by the
    // first attempt and never resumed — and so did every attempt after
    // the document was corrected, until manager.close() rotated the id.
    await assertRejects(
      () => manager.ensureSpaceInitialized(space),
      Error,
      "concrete OWNER",
    );
    const corrected = {
      [space]: "OWNER" as const,
      [daemon.did()]: "WRITE" as const,
    };
    manager.registerSpaceIdentity(spaceIdentity, { genesisAcl: corrected });
    await manager.ensureSpaceInitialized(space);
    assertEquals((await server.readDocument(space, aclId))?.value, corrected);
    const sync = await manager.open(space).sync(aclId);
    assert(!sync.error, sync.error?.message);
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("runtime.resolveSpaceName refuses a genesis ACL it cannot honor: a cached name, a bare DID; an identical re-resolution is fine", async () => {
  const user = await Identity.fromPassphrase("acl genesis cached user");
  const server = createServer("runner-acl-genesis-cached");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: manager,
  });
  const sealed = { [user.did()]: "OWNER" as const };
  try {
    // Red-first witnessed: the cache short-circuit returned before
    // registration, so a name anything else had already resolved made the
    // sealing call a silent no-op and the space was born with the default.
    const first = await runtime.resolveSpaceName("genesis-acl-cached");
    await assertRejects(
      () =>
        runtime.resolveSpaceName("genesis-acl-cached", { genesisAcl: sealed }),
      Error,
      "already resolved",
    );
    // A bare DID derives no key, so there is nothing to register the
    // document against; refuse rather than open an ACL-less space.
    await assertRejects(
      () => runtime.resolveSpaceName(first, { genesisAcl: sealed }),
      Error,
      "DID",
    );
    // The same caller resolving the same name with the same document is a
    // retry, not a conflict.
    const space = await runtime.resolveSpaceName("genesis-acl-retry", {
      genesisAcl: sealed,
    });
    assertEquals(
      await runtime.resolveSpaceName("genesis-acl-retry", {
        genesisAcl: sealed,
      }),
      space,
    );
    await assertRejects(
      () =>
        runtime.resolveSpaceName("genesis-acl-retry", {
          genesisAcl: { [user.did()]: "OWNER", "*": "READ" },
        }),
      Error,
      "already resolved",
    );
    await manager.ensureSpaceInitialized(space);
    assertEquals(
      (await server.readDocument(space, `of:${space}`))?.value,
      sealed,
    );
  } finally {
    await runtime.dispose();
    await manager.close();
    await server.close();
  }
});

Deno.test("registerSpaceIdentity refuses a genesis ACL on a manager whose session factory cannot bootstrap", async () => {
  const user = await Identity.fromPassphrase("acl genesis no-bootstrap user");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis no-bootstrap space",
  );
  const server = createServer("runner-acl-genesis-no-bootstrap");
  const factory = new RecordingLoopbackSessionFactory(server);
  (factory as { supportsAclBootstrap: boolean }).supportsAclBootstrap = false;
  const manager = TestStorageManager.overServer({ as: user }, factory);
  try {
    // Red-first witnessed: the document was accepted and never written —
    // the space opened ACL-less with no error.
    assertThrows(
      () =>
        manager.registerSpaceIdentity(spaceIdentity, {
          genesisAcl: { [user.did()]: "OWNER" },
        }),
      Error,
      "cannot bootstrap",
    );
    // The owner option keeps its pre-existing, ignorable semantics.
    manager.registerSpaceIdentity(spaceIdentity, { owner: user.did() });
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("a manager reused after close() mounts its NEW session id (no stale detached resume survives close)", async () => {
  const user = await Identity.fromPassphrase("acl genesis reuse user");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis reuse space",
  );
  const space = spaceIdentity.did();
  const server = createServer("runner-acl-genesis-reuse");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer(
    { as: user, spaceIdentity },
    factory,
  );
  try {
    // Plain default genesis — the path every client runs.
    const first = await manager.open(space).sync(`of:${space}` as URI);
    assert(!first.error, first.error?.message);
    const firstId = manager.scopeKeyIdentity().sessionId;
    await manager.close();
    // Red-first witnessed: the reopen presented the pre-close session id and
    // its pre-rotation token — "resume token is no longer valid".
    const second = await manager.open(space).sync(`of:${space}` as URI);
    assert(!second.error, second.error?.message);
    const secondId = manager.scopeKeyIdentity().sessionId;
    assert(firstId !== secondId, "close() rotates the session id");
    assertEquals(
      factory.sessions.at(-1)?.requested.sessionId,
      secondId,
      "the reopen mounts the manager's current session id",
    );
    assertEquals(factory.sessions.at(-1)?.actualSessionId, secondId);
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("a refused genesis, then close(), then a corrected document: the recovery mounts the NEW session id", async () => {
  const daemon = await Identity.fromPassphrase(
    "acl genesis close-recover daemon",
  );
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis close-recover space",
  );
  const space = spaceIdentity.did();
  const server = createServer("runner-acl-genesis-close-recover");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: daemon }, factory);
  manager.registerSpaceIdentity(spaceIdentity, {
    genesisAcl: { "*": "OWNER", [daemon.did()]: "WRITE" },
  });
  try {
    await assertRejects(
      () => manager.ensureSpaceInitialized(space),
      Error,
      "concrete OWNER",
    );
    await manager.close();
    const corrected = {
      [space]: "OWNER" as const,
      [daemon.did()]: "WRITE" as const,
    };
    manager.registerSpaceIdentity(spaceIdentity, { genesisAcl: corrected });
    await manager.ensureSpaceInitialized(space);
    // Red-first witnessed: the recovery succeeded but on the OLD session id
    // while scopeKeyIdentity() reported the new one.
    assertEquals(
      factory.sessions.at(-1)?.actualSessionId,
      manager.scopeKeyIdentity().sessionId,
    );
    assertEquals(
      (await server.readDocument(space, `of:${space}`))?.value,
      corrected,
    );
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("a sealer that loses the race in the RECHECK window (before its commit) is told too", async () => {
  const alice = await Identity.fromPassphrase("acl genesis recheck alice");
  const bob = await Identity.fromPassphrase("acl genesis recheck bob");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis recheck space",
  );
  const space = spaceIdentity.did();
  const server = createServer("runner-acl-genesis-recheck");
  // Alice's bootstrap session is held at its RECHECK query, so Bob's default
  // genesis lands between Alice's first inspection and her recheck.
  const aliceGate = gate();
  const aliceFactory = new GatedGenesisSessionFactory(
    server,
    space,
    aliceGate.opened,
    "queryGraph",
  );
  const aliceManager = TestStorageManager.overServer(
    { as: alice },
    aliceFactory,
  );
  const bobManager = TestStorageManager.overServer(
    { as: bob, spaceIdentity },
    new RecordingLoopbackSessionFactory(server),
  );
  aliceManager.registerSpaceIdentity(spaceIdentity, {
    genesisAcl: { [space]: "OWNER", [alice.did()]: "WRITE" },
  });
  try {
    const aliceOpen = aliceManager.ensureSpaceInitialized(space);
    await aliceFactory.held;
    const bobSync = await bobManager.open(space).sync("of:recheck-bob" as URI);
    assert(!bobSync.error, bobSync.error?.message);
    aliceGate.open();
    // Red-first witnessed: the recheck found the ACL created, skipped the
    // bootstrap arm with no conflict to catch, and Alice's open SUCCEEDED
    // under Bob's wildcard.
    await assertRejects(() => aliceOpen, Error, "different ACL");
    assertEquals((await server.readDocument(space, `of:${space}`))?.value, {
      [bob.did()]: "OWNER",
      "*": "WRITE",
    });
  } finally {
    await aliceManager.close();
    await bobManager.close();
    await server.close();
  }
});

Deno.test("a sealer opening a space that already carries exactly its document proceeds (a reopen is not a conflict)", async () => {
  const alice = await Identity.fromPassphrase("acl genesis reopen alice");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis reopen space",
  );
  const space = spaceIdentity.did();
  const server = createServer("runner-acl-genesis-reopen");
  const sealed = { [space]: "OWNER" as const, [alice.did()]: "WRITE" as const };
  const first = TestStorageManager.overServer(
    { as: alice },
    new RecordingLoopbackSessionFactory(server),
  );
  first.registerSpaceIdentity(spaceIdentity, { genesisAcl: sealed });
  const secondFactory = new RecordingLoopbackSessionFactory(server);
  const second = TestStorageManager.overServer({ as: alice }, secondFactory);
  second.registerSpaceIdentity(spaceIdentity, { genesisAcl: sealed });
  try {
    await first.ensureSpaceInitialized(space);
    await first.close();
    // A second manager (a restart, say) with the same document finds the
    // space already sealed as asked: no genesis, no refusal.
    const sync = await second.open(space).sync(`of:${space}` as URI);
    assert(!sync.error, sync.error?.message);
    assertEquals(secondFactory.principals, [alice.did()], "no bootstrap");
    // But a document asserting a different OWNER set on the same existing
    // space is refused, and the refusal says what stands.
    const third = TestStorageManager.overServer(
      { as: alice },
      new RecordingLoopbackSessionFactory(server),
    );
    third.registerSpaceIdentity(spaceIdentity, {
      genesisAcl: { [alice.did()]: "OWNER" },
    });
    try {
      await assertRejects(
        () => third.ensureSpaceInitialized(space),
        Error,
        "owned by",
      );
    } finally {
      await third.close();
    }
  } finally {
    await second.close();
    await server.close();
  }
});

Deno.test("registerSpaceIdentity refuses a genesis ACL once the space's provider exists (it could never be written)", async () => {
  const user = await Identity.fromPassphrase("acl genesis late-register user");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis late-register space",
  );
  const space = spaceIdentity.did();
  const server = createServer("runner-acl-genesis-late-register");
  const manager = TestStorageManager.overServer(
    { as: user },
    new RecordingLoopbackSessionFactory(server),
  );
  try {
    const sync = await manager.open(space).sync(`of:${space}` as URI);
    assert(!sync.error, sync.error?.message);
    // Red-first witnessed: accepted, never written — ACL null, no error.
    assertThrows(
      () =>
        manager.registerSpaceIdentity(spaceIdentity, {
          genesisAcl: { [space]: "OWNER" },
        }),
      Error,
      "already open",
    );
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("a sealer's reopen survives the owner granting rows: ownership is what a seal asserts, grants evolve", async () => {
  const daemon = await Identity.fromPassphrase("acl genesis evolve daemon");
  const guest = await Identity.fromPassphrase("acl genesis evolve guest");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis evolve space",
  );
  const space = spaceIdentity.did();
  const aclId = `of:${space}` as URI;
  const server = createServer("runner-acl-genesis-evolve");
  const sealed = {
    [space]: "OWNER" as const,
    [daemon.did()]: "WRITE" as const,
  };
  const first = TestStorageManager.overServer(
    { as: daemon },
    new RecordingLoopbackSessionFactory(server),
  );
  first.registerSpaceIdentity(spaceIdentity, { genesisAcl: sealed });
  try {
    await first.ensureSpaceInitialized(space);
    await first.close();
    // The OWNER (the space key) grants a guest READ — Loom's share-acl arc.
    const owner = await new RecordingLoopbackSessionFactory(server).create(
      space,
      spaceIdentity,
    );
    try {
      await owner.session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: aclId,
          value: { value: { ...sealed, [guest.did()]: "READ" } },
        }],
      });
    } finally {
      await owner.client.close();
    }
    // Red-first witnessed: the daemon's restart, registering the SAME
    // document by name, was refused with "claimed with a different ACL" —
    // a false statement about a document that WAS applied at seq 1.
    const restarted = TestStorageManager.overServer(
      { as: daemon },
      new RecordingLoopbackSessionFactory(server),
    );
    restarted.registerSpaceIdentity(spaceIdentity, { genesisAcl: sealed });
    try {
      await restarted.ensureSpaceInitialized(space);
      assertEquals((await server.readDocument(space, aclId))?.value, {
        ...sealed,
        [guest.did()]: "READ",
      });
    } finally {
      await restarted.close();
    }
    // A default-wildcard winner still fails the ownership check: its OWNER
    // is another principal (pinned by the race tests); so does a space
    // whose owner has been replaced.
    const transferred = await new RecordingLoopbackSessionFactory(server)
      .create(space, spaceIdentity);
    try {
      await transferred.session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: aclId,
          value: { value: { [guest.did()]: "OWNER", [daemon.did()]: "WRITE" } },
        }],
      });
    } finally {
      await transferred.client.close();
    }
    const after = TestStorageManager.overServer(
      { as: daemon },
      new RecordingLoopbackSessionFactory(server),
    );
    after.registerSpaceIdentity(spaceIdentity, { genesisAcl: sealed });
    try {
      await assertRejects(
        () => after.ensureSpaceInitialized(space),
        Error,
        "owned by",
      );
    } finally {
      await after.close();
    }
  } finally {
    await server.close();
  }
});

Deno.test("a demanded document on a retracted ACL is refused naming the tombstone", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "runner-acl-genesis-tombstone-",
  });
  const store = toFileUrl(`${directory}/`);
  const user = await Identity.fromPassphrase("acl genesis tombstone user");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis tombstone space",
  );
  const space = spaceIdentity.did();
  const aclId = `of:${space}` as URI;
  try {
    // Seed and retract in `off` mode, then open in `off` mode too: the
    // server's fail-closed session open is out of the way, so the client's
    // own refusal is what the test observes.
    const seedServer = createServer("unused", { store, mode: "off" });
    try {
      await seedServer.writeDocument(space, aclId, { [space]: "OWNER" });
      const seeded = await new RecordingLoopbackSessionFactory(seedServer)
        .create(space, spaceIdentity);
      try {
        await seeded.session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "delete", id: aclId }],
        });
      } finally {
        await seeded.client.close();
      }
    } finally {
      await seedServer.close();
    }
    const server = createServer("unused", { store, mode: "off" });
    const manager = TestStorageManager.overServer(
      { as: user },
      new RecordingLoopbackSessionFactory(server),
    );
    manager.registerSpaceIdentity(spaceIdentity, {
      genesisAcl: { [space]: "OWNER" },
    });
    try {
      await assertRejects(
        () => manager.ensureSpaceInitialized(space),
        Error,
        "retracted",
      );
      assertEquals(await server.readDocument(space, aclId), null);
    } finally {
      await manager.close();
      await server.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a sealer that loses the race to its OWN other runtime's default is refused: same owner, but the wildcard stands", async () => {
  const alice = await Identity.fromPassphrase("acl genesis same-owner alice");
  const member = await Identity.fromPassphrase("acl genesis same-owner member");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis same-owner space",
  );
  const space = spaceIdentity.did();
  const server = createServer("runner-acl-genesis-same-owner");
  const aliceGate = gate();
  const sealerFactory = new GatedGenesisSessionFactory(
    server,
    space,
    aliceGate.opened,
  );
  const sealer = TestStorageManager.overServer({ as: alice }, sealerFactory);
  sealer.registerSpaceIdentity(spaceIdentity, {
    genesisAcl: { [alice.did()]: "OWNER", [member.did()]: "WRITE" },
  });
  // Alice's OTHER runtime — a pattern's inSpace(name), no document — races
  // with the rollout default { alice: OWNER, "*": WRITE }.
  const other = TestStorageManager.overServer(
    { as: alice, spaceIdentity },
    new RecordingLoopbackSessionFactory(server),
  );
  try {
    const sealerOpen = sealer.ensureSpaceInitialized(space);
    await sealerFactory.held;
    await other.ensureSpaceInitialized(space);
    aliceGate.open();
    // Red-first witnessed: the owner sets matched, so the sealer was
    // ADMITTED into a world-writable space with nothing reported.
    await assertRejects(() => sealerOpen, Error, "different ACL");
    assertEquals((await server.readDocument(space, `of:${space}`))?.value, {
      [alice.did()]: "OWNER",
      "*": "WRITE",
    });
  } finally {
    await sealer.close();
    await other.close();
    await server.close();
  }
});

Deno.test("a wildcard OWNER counts as an owner: a space owned by everyone is not owned as the document says", async () => {
  const daemon = await Identity.fromPassphrase("acl genesis wild-owner daemon");
  const spaceIdentity = await Identity.fromPassphrase(
    "acl genesis wild-owner space",
  );
  const space = spaceIdentity.did();
  const aclId = `of:${space}` as URI;
  const server = createServer("runner-acl-genesis-wild-owner");
  // The server accepts a wildcard OWNER beside a concrete one at genesis.
  const authority = await new RecordingLoopbackSessionFactory(server).create(
    space,
    spaceIdentity,
  );
  try {
    await authority.session.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: aclId,
        value: { value: { "*": "OWNER", [space]: "OWNER" } },
      }],
    });
  } finally {
    await authority.client.close();
  }
  const manager = TestStorageManager.overServer(
    { as: daemon },
    new RecordingLoopbackSessionFactory(server),
  );
  manager.registerSpaceIdentity(spaceIdentity, {
    genesisAcl: { [space]: "OWNER", [daemon.did()]: "WRITE" },
  });
  try {
    // Red-first witnessed: the wildcard was dropped from the owner set, the
    // sets matched, and the sealer was admitted to a space owned by everyone.
    await assertRejects(
      () => manager.ensureSpaceInitialized(space),
      Error,
      "owned by",
    );
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("runtime.resolveSpaceName refuses owner beside genesisAcl even on a cached name, and refuses a genesisAcl its storage manager cannot register", async () => {
  const user = await Identity.fromPassphrase("acl genesis cubic user");
  const server = createServer("runner-acl-genesis-cubic");
  const manager = TestStorageManager.overServer(
    { as: user },
    new RecordingLoopbackSessionFactory(server),
  );
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: manager,
  });
  const sealed = { [user.did()]: "OWNER" as const };
  try {
    await runtime.resolveSpaceName("genesis-acl-owner-and-doc", {
      genesisAcl: sealed,
    });
    // Red-first witnessed: the cached path returned the DID and silently
    // dropped the conflicting owner.
    await assertRejects(
      () =>
        runtime.resolveSpaceName("genesis-acl-owner-and-doc", {
          owner: user.did(),
          genesisAcl: sealed,
        }),
      Error,
      "not both",
    );
    // A storage manager with no registerSpaceIdentity seam has nowhere to
    // put the document; the optional call used to drop it silently.
    const seamless = new Proxy(manager, {
      get(target, property, receiver) {
        if (property === "registerSpaceIdentity") return undefined;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const bare = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: seamless,
    });
    try {
      await assertRejects(
        () =>
          bare.resolveSpaceName("genesis-acl-no-seam", { genesisAcl: sealed }),
        Error,
        "cannot register",
      );
      assertEquals(bare.resolveSpaceNameSync("genesis-acl-no-seam"), undefined);
    } finally {
      await bare.dispose();
    }
  } finally {
    await runtime.dispose();
    await manager.close();
    await server.close();
  }
});

Deno.test("runtime.resolveSpaceName: two concurrent resolutions of one uncached name with different documents cannot both register", async () => {
  const user = await Identity.fromPassphrase("acl genesis concurrent user");
  const other = await Identity.fromPassphrase("acl genesis concurrent other");
  const server = createServer("runner-acl-genesis-concurrent");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: manager,
  });
  const first = { [user.did()]: "OWNER" as const };
  const second = {
    [user.did()]: "OWNER" as const,
    [other.did()]: "WRITE" as const,
  };
  try {
    // Red-first witnessed: both passed the cache check before either
    // registration, the second overwrote the first, and the space was born
    // with the SECOND document while the first caller believed it sealed.
    const [a, b] = await Promise.allSettled([
      runtime.resolveSpaceName("genesis-acl-concurrent", { genesisAcl: first }),
      runtime.resolveSpaceName("genesis-acl-concurrent", {
        genesisAcl: second,
      }),
    ]);
    assertEquals(a.status, "fulfilled", "the first resolution wins");
    assertEquals(b.status, "rejected", "the conflicting second is refused");
    assert(
      b.status === "rejected" &&
        String(b.reason).includes("different genesisAcl"),
      String((b as PromiseRejectedResult).reason),
    );
    const space = (a as PromiseFulfilledResult<MemorySpace>).value;
    // An identical concurrent request is a retry and shares the outcome.
    const [c, d] = await Promise.all([
      runtime.resolveSpaceName("genesis-acl-concurrent-same", {
        genesisAcl: first,
      }),
      runtime.resolveSpaceName("genesis-acl-concurrent-same", {
        genesisAcl: first,
      }),
    ]);
    assertEquals(c, d);
    await manager.ensureSpaceInitialized(space);
    assertEquals(
      (await server.readDocument(space, `of:${space}`))?.value,
      first,
    );
  } finally {
    await runtime.dispose();
    await manager.close();
    await server.close();
  }
});

Deno.test("runtime.resolveSpaceName: a joiner shares a failed resolution's rejection rather than retrying on its own", async () => {
  const user = await Identity.fromPassphrase("acl genesis joiner user");
  const server = createServer("runner-acl-genesis-joiner");
  const factory = new RecordingLoopbackSessionFactory(server);
  (factory as { supportsAclBootstrap: boolean }).supportsAclBootstrap = false;
  const manager = TestStorageManager.overServer({ as: user }, factory);
  let registrations = 0;
  // Every registration is refused (the factory cannot bootstrap); count them.
  const counting = new Proxy(manager, {
    get(target, property, receiver) {
      if (property === "registerSpaceIdentity") {
        return (...args: unknown[]) => {
          registrations++;
          return (target.registerSpaceIdentity as (...a: unknown[]) => void)(
            ...args,
          );
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: counting,
  });
  try {
    // Red-first witnessed: the joiner swallowed the first rejection and ran
    // a second registration attempt of its own (registrations === 2).
    const outcomes = await Promise.allSettled([
      runtime.resolveSpaceName("genesis-acl-joiner", {
        genesisAcl: { [user.did()]: "OWNER" },
      }),
      runtime.resolveSpaceName("genesis-acl-joiner", {
        genesisAcl: { [user.did()]: "OWNER" },
      }),
    ]);
    assertEquals(outcomes.map((o) => o.status), ["rejected", "rejected"]);
    for (const outcome of outcomes) {
      assert(
        String((outcome as PromiseRejectedResult).reason).includes(
          "cannot bootstrap",
        ),
      );
    }
    assertEquals(registrations, 1, "one attempt, shared by both callers");
    assertEquals(runtime.resolveSpaceNameSync("genesis-acl-joiner"), undefined);
  } finally {
    await runtime.dispose();
    await manager.close();
    await server.close();
  }
});

Deno.test("custom root genesis snapshots preserve typed Fabric links", async () => {
  const user = await Identity.fromPassphrase("root link snapshot user");
  const spaceIdentity = await Identity.fromPassphrase(
    "root link snapshot space",
  );
  const space = spaceIdentity.did();
  const server = createServer("root-link-snapshot");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  const link = new FabricLink({
    id: "of:fid1:target",
    space,
    scope: "user",
    path: ["nested"],
  });
  try {
    manager.registerSpaceIdentity(spaceIdentity, {
      genesisAcl: { [user.did()]: "OWNER" },
      genesisRoot: {
        source: "system:loom/main.tsx",
        cause: "root-link",
        argument: { target: link },
      },
    });
    const sync = await manager.open(space).sync(`of:${space}` as URI);
    assert(!sync.error, sync.error?.message);
    const stored = readGenesisRoot(await server.engineForSpace(space));
    assert(stored?.argument?.target instanceof FabricLink);
    assertEquals(stored.argument.target.payload, link.payload);
    assertEquals(stored.argument.target.payload, {
      id: "of:fid1:target",
      space,
      scope: "user",
      path: ["nested"],
    });
    assertEquals(
      factory.sessions.map((entry) => entry.requested.genesisRoot),
      factory.sessions.map(() => stored),
      "Every mount, including the space-key bootstrap, declares the complete root intent",
    );
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("custom root resume requires the complete original intent", async () => {
  const user = await Identity.fromPassphrase("root intent user");
  const spaceIdentity = await Identity.fromPassphrase("root intent space");
  const space = spaceIdentity.did();
  const server = createServer("root-intent");
  const genesisRoot = {
    source: "system:loom/main.tsx",
    cause: "root-intent",
    sourceRoots: ["system:loom/main.test.tsx"],
    argument: { title: "Original" },
  };
  async function open(root: typeof genesisRoot) {
    const manager = TestStorageManager.overServer(
      { as: user },
      new RecordingLoopbackSessionFactory(server),
    );
    try {
      manager.registerSpaceIdentity(spaceIdentity, {
        genesisAcl: { [user.did()]: "OWNER" },
        genesisRoot: root,
      });
      return await manager.open(space).sync(`of:${space}` as URI);
    } finally {
      await manager.close();
    }
  }
  try {
    assert(!(await open(genesisRoot)).error);
    assert(!(await open(genesisRoot)).error);
    for (
      const changed of [
        { ...genesisRoot, source: "system:system/default-app.tsx" },
        { ...genesisRoot, argument: { title: "Changed" } },
        { ...genesisRoot, sourceRoots: [] },
        { ...genesisRoot, cause: "changed-cause" },
      ]
    ) {
      const result = await open(changed);
      assert(result.error, "A different root intent must fail closed");
      assert(
        result.error.message.includes("root intent"),
        result.error.message,
      );
    }
  } finally {
    await server.close();
  }
});

Deno.test("concurrent custom-root sealers converge with an explicit management owner", async () => {
  const user = await Identity.fromPassphrase("root race manager");
  const spaceIdentity = await Identity.fromPassphrase("root race space");
  const space = spaceIdentity.did();
  const server = createServer("root-race");
  const barrier = Promise.withResolvers<void>();
  let arrivals = 0;
  class ConcurrentFactory extends RecordingLoopbackSessionFactory {
    override async create(
      space: MemorySpace,
      signer?: Signer,
      requested: MemoryV2Client.MountOptions = {},
    ) {
      const opened = await super.create(space, signer, requested);
      if (signer?.did() === spaceIdentity.did()) {
        const transact = opened.session.transact.bind(opened.session);
        opened.session.transact = async (
          ...args: Parameters<typeof transact>
        ) => {
          if (args[0].genesisRoot) {
            if (++arrivals === 2) barrier.resolve();
            await barrier.promise;
          }
          return await transact(...args);
        };
      }
      return opened;
    }
  }
  const managers = [0, 1].map(() =>
    TestStorageManager.overServer({ as: user }, new ConcurrentFactory(server))
  );
  try {
    for (const manager of managers) {
      manager.registerSpaceIdentity(spaceIdentity, {
        genesisAcl: { [user.did()]: "OWNER" },
        genesisRoot: { source: "system:loom/main.tsx", cause: "same-root" },
      });
    }
    const results = await Promise.all(
      managers.map((manager) => manager.open(space).sync(`of:${space}` as URI)),
    );
    for (const result of results) assert(!result.error, result.error?.message);
  } finally {
    await Promise.all(managers.map((manager) => manager.close()));
    await server.close();
  }
});
