import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
  toDirtyKey,
  type TransactRequest,
} from "../v2.ts";

const TEST_AUDIENCE = "did:key:z6Mk-memory-v2-miss-interest-audience";

const link = (space: string, id: string) => ({
  "/": { "link@1": { id, path: [], space } },
});

describe("v2-server-miss-interest", () => {
  let server: Server;
  let messages: ServerMessage[];
  let connection: ReturnType<Server["connect"]>;

  beforeEach(() => {
    server = new Server({
      store: new URL("memory://miss-interest"),
      subscriptionRefreshDelayMs: "manual",
      authorizeSessionOpen() {
        return "did:key:z6Mk-memory-v2-miss-interest-principal";
      },
      sessionOpenAuth: {
        audience: TEST_AUDIENCE,
      },
    });
    messages = [];
    connection = server.connect((message) => {
      messages.push(message);
    });
  });

  afterEach(async () => {
    await server.close();
  });

  const openSession = async (space: string): Promise<string> => {
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
      requestId: "open",
      space,
      session: {},
      invocation: {
        aud: sessionOpen.audience,
        challenge: sessionOpen.challenge.value,
      },
    }));
    const opened = messages.shift() as ResponseMessage<{ sessionId: string }>;
    expect(opened.ok).toBeDefined();
    return opened.ok!.sessionId;
  };

  const transactMessage = (
    space: string,
    sessionId: string,
    commit: TransactRequest["commit"],
  ): TransactRequest => ({
    type: "transact",
    requestId: crypto.randomUUID(),
    space,
    sessionId,
    commit,
  });

  it("drops a retired miss from the session's wake set", async () => {
    // A watch whose walk dead-ends on an absent link target records a
    // miss — wake interest, so the target's creation re-fires the query.
    // Rewriting the referrer without the link releases the miss on the
    // re-walk, and the retired interest must leave `session.trackedIds`
    // with it, or every later commit to the orphaned document keeps
    // waking and refreshing the session.

    const space = "did:key:z6Mk-memory-v2-miss-interest";
    const sessionId = await openSession(space);
    const seeded = await server.transact(
      transactMessage(space, sessionId, {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:root",
          value: { value: { child: link(space, "of:absent") } },
        }],
      }),
    );
    expect(seeded.error).toBeUndefined();

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.add",
      requestId: "watch",
      space,
      sessionId,
      watches: [{
        id: "miss-interest-watch",
        kind: "graph",
        query: {
          roots: [{
            id: "of:root",
            selector: {
              path: [],
              schema: {
                type: "object",
                properties: {
                  child: {
                    type: "object",
                    properties: { name: { type: "string" } },
                  },
                },
              },
            },
          }],
        },
      }],
    }));

    const absentDirtyKey = toDirtyKey("of:absent");
    // The walk dead-ended on the target: its key is wake interest.
    expect(
      server.sessionTracksAny(space, sessionId, new Set([absentDirtyKey])),
    ).toBe(true);

    const unhooked = await server.transact(
      transactMessage(space, sessionId, {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:root",
          value: { value: { name: "root, unhooked" } },
        }],
      }),
    );
    expect(unhooked.error).toBeUndefined();
    await server.flushSessions([space]);

    // The re-walk released the miss, and the rebuild carried the
    // retirement into the wake set.
    expect(
      server.sessionTracksAny(space, sessionId, new Set([absentDirtyKey])),
    ).toBe(false);

    // The orphaned document's creation delivers nothing to this session:
    // the explicit flush delivers the marker commit's frame without
    // including the orphaned document.
    const framesBefore = messages.length;
    const orphanBorn = await server.transact(
      transactMessage(space, sessionId, {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:absent",
          value: { value: { name: "born orphaned" } },
        }],
      }),
    );
    expect(orphanBorn.error).toBeUndefined();
    const marker = await server.transact(
      transactMessage(space, sessionId, {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:root",
          value: { value: { name: "root, unhooked", marker: true } },
        }],
      }),
    );
    expect(marker.error).toBeUndefined();
    await server.flushSessions([space]);
    const framesSince = messages.slice(framesBefore);
    expect(framesSince.some((message) =>
      message.type === "session/effect" &&
      message.effect.caughtUpLocalSeq === 4
    )).toBe(true);
    expect(JSON.stringify(framesSince).includes("of:absent")).toBe(false);
  });

  for (const refresh of ["incremental", "full"] as const) {
    const name = refresh === "incremental"
      ? "notifies demand when a rewrite swaps one absent target for another"
      : "notifies demand when a full refresh swaps one absent target for another";
    it(name, async () => {
      // The wake set is rebuilt on refresh, so retargeting a root's link
      // from absent A to absent B replaces one tracked id with another at
      // the same cardinality. The demand pass must hear about the swap — a
      // size-growth check stays silent on it, and server execution would
      // keep the old demand registry and never activate B.

      const space = "did:key:z6Mk-memory-v2-miss-swap";
      const sessionId = await openSession(space);
      const seeded = await server.transact(
        transactMessage(space, sessionId, {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:root",
            value: { value: { child: link(space, "of:absent-a") } },
          }],
        }),
      );
      expect(seeded.error).toBeUndefined();

      await connection.receive(encodeMemoryBoundary({
        type: "session.watch.add",
        requestId: "watch",
        space,
        sessionId,
        watches: [{
          id: "miss-swap-watch",
          kind: "graph",
          query: {
            roots: [{
              id: "of:root",
              selector: {
                path: [],
                schema: {
                  type: "object",
                  properties: {
                    child: {
                      type: "object",
                      properties: { name: { type: "string" } },
                    },
                  },
                },
              },
            }],
          },
        }],
      }));

      const aKey = toDirtyKey("of:absent-a");
      const bKey = toDirtyKey("of:absent-b");
      expect(server.sessionTracksAny(space, sessionId, new Set([aKey])))
        .toBe(true);
      expect(server.sessionTracksAny(space, sessionId, new Set([bKey])))
        .toBe(false);

      // Attached after the watch, so the captures below are the swap's own.
      const reasons: (string | undefined)[] = [];
      server.setServerExecutionObserver({
        demandChanged: (_space, reason) => {
          reasons.push(reason);
        },
      });

      const swapped = await server.transact(
        transactMessage(space, sessionId, {
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:root",
            value: { value: { child: link(space, "of:absent-b") } },
          }],
        }),
      );
      expect(swapped.error).toBeUndefined();
      // Explicit dirty keys select the incremental path; omitting them selects
      // full evaluation. Manual scheduling keeps the swap pending for this call.
      const frame = await server.syncSessionForConnection(
        space,
        sessionId,
        refresh === "incremental"
          ? new Set([toDirtyKey("of:root")])
          : undefined,
      );
      expect(frame?.effect.upserts.map((entry) => entry.id)).toContain(
        "of:root",
      );

      // The membership swapped at unchanged cardinality...
      expect(server.sessionTracksAny(space, sessionId, new Set([aKey])))
        .toBe(false);
      expect(server.sessionTracksAny(space, sessionId, new Set([bKey])))
        .toBe(true);
      // ...and the swap still reached the demand pass.
      expect(reasons).toEqual(["push-growth"]);
      await server.syncSessionForConnection(space, sessionId);
      expect(reasons).toEqual(["push-growth"]);
    });
  }
});
