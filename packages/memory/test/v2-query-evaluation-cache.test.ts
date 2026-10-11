import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { applyCommit, open as openEngine } from "../v2/engine.ts";
import {
  classifyStateScope,
  createQueryEvaluationCache,
  queryEvaluationCacheDiagnostics,
  type TrackedGraphState,
  trackGraph,
} from "../v2/query.ts";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
  type SessionSync,
  type WatchAddResult,
} from "../v2.ts";

const TEST_AUDIENCE = "did:key:z6Mk-memory-v2-eval-cache-test-audience";

const createServer = (store: string, budget?: number) =>
  new Server({
    store: new URL(store),
    ...(budget === undefined ? {} : { queryEvaluationCacheBudget: budget }),
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string"
        ? principal
        : "did:key:z6Mk-memory-v2-eval-cache-principal";
    },
    sessionOpenAuth: {
      audience: TEST_AUDIENCE,
    },
  });

const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const openSession = async (
  connection: ReturnType<Server["connect"]>,
  messages: ServerMessage[],
  space: string,
  label: string,
  principal?: string,
): Promise<string> => {
  await connection.receive(encodeMemoryBoundary({
    type: "hello",
    protocol: MEMORY_PROTOCOL,
    flags: getMemoryProtocolFlags(),
  }));
  const hello = messages.shift() as
    | { type: string; sessionOpen?: SessionOpenAuthMetadata }
    | undefined;
  expect(hello?.type).toBe("hello.ok");
  const sessionOpen = hello!.sessionOpen!;
  await connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: `${label}-open`,
    space,
    session: {},
    invocation: {
      aud: sessionOpen.audience,
      challenge: sessionOpen.challenge.value,
    },
    ...(principal === undefined ? {} : { authorization: { principal } }),
  }));
  const opened = messages.shift() as ResponseMessage<{ sessionId: string }>;
  expect(opened.ok).toBeDefined();
  return opened.ok!.sessionId;
};

const watchAdd = async (
  connection: ReturnType<Server["connect"]>,
  messages: ServerMessage[],
  space: string,
  sessionId: string,
  label: string,
  roots: { id: string; scope?: string }[],
): Promise<SessionSync> => {
  await connection.receive(encodeMemoryBoundary({
    type: "session.watch.add",
    requestId: `${label}-watch`,
    space,
    sessionId,
    watches: [{
      id: `${label}-watch-id`,
      kind: "graph",
      query: {
        roots: roots.map((root) => ({
          ...root,
          selector: { path: [], schema: true },
        })),
      },
    }],
  }));
  const response = messages.shift() as ResponseMessage<WatchAddResult>;
  expect(response.ok).toBeDefined();
  return response.ok!.sync;
};

const upsertIds = (sync: SessionSync): string[] =>
  [...sync.upserts.map((upsert) => upsert.id)].toSorted();

const seedDocs = async (
  server: Server,
  messages: ServerMessage[],
  space: string,
  sessionId: string,
  ids: string[],
): Promise<void> => {
  const response = await server.transact({
    type: "transact",
    requestId: crypto.randomUUID(),
    space,
    sessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: ids.map((id, index) => ({
        op: "set",
        id,
        value: { value: { n: index + 1 } },
      })),
    },
  });
  expect(response.error).toBeUndefined();
  await tick();
  messages.length = 0;
};

describe("v2 query evaluation cache", () => {
  it("serves a second session's identical watch set without re-evaluating, keeping its delivery live", async () => {
    const space = "did:key:z6Mk-eval-cache-shared";
    const server = createServer("memory://eval-cache-shared");
    const messagesA: ServerMessage[] = [];
    const messagesB: ServerMessage[] = [];
    const connectionA = server.connect((message) => messagesA.push(message));
    const connectionB = server.connect((message) => messagesB.push(message));
    let connectionW: ReturnType<Server["connect"]> | undefined;
    try {
      const sessionA = await openSession(connectionA, messagesA, space, "a");
      const sessionB = await openSession(connectionB, messagesB, space, "b");
      await seedDocs(server, messagesA, space, sessionA, [
        "of:doc:1",
        "of:doc:2",
      ]);
      messagesB.length = 0;

      const before = server.evaluationCacheDiagnostics(space);
      const syncA = await watchAdd(
        connectionA,
        messagesA,
        space,
        sessionA,
        "a",
        [
          { id: "of:doc:1" },
          { id: "of:doc:2" },
        ],
      );
      const syncB = await watchAdd(
        connectionB,
        messagesB,
        space,
        sessionB,
        "b",
        [
          { id: "of:doc:1" },
          { id: "of:doc:2" },
        ],
      );
      const after = server.evaluationCacheDiagnostics(space);

      expect(after.misses - before.misses).toBe(1);
      expect(after.hits - before.hits).toBe(1);
      expect(upsertIds(syncB)).toEqual(upsertIds(syncA));

      // The soundness pin: a cache-served session's coverage must deliver
      // exactly like an evaluated one. A THIRD session writes (a writer's
      // own change is not echoed back to it), and the update must reach
      // both watchers — the evaluated one and the cache-served one alike.
      const messagesW: ServerMessage[] = [];
      connectionW = server.connect((message) => messagesW.push(message));
      const sessionW = await openSession(connectionW, messagesW, space, "w");
      messagesA.length = 0;
      messagesB.length = 0;
      const write = await server.transact({
        type: "transact",
        requestId: crypto.randomUUID(),
        space,
        sessionId: sessionW,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:doc:1", value: { value: { n: 99 } } },
          ],
        },
      });
      expect(write.error).toBeUndefined();
      await server.flushSessions();
      await tick();

      const delivered = (messages: ServerMessage[]): boolean =>
        messages.some((message) =>
          message.type === "session/effect" &&
          (message as { effect?: SessionSync }).effect?.upserts.some(
            (upsert) => upsert.id === "of:doc:1",
          )
        );
      expect(delivered(messagesA)).toBe(true);
      expect(delivered(messagesB)).toBe(true);
    } finally {
      connectionA.close();
      connectionB.close();
      connectionW?.close();
    }
  });

  it("rotates on a commit so a later evaluation sees current state", async () => {
    const space = "did:key:z6Mk-eval-cache-rotate";
    const server = createServer("memory://eval-cache-rotate");
    const messagesA: ServerMessage[] = [];
    const messagesB: ServerMessage[] = [];
    const connectionA = server.connect((message) => messagesA.push(message));
    const connectionB = server.connect((message) => messagesB.push(message));
    try {
      const sessionA = await openSession(connectionA, messagesA, space, "a");
      const sessionB = await openSession(connectionB, messagesB, space, "b");
      await seedDocs(server, messagesA, space, sessionA, [
        "of:doc:1",
      ]);
      messagesB.length = 0;

      const syncA = await watchAdd(
        connectionA,
        messagesA,
        space,
        sessionA,
        "a",
        [
          { id: "of:doc:1" },
        ],
      );
      expect(syncA.upserts.length).toBe(1);

      const write = await server.transact({
        type: "transact",
        requestId: crypto.randomUUID(),
        space,
        sessionId: sessionA,
        commit: {
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:doc:1", value: { value: { n: 42 } } },
          ],
        },
      });
      expect(write.error).toBeUndefined();
      await tick();

      const before = server.evaluationCacheDiagnostics(space);
      const syncB = await watchAdd(
        connectionB,
        messagesB,
        space,
        sessionB,
        "b",
        [
          { id: "of:doc:1" },
        ],
      );
      const after = server.evaluationCacheDiagnostics(space);

      expect(after.hits - before.hits).toBe(0);
      expect(after.rotations - before.rotations).toBeGreaterThanOrEqual(1);
      const upsert = syncB.upserts.find((entry) => entry.id === "of:doc:1");
      expect(upsert).toBeDefined();
      expect(
        (upsert!.doc as { value?: { n?: number } } | undefined)?.value?.n,
      ).toBe(42);
    } finally {
      connectionA.close();
      connectionB.close();
    }
  });

  it("shares a scope-pure evaluation across principals", async () => {
    const space = "did:key:z6Mk-eval-cache-principals";
    const server = createServer("memory://eval-cache-principals");
    const messagesA: ServerMessage[] = [];
    const messagesB: ServerMessage[] = [];
    const connectionA = server.connect((message) => messagesA.push(message));
    const connectionB = server.connect((message) => messagesB.push(message));
    try {
      const sessionA = await openSession(
        connectionA,
        messagesA,
        space,
        "a",
        "did:key:z6Mk-eval-cache-principal-a",
      );
      const sessionB = await openSession(
        connectionB,
        messagesB,
        space,
        "b",
        "did:key:z6Mk-eval-cache-principal-b",
      );
      await seedDocs(server, messagesA, space, sessionA, [
        "of:doc:1",
      ]);
      messagesB.length = 0;

      const before = server.evaluationCacheDiagnostics(space);
      const syncA = await watchAdd(
        connectionA,
        messagesA,
        space,
        sessionA,
        "a",
        [{ id: "of:doc:1" }],
      );
      const syncB = await watchAdd(
        connectionB,
        messagesB,
        space,
        sessionB,
        "b",
        [{ id: "of:doc:1" }],
      );
      const after = server.evaluationCacheDiagnostics(space);

      // The post-crash stampede's shape: different principals, identical
      // space-scoped corpus. One evaluation serves both.
      expect(after.misses - before.misses).toBe(1);
      expect(after.hits - before.hits).toBe(1);
      expect(after.hitsPure - before.hitsPure).toBe(1);
      expect(after.entriesPure - before.entriesPure).toBe(1);
      expect(upsertIds(syncB)).toEqual(upsertIds(syncA));
    } finally {
      connectionA.close();
      connectionB.close();
    }
  });

  it("keys a session-scoped evaluation to its identity instead of sharing it", async () => {
    const space = "did:key:z6Mk-eval-cache-scoped";
    const server = createServer("memory://eval-cache-scoped");
    const messagesA: ServerMessage[] = [];
    const messagesB: ServerMessage[] = [];
    const connectionA = server.connect((message) => messagesA.push(message));
    const connectionB = server.connect((message) => messagesB.push(message));
    try {
      const sessionA = await openSession(connectionA, messagesA, space, "a");
      const sessionB = await openSession(connectionB, messagesB, space, "b");
      messagesA.length = 0;
      messagesB.length = 0;

      const before = server.evaluationCacheDiagnostics(space);
      await watchAdd(connectionA, messagesA, space, sessionA, "a", [
        { id: "of:doc:scoped", scope: "session" },
      ]);
      await watchAdd(connectionB, messagesB, space, sessionB, "b", [
        { id: "of:doc:scoped", scope: "session" },
      ]);
      const after = server.evaluationCacheDiagnostics(space);

      // Two identities, each a miss: the tainted entry never crosses.
      expect(after.misses - before.misses).toBe(2);
      expect(after.hits - before.hits).toBe(0);
      expect(after.entriesTainted - before.entriesTainted).toBe(2);
    } finally {
      connectionA.close();
      connectionB.close();
    }
  });

  it("rewrites absent scoped dead-ends to the requester, whose own instance stays deliverable", async () => {
    const space = "did:key:z6Mk-eval-cache-residue";
    const server = createServer("memory://eval-cache-residue");
    const messagesA: ServerMessage[] = [];
    const messagesB: ServerMessage[] = [];
    const connectionA = server.connect((message) => messagesA.push(message));
    const connectionB = server.connect((message) => messagesB.push(message));
    try {
      const sessionA = await openSession(
        connectionA,
        messagesA,
        space,
        "a",
        "did:key:z6Mk-residue-p1",
      );
      const sessionB = await openSession(
        connectionB,
        messagesB,
        space,
        "b",
        "did:key:z6Mk-residue-p2",
      );
      // A shared doc whose value links to a session-scoped draft nobody
      // has written: the walk dead-ends there, recording a scoped miss —
      // the identity-dependent residue.
      const seed = await server.transact({
        type: "transact",
        requestId: crypto.randomUUID(),
        space,
        sessionId: sessionA,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:doc:linked",
            value: {
              value: {
                note: "shared",
                draft: {
                  "/": {
                    "link@1": {
                      path: [],
                      id: "of:doc:draft",
                      space,
                      scope: "user",
                    },
                  },
                },
              },
            },
          }],
        },
      });
      expect(seed.error).toBeUndefined();
      await tick();
      messagesA.length = 0;
      messagesB.length = 0;

      const before = server.evaluationCacheDiagnostics(space);
      const syncA = await watchAdd(
        connectionA,
        messagesA,
        space,
        sessionA,
        "a",
        [{ id: "of:doc:linked" }],
      );
      const syncB = await watchAdd(
        connectionB,
        messagesB,
        space,
        sessionB,
        "b",
        [{ id: "of:doc:linked" }],
      );
      const after = server.evaluationCacheDiagnostics(space);
      expect(after.misses - before.misses).toBe(1);
      expect(after.hits - before.hits).toBe(1);
      expect(after.hitsAbsentResidue - before.hitsAbsentResidue).toBe(1);
      expect(after.entriesAbsentResidue - before.entriesAbsentResidue).toBe(1);
      expect(upsertIds(syncB)).toEqual(upsertIds(syncA));

      // The recording identity re-asking (as a one-shot graph query, which
      // shares the cache) needs no rewrite at all: its residue keys are
      // already its own.
      messagesA.length = 0;
      const beforeSame = server.evaluationCacheDiagnostics(space);
      const same = await server.evaluateGraphQuery(
        space,
        {
          roots: [{
            id: "of:doc:linked",
            selector: { path: [], schema: true },
          }],
        },
        undefined,
        undefined,
        { principal: "did:key:z6Mk-residue-p1", sessionId: sessionA },
      );
      const afterSame = server.evaluationCacheDiagnostics(space);
      expect(afterSame.hits - beforeSame.hits).toBe(1);
      expect(afterSame.hitsAbsentResidue - beforeSame.hitsAbsentResidue)
        .toBe(1);
      expect(same.entities.map((entity) => entity.id)).toContain(
        "of:doc:linked",
      );

      // The rewrite's reactivity pin: another session of the SAME principal
      // writes that principal's draft instance (a writer's own change is
      // not echoed back to it, so the watcher must be a different session),
      // and the delivery machinery must recognize it through the rewritten
      // miss key. The recording principal's watch must NOT receive it.
      const messagesB2: ServerMessage[] = [];
      const connectionB2 = server.connect((message) =>
        messagesB2.push(message)
      );
      const sessionB2 = await openSession(
        connectionB2,
        messagesB2,
        space,
        "b2",
        "did:key:z6Mk-residue-p2",
      );
      messagesA.length = 0;
      messagesB.length = 0;
      const write = await server.transact({
        type: "transact",
        requestId: crypto.randomUUID(),
        space,
        sessionId: sessionB2,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:doc:draft",
            scope: "user",
            value: { value: { d: 1 } },
          }],
        },
      });
      connectionB2.close();
      expect(write.error).toBeUndefined();
      await server.flushSessions();
      await tick();

      const draftDelivered = (messages: ServerMessage[]): boolean =>
        messages.some((message) =>
          message.type === "session/effect" &&
          (message as { effect?: SessionSync }).effect?.upserts.some(
            (upsert) => upsert.id === "of:doc:draft",
          )
        );
      expect(draftDelivered(messagesB)).toBe(true);
      expect(draftDelivered(messagesA)).toBe(false);
    } finally {
      connectionA.close();
      connectionB.close();
    }
  });

  it("evaluates normally for a requester whose scoped instance already exists", async () => {
    const space = "did:key:z6Mk-eval-cache-present";
    const server = createServer("memory://eval-cache-present");
    const messagesA: ServerMessage[] = [];
    const messagesC: ServerMessage[] = [];
    const connectionA = server.connect((message) => messagesA.push(message));
    const connectionC = server.connect((message) => messagesC.push(message));
    try {
      const sessionA = await openSession(
        connectionA,
        messagesA,
        space,
        "a",
        "did:key:z6Mk-present-p1",
      );
      const sessionC = await openSession(
        connectionC,
        messagesC,
        space,
        "c",
        "did:key:z6Mk-present-p3",
      );
      // Seed the shared linked doc AND C's own draft instance BEFORE any
      // watch, so no rotation separates the evaluations.
      const seed = await server.transact({
        type: "transact",
        requestId: crypto.randomUUID(),
        space,
        sessionId: sessionA,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:doc:linked",
            value: {
              value: {
                draft: {
                  "/": {
                    "link@1": {
                      path: [],
                      id: "of:doc:draft",
                      space,
                      scope: "user",
                    },
                  },
                },
              },
            },
          }],
        },
      });
      expect(seed.error).toBeUndefined();
      const own = await server.transact({
        type: "transact",
        requestId: crypto.randomUUID(),
        space,
        sessionId: sessionC,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:doc:draft",
            scope: "user",
            value: { value: { mine: true } },
          }],
        },
      });
      expect(own.error).toBeUndefined();
      await tick();
      messagesA.length = 0;
      messagesC.length = 0;

      const before = server.evaluationCacheDiagnostics(space);
      await watchAdd(connectionA, messagesA, space, sessionA, "a", [
        { id: "of:doc:linked" },
      ]);
      const syncC = await watchAdd(
        connectionC,
        messagesC,
        space,
        sessionC,
        "c",
        [
          { id: "of:doc:linked" },
        ],
      );
      const after = server.evaluationCacheDiagnostics(space);

      // C's instance EXISTS, so the shared entry does not describe C's
      // reach: the absence probe refuses the share, and C's own
      // evaluation delivers its instance.
      expect(after.misses - before.misses).toBe(2);
      expect(after.hits - before.hits).toBe(0);
      expect(after.residueRefusals - before.residueRefusals).toBe(1);
      expect(upsertIds(syncC)).toContain("of:doc:draft");

      // C's refused evaluation was cached under its identity, and the
      // shared entry must not shadow it: the same identity asking the
      // same question again — here as a one-shot graph query, which
      // shares the cache with watch establishment — is served from it.
      const again = await server.evaluateGraphQuery(
        space,
        {
          roots: [{
            id: "of:doc:linked",
            selector: { path: [], schema: true },
          }],
        },
        undefined,
        undefined,
        { principal: "did:key:z6Mk-present-p3", sessionId: sessionC },
      );
      const retried = server.evaluationCacheDiagnostics(space);
      expect(retried.hits - after.hits).toBe(1);
      expect(retried.hitsIdentity - after.hitsIdentity).toBe(1);
      expect(again.entities.map((entity) => entity.id)).toContain(
        "of:doc:draft",
      );
    } finally {
      connectionA.close();
      connectionC.close();
    }
  });

  it("classifies a scoped load without a tracker registration as tainted", () => {
    // The shape meta-linked loads produce: the document was loaded through
    // the manager but registered no tracker entry, so the tracker loop
    // alone would misjudge the state as shareable.
    const state = {
      branch: "",
      tracker: new Map(),
      missed: new Map(),
      missedBy: new Map(),
      missesOf: new Map(),
      crossings: new Map(),
      crossedBy: new Map(),
      crossingsOf: new Map(),
      entities: new Map(),
      memo: new Map(),
      manager: {
        loadedAddresses: () => [{
          id: "of:doc:meta",
          type: "application/json",
          scope: "session",
          scopeKey: "session:p:s",
        }],
      },
    } as unknown as TrackedGraphState;
    expect(classifyStateScope(state)).toEqual({ kind: "tainted" });
  });

  it("reads a never-evaluated space's diagnostics as empty", () => {
    const server = createServer("memory://eval-cache-absent-diagnostics");
    const diagnostics = server.evaluationCacheDiagnostics(
      "did:key:z6Mk-eval-cache-never-evaluated",
    );
    expect(diagnostics).toEqual({
      seq: -1,
      entries: 0,
      weight: 0,
      hits: 0,
      misses: 0,
      rotations: 0,
      hitsPure: 0,
      hitsAbsentResidue: 0,
      hitsIdentity: 0,
      residueRefusals: 0,
      entriesPure: 0,
      entriesAbsentResidue: 0,
      entriesTainted: 0,
    });
  });

  it("rotates when a different engine presents the same sequence", async () => {
    const space = "did:key:z6Mk-eval-cache-engines";
    const commitFor = (value: number) => ({
      sessionId: "session:test",
      invocation: {
        iss: "did:key:test",
        aud: "did:key:service",
        cmd: "/memory/transact",
        sub: space,
      },
      authorization: { proof: "ok" },
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set" as const,
            id: "of:doc:1",
            value: { value: { n: value } },
          },
        ],
      },
    });
    const engineA = await openEngine({
      url: new URL("memory:///eval-cache-engine-a"),
    });
    const engineB = await openEngine({
      url: new URL("memory:///eval-cache-engine-b"),
    });
    applyCommit(engineA, commitFor(1));
    applyCommit(engineB, commitFor(2));

    // Two engines for one space, both at sequence 1, holding different
    // values: a sequence number identifies state only within its engine,
    // so the second engine must rotate the cache rather than be served
    // the first engine's document.
    const cache = createQueryEvaluationCache();
    const query = {
      roots: [{ id: "of:doc:1", selector: { path: [], schema: true } }],
    };
    const fromA = trackGraph(space, engineA, query, undefined, {
      evaluationCache: cache,
    });
    const fromB = trackGraph(space, engineB, query, undefined, {
      evaluationCache: cache,
    });
    const valueOf = (state: TrackedGraphState): number | undefined => {
      const entity = [...state.entities.values()][0] as {
        document?: { value?: { n?: number } } | null;
      };
      return entity?.document?.value?.n;
    };
    expect(valueOf(fromA.state)).toBe(1);
    expect(valueOf(fromB.state)).toBe(2);
    expect(queryEvaluationCacheDiagnostics(cache).hits).toBe(0);
    expect(cache.rotations).toBe(2);
  });

  it("reports residue absence probes as engine reads on a hit", async () => {
    const space = "did:key:z6Mk-eval-cache-probes";
    const engine = await openEngine({
      url: new URL("memory:///eval-cache-probes"),
    });
    applyCommit(engine, {
      sessionId: "session:test",
      invocation: {
        iss: "did:key:test",
        aud: "did:key:service",
        cmd: "/memory/transact",
        sub: space,
      },
      authorization: { proof: "ok" },
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set" as const,
          id: "of:doc:linked",
          value: {
            value: {
              draft: {
                "/": {
                  "link@1": {
                    path: [],
                    id: "of:doc:draft",
                    space,
                    scope: "user",
                  },
                },
              },
            },
          },
        }],
      },
    });
    const cache = createQueryEvaluationCache();
    const query = {
      roots: [{ id: "of:doc:linked", selector: { path: [], schema: true } }],
    };
    const miss = trackGraph(space, engine, query, undefined, {
      principal: "did:key:z6Mk-probe-p1",
      sessionId: "probe-s1",
      evaluationCache: cache,
    });
    expect(miss.stats.managerReads).toBeGreaterThan(0);
    const hit = trackGraph(space, engine, query, undefined, {
      principal: "did:key:z6Mk-probe-p2",
      sessionId: "probe-s2",
      evaluationCache: cache,
    });
    expect(cache.hitsAbsentResidue).toBe(1);
    // One residue doc was probed for absence: a hit is not free of engine
    // reads, and its stats say exactly what it read.
    expect(hit.stats.managerReads).toBe(1);
  });

  it("reports no visited roots when it serves the evaluation", async () => {
    const space = "did:key:z6Mk-eval-cache-roots-visited";
    const engine = await openEngine({
      url: new URL("memory:///eval-cache-roots-visited"),
    });
    applyCommit(engine, {
      sessionId: "session:test",
      invocation: {
        iss: "did:key:test",
        aud: "did:key:service",
        cmd: "/memory/transact",
        sub: space,
      },
      authorization: { proof: "ok" },
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set" as const,
          id: "of:doc:served",
          value: { value: { n: 1 } },
        }],
      },
    });
    const cache = createQueryEvaluationCache();
    const query = {
      roots: [{ id: "of:doc:served", selector: { path: [], schema: true } }],
    };
    const miss = trackGraph(space, engine, query, undefined, {
      evaluationCache: cache,
    });
    const hit = trackGraph(space, engine, query, undefined, {
      evaluationCache: cache,
    });

    expect(queryEvaluationCacheDiagnostics(cache).hits).toBe(1);
    expect(miss.stats.rootsVisited).toBe(1);
    // A served evaluation walked nothing, and its stats have to say so:
    // `rootsVisited: 0` beside a long duration is what tells a slow-query
    // reader the time went somewhere other than traversal.
    expect(hit.stats.rootsVisited).toBe(0);
    expect(hit.stats.rootsElapsedMs).toBe(0);
    expect(hit.stats.slowestRoot).toBeUndefined();
  });

  it("evicts by weight across spaces until the budget fits", async () => {
    const server = createServer("memory://eval-cache-budget", 3);
    const spaces = [
      "did:key:z6Mk-eval-budget-1",
      "did:key:z6Mk-eval-budget-2",
    ];
    const connections: ReturnType<Server["connect"]>[] = [];
    try {
      for (const space of spaces) {
        const messages: ServerMessage[] = [];
        const connection = server.connect((message) => messages.push(message));
        connections.push(connection);
        const sessionId = await openSession(
          connection,
          messages,
          space,
          space.slice(-8),
        );
        await seedDocs(server, messages, space, sessionId, [
          "of:doc:1",
          "of:doc:2",
        ]);
        await watchAdd(
          connection,
          messages,
          space,
          sessionId,
          space.slice(-8),
          [
            { id: "of:doc:1" },
            { id: "of:doc:2" },
          ],
        );
      }
      // Each corpus weighs 2; a budget of 3 holds one of them, so the
      // second space's insert evicted the first space's entry.
      expect(server.evaluationCacheDiagnostics(spaces[0]).weight).toBe(0);
      expect(server.evaluationCacheDiagnostics(spaces[1]).weight).toBe(2);
    } finally {
      for (const connection of connections) {
        connection.close();
      }
    }
  });

  it("does not retain an evaluation heavier than the whole budget", async () => {
    const space = "did:key:z6Mk-eval-budget-oversize";
    const server = createServer("memory://eval-cache-oversize", 1);
    const messages: ServerMessage[] = [];
    const connection = server.connect((message) => messages.push(message));
    try {
      const sessionId = await openSession(connection, messages, space, "o");
      await seedDocs(server, messages, space, sessionId, [
        "of:doc:1",
        "of:doc:2",
      ]);
      await watchAdd(connection, messages, space, sessionId, "o", [
        { id: "of:doc:1" },
        { id: "of:doc:2" },
      ]);
      const diagnostics = server.evaluationCacheDiagnostics(space);
      expect(diagnostics.misses).toBe(1);
      expect(diagnostics.entries).toBe(0);
      expect(diagnostics.weight).toBe(0);
    } finally {
      connection.close();
    }
  });

  it("holds the budget even when a later watch group fails", async () => {
    const space = "did:key:z6Mk-eval-budget-failure";
    const server = createServer("memory://eval-cache-budget-failure", 1);
    const messages: ServerMessage[] = [];
    const connection = server.connect((message) => messages.push(message));
    try {
      const sessionId = await openSession(connection, messages, space, "f");
      await seedDocs(server, messages, space, sessionId, [
        "of:doc:1",
        "of:doc:2",
      ]);
      // One request, two groups: the first evaluates a valid two-document
      // graph (inserting weight 2 against a budget of 1), the second
      // fails evaluation. The failure must not skip the enforcement the
      // first group's insert already owed.
      await connection.receive(encodeMemoryBoundary({
        type: "session.watch.add",
        requestId: "f-watch",
        space,
        sessionId,
        watches: [
          {
            id: "f-valid",
            kind: "graph",
            query: {
              roots: [
                { id: "of:doc:1", selector: { path: [], schema: true } },
                { id: "of:doc:2", selector: { path: [], schema: true } },
              ],
            },
          },
          {
            id: "f-broken",
            kind: "graph",
            query: {
              branch: "broken",
              roots: [{
                id: "of:doc:1",
                selector: {
                  path: [],
                  schema: { "$ref": "cid:fid1:does-not-exist" },
                },
              }],
            },
          },
        ],
      }));
      const response = messages.shift() as ResponseMessage<WatchAddResult>;
      expect(response.error).toBeDefined();
      const diagnostics = server.evaluationCacheDiagnostics(space);
      expect(diagnostics.weight).toBeLessThanOrEqual(1);
    } finally {
      connection.close();
    }
  });

  it("reports only the probes a refused share actually performed", async () => {
    const space = "did:key:z6Mk-eval-cache-refusal-count";
    const engine = await openEngine({
      url: new URL("memory:///eval-cache-refusal-count"),
    });
    const invocation = {
      iss: "did:key:test",
      aud: "did:key:service",
      cmd: "/memory/transact",
      sub: space,
    };
    const link = (id: string) => ({
      "/": { "link@1": { path: [], id, space, scope: "session" } },
    });
    applyCommit(engine, {
      sessionId: "refusal-seed",
      invocation,
      authorization: { proof: "ok" },
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set" as const,
          id: "of:doc:linked",
          value: {
            value: {
              draftOne: link("of:doc:draft1"),
              draftTwo: link("of:doc:draft2"),
            },
          },
        }],
      },
    });
    // C's own first draft exists BEFORE any evaluation, so the shared
    // entry's first probe refuses and the second residue is never read.
    applyCommit(engine, {
      sessionId: "refusal-c",
      principal: "did:key:z6Mk-refusal-c",
      invocation,
      authorization: { proof: "ok" },
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set" as const,
          id: "of:doc:draft1",
          scope: "session" as const,
          value: { value: { mine: true } },
        }],
      },
    });

    const cache = createQueryEvaluationCache();
    const query = {
      roots: [{ id: "of:doc:linked", selector: { path: [], schema: true } }],
    };
    const seedIdentity = {
      principal: "did:key:z6Mk-refusal-a",
      sessionId: "refusal-a",
    };
    const cIdentity = {
      principal: "did:key:z6Mk-refusal-c",
      sessionId: "refusal-c",
    };
    trackGraph(space, engine, query, undefined, {
      ...seedIdentity,
      evaluationCache: cache,
    });
    expect(cache.misses).toBe(1);
    const evaluated = trackGraph(space, engine, query, undefined, {
      ...cIdentity,
      evaluationCache: cache,
    });
    // The refusal's single probe rides the full evaluation's own reads.
    expect(cache.misses).toBe(2);
    expect(evaluated.stats.managerReads).toBeGreaterThan(1);
    const fallback = trackGraph(space, engine, query, undefined, {
      ...cIdentity,
      evaluationCache: cache,
    });
    // Identity-fallback hit: exactly ONE probe was performed before the
    // refusal — not the residue's full length. The shared entry is
    // consulted (and refused) on EVERY ask, so both of C's asks count a
    // refusal.
    expect(cache.hitsIdentity).toBe(1);
    expect(cache.residueRefusals).toBe(2);
    expect(fallback.stats.managerReads).toBe(1);
  });

  it("evicts the least-recently-evaluated space's cache beyond the space bound", async () => {
    const server = new Server({
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen() {
        return "did:key:z6Mk-eval-cache-lru-principal";
      },
      sessionOpenAuth: {
        audience: TEST_AUDIENCE,
      },
    });
    const connections: ReturnType<Server["connect"]>[] = [];
    try {
      const spaces = Array.from(
        { length: 9 },
        (_, index) => `did:key:z6Mk-eval-cache-lru-${index}`,
      );
      for (const space of spaces) {
        const messages: ServerMessage[] = [];
        const connection = server.connect((message) => messages.push(message));
        connections.push(connection);
        const sessionId = await openSession(
          connection,
          messages,
          space,
          space.slice(-6),
        );
        await watchAdd(
          connection,
          messages,
          space,
          sessionId,
          space.slice(-6),
          [
            { id: "of:doc:1" },
          ],
        );
      }
      // Nine spaces evaluated against a bound of eight: the first has been
      // evicted (a peek reads empty), the rest retain their entries.
      expect(server.evaluationCacheDiagnostics(spaces[0]).entries).toBe(0);
      expect(server.evaluationCacheDiagnostics(spaces[1]).entries).toBe(1);
      expect(server.evaluationCacheDiagnostics(spaces[8]).entries).toBe(1);

      // A cache-ineligible query must not create a cache for its space —
      // nor evict a live space's on its way through the LRU.
      await server.evaluateGraphQuery(
        spaces[0],
        { roots: [{ id: "of:doc:1", selector: { path: [], schema: true } }] },
        undefined,
        undefined,
        { keyedSnapshots: true },
      );
      expect(server.evaluationCacheDiagnostics(spaces[0]).seq).toBe(-1);
      expect(server.evaluationCacheDiagnostics(spaces[1]).entries).toBe(1);
    } finally {
      for (const connection of connections) {
        connection.close();
      }
    }
  });
});
