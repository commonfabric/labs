import { expect } from "@std/expect";
import { FabricLink } from "@commonfabric/data-model/fabric-instances";
import { readGenesisRoot } from "@commonfabric/memory/v2/genesis-root";
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  selectCommitsSince,
  selectDocHead,
} from "@commonfabric/memory/v2/engine";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
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
    delegatingDids?: readonly string[];
  } = {},
): MemoryV2Server.Server =>
  new MemoryV2Server.Server({
    store: options.store ?? new URL(`memory://${label}`),
    authorizeSessionOpen: authorizeLoopbackSessionOpen,
    sessionOpenAuth: { audience: TEST_AUDIENCE },
    acl: {
      mode: options.mode ?? "enforce",
      delegatingDids: options.delegatingDids,
    },
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

Deno.test("storage ACL bootstrap leaves a populated home space without an ACL as it stands", async () => {
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
      // Only a space with no history is born on open; the server grants a
      // space's own DID nothing past that.
      assertEquals(await server.readDocument(space, `of:${space}`), null);
      assertEquals(factory.principals, [space]);
    } finally {
      await manager.close();
      await server.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("storage ACL bootstrap does not recreate a retracted home ACL, which fails closed for its user", async () => {
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
      // A retracted ACL fails closed for everyone, the space's own DID
      // included, and opening never writes a new one.
      const sync = await manager.open(space).sync(aclId);
      expect(sync.error?.message).toContain(
        "malformed, ownerless, or retracted ACL",
      );
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
  const space = (await Identity.fromPassphrase(
    "acl bootstrap populated named space",
  )).did();
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
    const manager = TestStorageManager.overServer({ as: user }, factory);
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

Deno.test("opening a DID with no history writes nothing, and nothing can be written to it", async () => {
  const user = await Identity.fromPassphrase("acl bootstrap unused did user");
  const space = (await Identity.generate()).did();
  const server = createServer("runner-acl-bootstrap-unused-did");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  try {
    const sync = await manager.open(space).sync(`of:${space}` as URI);
    assert(!sync.error, sync.error?.message);
    assertEquals(await server.readDocument(space, `of:${space}`), null);
    assertEquals(factory.principals, [user.did()]);

    const direct = await new RecordingLoopbackSessionFactory(server).create(
      space,
      user,
    );
    try {
      await assertRejects(
        () =>
          direct.session.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:uninvited",
              value: { value: { written: true } },
            }],
          }),
        Error,
        "requires an ACL genesis commit",
      );
    } finally {
      await direct.client.close();
    }
    assertEquals(await server.readDocument(space, `of:${space}`), null);
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("createSpace writes its ACL as the new space's first and only commit, signed as the space", async () => {
  const user = await Identity.fromPassphrase("acl create user");
  const server = createServer("runner-acl-create");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  try {
    const space = await manager.createSpace({ [user.did()]: "OWNER" });
    assertEquals(
      (await server.readDocument(space, `of:${space}`))?.value,
      { [user.did()]: "OWNER" },
    );
    assertEquals(
      selectCommitsSince(await server.engineForSpace(space), { fromSeq: 0 })
        .length,
      1,
    );
    // The one session creation opened authenticated as the space itself.
    assertEquals(factory.principals, [space]);

    const sync = await manager.open(space).sync("of:after-create" as URI);
    assert(!sync.error, sync.error?.message);
    assertEquals(factory.principals, [space, user.did()]);
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("createSpace gives every space a new DID", async () => {
  const user = await Identity.fromPassphrase("acl create twice user");
  const server = createServer("runner-acl-create-twice");
  const manager = TestStorageManager.overServer(
    { as: user },
    new RecordingLoopbackSessionFactory(server),
  );
  try {
    const acl = { [user.did()]: "OWNER" as const };
    const first = await manager.createSpace(acl);
    const second = await manager.createSpace(acl);
    assert(first !== second, "two creations reached one space");
    assert(first !== user.did() && second !== user.did());
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("createSpace grants nobody but the creator, unless the document says so", async () => {
  const user = await Identity.fromPassphrase("acl create private user");
  const guest = await Identity.fromPassphrase("acl create private guest");
  const server = createServer("runner-acl-create-private");
  const manager = TestStorageManager.overServer(
    { as: user },
    new RecordingLoopbackSessionFactory(server),
  );
  const guestFactory = new RecordingLoopbackSessionFactory(server);
  try {
    const closed = await manager.createSpace({ [user.did()]: "OWNER" });
    await assertRejects(
      () => guestFactory.create(closed, guest),
      Error,
      "lacks READ",
    );

    const readable = await manager.createSpace({
      [user.did()]: "OWNER",
      "*": "READ",
    });
    const opened = await guestFactory.create(readable, guest);
    try {
      await assertRejects(
        () =>
          opened.session.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:guest-write",
              value: { value: { written: true } },
            }],
          }),
        Error,
        "lacks WRITE",
      );
    } finally {
      await opened.client.close();
    }
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("createSpace rejects a document the server refuses, and the space stays uninitialized", async () => {
  const user = await Identity.fromPassphrase("acl create refused user");
  const server = createServer("runner-acl-create-refused");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  try {
    await assertRejects(
      () => manager.createSpace({ "*": "OWNER", [user.did()]: "WRITE" }),
      Error,
      "concrete OWNER",
    );
    const [space] = factory.sessions.map((entry) => entry.space);
    assertExists(space);
    assertEquals(await server.readDocument(space, `of:${space}`), null);
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("a manager reused after close() mounts its NEW session id (no stale detached resume survives close)", async () => {
  const user = await Identity.fromPassphrase("acl genesis reuse user");
  const server = createServer("runner-acl-genesis-reuse");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  try {
    const space = await manager.createSpace({ [user.did()]: "OWNER" });
    const first = await manager.open(space).sync(`of:${space}` as URI);
    assert(!first.error, first.error?.message);
    const firstId = manager.scopeKeyIdentity().sessionId;
    await manager.close();
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

Deno.test("createSpace reserves a custom root in the genesis commit, typed links intact", async () => {
  const user = await Identity.fromPassphrase("root link snapshot user");
  const server = createServer("root-link-snapshot");
  const factory = new RecordingLoopbackSessionFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  const link = new FabricLink({
    id: "of:fid1:target",
    space: "did:key:z6Mk-root-link-target",
    scope: "user",
    path: ["nested"],
  });
  try {
    const space = await manager.createSpace({ [user.did()]: "OWNER" }, {
      source: "system:loom/main.tsx",
      cause: "root-link",
      argument: { target: link },
    });
    const stored = readGenesisRoot(await server.engineForSpace(space));
    assert(stored?.argument?.target instanceof FabricLink);
    assertEquals(stored.argument.target.payload, link.payload);
    assertEquals(factory.sessions[0].requested.genesisRoot, stored);
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("a mount that declares a root intent must match the space's reserved root", async () => {
  const user = await Identity.fromPassphrase("root intent user");
  const server = createServer("root-intent");
  const genesisRoot = {
    source: "system:loom/main.tsx",
    cause: "root-intent",
    sourceRoots: ["system:loom/main.test.tsx"],
    argument: { title: "Original" },
  };
  const manager = TestStorageManager.overServer(
    { as: user },
    new RecordingLoopbackSessionFactory(server),
  );
  const factory = new RecordingLoopbackSessionFactory(server);
  try {
    const space = await manager.createSpace(
      { [user.did()]: "OWNER" },
      genesisRoot,
    );
    for (const intent of [undefined, genesisRoot]) {
      const opened = await factory.create(space, user, {
        ...(intent === undefined ? {} : { genesisRoot: intent }),
      });
      await opened.client.close();
    }
    for (
      const changed of [
        { ...genesisRoot, source: "system:system/default-app.tsx" },
        { ...genesisRoot, argument: { title: "Changed" } },
        { ...genesisRoot, sourceRoots: [] },
        { ...genesisRoot, cause: "changed-cause" },
      ]
    ) {
      await assertRejects(
        () => factory.create(space, user, { genesisRoot: changed }),
        Error,
        "root intent",
      );
    }
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("createSpace refuses a root on a host that does not advertise reservations, and writes nothing", async () => {
  const user = await Identity.fromPassphrase(
    "unsupported genesis root manager",
  );
  const server = createServer("unsupported-genesis-root");
  class UnadvertisedRootFactory extends RecordingLoopbackSessionFactory {
    override async create(
      space: MemorySpace,
      signer?: Signer,
      requested: MemoryV2Client.MountOptions = {},
    ) {
      const opened = await super.create(space, signer, requested);
      Object.defineProperty(opened.client, "serverFlags", {
        value: { ...opened.client.serverFlags, genesisRoot: false },
      });
      return opened;
    }
  }
  const factory = new UnadvertisedRootFactory(server);
  const manager = TestStorageManager.overServer({ as: user }, factory);
  try {
    await assertRejects(
      () =>
        manager.createSpace({ [user.did()]: "OWNER" }, {
          source: "system:loom/main.tsx",
          cause: "unsupported-root",
        }),
      Error,
      "Host does not support genesis root reservations",
    );
    const [space] = factory.sessions.map((entry) => entry.space);
    const engine = await server.engineForSpace(space);
    expect(selectDocHead(engine, { id: `of:${space}`, scopeKey: "space" }))
      .toBe(0);
    expect(readGenesisRoot(engine)).toBeUndefined();
  } finally {
    await manager.close();
    await server.close();
  }
});

Deno.test("runtime.createSpace names the runtime's identity OWNER beside the grants", async () => {
  const user = await Identity.fromPassphrase("runtime create user");
  const server = createServer("runtime-create");
  const manager = TestStorageManager.overServer(
    { as: user },
    new RecordingLoopbackSessionFactory(server),
  );
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: manager,
  });
  try {
    const space = await runtime.createSpace({ grants: { "*": "READ" } });
    assertEquals(
      (await server.readDocument(space, `of:${space}`))?.value,
      { "*": "READ", [user.did()]: "OWNER" },
    );
    assert(await runtime.spaceExists(space));
    assertEquals(
      await runtime.spaceExists((await Identity.generate()).did()),
      false,
    );
  } finally {
    await runtime.dispose();
    await manager.close();
    await server.close();
  }
});

Deno.test("a READ member can cold-start a shared piece without persisting its scoped default", async () => {
  const owner = await Identity.fromPassphrase("scoped-default-acl-owner");
  const reader = await Identity.fromPassphrase("scoped-default-acl-reader");
  const server = createServer("scoped-default-read-only-start");
  const factory = new RecordingLoopbackSessionFactory(server);
  const ownerStorage = TestStorageManager.overServer({ as: owner }, factory);
  const readerStorage = TestStorageManager.overServer({ as: reader }, factory);
  const open = (storageManager: TestStorageManager) =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: false },
    });
  const author = open(ownerStorage);
  const viewer = open(readerStorage);
  try {
    const space = await ownerStorage.createSpace({
      [owner.did()]: "OWNER",
      [reader.did()]: "READ",
    });
    const compiled = await author.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `import { pattern, Writable } from "commonfabric";
      export default pattern<Record<string, never>, { title: string; draft: Writable<{title:string}> }>(() => ({
        title: "Shared", draft: Writable.perUser.of({title:""}),
      }));`,
      }],
    }, { space });
    const original = author.getCell(space, "read-only-scoped-draft");
    await author.runSynced(original, compiled, {});
    await author.idle();
    author.runner.stop(original);

    const reached = viewer.getCellFromLink(original.getAsNormalizedFullLink())
      .asSchema(compiled.resultSchema);
    const deniedBeforeStart = server.aclStats.denied;
    expect(await viewer.start(reached)).toBe(true);
    await viewer.idle();
    expect(server.aclStats.denied).toBe(deniedBeforeStart);
    expect(reached.key("title").get()).toBe("Shared");
    expect(reached.key("draft").get()).toEqual({ title: "" });
    expect(reached.key("draft").resolveAsCell().getRawUntyped())
      .toBeUndefined();

    for (const live of [false, true]) {
      const title = live ? "Already loaded update" : "Cold loaded update";
      const program = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `import { pattern, Writable } from "commonfabric";
        export default pattern<Record<string, never>, { title: string; draft: Writable<{title:string}> }>(() => ({
          title: ${
            JSON.stringify(title)
          }, draft: Writable.perUser.of({title:""}),
        }));`,
        }],
      };
      const updated = await author.patternManager.compilePattern(program, {
        space,
      });
      if (live) await viewer.patternManager.compilePattern(program);
      await author.runSynced(original, updated, {}, { start: false });
      await author.idle();
      await reached.sync();
      await viewer.runner.idlePointerMaintenance();
      await viewer.idle();
      expect(reached.key("title").get()).toBe(title);
      expect(reached.key("draft").resolveAsCell().getRawUntyped())
        .toBeUndefined();
      expect(server.aclStats.denied).toBe(deniedBeforeStart);
    }

    const denied = viewer.edit();
    reached.key("draft").withTx(denied).set({ title: "unauthorized" });
    expect((await denied.commit().settled).error?.name).toBe(
      "AuthorizationError",
    );
    expect(original.key("title").get()).toBe("Already loaded update");
  } finally {
    await viewer.dispose({ closeStorage: false });
    await author.dispose({ closeStorage: false });
    await readerStorage.close();
    await ownerStorage.close();
    await server.close();
  }
});
