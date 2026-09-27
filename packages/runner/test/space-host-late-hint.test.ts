import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { internSchema } from "@commonfabric/data-model-schema";
import {
  type Options,
  type SessionFactory,
  type SpaceReplica,
  StorageManager,
} from "../src/storage/v2.ts";
import type { ISpaceReplica } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import { loadSchemaDocument } from "../src/cfc/prepare.ts";
import {
  TEST_MEMORY_SERVER_AUTH,
  testPrincipalSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
  streamEntriesDocId,
} from "@commonfabric/memory/v2";

class LoopbackSessionFactory implements SessionFactory {
  readonly #serverForSpace: (
    space: MemorySpace,
  ) => MemoryV2Server.Server;

  constructor(
    serverForSpace: (
      space: MemorySpace,
    ) => MemoryV2Server.Server,
  ) {
    this.#serverForSpace = serverForSpace;
  }

  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryV2Client.MountOptions = {},
    _signal?: AbortSignal,
  ) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.#serverForSpace(space)),
    });
    const session = await client.mount(
      space,
      mountOptions,
      testPrincipalSessionOpenAuthFactory(signer),
    );
    return { client, session };
  }
}

class TestStorageManager extends StorageManager {
  static create(
    signer: Signer,
    sessionFactory: SessionFactory,
    memoryHost = new URL("https://default-toolshed.test"),
  ): TestStorageManager {
    return new TestStorageManager({
      as: signer,
      memoryHost,
    }, sessionFactory);
  }

  private constructor(options: Options, sessionFactory: SessionFactory) {
    super(options, sessionFactory);
  }
}

const makeServer = (name: string): MemoryV2Server.Server =>
  new MemoryV2Server.Server({
    store: new URL(`memory://${name}`),
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

/**
 * Pins that `replica` holds a record for `id` and no value under it: the
 * read reached this replica and found nothing. `getDocument()` reads
 * `undefined` for a document this replica never looked at as well. Each
 * caller below asserts before any transaction writes `id`, which is the
 * other way a record appears.
 */
function expectExaminedAbsent(replica: ISpaceReplica, id: URI): void {
  expect(
    (replica as SpaceReplica).accessForTestingOnly.hasDocumentRecord(id),
  ).toBe(true);
  expect(replica.getDocument(id)).toBeUndefined();
}

describe("late space host hints", () => {
  it("confirms the default host without rebuilding its provider", async () => {
    const signer = await Identity.fromPassphrase("matching-default-host-hint");
    const targetSpace = (await Identity.fromPassphrase(
      "matching-default-host-target",
    )).did();
    const targetId = "of:matching-default-host-target" as URI;
    const defaultServer = makeServer("matching-default-host");
    let targetSessions = 0;
    const manager = TestStorageManager.create(
      signer,
      new LoopbackSessionFactory(() => {
        targetSessions++;
        return defaultServer;
      }),
    );

    try {
      const provider = manager.open(targetSpace);
      const firstRead = await provider.sync(targetId, {
        path: [],
        schema: true,
      });
      expect(firstRead.error).toBeUndefined();
      expect(targetSessions).toBe(1);

      expect(
        manager.registerSpaceHost(
          targetSpace,
          "https://default-toolshed.test",
        ),
      ).toBe(true);
      await manager.crossSpaceSettled();

      expect(manager.open(targetSpace)).toBe(provider);
      expect(targetSessions).toBe(1);
      expect(
        manager.registerSpaceHost(
          targetSpace,
          "https://different-toolshed.test",
        ),
      ).toBe(false);
    } finally {
      await manager.close();
      await defaultServer.close();
    }
  });

  it("confirms the default host after the caller mutates the host URL", async () => {
    const signer = await Identity.fromPassphrase("mutated-default-host-hint");
    const targetSpace = (await Identity.fromPassphrase(
      "mutated-default-host-target",
    )).did();
    const targetId = "of:mutated-default-host-target" as URI;
    const defaultServer = makeServer("mutated-default-host");
    const memoryHost = new URL("https://default-toolshed.test");
    let targetSessions = 0;
    const manager = TestStorageManager.create(
      signer,
      new LoopbackSessionFactory(() => {
        targetSessions++;
        return defaultServer;
      }),
      memoryHost,
    );

    try {
      const provider = manager.open(targetSpace);
      const provisionalReplica = provider.replica;
      const firstRead = await provider.sync(targetId, {
        path: [],
        schema: true,
      });
      expect(firstRead.error).toBeUndefined();
      expect(targetSessions).toBe(1);

      memoryHost.href = "https://moved-toolshed.test/";

      expect(
        manager.registerSpaceHost(
          targetSpace,
          "https://default-toolshed.test",
        ),
      ).toBe(true);
      await manager.crossSpaceSettled();

      expect(manager.open(targetSpace)).toBe(provider);
      expect(provider.replica).toBe(provisionalReplica);
      expect(targetSessions).toBe(1);
    } finally {
      await manager.close();
      await defaultServer.close();
    }
  });

  it("resolves the default route when a hint reads it, not at construction", async () => {
    const signer = await Identity.fromPassphrase("deferred-default-route");
    const targetSpace = (await Identity.fromPassphrase(
      "deferred-default-route-target",
    )).did();
    const targetId = "of:deferred-default-route-target" as URI;
    const defaultServer = makeServer("deferred-default-route");
    const memoryHost = new URL("https://default-toolshed.test");
    let targetSessions = 0;
    const sessionFactory = new LoopbackSessionFactory(() => {
      targetSessions++;
      return defaultServer;
    });

    // Turning the memory host into the WebSocket storage endpoint an
    // unseeded, unhinted space opens against parses the host, joins the
    // storage path onto it, copies the result, and parses that copy again to
    // swap the scheme. The manager holds the host as text and does none of
    // that until registerSpaceHost() compares against the route, so a URL
    // parsed while the constructor runs is that resolution back inside it.
    // Counting parses is what separates the two shapes: both read the
    // caller's host object exactly once, one to snapshot it and the other to
    // resolve it.
    const RealURL = globalThis.URL;
    let parsedWhileConstructing = 0;
    class CountingURL extends RealURL {
      constructor(url: string | URL, base?: string | URL) {
        parsedWhileConstructing += 1;
        super(url, base);
      }
    }
    globalThis.URL = CountingURL as unknown as typeof URL;
    let manager: TestStorageManager;
    try {
      manager = TestStorageManager.create(
        signer,
        sessionFactory,
        memoryHost,
      );
    } finally {
      globalThis.URL = RealURL;
    }

    try {
      expect(parsedWhileConstructing).toBe(0);

      const provider = manager.open(targetSpace);
      const provisionalReplica = provider.replica;
      const firstRead = await provider.sync(targetId, {
        path: [],
        schema: true,
      });
      expect(firstRead.error).toBeUndefined();
      expect(targetSessions).toBe(1);

      // The hint reads the route, so by now the route has to be there. A
      // route that was never resolved compares unequal to the hint, which
      // makes the hint a replacement: the replica is rebuilt and a second
      // session opens.
      expect(
        manager.registerSpaceHost(
          targetSpace,
          "https://default-toolshed.test",
        ),
      ).toBe(true);
      await manager.crossSpaceSettled();

      expect(provider.replica).toBe(provisionalReplica);
      expect(targetSessions).toBe(1);
    } finally {
      await manager.close();
      await defaultServer.close();
    }
  });

  it("replays a read that first opened against the default host", async () => {
    const signer = await Identity.fromPassphrase("late-space-host-hint");
    const targetSpace = (await Identity.fromPassphrase(
      "late-space-host-target",
    )).did();
    const targetId = "of:late-space-host-target" as URI;
    const schema = internSchema({
      type: "object",
      properties: { name: { type: "string" } },
    }, true);
    const schemaHash = schema.taggedHashString;
    const schemaId = `cid:${schemaHash}` as URI;
    const defaultServer = makeServer("late-space-host-default");
    const hintedServer = makeServer("late-space-host-hinted");
    const writer = TestStorageManager.create(
      signer,
      new LoopbackSessionFactory(() => hintedServer),
    );
    let targetSessions = 0;
    const reader = TestStorageManager.create(
      signer,
      new LoopbackSessionFactory((space) => {
        if (space !== targetSpace) return defaultServer;
        targetSessions++;
        return targetSessions === 1 ? defaultServer : hintedServer;
      }),
    );

    try {
      const writerProvider = writer.open(targetSpace) as unknown as {
        send(
          batch: {
            uri: URI;
            value: {
              value: unknown;
              cfc?: { schemaHash: string };
            };
          }[],
        ): Promise<{ error?: unknown }>;
      };
      const written = await writerProvider.send([
        {
          uri: targetId,
          value: {
            value: { name: "intended data" },
            cfc: { schemaHash },
          },
        },
        {
          uri: schemaId,
          value: {
            value: schema.schema,
          },
        },
      ]);
      expect(written.error).toBeUndefined();
      await writer.synced();

      const provider = reader.open(targetSpace);
      const provisionalReplica = provider.replica;
      const firstRead = await provider.sync(targetId, {
        path: [],
        schema: true,
      });
      expect(firstRead.error).toBeUndefined();
      expectExaminedAbsent(provider.replica, targetId);

      expect(
        reader.registerSpaceHost(
          targetSpace,
          "https://hinted-toolshed.test",
        ),
      ).toBe(true);
      await reader.crossSpaceSettled();

      expect(reader.open(targetSpace)).toBe(provider);
      expect(provider.replica).not.toBe(provisionalReplica);
      expect(provider.replica.getDocument(targetId)).toEqual({
        value: { name: "intended data" },
        cfc: { schemaHash },
      });
      expect(provider.replica.getDocument(schemaId)).toEqual({
        value: schema.schema,
      });
      const runtime = new Runtime({
        apiUrl: new URL("https://default-toolshed.test"),
        storageManager: reader,
      });
      try {
        expect(
          loadSchemaDocument(runtime.edit(), targetSpace, schemaHash),
        ).toEqual(schema.schema);
      } finally {
        await runtime.dispose();
      }
      const staleRead = await (
        provisionalReplica as typeof provisionalReplica & {
          sync(
            uri: URI,
            selector: { path: string[]; schema: boolean },
          ): Promise<{ error?: { message: string } }>;
        }
      ).sync(targetId, { path: [], schema: true });
      expect(staleRead.error?.message).toContain("memory replica closed");
      expect(targetSessions).toBe(2);
    } finally {
      await reader.close();
      await writer.close();
      await defaultServer.close();
      await hintedServer.close();
    }
  });

  it("replays every registered document after a late hint", async () => {
    const signer = await Identity.fromPassphrase("late-hint-many-reads");
    const targetSpace = (await Identity.fromPassphrase(
      "late-hint-many-reads-target",
    )).did();
    const firstId = "of:late-hint-many-reads-first" as URI;
    const secondId = "of:late-hint-many-reads-second" as URI;
    const defaultServer = makeServer("late-hint-many-reads-default");
    const hintedServer = makeServer("late-hint-many-reads-hinted");
    const writer = TestStorageManager.create(
      signer,
      new LoopbackSessionFactory(() => hintedServer),
    );
    let targetSessions = 0;
    const reader = TestStorageManager.create(
      signer,
      new LoopbackSessionFactory((space) => {
        if (space !== targetSpace) return defaultServer;
        targetSessions++;
        return targetSessions === 1 ? defaultServer : hintedServer;
      }),
    );

    try {
      const seeded = await (writer.open(targetSpace) as unknown as {
        send(
          batch: { uri: URI; value: { value: { name: string } } }[],
        ): Promise<{ error?: unknown }>;
      }).send([
        { uri: firstId, value: { value: { name: "first" } } },
        { uri: secondId, value: { value: { name: "second" } } },
      ]);
      expect(seeded.error).toBeUndefined();
      await writer.synced();

      const provider = reader.open(targetSpace);
      const provisionalReplica = provider.replica;

      // Register both documents, and register the first one repeatedly with
      // freshly built but structurally equal selectors. Every registration
      // after the first is the same read, so the replay set holds one entry
      // per document however many times each was asked for.
      for (let index = 0; index < 64; index++) {
        expect(
          (await provider.sync(firstId, {
            path: ["value", "name"],
            schema: false,
          })).error,
        ).toBeUndefined();
      }
      expect((await provider.sync(secondId)).error).toBeUndefined();
      expectExaminedAbsent(provider.replica, firstId);
      expectExaminedAbsent(provider.replica, secondId);

      expect(
        reader.registerSpaceHost(
          targetSpace,
          "https://hinted-toolshed.test",
        ),
      ).toBe(true);
      await reader.crossSpaceSettled();

      expect(provider.replica).not.toBe(provisionalReplica);
      expect(provider.replica.getDocument(firstId)).toEqual({
        value: { name: "first" },
      });
      expect(provider.replica.getDocument(secondId)).toEqual({
        value: { name: "second" },
      });
      expect(targetSessions).toBe(2);
    } finally {
      await reader.close();
      await writer.close();
      await defaultServer.close();
      await hintedServer.close();
    }
  });

  it("rejects a transaction based on the replaced provisional replica", async () => {
    const signer = await Identity.fromPassphrase("late-hint-stale-transaction");
    const targetSpace = (await Identity.fromPassphrase(
      "late-hint-stale-transaction-target",
    )).did();
    const targetId = "of:late-hint-stale-transaction-target" as URI;
    const defaultServer = makeServer("late-hint-stale-transaction-default");
    const hintedServer = makeServer("late-hint-stale-transaction-hinted");
    const writer = TestStorageManager.create(
      signer,
      new LoopbackSessionFactory(() => hintedServer),
    );
    let targetSessions = 0;
    const reader = TestStorageManager.create(
      signer,
      new LoopbackSessionFactory(() =>
        targetSessions++ === 0 ? defaultServer : hintedServer
      ),
    );

    try {
      const seeded = await (writer.open(targetSpace) as unknown as {
        send(
          batch: { uri: URI; value: { value: { name: string } } }[],
        ): Promise<{ error?: unknown }>;
      }).send([{
        uri: targetId,
        value: { value: { name: "intended data" } },
      }]);
      expect(seeded.error).toBeUndefined();
      await writer.synced();

      const provider = reader.open(targetSpace);
      expect((await provider.sync(targetId)).error).toBeUndefined();
      expectExaminedAbsent(provider.replica, targetId);

      const stale = reader.edit();
      const address = {
        space: targetSpace,
        id: targetId,
        type: "application/json" as const,
        path: [],
      };
      expect(stale.read(address).ok?.value).toBeUndefined();
      const emptyReactive = reader.edit();
      emptyReactive.validateReactiveReads = true;
      expect(emptyReactive.read(address).ok?.value).toBeUndefined();
      expect(
        stale.write(address, { name: "derived from missing data" }).error,
      ).toBeUndefined();

      expect(
        reader.registerSpaceHost(
          targetSpace,
          "https://hinted-toolshed.test",
        ),
      ).toBe(true);
      await reader.crossSpaceSettled();

      const rejected = await stale.commit();
      expect(rejected.error?.name).toBe("StorageTransactionInconsistent");
      const emptyRejected = await emptyReactive.commit();
      expect(emptyRejected.error).toMatchObject({
        name: "StorageTransactionInconsistent",
        emptyReactiveCommit: true,
      });
      expect(provider.replica.getDocument(targetId)).toEqual({
        value: { name: "intended data" },
      });
      expect(await hintedServer.readDocument(targetSpace, targetId)).toEqual({
        value: { name: "intended data" },
      });
      expect(await defaultServer.readDocument(targetSpace, targetId))
        .toBeNull();
    } finally {
      await reader.close();
      await writer.close();
      await defaultServer.close();
      await hintedServer.close();
    }
  });

  it("refuses replacement after an EVENT APPEND issued on the provisional route (verdict blocker, 2026-08-12): the queue's commits are stateful route operations", async () => {
    // Pre-fix the event queue's transact passed a no-op beforeIssue
    // callback, skipping the writeIssuedGeneration marker ordinary
    // commits set — so a late host hint could still approve
    // replaceProvisionalReplica() after an event append had already
    // targeted the original route, closing the old queue's route
    // underneath its traffic.
    setServerExecutionConfig(true);
    const signer = await Identity.fromPassphrase("late-hint-event-append");
    const targetSpace = (await Identity.fromPassphrase(
      "late-hint-event-append-target",
    )).did();
    const defaultServer = makeServer("late-hint-event-append-default");
    const manager = TestStorageManager.create(
      signer,
      new LoopbackSessionFactory(() => defaultServer),
    );
    try {
      const provider = manager.open(targetSpace);
      const replica = provider.replica as unknown as {
        enqueueEventAppend(append: {
          sidecarId: string;
          stream: { id: string; path: readonly string[] };
          eventId: string;
          payload?: unknown;
        }): Promise<{ delivered: boolean }>;
      };
      const stream = { id: "of:late-hint-stream", path: [] as string[] };
      const outcome = await replica.enqueueEventAppend({
        sidecarId: streamEntriesDocId(stream),
        stream,
        eventId: "evt-late-hint",
        payload: { n: 1 },
      });
      expect(outcome.delivered).toBe(true);
      // The issued append marked the route: a late hint to a DIFFERENT
      // host may no longer replace the provisional replica.
      expect(
        manager.registerSpaceHost(
          targetSpace,
          "https://hinted-toolshed.test",
        ),
      ).toBe(false);
    } finally {
      resetServerExecutionConfig();
      await manager.close();
      await defaultServer.close();
    }
  });

  it("a provisional-replica replacement preserves queued event intents — the manager-shared store survives the swap (LT9; verdict blocker, 2026-08-12)", async () => {
    // Pre-fix every EventAppendQueue minted its own private in-memory
    // store, so the replacement's fresh queue lost the old queue's
    // undischarged user intents in-process. The manager now owns ONE
    // store; the replacement replica's eager queue init loads the
    // backlog and discharges it with no fresh fire.
    setServerExecutionConfig(true);
    const signer = await Identity.fromPassphrase("late-hint-queue-preserve");
    const targetSpace = (await Identity.fromPassphrase(
      "late-hint-queue-preserve-target",
    )).did();
    const workingServer = makeServer("late-hint-queue-preserve-hinted");
    // The FIRST session open fails (the provisional route is dark), so
    // the queued intent stays undischarged and the route stays
    // UNMARKED — replacement is still approvable.
    let sessionAttempts = 0;
    const factory: SessionFactory = {
      create: (space, signerArg, mountOptions, signal) => {
        sessionAttempts += 1;
        if (sessionAttempts === 1) {
          return Promise.reject(new Error("provisional host down"));
        }
        return new LoopbackSessionFactory(() => workingServer).create(
          space,
          signerArg,
          mountOptions,
          signal,
        );
      },
    };
    const manager = TestStorageManager.create(signer, factory);
    try {
      const provider = manager.open(targetSpace);
      const replica = provider.replica as unknown as {
        enqueueEventAppend(append: {
          sidecarId: string;
          stream: { id: string; path: readonly string[] };
          eventId: string;
          payload?: unknown;
        }): Promise<{ delivered: boolean }>;
        pendingEventAppends(): readonly unknown[];
      };
      const stream = { id: "of:preserved-stream", path: [] as string[] };
      const sidecarId = streamEntriesDocId(stream);
      const outcome = replica.enqueueEventAppend({
        sidecarId,
        stream,
        eventId: "evt-preserved",
        payload: { n: 7 },
      });
      // The intent is queued (first discharge attempt failing).
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(replica.pendingEventAppends().length).toBe(1);
      // The late hint replaces the provisional replica (no append ever
      // ISSUED on the dark route, so the route-write guard permits it).
      expect(
        manager.registerSpaceHost(
          targetSpace,
          "https://hinted-toolshed.test",
        ),
      ).toBe(true);
      // registerSpaceHost triggered the replacement itself; settle it
      // the way the neighboring tests do.
      await manager.crossSpaceSettled();
      // The REPLACEMENT queue discharges the preserved intent with no
      // fresh fire; the working host's engine holds the entry.
      const delivered = await outcome;
      expect(delivered).toEqual({
        delivered: false,
        refused: "event queue closed",
      });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const doc = await workingServer.readDocument(
          targetSpace,
          sidecarId as never,
        );
        const entries =
          ((doc?.value ?? {}) as { entries?: Array<{ eventId?: string }> })
            .entries ?? [];
        if (entries.some((entry) => entry.eventId === "evt-preserved")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const doc = await workingServer.readDocument(
        targetSpace,
        sidecarId as never,
      );
      const entries =
        ((doc?.value ?? {}) as { entries?: Array<{ eventId?: string }> })
          .entries ?? [];
      expect(entries.some((entry) => entry.eventId === "evt-preserved"))
        .toBe(true);
    } finally {
      resetServerExecutionConfig();
      await manager.close();
      await workingServer.close();
    }
  });

  it("rejects a provisional transaction when the hint arrives during commit", async () => {
    const signer = await Identity.fromPassphrase(
      "late-hint-committing-transaction",
    );
    const targetSpace = (await Identity.fromPassphrase(
      "late-hint-committing-transaction-target",
    )).did();
    const targetId = "of:late-hint-committing-transaction-target" as URI;
    const hintedServer = makeServer("late-hint-committing-transaction-hinted");
    const writer = TestStorageManager.create(
      signer,
      new LoopbackSessionFactory(() => hintedServer),
    );
    const openingStarted = Promise.withResolvers<void>();
    const hintedFactory = new LoopbackSessionFactory(() => hintedServer);
    let sessionCreations = 0;
    const reader = TestStorageManager.create(signer, {
      create(space, sessionSigner, mountOptions, signal) {
        sessionCreations++;
        if (sessionCreations === 1) {
          openingStarted.resolve();
          return new Promise((_, reject) => {
            const rejectForAbort = () =>
              reject(
                signal?.reason instanceof Error
                  ? signal.reason
                  : new Error("memory replica route replaced"),
              );
            if (signal?.aborted) {
              rejectForAbort();
            } else {
              signal?.addEventListener("abort", rejectForAbort, {
                once: true,
              });
            }
          });
        }
        return hintedFactory.create(
          space,
          sessionSigner,
          mountOptions,
          signal,
        );
      },
    });

    try {
      const seeded = await (writer.open(targetSpace) as unknown as {
        send(
          batch: { uri: URI; value: { value: { name: string } } }[],
        ): Promise<{ error?: unknown }>;
      }).send([{
        uri: targetId,
        value: { value: { name: "intended data" } },
      }]);
      expect(seeded.error).toBeUndefined();
      await writer.synced();

      const stale = reader.edit();
      const address = {
        space: targetSpace,
        id: targetId,
        type: "application/json" as const,
        path: [],
      };
      expect(stale.read(address).ok?.value).toBeUndefined();
      expect(
        stale.write(address, { name: "derived from missing data" }).error,
      ).toBeUndefined();
      const committing = stale.commit();
      await openingStarted.promise;

      expect(
        reader.registerSpaceHost(
          targetSpace,
          "https://hinted-toolshed.test",
        ),
      ).toBe(true);

      expect((await committing).error?.name).toBe("ConflictError");
      expect(await hintedServer.readDocument(targetSpace, targetId)).toEqual({
        value: { name: "intended data" },
      });
      expect((await reader.open(targetSpace).sync(targetId)).error)
        .toBeUndefined();
      expect(reader.open(targetSpace).replica.getDocument(targetId)).toEqual({
        value: { name: "intended data" },
      });
    } finally {
      await reader.close();
      await writer.close();
      await hintedServer.close();
    }
  });

  it("rejects a write to another space when its linked read route changes during commit", async () => {
    const signer = await Identity.fromPassphrase(
      "late-hint-cross-space-transaction",
    );
    const targetSpace = (await Identity.fromPassphrase(
      "late-hint-cross-space-transaction-target",
    )).did();
    const targetId = "of:late-hint-cross-space-target" as URI;
    const resultId = "of:late-hint-cross-space-result" as URI;
    const defaultServer = makeServer("late-hint-cross-space-default");
    const hintedServer = makeServer("late-hint-cross-space-hinted");
    const defaultFactory = new LoopbackSessionFactory(() => defaultServer);
    const hintedFactory = new LoopbackSessionFactory(() => hintedServer);
    const writer = TestStorageManager.create(signer, hintedFactory);
    const writeSessionStarted = Promise.withResolvers<void>();
    const releaseWriteSession = Promise.withResolvers<void>();
    let targetSessions = 0;
    const reader = TestStorageManager.create(signer, {
      async create(space, sessionSigner, mountOptions, signal) {
        if (space === targetSpace) {
          const factory = targetSessions++ === 0
            ? defaultFactory
            : hintedFactory;
          return await factory.create(
            space,
            sessionSigner,
            mountOptions,
            signal,
          );
        }
        if (space === signer.did()) {
          writeSessionStarted.resolve();
          await releaseWriteSession.promise;
        }
        return await defaultFactory.create(
          space,
          sessionSigner,
          mountOptions,
          signal,
        );
      },
    });

    try {
      const seeded = await (writer.open(targetSpace) as unknown as {
        send(
          batch: { uri: URI; value: { value: { name: string } } }[],
        ): Promise<{ error?: unknown }>;
      }).send([{
        uri: targetId,
        value: { value: { name: "intended data" } },
      }]);
      expect(seeded.error).toBeUndefined();
      await writer.synced();

      const targetProvider = reader.open(targetSpace);
      expect((await targetProvider.sync(targetId)).error).toBeUndefined();
      expectExaminedAbsent(targetProvider.replica, targetId);

      const stale = reader.edit();
      const target = stale.read({
        space: targetSpace,
        id: targetId,
        type: "application/json",
        path: ["name"],
      });
      expect(target.ok?.value).toBeUndefined();
      expect(
        stale.write({
          space: signer.did(),
          id: resultId,
          type: "application/json",
          path: [],
        }, { seen: target.ok?.value ?? "missing" }).error,
      ).toBeUndefined();

      const committing = stale.commit();
      await writeSessionStarted.promise;
      expect(
        reader.registerSpaceHost(
          targetSpace,
          "https://hinted-toolshed.test",
        ),
      ).toBe(true);
      await reader.crossSpaceSettled();
      expect(targetProvider.replica.getDocument(targetId)).toEqual({
        value: { name: "intended data" },
      });

      releaseWriteSession.resolve();
      const rejected = await committing;
      expect(rejected.error?.name).toBe("StorageTransactionInconsistent");
      expect(
        await defaultServer.readDocument(signer.did(), resultId),
      ).toBeNull();
      expect(reader.open(signer.did()).replica.getDocument(resultId))
        .toBeUndefined();
    } finally {
      releaseWriteSession.resolve();
      await reader.close();
      await writer.close();
      await defaultServer.close();
      await hintedServer.close();
    }
  });

  it("moves an overlapping entity listing to the hinted host", async () => {
    const signer = await Identity.fromPassphrase("late-hint-entity-list");
    const targetSpace = (await Identity.fromPassphrase(
      "late-hint-entity-list-target",
    )).did();
    const targetId = "of:late-hint-entity-list-target" as URI;
    const hintedServer = makeServer("late-hint-entity-list-hinted");
    const writer = TestStorageManager.create(
      signer,
      new LoopbackSessionFactory(() => hintedServer),
    );
    const openingStarted = Promise.withResolvers<void>();
    const openingCancelled = Promise.withResolvers<void>();
    const hintedFactory = new LoopbackSessionFactory(() => hintedServer);
    let sessionCreations = 0;
    const reader = TestStorageManager.create(signer, {
      create(space, sessionSigner, mountOptions, signal) {
        sessionCreations++;
        if (sessionCreations === 1) {
          openingStarted.resolve();
          return new Promise((_, reject) => {
            const rejectForAbort = () => {
              openingCancelled.resolve();
              reject(
                signal?.reason instanceof Error
                  ? signal.reason
                  : new Error("memory replica route replaced"),
              );
            };
            if (signal?.aborted) {
              rejectForAbort();
            } else {
              signal?.addEventListener("abort", rejectForAbort, {
                once: true,
              });
            }
          });
        }
        return hintedFactory.create(
          space,
          sessionSigner,
          mountOptions,
          signal,
        );
      },
    });

    try {
      const seeded = await (writer.open(targetSpace) as unknown as {
        send(
          batch: { uri: URI; value: { value: { name: string } } }[],
        ): Promise<{ error?: unknown }>;
      }).send([{
        uri: targetId,
        value: { value: { name: "intended data" } },
      }]);
      expect(seeded.error).toBeUndefined();
      await writer.synced();

      const listing = reader.open(targetSpace).listEntityIds!();
      await openingStarted.promise;
      expect(
        reader.registerSpaceHost(
          targetSpace,
          "https://hinted-toolshed.test",
        ),
      ).toBe(true);

      await openingCancelled.promise;
      expect(await listing).toContain(targetId);
      await reader.crossSpaceSettled();
      expect(sessionCreations).toBe(2);
    } finally {
      await reader.close();
      await writer.close();
      await hintedServer.close();
    }
  });

  it("keeps an existing synced barrier open until hinted reads replay", async () => {
    const signer = await Identity.fromPassphrase("late-hint-synced-barrier");
    const targetSpace = (await Identity.fromPassphrase(
      "late-hint-synced-barrier-target",
    )).did();
    const targetId = "of:late-hint-synced-barrier-target" as URI;
    const hintedServer = makeServer("late-hint-synced-barrier-hinted");
    const hintedFactory = new LoopbackSessionFactory(() => hintedServer);
    const writer = TestStorageManager.create(signer, hintedFactory);
    const provisionalSessionStarted = Promise.withResolvers<void>();
    const hintedSessionStarted = Promise.withResolvers<void>();
    const releaseHintedSession = Promise.withResolvers<void>();
    let sessionCreations = 0;
    const reader = TestStorageManager.create(signer, {
      async create(space, sessionSigner, mountOptions, signal) {
        sessionCreations++;
        if (sessionCreations === 1) {
          provisionalSessionStarted.resolve();
          return await new Promise((_, reject) => {
            const rejectForAbort = () =>
              reject(
                signal?.reason instanceof Error
                  ? signal.reason
                  : new Error("memory replica route replaced"),
              );
            if (signal?.aborted) {
              rejectForAbort();
            } else {
              signal?.addEventListener("abort", rejectForAbort, {
                once: true,
              });
            }
          });
        }
        hintedSessionStarted.resolve();
        await releaseHintedSession.promise;
        return await hintedFactory.create(
          space,
          sessionSigner,
          mountOptions,
          signal,
        );
      },
    });

    try {
      const seeded = await (writer.open(targetSpace) as unknown as {
        send(
          batch: { uri: URI; value: { value: { name: string } } }[],
        ): Promise<{ error?: unknown }>;
      }).send([{
        uri: targetId,
        value: { value: { name: "intended data" } },
      }]);
      expect(seeded.error).toBeUndefined();
      await writer.synced();

      const provider = reader.open(targetSpace);
      const provisionalReplica = provider.replica as typeof provider.replica & {
        synced(): Promise<void>;
      };
      const reading = provider.sync(targetId);
      await provisionalSessionStarted.promise;
      const synced = provider.synced();
      let syncedSettled = false;
      synced.then(() => {
        syncedSettled = true;
      }, () => {
        syncedSettled = true;
      });
      expect(
        reader.registerSpaceHost(
          targetSpace,
          "https://hinted-toolshed.test",
        ),
      ).toBe(true);
      await hintedSessionStarted.promise;

      await provisionalReplica.synced();
      await Promise.resolve();
      expect(syncedSettled).toBe(false);

      releaseHintedSession.resolve();
      await synced;
      expect((await reading).error).toBeUndefined();
      expect(provider.replica.getDocument(targetId)).toEqual({
        value: { name: "intended data" },
      });
      expect(sessionCreations).toBe(2);
    } finally {
      releaseHintedSession.resolve();
      await reader.close();
      await writer.close();
      await hintedServer.close();
    }
  });

  it("settles an in-flight provisional read before replaying it", async () => {
    const signer = await Identity.fromPassphrase("pending-space-host-hint");
    const targetSpace = (await Identity.fromPassphrase(
      "pending-space-host-target",
    )).did();
    const targetId = "of:pending-space-host-target" as URI;
    const hintedServer = makeServer("pending-space-host-hinted");
    const pendingSession = Promise.withResolvers<{
      client: MemoryV2Client.Client;
      session: MemoryV2Client.SpaceSession;
    }>();
    const provisionalSessionStarted = Promise.withResolvers<void>();
    const hintedFactory = new LoopbackSessionFactory(() => hintedServer);
    const writer = TestStorageManager.create(signer, hintedFactory);
    let targetSessions = 0;
    const reader = TestStorageManager.create(signer, {
      create(space, sessionSigner, mountOptions) {
        targetSessions++;
        if (targetSessions === 1) {
          provisionalSessionStarted.resolve();
          return pendingSession.promise;
        }
        return hintedFactory.create(space, sessionSigner, mountOptions);
      },
    });

    try {
      const writerProvider = writer.open(targetSpace) as unknown as {
        send(
          batch: { uri: URI; value: { value: { name: string } } }[],
        ): Promise<{ error?: unknown }>;
      };
      const written = await writerProvider.send([{
        uri: targetId,
        value: { value: { name: "intended data" } },
      }]);
      expect(written.error).toBeUndefined();
      await writer.synced();

      const provider = reader.open(targetSpace);
      const firstRead = provider.sync(targetId, {
        path: [],
        schema: true,
      });
      reader.trackUntilSettled(firstRead);
      await provisionalSessionStarted.promise;

      expect(
        reader.registerSpaceHost(
          targetSpace,
          "https://hinted-toolshed.test",
        ),
      ).toBe(true);
      await reader.crossSpaceSettled();

      const firstResult = await firstRead;
      expect(firstResult.error).toBeUndefined();
      expect(provider.replica.getDocument(targetId)).toEqual({
        value: { name: "intended data" },
      });
      expect(reader.pendingCrossSpacePromiseCount()).toBe(0);
      expect(targetSessions).toBe(2);
    } finally {
      await reader.close();
      await writer.close();
      await hintedServer.close();
    }
  });

  it("moves a deferred session open without starting the old factory", async () => {
    const signer = await Identity.fromPassphrase(
      "deferred-provisional-session",
    );
    const targetSpace = (await Identity.fromPassphrase(
      "deferred-provisional-session-target",
    )).did();
    const hintedServer = makeServer("deferred-provisional-session-hinted");
    const hintedFactory = new LoopbackSessionFactory(() => hintedServer);
    let sessionCreations = 0;
    const manager = TestStorageManager.create(signer, {
      create(space, sessionSigner, mountOptions) {
        sessionCreations++;
        return hintedFactory.create(space, sessionSigner, mountOptions);
      },
    });

    try {
      const provider = manager.open(targetSpace);
      const provisionalOpening = provider.ensureSession!();

      expect(
        manager.registerSpaceHost(
          targetSpace,
          "https://hinted-toolshed.test",
        ),
      ).toBe(true);
      await provisionalOpening;
      await manager.crossSpaceSettled();

      await provider.ensureSession!();
      expect(sessionCreations).toBe(1);
    } finally {
      await manager.close();
      await hintedServer.close();
    }
  });

  it("replaces the provisional route before a waiting write is issued", async () => {
    const signer = await Identity.fromPassphrase("provisional-route-write");
    const targetSpace = (await Identity.fromPassphrase(
      "provisional-route-write-target",
    )).did();
    const targetId = "of:provisional-route-write-target" as URI;
    const defaultServer = makeServer("provisional-route-write-default");
    const pendingSession = Promise.withResolvers<{
      client: MemoryV2Client.Client;
      session: MemoryV2Client.SpaceSession;
    }>();
    const sessionStarted = Promise.withResolvers<void>();
    const manager = TestStorageManager.create(
      signer,
      {
        create() {
          sessionStarted.resolve();
          return pendingSession.promise;
        },
      },
    );

    try {
      const provider = manager.open(targetSpace);
      const replica = provider.replica;
      const write = (provider as unknown as {
        send(
          batch: { uri: URI; value: { value: { name: string } } }[],
        ): Promise<{ error?: unknown }>;
      }).send([{
        uri: targetId,
        value: { value: { name: "acknowledged data" } },
      }]);

      await sessionStarted.promise;
      expect(
        manager.registerSpaceHost(
          targetSpace,
          "https://different-toolshed.test",
        ),
      ).toBe(true);
      await manager.crossSpaceSettled();

      const written = await write;
      expect(written.error).toBeDefined();

      expect(manager.open(targetSpace)).toBe(provider);
      expect(provider.replica).not.toBe(replica);
      expect(
        await defaultServer.readDocument(targetSpace, targetId),
      ).toBeNull();
    } finally {
      await manager.close();
      await defaultServer.close();
    }
  });

  it("keeps the provisional route after a write reaches its host", async () => {
    const signer = await Identity.fromPassphrase(
      "issued-provisional-route-write",
    );
    const targetSpace = (await Identity.fromPassphrase(
      "issued-provisional-route-write-target",
    )).did();
    const targetId = "of:issued-provisional-route-write-target" as URI;
    const defaultServer = makeServer("issued-provisional-route-write-default");
    const manager = TestStorageManager.create(
      signer,
      new LoopbackSessionFactory(() => defaultServer),
    );

    try {
      const provider = manager.open(targetSpace);
      const replica = provider.replica;
      const written = await (provider as unknown as {
        send(
          batch: { uri: URI; value: { value: { name: string } } }[],
        ): Promise<{ error?: unknown }>;
      }).send([{
        uri: targetId,
        value: { value: { name: "acknowledged data" } },
      }]);
      expect(written.error).toBeUndefined();

      expect(
        manager.registerSpaceHost(
          targetSpace,
          "https://different-toolshed.test",
        ),
      ).toBe(false);
      expect(
        manager.registerSpaceHostDetailed(
          targetSpace,
          "https://different-toolshed.test",
        ),
      ).toEqual({ accepted: false, reason: "default-route-in-use" });
      // The refusal fixes no route: a hint naming the default host, which the
      // written provider is on, is still confirmed.
      expect(
        manager.registerSpaceHostDetailed(
          targetSpace,
          "https://default-toolshed.test",
        ),
      ).toEqual({ accepted: true });
      expect(provider.replica).toBe(replica);
      expect(provider.replica.getDocument(targetId)).toEqual({
        value: { name: "acknowledged data" },
      });
    } finally {
      await manager.close();
      await defaultServer.close();
    }
  });

  it("keeps the route when a committed write loses its acknowledgment", async () => {
    const signer = await Identity.fromPassphrase(
      "lost-acknowledgment-route-write",
    );
    const targetSpace = (await Identity.fromPassphrase(
      "lost-acknowledgment-route-write-target",
    )).did();
    const targetId = "of:lost-acknowledgment-route-write-target" as URI;
    const defaultServer = makeServer("lost-acknowledgment-route-default");
    const factory = new LoopbackSessionFactory(() => defaultServer);
    const manager = TestStorageManager.create(
      signer,
      {
        async create(space, sessionSigner, mountOptions) {
          const connection = await factory.create(
            space,
            sessionSigner,
            mountOptions,
          );
          const transact = connection.session.transact.bind(
            connection.session,
          );
          connection.session.transact = async (commit, beforeIssue) => {
            await transact(commit, beforeIssue);
            throw new Error("write acknowledgment lost");
          };
          return connection;
        },
      },
    );

    try {
      const provider = manager.open(targetSpace);
      const written = await (provider as unknown as {
        send(
          batch: { uri: URI; value: { value: { name: string } } }[],
        ): Promise<{ error?: unknown }>;
      }).send([{
        uri: targetId,
        value: { value: { name: "committed data" } },
      }]);
      expect(written.error).toBeDefined();
      expect(
        await defaultServer.readDocument(targetSpace, targetId),
      ).toEqual({ value: { name: "committed data" } });

      expect(
        manager.registerSpaceHost(
          targetSpace,
          "https://different-toolshed.test",
        ),
      ).toBe(false);
    } finally {
      await manager.close();
      await defaultServer.close();
    }
  });

  it("can replace a provisional route after a pre-send write failure", async () => {
    const signer = await Identity.fromPassphrase(
      "failed-provisional-route-write",
    );
    const targetSpace = (await Identity.fromPassphrase(
      "failed-provisional-route-write-target",
    )).did();
    const targetId = "of:failed-provisional-route-write-target" as URI;
    const manager = TestStorageManager.create(signer, {
      create() {
        return Promise.reject(new Error("provisional connection failed"));
      },
    });

    try {
      const provider = manager.open(targetSpace);
      const written = await (provider as unknown as {
        send(
          batch: { uri: URI; value: { value: { name: string } } }[],
        ): Promise<{ error?: unknown }>;
      }).send([{
        uri: targetId,
        value: { value: { name: "uncommitted data" } },
      }]);
      expect(written.error).toBeDefined();

      expect(
        manager.registerSpaceHost(
          targetSpace,
          "https://hinted-toolshed.test",
        ),
      ).toBe(true);
      await manager.crossSpaceSettled();
    } finally {
      await manager.close();
    }
  });

  it("can replace a provisional route after a closed session rejects a write", async () => {
    const signer = await Identity.fromPassphrase(
      "closed-provisional-route-write",
    );
    const targetSpace = (await Identity.fromPassphrase(
      "closed-provisional-route-write-target",
    )).did();
    const targetId = "of:closed-provisional-route-write-target" as URI;
    const defaultServer = makeServer("closed-provisional-route-default");
    const factory = new LoopbackSessionFactory(() => defaultServer);
    let opened:
      | {
        client: MemoryV2Client.Client;
        session: MemoryV2Client.SpaceSession;
      }
      | undefined;
    const manager = TestStorageManager.create(signer, {
      async create(space, sessionSigner, mountOptions) {
        opened = await factory.create(space, sessionSigner, mountOptions);
        return opened;
      },
    });

    try {
      const provider = manager.open(targetSpace);
      await provider.ensureSession!();
      await opened!.session.close();

      const written = await (provider as unknown as {
        send(
          batch: { uri: URI; value: { value: { name: string } } }[],
        ): Promise<{ error?: unknown }>;
      }).send([{
        uri: targetId,
        value: { value: { name: "uncommitted data" } },
      }]);
      expect(written.error).toBeDefined();

      expect(
        manager.registerSpaceHost(
          targetSpace,
          "https://hinted-toolshed.test",
        ),
      ).toBe(true);
      await manager.crossSpaceSettled();
    } finally {
      await manager.close();
      await defaultServer.close();
    }
  });

  it("cancels an in-progress provisional ACL query before replay", async () => {
    const signer = await Identity.fromPassphrase("late-hint-acl-user");
    const spaceIdentity = await Identity.fromPassphrase("late-hint-acl-space");
    const targetSpace = spaceIdentity.did();
    const targetId = "of:late-hint-acl-target" as URI;
    const defaultServer = makeServer("late-hint-acl-default");
    const hintedServer = makeServer("late-hint-acl-hinted");
    const bootstrapQueryStarted = Promise.withResolvers<void>();
    const bootstrapQueryCancelled = Promise.withResolvers<void>();
    const bootstrapClosed = Promise.withResolvers<void>();
    const tokenOrigins = new Map<string, "default" | "hinted">();
    let staleResumeAttempts = 0;
    let useHintedServer = false;
    let gateDefaultBootstrap = true;
    const manager = TestStorageManager.create(signer, {
      supportsAclBootstrap: true,
      async create(space, sessionSigner, mountOptions = {}) {
        const origin = useHintedServer ? "hinted" : "default";
        if (
          origin === "hinted" &&
          mountOptions.sessionToken !== undefined &&
          tokenOrigins.get(mountOptions.sessionToken) === "default"
        ) {
          staleResumeAttempts++;
        }
        const server = origin === "hinted" ? hintedServer : defaultServer;
        const connection = await new LoopbackSessionFactory(() => server)
          .create(space, sessionSigner, mountOptions);
        if (connection.session.sessionToken !== undefined) {
          tokenOrigins.set(connection.session.sessionToken, origin);
        }
        if (
          gateDefaultBootstrap &&
          server === defaultServer &&
          sessionSigner?.did() === spaceIdentity.did()
        ) {
          gateDefaultBootstrap = false;
          const queryGraph = connection.session.queryGraph.bind(
            connection.session,
          );
          connection.session.queryGraph = async (query) => {
            bootstrapQueryStarted.resolve();
            await bootstrapQueryCancelled.promise;
            return await queryGraph(query);
          };
          const close = connection.client.close.bind(connection.client);
          connection.client.close = async () => {
            bootstrapQueryCancelled.reject(
              new Error("provisional ACL query cancelled"),
            );
            try {
              await close();
            } finally {
              bootstrapClosed.resolve();
            }
          };
        }
        return connection;
      },
    });
    manager.registerSpaceIdentity(spaceIdentity);

    try {
      const provider = manager.open(targetSpace);
      const firstRead = provider.sync(targetId, {
        path: [],
        schema: true,
      });
      await bootstrapQueryStarted.promise;

      useHintedServer = true;
      expect(
        manager.registerSpaceHost(
          targetSpace,
          "https://hinted-toolshed.test",
        ),
      ).toBe(true);

      await bootstrapClosed.promise;
      expect((await firstRead).error).toBeUndefined();
      await manager.crossSpaceSettled();
      expect(staleResumeAttempts).toBe(0);
      expect(
        await defaultServer.readDocument(targetSpace, `of:${targetSpace}`),
      ).toBeNull();
      expect(
        await hintedServer.readDocument(targetSpace, `of:${targetSpace}`),
      ).toEqual({
        value: {
          [signer.did()]: "OWNER",
          "*": "WRITE",
        },
      });
    } finally {
      bootstrapQueryCancelled.reject(
        new Error("provisional ACL query cancelled"),
      );
      await manager.close();
      await defaultServer.close();
      await hintedServer.close();
    }
  });

  it("does not issue ACL setup after immediate manager disposal", async () => {
    const signer = await Identity.fromPassphrase("disposed-acl-user");
    const spaceIdentity = await Identity.fromPassphrase("disposed-acl-space");
    const targetSpace = spaceIdentity.did();
    const defaultServer = makeServer("disposed-acl-default");
    const bootstrapQueryStarted = Promise.withResolvers<void>();
    const bootstrapQueryCancelled = Promise.withResolvers<void>();
    const bootstrapClosed = Promise.withResolvers<void>();
    let aclTransactions = 0;
    const factory = new LoopbackSessionFactory(() => defaultServer);
    const manager = TestStorageManager.create(signer, {
      supportsAclBootstrap: true,
      async create(space, sessionSigner, mountOptions = {}) {
        const connection = await factory.create(
          space,
          sessionSigner,
          mountOptions,
        );
        if (sessionSigner?.did() === spaceIdentity.did()) {
          const queryGraph = connection.session.queryGraph.bind(
            connection.session,
          );
          connection.session.queryGraph = async (query) => {
            bootstrapQueryStarted.resolve();
            await bootstrapQueryCancelled.promise;
            return await queryGraph(query);
          };
          const transact = connection.session.transact.bind(
            connection.session,
          );
          connection.session.transact = (commit, beforeIssue) =>
            transact(commit, () => {
              beforeIssue?.();
              aclTransactions++;
            });
          const close = connection.client.close.bind(connection.client);
          connection.client.close = async () => {
            bootstrapQueryCancelled.reject(
              new Error("disposed ACL query cancelled"),
            );
            try {
              await close();
            } finally {
              bootstrapClosed.resolve();
            }
          };
        }
        return connection;
      },
    });
    manager.registerSpaceIdentity(spaceIdentity);

    try {
      const firstRead = manager.open(targetSpace).sync(
        "of:disposed-acl-target" as URI,
        { path: [], schema: true },
      );
      await bootstrapQueryStarted.promise;

      await manager.closeNow();
      await bootstrapClosed.promise;

      expect((await firstRead).error).toBeDefined();
      expect(aclTransactions).toBe(0);
      expect(
        await defaultServer.readDocument(targetSpace, `of:${targetSpace}`),
      ).toBeNull();
    } finally {
      bootstrapQueryCancelled.reject(
        new Error("disposed ACL query cancelled"),
      );
      await manager.closeNow();
      await defaultServer.close();
    }
  });

  it("keeps the provisional route after issuing its ACL setup write", async () => {
    const signer = await Identity.fromPassphrase(
      "issued-acl-provisional-user",
    );
    const spaceIdentity = await Identity.fromPassphrase(
      "issued-acl-provisional-space",
    );
    const targetSpace = spaceIdentity.did();
    const defaultServer = makeServer("issued-acl-provisional-default");
    const factory = new LoopbackSessionFactory(() => defaultServer);
    const manager = TestStorageManager.create(signer, {
      supportsAclBootstrap: true,
      create: (space, sessionSigner, mountOptions) =>
        factory.create(space, sessionSigner, mountOptions),
    });
    manager.registerSpaceIdentity(spaceIdentity);

    try {
      const read = await manager.open(targetSpace).sync(
        "of:issued-acl-provisional-target" as URI,
      );
      expect(read.error).toBeUndefined();
      expect(
        await defaultServer.readDocument(targetSpace, `of:${targetSpace}`),
      ).toEqual({
        value: {
          [signer.did()]: "OWNER",
          "*": "WRITE",
        },
      });

      expect(
        manager.registerSpaceHost(
          targetSpace,
          "https://different-toolshed.test",
        ),
      ).toBe(false);
    } finally {
      await manager.close();
      await defaultServer.close();
    }
  });

  it("settles waiting disk registration and pins an issued registration", async () => {
    const signer = await Identity.fromPassphrase(
      "late-hint-disk-registration",
    );
    const targetSpace = (await Identity.fromPassphrase(
      "late-hint-disk-registration-target",
    )).did();
    const hintedServer = makeServer("late-hint-disk-registration-hinted");
    const hintedFactory = new LoopbackSessionFactory(() => hintedServer);
    const pendingSession = Promise.withResolvers<{
      client: MemoryV2Client.Client;
      session: MemoryV2Client.SpaceSession;
    }>();
    const sessionStarted = Promise.withResolvers<void>();
    let sessionCreations = 0;
    const manager = TestStorageManager.create(signer, {
      create(space, sessionSigner, mountOptions) {
        sessionCreations++;
        if (sessionCreations === 1) {
          sessionStarted.resolve();
          return pendingSession.promise;
        }
        return hintedFactory.create(space, sessionSigner, mountOptions);
      },
    });
    const diskPath = Deno.makeTempFileSync({ suffix: ".sqlite" });

    try {
      const provider = manager.open(targetSpace);
      const provisionalRegistration = provider.registerSqliteDiskSource!(
        "of:provisional-disk",
        diskPath,
      );
      await sessionStarted.promise;

      expect(
        manager.registerSpaceHost(
          targetSpace,
          "https://hinted-toolshed.test",
        ),
      ).toBe(true);
      await manager.crossSpaceSettled();
      await expect(provisionalRegistration).rejects.toThrow(
        "memory replica closed",
      );

      await provider.registerSqliteDiskSource!(
        "of:hinted-disk",
        diskPath,
      );
      expect(
        manager.registerSpaceHost(
          targetSpace,
          "https://different-toolshed.test",
        ),
      ).toBe(false);
      expect(sessionCreations).toBe(2);
    } finally {
      await manager.close();
      Deno.removeSync(diskPath);
      await hintedServer.close();
    }
  });

  it("updates a running pattern after its first linked read misses", async () => {
    const signer = await Identity.fromPassphrase("late-hint-pattern");
    const targetSpace = (await Identity.fromPassphrase(
      "late-hint-pattern-target",
    )).did();
    const targetId = "of:late-hint-pattern-target" as URI;
    const defaultServer = makeServer("late-hint-pattern-default");
    const hintedServer = makeServer("late-hint-pattern-hinted");
    const writer = TestStorageManager.create(
      signer,
      new LoopbackSessionFactory(() => hintedServer),
    );
    let targetSessions = 0;
    const reader = TestStorageManager.create(
      signer,
      new LoopbackSessionFactory((space) => {
        if (space !== targetSpace) return defaultServer;
        targetSessions++;
        return targetSessions === 1 ? defaultServer : hintedServer;
      }),
    );
    const runtime = new Runtime({
      apiUrl: new URL("https://default-toolshed.test"),
      storageManager: reader,
    });

    try {
      const writerProvider = writer.open(targetSpace) as unknown as {
        send(
          batch: { uri: URI; value: { value: { name: string } } }[],
        ): Promise<{ error?: unknown }>;
      };
      const written = await writerProvider.send([{
        uri: targetId,
        value: { value: { name: "intended data" } },
      }]);
      expect(written.error).toBeUndefined();
      await writer.synced();

      const target = runtime.getCellFromLink<{ name?: string }>({
        id: targetId,
        path: [],
        space: targetSpace,
        scope: "space",
      }, {
        type: "object",
        properties: { name: { type: "string" } },
      });
      const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
      const readName = lift(
        (value: { name?: string } | undefined) => value?.name ?? "missing",
      );
      const Root = pattern<{ target?: { name?: string } }>(({ target }) => ({
        seen: readName(target),
      }));
      const tx = runtime.edit();
      const resultCell = runtime.getCell<{ seen?: string }>(
        signer.did(),
        "late hint pattern result",
        undefined,
        tx,
      );
      const result = runtime.run(tx, Root, { target }, resultCell);
      const committed = await tx.commit();
      expect(committed.error).toBeUndefined();
      await result.pull();
      expect(result.key("seen").get()).toBeUndefined();

      expect(
        runtime.registerSpaceHost(
          targetSpace,
          "https://hinted-toolshed.test",
        ),
      ).toBe(true);
      await reader.crossSpaceSettled();
      await runtime.idle();

      expect(await result.key("seen").pull()).toBe("intended data");
      expect(targetSessions).toBe(2);
    } finally {
      await runtime.dispose();
      await writer.close();
      await defaultServer.close();
      await hintedServer.close();
    }
  });
});
