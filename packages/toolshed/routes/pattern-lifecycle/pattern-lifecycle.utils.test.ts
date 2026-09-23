import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { EntityDocument } from "@commonfabric/memory/v2";
import { verifySessionOpenAuthorization } from "@commonfabric/memory/v2/session-open-auth";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { entityIdFrom, isStream, Runtime } from "@commonfabric/runner";
import { PiecesController } from "@commonfabric/piece/ops";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { LoopbackStorageManager } from "@commonfabric/runner/executor/loopback-storage";
import {
  createAclServer,
  genesisAcl,
  LoopbackSessionFactory,
  TestStorageManager,
} from "@/lib/test-support/memory-acl.ts";
import {
  type LifecycleDeps,
  type LifecycleResult,
  processInstantiate,
  processSetSource,
  processUpload,
} from "./pattern-lifecycle.utils.ts";

const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ seed?: string }, { label: string }>(",
      "  ({ seed }) => ({ label: seed ?? 'unset' }),",
      ");",
      "",
    ].join("\n"),
  }],
};

const NUMERIC_SEED_PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ seed?: number }, { label: string }>(",
      "  ({ seed }) => ({ label: String(seed ?? 0) }),",
      ");",
      "",
    ].join("\n"),
  }],
};

/** Narrow a result to its success body, failing loudly otherwise. */
const ok = <T>(result: LifecycleResult<T>): T => {
  assert(
    result.status === 200,
    `expected 200, got ${result.status}: ${JSON.stringify(result.body)}`,
  );
  return result.body;
};

/** Narrow a result to its refusal, failing loudly otherwise. */
const refused = (result: LifecycleResult<unknown>) => {
  assert(result.status !== 200, "expected a refusal");
  return { status: result.status, ...result.body };
};

describe("pattern-lifecycle verbs (transport half)", () => {
  // Authorization against a real ACL document, and the verbs against a
  // real serving host. The memory server's own enforcement is off so the
  // serving side's loopback sessions need no grant; what is under test is
  // the writer check the route makes against the ACL, and the routing of a
  // verb into the host and of its outcome into a status.

  let server: MemoryV2Server.Server;
  let factory: LoopbackSessionFactory;
  let operator: Identity;
  let alice: Identity;
  let bob: Identity;
  let mallory: Identity;
  let spaceIdentity: Identity;
  let space: string;
  let storageManager: TestStorageManager;
  let runtime: Runtime;
  let host: ExecutorHost | undefined;
  let deps: LifecycleDeps;

  /** A serving host over the test server, holding leases as `serviceDid`. */
  const newHost = (serviceDid: string): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceDid,
      createRuntime: (servedSpace) => {
        const manager = LoopbackStorageManager.connect(server, {
          as: operator,
          servingHomeSpace: servedSpace,
        });
        const serving = new Runtime({
          apiUrl: new URL("https://pl-test.invalid"),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        return Promise.resolve({
          runtime: serving,
          dispose: async () => {
            await serving.dispose();
            await manager.close();
          },
        });
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      ensureSpaceRoots: false,
    });

  beforeEach(async () => {
    server = createAclServer(
      `pattern-lifecycle-${crypto.randomUUID()}`,
      "off",
    );
    factory = new LoopbackSessionFactory(server);
    operator = await Identity.fromPassphrase("pl-operator");
    alice = await Identity.fromPassphrase("pl-alice");
    bob = await Identity.fromPassphrase("pl-bob");
    mallory = await Identity.fromPassphrase("pl-mallory");
    spaceIdentity = await Identity.fromPassphrase("pl-space");
    space = spaceIdentity.did();
    storageManager = TestStorageManager.overServer({ as: operator }, factory);
    runtime = new Runtime({
      apiUrl: new URL("https://pl-test.invalid"),
      storageManager,
    });
    host = newHost(operator.did());
    deps = {
      authority: {
        runtime,
        operatorDid: operator.did(),
        serviceDids: [],
        hostsSpace: () => true,
        aclMode: "enforce",
      },
      host: () => host,
      serviceIdentity: operator,
      append: (entry) => server.commitDelegatedAppend(entry),
      readDocument: (space, id) => server.readDocument(space, id),
      watchAdmittedCommits: (watcher) => server.watchAdmittedCommits(watcher),
    };
    await genesisAcl(factory, spaceIdentity, {
      [alice.did()]: "OWNER",
      [bob.did()]: "WRITE",
      [operator.did()]: "READ",
    });
  });

  afterEach(async () => {
    await host?.close();
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  it("registers and retries in a private space when the process has delegation authority only", async () => {
    await host?.close();
    await runtime.dispose();
    await storageManager.close();
    await server.close();
    server = new MemoryV2Server.Server({
      store: new URL(`memory://private-registration-${crypto.randomUUID()}`),
      authorizeSessionOpen(message, context) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string"
          ? principal
          : verifySessionOpenAuthorization(message, context);
      },
      sessionOpenAuth: {
        audience: "did:key:z6Mk-private-registration-audience",
      },
      acl: { mode: "enforce", delegatingDids: [operator.did()] },
      subscriptionRefreshDelayMs: 0,
    });
    factory = new LoopbackSessionFactory(server);
    storageManager = TestStorageManager.overServer({ as: operator }, factory);
    runtime = new Runtime({
      apiUrl: new URL("https://pl-test.invalid"),
      storageManager,
    });
    host = newHost(operator.did());
    const acl = { [alice.did()]: "OWNER", [bob.did()]: "WRITE" } as const;
    await genesisAcl(factory, spaceIdentity, acl);
    deps = {
      ...deps,
      authority: {
        ...deps.authority,
        runtime,
        readAcl: async (target) =>
          (await server.readDocument(target, `of:${target}`))?.value,
      },
      host: () => host,
      append: (entry) => server.commitDelegatedAppend(entry),
      readDocument: (space, id) => server.readDocument(space, id),
      watchAdmittedCommits: (watcher) => server.watchAdmittedCommits(watcher),
    };
    const ownerStorage = TestStorageManager.overServer({ as: alice }, factory);
    const ownerRuntime = new Runtime({
      apiUrl: new URL("https://pl-test.invalid"),
      storageManager: ownerStorage,
    });
    try {
      const root = ok(
        await processInstantiate(deps, alice.did(), {
          space,
          program: {
            main: "/main.tsx",
            files: [{
              name: "/main.tsx",
              contents: `
import { computed, handler, pattern, Writable } from "commonfabric";
const addPiece = handler<{piece: Writable<unknown>}, {panels: Writable<Writable<unknown>[]>}>(({piece}, {panels}) => panels.addUnique(piece));
export default pattern(() => {
  const panels = new Writable<Writable<unknown>[]>([]);
  return {panels, pieceRegistry: computed(() => panels.get().map(piece => piece)), addPiece: addPiece({panels})};
});`,
            }],
          },
          register: false,
        }),
      );
      const owner = new PiecesController(
        await createSession({ identity: alice, spaceDid: spaceIdentity.did() }),
        ownerRuntime,
      );
      await owner.ready;
      await owner.linkDefaultPattern(
        ownerRuntime.getCellFromEntityId(
          space as MemorySpace,
          entityIdFrom(root.pieceId),
        ),
      );
      const request = {
        space,
        program: PROGRAM,
        register: true,
        requestKey: "private-created-and-registered",
      };
      const created = ok(await processInstantiate(deps, bob.did(), request));
      expect(created.registration.error).toBeUndefined();
      expect(created.registration).toMatchObject({ status: "handled" });
      const repeated = ok(await processInstantiate(deps, bob.did(), request));
      expect(repeated).toEqual(created);
      expect((await owner.getRegisteredPieces()).map((piece) => piece.id))
        .toEqual([created.pieceId]);
      expect((await server.readDocument(space, `of:${space}`))?.value).toEqual(
        acl,
      );
    } finally {
      await ownerRuntime.dispose();
      await ownerStorage.close();
    }
  });

  it("refuses foreign registration targets before observing private events or appending", async () => {
    const foreign = await Identity.fromPassphrase(
      "pl-private-registration-target",
    );
    await genesisAcl(factory, foreign, { [mallory.did()]: "OWNER" });
    const foreignRoot = ok(
      await processInstantiate(deps, mallory.did(), {
        space: foreign.did(),
        register: false,
        program: {
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: `
import { computed, handler, pattern, Writable } from "commonfabric";
const addPiece = handler<{piece: Writable<unknown>}, {panels: Writable<Writable<unknown>[]>}>(({piece}, {panels}) => panels.addUnique(piece));
export default pattern(() => {
  const panels = new Writable<Writable<unknown>[]>([]);
  return {pieceRegistry: computed(() => panels.get().map(piece => piece)), addPiece: addPiece({panels})};
});`,
          }],
        },
      }),
    );
    const local = new PiecesController(
      await createSession({ identity: alice, spaceDid: spaceIdentity.did() }),
      runtime,
    );
    await local.ready;
    const foreignHandler = await runtime.getCellFromEntityId(
      foreign.did(),
      entityIdFrom(foreignRoot.pieceId),
    ).asSchema({
      type: "object",
      properties: { addPiece: { asCell: ["stream"] } },
    }).key("addPiece").pull();
    expect(isStream(foreignHandler)).toBe(true);
    const localRoot = runtime.getCell(
      space as MemorySpace,
      "foreign-handler-local-root",
    );
    await localRoot.sync();
    const seeded = await runtime.editWithRetry((tx) =>
      localRoot.withTx(tx).set({
        addPiece: foreignHandler,
        pieceRegistry: [],
      })
    );
    expect(seeded.error).toBeUndefined();
    await local.linkDefaultPattern(localRoot);
    const operations: string[] = [];
    const result = ok(
      await processInstantiate(
        {
          ...deps,
          readDocument: () => {
            operations.push("read event sidecar");
            throw new Error("Private target event details");
          },
          append: () => {
            operations.push("append event");
            throw new Error("Unauthorized target append");
          },
          watchAdmittedCommits: (watcher) => {
            operations.push("watch event sidecar");
            return server.watchAdmittedCommits(watcher);
          },
        },
        bob.did(),
        {
          space,
          program: PROGRAM,
          register: true,
          requestKey: "foreign-handler-refusal",
        },
      ),
    );
    expect(operations).toEqual([]);
    expect(result.registration.status).toBe("failed");
    expect(result.registration.error).toContain(
      "Not authorized to write to that space",
    );
    expect(result.registration.terminal).toBeUndefined();
  });

  for (
    const mode of [
      "terminal",
      "terminal-with-late-notice",
      "uncertain",
      "readback-unavailable",
    ] as const
  ) {
    it(`retains ${mode} registration evidence after an append response fails`, async () => {
      const root = ok(
        await processInstantiate(deps, alice.did(), {
          space,
          register: false,
          program: {
            main: "/main.tsx",
            files: [{
              name: "/main.tsx",
              contents: `
import { computed, handler, pattern, Writable } from "commonfabric";
const addPiece = handler<{piece: Writable<unknown>}, {panels: Writable<Writable<unknown>[]>}>(({piece}, {panels}) => panels.addUnique(piece));
export default pattern(() => {
  const panels = new Writable<Writable<unknown>[]>([]);
  return {pieceRegistry: computed(() => panels.get().map(piece => piece)), addPiece: addPiece({panels})};
});`,
            }],
          },
        }),
      );
      const owner = new PiecesController(
        await createSession({ identity: alice, spaceDid: spaceIdentity.did() }),
        runtime,
      );
      await owner.ready;
      await owner.linkDefaultPattern(runtime.getCellFromEntityId(
        space as MemorySpace,
        entityIdFrom(root.pieceId),
      ));
      const terminal = mode.startsWith("terminal");
      let retained: EntityDocument | null = null;
      let delivery: Parameters<LifecycleDeps["append"]>[0] | undefined;
      const eventIds: string[] = [];
      let cancelled = 0;
      let reads = 0;
      const transport: LifecycleDeps = {
        ...deps,
        readDocument: () => {
          reads++;
          if (mode === "readback-unavailable") {
            return Promise.reject(new Error("readback unavailable"));
          }
          return Promise.resolve(retained);
        },
        append: async (entry) => {
          eventIds.push(entry.eventId);
          delivery = entry;
          await Promise.resolve();
          retained = terminal
            ? {
              value: {
                entries: [{
                  eventId: entry.eventId,
                  status: "dropped",
                  reason: "handler refused",
                }],
              },
            }
            : null;
          throw new Error("append acknowledgement lost");
        },
        watchAdmittedCommits: (watcher) => () => {
          cancelled++;
          if (mode === "terminal-with-late-notice" && delivery) {
            watcher({
              space: delivery.targetSpace,
              seq: 1,
              class: "derived",
              sessionId: "queued-before-disposal",
              writes: [{ id: delivery.targetStream, scopeKey: "space" }],
            });
          }
        },
      };
      const request = {
        space,
        program: PROGRAM,
        register: true,
        requestKey: `append-${mode}`,
      };
      const first = ok(await processInstantiate(transport, bob.did(), request));
      expect(first.registration.status).toBe("failed");
      expect(first.registration.terminal).toBe(
        terminal ? true : undefined,
      );
      expect(first.registration.error).toContain(
        terminal ? "handler refused" : "acknowledgement lost",
      );
      retained = null;
      const retry = ok(await processInstantiate(transport, bob.did(), request));
      expect(retry.pieceId).toBe(first.pieceId);
      expect(eventIds).toHaveLength(2);
      if (terminal) expect(eventIds[1]).not.toBe(eventIds[0]);
      else expect(eventIds[1]).toBe(eventIds[0]);
      expect(cancelled).toBe(2);
      expect(reads).toBeGreaterThanOrEqual(4);
      if (mode === "terminal-with-late-notice") expect(reads).toBe(4);
    });
  }

  for (const refusalAt of [2, 3]) {
    it(`preserves the durable creation receipt when registration phase ${refusalAt} loses authority`, async () => {
      let reads = 0;
      const request = {
        space,
        program: PROGRAM,
        register: true,
        requestKey: "withdrawn-after-creation",
      };
      const result = ok(
        await processInstantiate(
          {
            ...deps,
            authority: {
              ...deps.authority,
              readAcl: () =>
                Promise.resolve({
                  [alice.did()]: "OWNER",
                  [bob.did()]: ++reads < refusalAt ? "WRITE" : "READ",
                }),
            },
          },
          bob.did(),
          request,
        ),
      );
      expect(reads).toBe(refusalAt);
      expect(result.requestKey).toBe(request.requestKey);
      expect(result.pieceId).toMatch(/\S/);
      expect(result.registration.status).toBe("failed");
      expect(result.registration.terminal).toBeUndefined();
      const repeated = ok(await processInstantiate(deps, bob.did(), request));
      expect(repeated.pieceId).toBe(result.pieceId);
    });
  }

  it("refuses a caller the ACL names as a reader only, and one it does not name", async () => {
    const mallorySees = refused(
      await processInstantiate(deps, mallory.did(), {
        space,
        program: PROGRAM,
      }),
    );
    expect(mallorySees.status).toBe(403);
    expect(mallorySees.code).toBe("forbidden");
    const operatorSees = refused(
      await processInstantiate(deps, operator.did(), {
        space,
        program: PROGRAM,
      }),
    );
    expect(operatorSees.status).toBe(403);
    // Refused before the host saw anything.
    expect(host!.stats().lifecycleVerbs.runs).toBe(0);
  });

  it("answers 503 with its own code on a deployment without the serving loop", async () => {
    const seen = refused(
      await processInstantiate(
        { ...deps, host: () => undefined },
        alice.did(),
        { space, program: PROGRAM },
      ),
    );
    expect(seen.status).toBe(503);
    expect(seen.code).toBe("server-execution-off");
  });

  it("refuses a request naming both a program and a pattern, or neither", async () => {
    const both = refused(
      await processInstantiate(deps, alice.did(), {
        space,
        program: PROGRAM,
        pattern: { identity: "x", symbol: "default" },
      }),
    );
    expect(both.status).toBe(400);
    expect(both.code).toBe("invalid-source");
    const neither = refused(
      await processInstantiate(deps, alice.did(), { space }),
    );
    expect(neither.status).toBe(400);
  });

  it("returns the same durable piece when a caller repeats its request key", async () => {
    const input = {
      space,
      program: PROGRAM,
      requestKey: "creation-retry",
      register: false,
    };
    const first = ok(await processInstantiate(deps, alice.did(), input));
    const retry = ok(await processInstantiate(deps, alice.did(), input));
    expect(retry.pieceId).toBe(first.pieceId);
    expect(retry.requestKey).toBe("creation-retry");
  });

  it("instantiates for an owner and for a writer, and uploads the pattern they share", async () => {
    const created = ok(
      await processInstantiate(deps, alice.did(), {
        space,
        program: PROGRAM,
        argument: { seed: "one" },
      }),
    );
    expect(created.pieceId).toMatch(/\S/);
    expect(created.pattern.symbol).toBe("default");
    const byWriter = ok(
      await processInstantiate(deps, bob.did(), { space, program: PROGRAM }),
    );
    expect(byWriter.pattern).toEqual(created.pattern);

    const uploaded = ok(
      await processUpload(deps, alice.did(), { space, program: PROGRAM }),
    );
    expect(uploaded.pattern).toEqual(created.pattern);
  });

  it("replaces a piece's source for a writer, and maps its refusals to their statuses", async () => {
    const created = ok(
      await processInstantiate(deps, alice.did(), {
        space,
        program: PROGRAM,
      }),
    );
    const updated = ok(
      await processSetSource(deps, bob.did(), {
        space,
        piece: created.pieceId,
        program: NUMERIC_SEED_PROGRAM,
        dangerouslyAllowIncompatibleSchema: true,
        start: false,
      }),
    );
    expect(updated.pieceId).toBe(created.pieceId);
    expect(updated.pattern.identity).not.toBe(created.pattern.identity);
    expect(updated.revisionId).toMatch(/\S/);
    expect(updated.seq).toBeGreaterThan(0);
    expect(updated.detachedOrigin).toBeNull();

    const incompatible = refused(
      await processSetSource(deps, alice.did(), {
        space,
        piece: created.pieceId,
        program: PROGRAM,
      }),
    );
    expect(incompatible.status).toBe(422);
    expect(incompatible.code).toBe("incompatible");

    const missing = refused(
      await processSetSource(deps, alice.did(), {
        space,
        piece: "no-such-piece",
        program: PROGRAM,
      }),
    );
    expect(missing.status).toBe(404);
    expect(missing.code).toBe("piece-not-found");

    const moved = refused(
      await processSetSource(deps, alice.did(), {
        space,
        piece: created.pieceId,
        program: PROGRAM,
        expectedPattern: created.pattern,
      }),
    );
    expect(moved.status).toBe(409);
    expect(moved.code).toBe("source-moved");

    const reader = refused(
      await processSetSource(deps, mallory.did(), {
        space,
        piece: created.pieceId,
        program: PROGRAM,
      }),
    );
    expect(reader.status).toBe(403);

    // A pattern the space already holds, by identity, moves the piece back.
    const restored = ok(
      await processSetSource(deps, alice.did(), {
        space,
        piece: created.pieceId,
        pattern: created.pattern,
        dangerouslyAllowIncompatibleSchema: true,
      }),
    );
    expect(restored.pattern).toEqual(created.pattern);

    const sourceless = refused(
      await processSetSource(deps, alice.did(), {
        space,
        piece: created.pieceId,
      }),
    );
    expect(sourceless.status).toBe(400);
    expect(sourceless.code).toBe("invalid-source");
  });

  it("maps a compile failure to 422", async () => {
    const broken = refused(
      await processInstantiate(deps, alice.did(), {
        space,
        program: {
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: "export default nope;" }],
        },
      }),
    );
    expect(broken.status).toBe(422);
    expect(broken.code).toBe("compile-failed");
  });

  it("answers 500 with its own code when the verb fails for a reason it does not name", async () => {
    const failing = {
      runLifecycleVerb: () => Promise.reject(new Error("the loop fell over")),
    } as unknown as ExecutorHost;
    const seen = refused(
      await processUpload(
        { ...deps, host: () => failing },
        alice.did(),
        { space, program: PROGRAM },
      ),
    );
    expect(seen.status).toBe(500);
    expect(seen.code).toBe("internal");
    expect(seen.error).toContain("the loop fell over");
  });

  it("answers 503 when the space is served elsewhere", async () => {
    // Another holder's unexpired lease: this deployment's host cannot
    // acquire, so the verb cannot run here. The host built in beforeEach
    // activated the space when the genesis session opened, so it parks
    // first, a rival takes the lease, and a fresh host stands in for it.
    await host!.close();
    const rival = newHost((await Identity.fromPassphrase("pl-rival")).did());
    try {
      await rival.runLifecycleVerb(space as MemorySpace, {
        name: "hold",
        run: () => Promise.resolve(undefined),
      });
      host = newHost(operator.did());
      const seen = refused(
        await processInstantiate(deps, alice.did(), {
          space,
          program: PROGRAM,
        }),
      );
      expect(seen.status).toBe(503);
      expect(seen.code).toBe("space-not-served");
    } finally {
      await rival.close();
    }
  });
});
