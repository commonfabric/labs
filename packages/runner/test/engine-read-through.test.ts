/**
 * Drives the serving loop end to end under `SpaceServerPolicy.storeReadThrough`
 * — a real memory server, its engine, a client runtime committing over the
 * loopback wire, and the SpaceServer's serving runtime — and checks that the
 * serving runtime reads its home space from the engine: it registers no
 * session watch, it derives from documents it read on first access, and an
 * authored commit landing after its reads reaches it through the feed's
 * refresh rather than through a frame. The piece is instantiated by a
 * separate, short-lived runtime before the host exists, so the serving
 * structure comes up through the demand loader after activation, and every
 * read reaches the engine through the read-through the SpaceServer itself
 * installed from the policy. The posture off is the control.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import {
  acquireExecutionLease,
  executionLeaseHolder,
  liveExecutionLeaseHolder,
  releaseExecutionLease,
} from "@commonfabric/memory/v2/execution-lease";
import type { FabricValue } from "@commonfabric/api";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { decomposeSchema } from "../src/schema-decompose.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { type Options, SpaceReplica } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace, URI } from "../src/storage/interface.ts";
import { engineReadThrough } from "../src/executor/engine-read-through.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import {
  type RuntimeFactoryContext,
  type SpaceServerPolicy,
  STORE_REFRESH_ATTEMPTS,
} from "../src/executor/space-server.ts";
import type { WaveCommitSink } from "../src/executor/wave.ts";
import { readWatermarkSeq, waitForSettled } from "../src/executor/watermark.ts";
import {
  newSharedServer,
  TEST_MEMORY_SERVER_AUTH,
} from "./memory-v2-test-utils.ts";
import { waitUntil } from "./support/wait-until.ts";

class SharedServerStorageManager extends EmulatedStorageManager {
  /**
   * Delegates to the base `connectTo()`: `new this` gives back this subclass,
   * and the base clears server ownership so closing this manager never closes
   * the shared server.
   */
  static override connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    return super.connectTo(server, options) as SharedServerStorageManager;
  }
}

const spaceSigner = await Identity.fromPassphrase("read-through space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("read-through service");
const aliceSigner = await Identity.fromPassphrase("read-through alice");
/** The instantiating runtime's identity: not the service's, so that the
 * session it leaves behind in the registry (a closed connection's sessions
 * linger for the resume window) never counts among the serving runtime's
 * sessions when the test inspects their watches. */
const creatorSigner = await Identity.fromPassphrase("read-through creator");

/**
 * The `{ total }` result schema of the pattern served below. The client
 * reads the result under it, so its watch crosses from `total` to the
 * computed document behind it: that crossing is the demand the serving loop
 * loads the piece for and runs the derivation under.
 */
const TOTAL_RESULT_SCHEMA = {
  type: "object",
  properties: { total: { type: "number" } },
  required: ["total"],
} as const satisfies JSONSchema;

describe("engine-read-through", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: SharedServerStorageManager;
  let clientRuntime: Runtime;

  /** How the serving manager's feed refresh is made to fail, when it is:
   * `once` throws on the first refresh and delegates from then on,
   * `always` throws on every refresh. */
  let failRefreshes: "once" | "always" | undefined;
  let refreshCalls = 0;

  /** The context the SpaceServer handed the runtime factory at the last
   * activation. The factory does not install what it carries — it reads
   * nothing before returning — so the SpaceServer's own install is what
   * the tests exercise. */
  let factoryContext: RuntimeFactoryContext | undefined;

  /** The serving manager the factory built at the last activation. */
  let factoryManager: SharedServerStorageManager | undefined;

  /** The serving runtime the factory built at the last activation. */
  let factoryRuntime: Runtime | undefined;

  /** The host's wave-commit sink decorator, for the test that holds a
   * wave commit in flight. Undefined everywhere else. */
  let decorateWaveCommitSink:
    | ((sink: WaveCommitSink) => WaveCommitSink)
    | undefined;

  const newHost = (policy: SpaceServerPolicy): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: (_space, context) => {
        factoryContext = context;
        const manager = SharedServerStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        factoryManager = manager;
        const integrate = manager.integrateStoreWrites.bind(manager);
        manager.integrateStoreWrites = (writeSpace, writes) => {
          refreshCalls += 1;
          if (
            failRefreshes === "always" ||
            (failRefreshes === "once" && refreshCalls === 1)
          ) {
            throw new Error("induced store refresh failure");
          }
          return integrate(writeSpace, writes);
        };
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        factoryRuntime = runtime;
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      policy,
      ...(decorateWaveCommitSink === undefined
        ? {}
        : { decorateWaveCommitSink }),
    });

  /**
   * Instantiates the piece — a pattern deriving `total = n + 1` — through a
   * short-lived runtime that leaves before the host exists. Nothing else
   * writes the space while it runs, so its commit lands first time, and its
   * local run dies with it: from then on only a server-started piece derives
   * anything.
   */
  const instantiatePiece = async (): Promise<void> => {
    const manager = SharedServerStorageManager.connectTo(server, {
      as: creatorSigner,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    try {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { computed, pattern } from 'commonfabric';",
            "export default pattern<{ n: number }, { total: number }>(",
            "  ({ n }) => ({ total: computed(() => n + 1) }),",
            ");",
          ].join("\n"),
        }],
      }, { space });
      const argument = runtime.getCell<{ n: number }>(
        space,
        "read-through-arg",
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        space,
        "read-through-result",
        compiled.resultSchema,
      );
      await argument.sync();
      await result.sync();
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
    } finally {
      await runtime.dispose();
      await manager.close();
    }
  };

  /** The service principal's live sessions on the space. */
  const serviceSessions = () =>
    server.accessForTestingOnly.sessionsForSpace(space).filter((session) =>
      session.principal === serviceSigner.did()
    );

  /**
   * Opens the client's demand on the result document under its schema,
   * which activates the space and has the serving loop load the piece, and
   * waits for the SpaceServer to be serving. Returns the client's result and
   * argument cells.
   */
  const demandFromClient = async (): Promise<{
    clientResult: Cell<{ total: number }>;
    clientArg: Cell<{ n: number }>;
  }> => {
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "read-through-result",
      TOTAL_RESULT_SCHEMA,
    );
    await clientResult.sync();
    await waitUntil(
      () => host?.spaceServer(space)?.active === true,
      "the SpaceServer to activate on the client's session",
    );
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "read-through-arg",
      undefined,
    );
    await clientArg.sync();
    return { clientResult, clientArg };
  };

  /** Commits `n` from the client and waits for the serving loop's derived
   * `total` to reach the client's subscription. */
  const deriveFromClient = async (
    clientArg: Cell<{ n: number }>,
    clientResult: Cell<{ total: number }>,
    n: number,
  ): Promise<void> => {
    const engine = await server.engineForSpace(space);
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ n });
    expect((await tx.commit().settled).error).toBeUndefined();
    // Only the authored input is the settlement target; the store head can
    // already include a serving wave that followed it.
    const authoredSeq = Engine.readState(engine, {
      id: clientArg.getAsNormalizedFullLink().id,
    })!.seq;
    expect(Engine.commitClassOfSeq(engine, authoredSeq)).toBe("authored");
    await waitUntil(
      () => readWatermarkSeq(engine) >= authoredSeq,
      () =>
        `the watermark (${readWatermarkSeq(engine)}) to reach the authored ` +
        `commit (${authoredSeq})`,
    );
    const settled = await waitForSettled(clientRuntime, space, authoredSeq, {
      timeoutMs: 10_000,
    });
    expect(settled).toBeGreaterThanOrEqual(authoredSeq);
    await waitUntil(
      () => clientResult.key("total").get() === n + 1,
      `client to observe the derived value ${n + 1}`,
    );
  };

  /**
   * Writes `{ draft }` into the client principal's own `user` instance of
   * the named document and returns the document id: a foreign instance
   * from the serving runtime's point of view, which the memory server
   * delivers to a session only while the session's lease is live.
   */
  const writeUserInstance = async (
    name: string,
    draft: string,
  ): Promise<URI> => {
    const link = clientRuntime.getCell<unknown>(space, name, undefined)
      .getAsNormalizedFullLink();
    const cell = clientRuntime.getCellFromLink<{ draft: string }>({
      ...link,
      scope: "user",
    });
    const tx = clientRuntime.edit();
    cell.withTx(tx).set({ draft });
    expect((await tx.commit().settled).error).toBeUndefined();
    await clientRuntime.storageManager.synced();
    return link.id;
  };

  /** The identity a user-instance read of the client principal names. */
  const clientIdentity: ScopeKeyIdentity = { principal: aliceSigner.did() };

  beforeEach(() => {
    server = newSharedServer({
      subscriptionRefreshDelayMs: 0,
    });
    failRefreshes = undefined;
    refreshCalls = 0;
    factoryContext = undefined;
    factoryManager = undefined;
    factoryRuntime = undefined;
    decorateWaveCommitSink = undefined;
    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime.dispose();
    await clientManager.close();
    await server.close();
  });

  it("derives from engine reads with no session watch, and refreshes a held document from the feed when a later authored commit writes it", async () => {
    await instantiatePiece();
    host = newHost({
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      storeReadThrough: true,
    });
    const { clientResult, clientArg } = await demandFromClient();
    // The SpaceServer offers the factory the tenure's read-through, so a
    // factory that reads before returning can install it ahead of that.
    expect(factoryContext?.storeReadThrough).toBeDefined();

    await deriveFromClient(clientArg, clientResult, 41);
    // A serving runtime under the posture may open no session at all —
    // nothing it did here needed one: reads came from the engine and the
    // wave committed through the engine sink — and any it does open
    // carries no watch.
    for (const session of serviceSessions()) {
      expect(session.watches).toEqual([]);
    }
    const readsAfterFirst = host.stats().storeReads;
    expect(readsAfterFirst).toBeGreaterThan(0);
    // A refresh touches only what the replica holds: nothing to list, or
    // an instance it never read, refreshes nothing and reads nothing.
    expect(factoryManager!.integrateStoreWrites(space, [])).toBe(0);
    expect(
      factoryManager!.integrateStoreWrites(space, [
        { id: "of:never-read", scopeKey: "space" },
      ]),
    ).toBe(0);
    expect(host.stats().storeReads).toBe(readsAfterFirst);

    // The second write lands after the serving runtime read the argument
    // document; with no watch on it, only the feed refresh can move it.
    await deriveFromClient(clientArg, clientResult, 100);
    expect(host.stats().storeRefreshes).toBeGreaterThan(0);
    expect(host.stats().storeReads).toBeGreaterThan(readsAfterFirst);
    for (const session of serviceSessions()) {
      expect(session.watches).toEqual([]);
    }
  });

  it("registers session watches and performs no engine reads with the posture off", async () => {
    await instantiatePiece();
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });
    const { clientResult, clientArg } = await demandFromClient();
    expect(factoryContext?.storeReadThrough).toBeUndefined();

    await deriveFromClient(clientArg, clientResult, 41);
    expect(serviceSessions().some((session) => session.watches.length > 0))
      .toBe(true);
    expect(host.stats().storeReads).toBe(0);
    expect(host.stats().storeRefreshes).toBe(0);
  });

  it("holds a feed record whose refresh failed for the next cycle, and derives from it once the retry succeeds, in the same tenure", async () => {
    failRefreshes = "once";
    await instantiatePiece();
    host = newHost({
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      storeReadThrough: true,
    });
    const { clientResult, clientArg } = await demandFromClient();
    const tenure = host.spaceServer(space);

    await deriveFromClient(clientArg, clientResult, 41);
    expect(refreshCalls).toBeGreaterThanOrEqual(2);
    expect(host.spaceServer(space)).toBe(tenure);
    expect(tenure?.active).toBe(true);
  });

  it("parks the space after a feed record's refresh has failed on consecutive cycles up to the bound", async () => {
    failRefreshes = "always";
    await instantiatePiece();
    host = newHost({
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      storeReadThrough: true,
    });
    const { clientArg } = await demandFromClient();
    const tenure = host.spaceServer(space)!;

    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ n: 41 });
    expect((await tx.commit().settled).error).toBeUndefined();
    await tenure.whenParked;
    expect(tenure.active).toBe(false);
    expect(refreshCalls).toBe(STORE_REFRESH_ATTEMPTS);
  });

  it("returns nothing for every address once the engine's database is closed", async () => {
    // A separate server, so closing its engine here leaves the suite's own
    // teardown nothing to close twice.
    const closing = new MemoryV2Server.Server({
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: () => aliceSigner.did(),
      sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
    });
    const engine = await closing.engineForSpace(space);
    let reads = 0;
    const read = engineReadThrough(engine, {
      onRead: () => {
        reads += 1;
      },
    });
    const absent = read({ id: "of:never-written" as never, scopeKey: "space" });
    expect(absent).toEqual({
      branch: "",
      id: "of:never-written",
      scope: "space",
      scopeKey: "space",
      seq: 0,
      deleted: true,
    });
    expect(reads).toBe(1);
    // A replica served by it reads the same way: before the close a miss
    // is served, after it a miss stays a miss and a sync resolves with
    // nothing.
    const manager = SharedServerStorageManager.connectTo(closing, {
      as: serviceSigner,
    });
    try {
      manager.installStoreReadThrough(space, read);
      const provider = manager.open(space);
      expect(provider.replica.getDocument("of:never-written" as URI))
        .toBeUndefined();
      expect(reads).toBe(2);
      await closing.close();
      expect(provider.replica.getDocument("of:closed-late" as URI))
        .toBeUndefined();
      expect((await provider.sync("of:closed-late" as URI)).ok).toBeDefined();
      expect(reads).toBe(2);
    } finally {
      await manager.close();
    }
    expect(read({ id: "of:never-written" as never, scopeKey: "space" }))
      .toBeUndefined();
    expect(reads).toBe(2);
  });

  it("reads the schema documents a document's link positions name, and the documents those name in turn, along with it", async () => {
    // The chase the frame validator's delivery guarantee needs, over a
    // store of three documents: a carrier whose link carries a schema
    // reference, the schema document that reference names, and the
    // schema document THAT one's own refs name. One read of the carrier
    // integrates all three.
    const decomposed = decomposeSchema({
      type: "object",
      properties: { leaf: { $ref: "#/$defs/Leaf" } },
      $defs: {
        Leaf: { type: "object", properties: { text: { type: "string" } } },
      },
    });
    const store = new Map<string, FabricValue>(
      [...decomposed.documents].map((
        [hash, document],
      ) => [`cid:${hash}`, document as FabricValue]),
    );
    const carried = {
      "/": {
        "link@1": {
          id: "of:chase-target",
          path: [],
          schema: { $ref: decomposed.rootRef },
        },
      },
    };
    store.set("of:chase-carrier", { carried });
    const reads: string[] = [];
    const manager = SharedServerStorageManager.connectTo(server, {
      as: serviceSigner,
    });
    try {
      manager.installStoreReadThrough(space, ({ id, scopeKey }) => {
        reads.push(id);
        const value = store.get(id);
        return {
          branch: "",
          id,
          scope: "space",
          scopeKey,
          ...(value === undefined
            ? { seq: 0, deleted: true as const }
            : { seq: 1, doc: { value } }),
        };
      });
      // The class, for the persisted-content probe the interface does
      // not carry.
      const replica = manager.open(space).replica as SpaceReplica;
      expect(replica.getDocument("of:chase-carrier" as URI)).toEqual({
        value: { carried },
      });
      // Dependency-first in the decomposition, so the chase — which reads
      // the referrer before what it references — runs it in reverse.
      expect(reads).toEqual([
        "of:chase-carrier",
        ...[...decomposed.documents.keys()].reverse().map((hash) =>
          `cid:${hash}`
        ),
      ]);
      for (const hash of decomposed.documents.keys()) {
        expect(replica.isContentAddressedDocPersisted(hash)).toBe(true);
      }
    } finally {
      await manager.close();
    }
  });

  it("reads the schema document a document's schema metadata member names along with it", async () => {
    // The frame validator holds a document's `schema` metadata member to
    // the same delivery guarantee as its link positions: the reference
    // form names a schema document, and the document is quarantined unless
    // that one arrives with it. The chase follows the member as a
    // session's walk does.
    const decomposed = decomposeSchema({
      type: "object",
      properties: { text: { type: "string" } },
    });
    const store = new Map<string, { value: FabricValue; schema?: JSONSchema }>(
      [...decomposed.documents].map((
        [hash, document],
      ) => [`cid:${hash}`, { value: document as FabricValue }]),
    );
    const carrier = {
      value: { text: "held" },
      schema: { $ref: decomposed.rootRef },
    };
    store.set("of:meta-carrier", carrier);
    const reads: string[] = [];
    const manager = SharedServerStorageManager.connectTo(server, {
      as: serviceSigner,
    });
    try {
      manager.installStoreReadThrough(space, ({ id, scopeKey }) => {
        reads.push(id);
        const doc = store.get(id);
        return {
          branch: "",
          id,
          scope: "space",
          scopeKey,
          ...(doc === undefined
            ? { seq: 0, deleted: true as const }
            : { seq: 1, doc }),
        };
      });
      const replica = manager.open(space).replica as SpaceReplica;
      expect(replica.getDocument("of:meta-carrier" as URI)).toEqual(carrier);
      expect(reads).toEqual([
        "of:meta-carrier",
        ...[...decomposed.documents.keys()].reverse().map((hash) =>
          `cid:${hash}`
        ),
      ]);
      // Held now: a second read reaches the store for nothing.
      expect(replica.getDocument("of:meta-carrier" as URI)).toEqual(carrier);
      expect(reads.length).toBe(1 + decomposed.documents.size);
    } finally {
      await manager.close();
    }
  });

  it("reads the store for a pull of a held document no further, and serves the value the feed last refreshed", async () => {
    // A held document is kept current by the feed's refresh at every
    // cycle, the way a session's covered selector is by its watch; a
    // later sync of it is answered from the replica. The refresh is what
    // moves it: the store's newer version reaches a sync only through
    // `integrateStoreWrites()`.
    const store = new Map<
      string,
      { seq: number; doc: { value: FabricValue } }
    >();
    store.set("of:held", { seq: 1, doc: { value: { n: 1 } } });
    const reads: string[] = [];
    const manager = SharedServerStorageManager.connectTo(server, {
      as: serviceSigner,
    });
    try {
      manager.installStoreReadThrough(space, ({ id, scopeKey }) => {
        reads.push(id);
        const entry = store.get(id);
        return {
          branch: "",
          id,
          scope: "space",
          scopeKey,
          ...(entry === undefined
            ? { seq: 0, deleted: true as const }
            : { seq: entry.seq, doc: entry.doc }),
        };
      });
      const replica = manager.open(space).replica as SpaceReplica;
      expect((await replica.sync("of:held" as URI)).ok).toBeDefined();
      expect(replica.getDocument("of:held" as URI)).toEqual({
        value: { n: 1 },
      });
      store.set("of:held", { seq: 2, doc: { value: { n: 2 } } });
      expect((await replica.sync("of:held" as URI)).ok).toBeDefined();
      expect(reads).toEqual(["of:held"]);
      expect(replica.getDocument("of:held" as URI)).toEqual({
        value: { n: 1 },
      });
      expect(
        manager.integrateStoreWrites(space, [
          { id: "of:held", scopeKey: "space" },
        ]),
      ).toBe(1);
      expect(replica.getDocument("of:held" as URI)).toEqual({
        value: { n: 2 },
      });
      expect(reads).toEqual(["of:held", "of:held"]);
    } finally {
      await manager.close();
    }
  });

  it("integrates a feed refresh at the seq a local commit already confirmed, since the store's document may carry what the commit merged", async () => {
    // A commit of this replica's own write promotes its record to the
    // commit's seq with the value it materialized locally; the store's
    // document at that seq can hold more — content the engine merged in
    // beside a mergeable write — and the refresh that carries it is the
    // replica's first delivery of that seq, never a repeat.
    const store = new Map<
      string,
      { seq: number; doc: { value: FabricValue } }
    >();
    const manager = SharedServerStorageManager.connectTo(server, {
      as: serviceSigner,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    try {
      manager.installStoreReadThrough(space, ({ id, scopeKey }) => {
        const entry = store.get(id);
        return {
          branch: "",
          id,
          scope: "space",
          scopeKey,
          ...(entry === undefined
            ? { seq: 0, deleted: true as const }
            : { seq: entry.seq, doc: entry.doc }),
        };
      });
      const cell = runtime.getCell<{ n: number; merged?: boolean }>(
        space,
        "read-through-promoted",
        undefined,
      );
      const id = cell.getAsNormalizedFullLink().id;
      const tx = runtime.edit();
      cell.withTx(tx).set({ n: 1 });
      expect((await tx.commit().settled).error).toBeUndefined();
      const replica = manager.open(space).replica as SpaceReplica;
      const confirmed = replica.get({ id, path: [], scope: "space" })?.since;
      expect(confirmed).toBeGreaterThan(0);
      store.set(id, {
        seq: confirmed!,
        doc: { value: { n: 1, merged: true } },
      });
      expect(
        manager.integrateStoreWrites(space, [{ id, scopeKey: "space" }]),
      ).toBe(1);
      expect(replica.getDocument(id)?.value).toEqual({ n: 1, merged: true });
    } finally {
      await runtime.dispose();
      await manager.close();
    }
  });

  it("does not read the store for a pull whose scope the identity cannot resolve", async () => {
    // Such a scope keys by its name, which names no store row: the store
    // would read the name as the space scope and answer with the wrong
    // document. A replica whose identity carries no principal is the
    // shape that makes a `user` scope unresolvable.
    const reads: string[] = [];
    const replica = new SpaceReplica({
      as: serviceSigner,
      space,
      settings: {},
      subscription: { next: () => {} },
      scopeKeyIdentity: () => ({}),
      routeState: { generation: 0 },
      routeGeneration: 0,
      createSession: () =>
        Promise.reject(new Error("no session is opened for this pull")),
      syncReplayDependencies: () => Promise.resolve(undefined),
      storeReadThrough: () => ({ id }) => {
        reads.push(id);
        return undefined;
      },
    });
    try {
      // A read on access under such a scope is not served either.
      expect(replica.getDocument("of:by-name" as URI, "user")).toBeUndefined();
      expect((await replica.sync("of:by-name" as URI, undefined, "user")).ok)
        .toBeDefined();
      expect(reads).toEqual([]);
      expect((await replica.sync("of:by-key" as URI)).ok).toBeDefined();
      expect(reads).toEqual(["of:by-key"]);
    } finally {
      replica.closeNow();
    }
  });

  it("reads another principal's instance under an expired lease only through the same-process reacquire, while a space-scoped read renews nothing", async () => {
    await instantiatePiece();
    host = newHost({
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      renewIntervalMs: 600_000,
      storeReadThrough: true,
    });
    await demandFromClient();
    const engine = await server.engineForSpace(space);
    const spaceServer = host.spaceServer(space)!;
    const id = await writeUserInstance("read-through-lease-doc", "A");
    expect(
      Engine.readState(engine, {
        id,
        scopeKey: resolveScopeKey("user", clientIdentity),
      })?.document,
    ).toBeDefined();
    const replica = factoryManager!.open(space).replica;

    // The lease row expires under the tenure (an expired row matches
    // nobody), as a stalled process would find it at its next renewal.
    expect(
      acquireExecutionLease(engine, {
        space,
        holder: spaceServer.holder,
        now: Date.now() - 60_000,
        ttlMs: 1,
      }),
    ).toBe(true);
    expect(liveExecutionLeaseHolder(engine, space)).toBeUndefined();
    // A space-scoped document is delivered to any session, lease or not,
    // and is read here without consulting the row.
    replica.get({ id: "of:read-through-space-probe", scope: "space" });
    expect(host.stats().lease.lost).toBe(0);
    expect(liveExecutionLeaseHolder(engine, space)).toBeUndefined();

    // Another principal's instance is served only to a live holder: the
    // read runs the renew arm first — the lease is lost and reacquired
    // in-process, the same step the renew timer takes — and is served
    // under the new tenure.
    expect(
      replica.getDocument(id, "user", clientIdentity)?.value,
    ).toEqual({ draft: "A" });
    expect(host.stats().lease.lost).toBe(1);
    expect(liveExecutionLeaseHolder(engine, space)).toBe(spaceServer.holder);
    expect(spaceServer.active).toBe(true);
    // Held now: later reads of the instance never reach the row again.
    releaseExecutionLease(engine, { space, holder: spaceServer.holder });
    expect(
      replica.getDocument(id, "user", clientIdentity)?.value,
    ).toEqual({ draft: "A" });
    expect(host.stats().lease.lost).toBe(1);
  });

  it("withholds another principal's instance while a rival holds the lease, and parks the space", async () => {
    await instantiatePiece();
    host = newHost({
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      renewIntervalMs: 600_000,
      storeReadThrough: true,
    });
    await demandFromClient();
    const engine = await server.engineForSpace(space);
    const spaceServer = host.spaceServer(space)!;
    const id = await writeUserInstance("read-through-rival-doc", "A");
    const replica = factoryManager!.open(space).replica;

    releaseExecutionLease(engine, { space, holder: spaceServer.holder });
    const rival = executionLeaseHolder("did:key:rival-process");
    expect(
      acquireExecutionLease(engine, { space, holder: rival, ttlMs: 600_000 }),
    ).toBe(true);
    // A former holder receives no foreign instance (protocol.md §3): the
    // read is withheld, and the tenure that cannot reacquire parks.
    expect(replica.getDocument(id, "user", clientIdentity)).toBeUndefined();
    expect(host.stats().lease.lost).toBe(1);
    await waitUntil(() => spaceServer.active === false, "the space to park");
    expect(liveExecutionLeaseHolder(engine, space)).toBe(rival);
  });

  /** One wave commit the decorated sink saw: the wave's basis, and the
   * seq the commit landed at once it has. */
  type ObservedWaveCommit = { basisSeq: number; seq?: number };

  /**
   * Installs a sink decorator on the next host that records every wave
   * commit and holds one in flight: the first one after `arm()`. `held()`
   * resolves once that commit is held, with it last in `commits`, and
   * fails the test on the shared backstop if no commit ever arrives;
   * `release()` lets it land. Every seal opens a wave when none is open,
   * at that moment's serverSeq, so a seal landing inside the hold opens
   * one whose basis the held commit passes; what is authored inside the
   * hold is the following cycle's batch, the one that would inherit that
   * wave. Under this posture an input reaches the serving runtime only
   * through a cycle's refresh, which keeps every seal but the test's own
   * out of the window.
   */
  const holdableWaveCommit = (): {
    arm: () => void;
    held: () => Promise<void>;
    release: () => void;
    commits: ObservedWaveCommit[];
  } => {
    const release = Promise.withResolvers<void>();
    const commits: ObservedWaveCommit[] = [];
    let armed = false;
    let holding = false;
    decorateWaveCommitSink = (sink) => ({
      currentHeads: (space, docs) => sink.currentHeads(space, docs),
      concurrentWritePaths: (space, doc, sinceSeq) =>
        sink.concurrentWritePaths(space, doc, sinceSeq),
      commitWave: async (batch) => {
        const observed: ObservedWaveCommit = { basisSeq: batch.basisSeq };
        commits.push(observed);
        if (armed) {
          armed = false;
          holding = true;
          await release.promise;
        }
        const result = await sink.commitWave(batch);
        if (result.ok !== undefined) observed.seq = result.ok.seq;
        return result;
      },
    });
    return {
      arm: () => {
        armed = true;
      },
      held: () => waitUntil(() => holding, "the armed wave commit to be held"),
      release: () => release.resolve(),
      commits,
    };
  };

  /** The basis of every wave committed after `heldCommit` landed is at or
   * past the seq it landed at: none was opened while it was in flight. */
  const expectWavesOpenedAfter = (
    commits: readonly ObservedWaveCommit[],
    heldCommit: ObservedWaveCommit,
  ): void => {
    expect(heldCommit.seq).toBeDefined();
    const later = commits.slice(commits.indexOf(heldCommit) + 1);
    expect(later.length).toBeGreaterThan(0);
    for (const commit of later) {
      expect(commit.basisSeq).toBeGreaterThanOrEqual(heldCommit.seq!);
    }
  };

  /** Seals a read probe against the serving runtime: a transaction that
   * reads the argument document and writes nothing. */
  const sealReadProbe = async (): Promise<void> => {
    const probe = factoryRuntime!.edit();
    factoryRuntime!.getCell<{ n: number }>(space, "read-through-arg", undefined)
      .withTx(probe).get();
    expect((await probe.commit().settled).error).toBeUndefined();
  };

  it("advances the watermark document over a commit authored while the wave creating that document was in flight, when nothing derives from it", async () => {
    // The activation's first wave creates the watermark document. A cycle
    // inheriting a wave opened during that commit carries only the next
    // watermark advance, a write to a document its basis predates the
    // creation of, which the per-doc CAS drops whole; the loop's own
    // view of W would advance anyway, and nothing would re-advance the
    // document until a later input.
    const hold = holdableWaveCommit();
    await instantiatePiece();
    hold.arm();
    host = newHost({
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      storeReadThrough: true,
    });
    await demandFromClient();
    const engine = await server.engineForSpace(space);
    await hold.held();
    const creation = hold.commits.at(-1)!;
    await sealReadProbe();
    const id = "of:read-through-window-doc" as URI;
    const cell = clientRuntime.getCellFromLink<{ made: boolean }>({
      id,
      space,
      path: [],
    });
    const creating = clientRuntime.edit();
    cell.withTx(creating).set({ made: true });
    expect((await creating.commit().settled).error).toBeUndefined();
    const authoredSeq = Engine.readState(engine, { id })!.seq;
    expect(Engine.commitClassOfSeq(engine, authoredSeq)).toBe("authored");
    hold.release();

    await waitUntil(
      () => readWatermarkSeq(engine) >= authoredSeq,
      "the watermark document to cover the commit authored inside the window",
    );
    const settled = await waitForSettled(clientRuntime, space, authoredSeq, {
      timeoutMs: 10_000,
    });
    expect(settled).toBeGreaterThanOrEqual(authoredSeq);
    expectWavesOpenedAfter(hold.commits, creation);
  });

  it("derives from an input authored while its own previous wave commit was in flight, and serves the derived value", async () => {
    // A cycle inheriting a wave opened during the commit of the wave
    // deriving the previous input would seal the next derivation's write
    // to the computed document under a basis that commit passed, and the
    // per-doc CAS would drop it as superseded with nothing re-running it
    // (serving-loop.md §3d).
    const hold = holdableWaveCommit();
    await instantiatePiece();
    host = newHost({
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      storeReadThrough: true,
    });
    const { clientResult, clientArg } = await demandFromClient();
    const engine = await server.engineForSpace(space);
    await deriveFromClient(clientArg, clientResult, 41);
    // The content wave's trailing quiescence advance lands first, so the
    // hold catches the wave deriving the next input and no other.
    await waitUntil(
      () => host!.stats().settleAdvances.count >= 1,
      "the drain-settle quiescence advance to land",
    );
    hold.arm();
    const input = clientRuntime.edit();
    clientArg.withTx(input).set({ n: 50 });
    expect((await input.commit().settled).error).toBeUndefined();
    await hold.held();
    const previous = hold.commits.at(-1)!;
    await sealReadProbe();
    const next = clientRuntime.edit();
    clientArg.withTx(next).set({ n: 60 });
    expect((await next.commit().settled).error).toBeUndefined();
    const authoredSeq = Engine.readState(engine, {
      id: clientArg.getAsNormalizedFullLink().id,
    })!.seq;
    expect(Engine.commitClassOfSeq(engine, authoredSeq)).toBe("authored");
    hold.release();

    await waitUntil(
      () => readWatermarkSeq(engine) >= authoredSeq,
      "the watermark document to cover the input authored inside the window",
    );
    await waitForSettled(clientRuntime, space, authoredSeq, {
      timeoutMs: 10_000,
    });
    await waitUntil(
      () => clientResult.key("total").get() === 61,
      "the client to observe the derived value 61",
    );
    expect(host!.stats().supersededWrites).toBe(0);
    expectWavesOpenedAfter(hold.commits, previous);
  });

  it("holds no record for an address the store has nothing at, reads it once, and picks it up from the feed once a commit creates it", async () => {
    await instantiatePiece();
    host = newHost({
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      storeReadThrough: true,
    });
    await demandFromClient();
    const engine = await server.engineForSpace(space);
    const replica = factoryManager!.open(space).replica as SpaceReplica;
    const id = "of:read-through-absent" as URI;
    const readsBefore = host.stats().storeReads;
    expect(replica.get({ id, path: [], scope: "space" })).toBeUndefined();
    expect(host.stats().storeReads).toBe(readsBefore + 1);
    // Examined once: the second read costs the engine nothing.
    expect(replica.get({ id, path: [], scope: "space" })).toBeUndefined();
    expect(host.stats().storeReads).toBe(readsBefore + 1);
    // No record stands for it, as none would after a session's pull
    // delivered nothing: a transaction that read it reports the absence
    // as unexamined, for commit's reconcile to re-read.
    const tx = factoryRuntime!.edit();
    factoryRuntime!.getCellFromLink<unknown>({ id, space, path: [] })
      .withTx(tx).get();
    expect(replica.unexaminedAbsences(tx).map((absence) => absence.id))
      .toEqual([id]);
    await tx.commit().settled;

    // A commit creating the document reaches the replica through the feed.
    const cell = clientRuntime.getCellFromLink<{ made: boolean }>({
      id,
      space,
      path: [],
    });
    const creating = clientRuntime.edit();
    cell.withTx(creating).set({ made: true });
    // The refresh baseline is read ahead of the commit: the loop can have
    // refreshed the record before the commit's own promise resolves.
    const refreshesBefore = host.stats().storeRefreshes;
    expect((await creating.commit().settled).error).toBeUndefined();
    // The creating commit's own seq is the settlement target: the loop's
    // wave commits can land between the client's commit and this read,
    // and the watermark covers authored input only.
    const authoredSeq = Engine.readState(engine, { id })!.seq;
    expect(Engine.commitClassOfSeq(engine, authoredSeq)).toBe("authored");
    await waitUntil(
      () => readWatermarkSeq(engine) >= authoredSeq,
      () =>
        `the watermark (${readWatermarkSeq(engine)}) to cover the creating ` +
        `commit (${authoredSeq})`,
    );
    expect(host.stats().storeRefreshes).toBeGreaterThan(refreshesBefore);
    // Held by the refresh: this read costs the engine nothing.
    const readsBeforeHeld = host.stats().storeReads;
    expect(replica.getDocument(id)?.value).toEqual({ made: true });
    expect(host.stats().storeReads).toBe(readsBeforeHeld);
  });
});
