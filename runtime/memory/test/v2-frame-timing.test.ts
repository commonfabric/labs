import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { getLogger } from "@commonfabric/utils/logger";

import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
  type WatchAddRequest,
} from "../v2.ts";
import { Server } from "../v2/server.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

// A connection handles its frames one at a time, so what a frame costs
// splits in two: how long it waited behind the frames already in flight,
// and how long it took once it started. The server records the halves
// under separate keys, `/api/health/stats` reports them as its
// `timingStats.memory` block, and both
// `docs/development/debugging/profiling.md` and
// `skills/perf-investigation/SKILL.md` name them as the way to tell
// head-of-line blocking from expensive work.
//
// That makes the KEY NAMES load-bearing documentation with no other gate
// behind them: nothing else in the repository fails when a rename leaves
// those two documents pointing at rows that no longer exist. These tests
// are that gate, so they assert the names and the split — never a
// duration, which is a property of the machine.
//
// The response halves (`memory/response/prepareSchemas` and `/sendRaw`)
// and the watch.add total (`memory/watchAdd/total`) are documented in the
// same place and gated here for the same reason.

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

/** Statistics accumulate per logger for the process's life, so a count is
 * only readable as a delta against what earlier tests left behind. */
const frameCounts = (): { queue: number; handle: number } => {
  const timing = getLogger("memory");
  return {
    queue: timing.getTimeStats("memory", "frame", "queue")?.count ?? 0,
    handle: timing.getTimeStats("memory", "frame", "handle")?.count ?? 0,
  };
};

const flushCounts = (): { queue: number; refresh: number } => {
  const timing = getLogger("memory");
  return {
    queue: timing.getTimeStats("memory", "flush", "queue")?.count ?? 0,
    refresh: timing.getTimeStats("memory", "flush", "refresh")?.count ?? 0,
  };
};

const responseCounts = (): { prepareSchemas: number; sendRaw: number } => {
  const timing = getLogger("memory");
  return {
    prepareSchemas:
      timing.getTimeStats("memory", "response", "prepareSchemas")?.count ?? 0,
    sendRaw: timing.getTimeStats("memory", "response", "sendRaw")?.count ?? 0,
  };
};

const watchAddCount = (): number =>
  getLogger("memory").getTimeStats("memory", "watchAdd", "total")?.count ?? 0;

/** Hello, then a session open answered with the challenge hello.ok issued. */
const openSession = async (
  server: Server,
  space: string,
): Promise<{
  connection: ReturnType<Server["connect"]>;
  sessionId: string;
  messages: ServerMessage[];
}> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary(HELLO));
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
  return { connection, sessionId: opened.ok!.sessionId, messages };
};

describe("v2 server frame timing", () => {
  it("records a waiting half and a working half for each frame received", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://frame-timing-records"),
    });
    try {
      const before = frameCounts();
      const connection = server.connect(() => {});
      await connection.receive(encodeMemoryBoundary(HELLO));

      const after = frameCounts();
      expect(after.queue - before.queue).toBe(1);
      expect(after.handle - before.handle).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("records one of each half per frame when frames arrive faster than they are handled", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://frame-timing-queues"),
    });
    try {
      const connection = server.connect(() => {});
      await connection.receive(encodeMemoryBoundary(HELLO));

      const before = frameCounts();
      // Handed over without awaiting the first, which is how a socket
      // delivers: the second frame waits in the ordered chain. Both halves
      // are counted per FRAME, so an instrument that measured the chain's
      // turn instead of the frame would come up short here and pass above.
      const frame = encodeMemoryBoundary({
        type: "session.watch.set",
        requestId: "watch",
        space: "did:key:z6Mk-frame-timing-queues",
        sessionId: "never-opened",
        watches: [],
      });
      await Promise.all([
        connection.receive(frame),
        connection.receive(frame),
        connection.receive(frame),
      ]);

      const after = frameCounts();
      expect(after.queue - before.queue).toBe(3);
      expect(after.handle - before.handle).toBe(3);
    } finally {
      await server.close();
    }
  });
  it("splits every outbound message into schema preparation and the transport hand-off", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://frame-timing-response"),
    });
    try {
      const before = responseCounts();
      const connection = server.connect(() => {});
      await connection.receive(encodeMemoryBoundary(HELLO));

      // One frame in, one message out: `hello.ok` leaves through the same
      // send as every response and effect, so each half counts once.
      const after = responseCounts();
      expect(after.prepareSchemas - before.prepareSchemas).toBe(1);
      expect(after.sendRaw - before.sendRaw).toBe(1);
    } finally {
      await server.close();
    }
  });
  it("times a watch.add handler under its own key", async () => {
    const space = "did:key:z6Mk-frame-timing-watch-add";
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://frame-timing-watch-add"),
    });
    try {
      const { connection, sessionId } = await openSession(server, space);
      const before = watchAddCount();
      await connection.receive(encodeMemoryBoundary({
        type: "session.watch.add",
        requestId: "watch",
        space,
        sessionId,
        watches: [{
          id: "watch-id",
          kind: "graph",
          query: {
            roots: [{ id: "of:timed", selector: { path: [], schema: true } }],
          },
        }],
      }));

      expect(watchAddCount() - before).toBe(1);
    } finally {
      await server.close();
    }
  });
  it("times duplicate and empty watch additions even when they return no changes", async () => {
    const space = "did:key:z6Mk-frame-timing-watch-add-no-op";
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://frame-timing-watch-add-no-op"),
    });
    try {
      const { sessionId } = await openSession(server, space);
      const request: WatchAddRequest = {
        type: "session.watch.add",
        requestId: "watch",
        space,
        sessionId,
        watches: [{
          id: "watch-id",
          kind: "graph",
          query: {
            roots: [{ id: "of:timed", selector: { path: [], schema: true } }],
          },
        }],
      };
      expect((await server.watchAdd(request)).ok).toBeDefined();

      const beforeDuplicate = watchAddCount();
      const duplicate = await server.watchAdd(request);
      expect(duplicate.ok?.sync).toMatchObject({ upserts: [], removes: [] });
      expect(watchAddCount() - beforeDuplicate).toBe(1);

      const beforeEmpty = watchAddCount();
      const empty = await server.watchAdd({ ...request, watches: [] });
      expect(empty.ok?.sync).toMatchObject({ upserts: [], removes: [] });
      expect(watchAddCount() - beforeEmpty).toBe(1);
    } finally {
      await server.close();
    }
  });
  it("times a watch addition rejected for changing an existing watch", async () => {
    const space = "did:key:z6Mk-frame-timing-watch-add-conflict";
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://frame-timing-watch-add-conflict"),
    });
    try {
      const { sessionId } = await openSession(server, space);
      const request: WatchAddRequest = {
        type: "session.watch.add",
        requestId: "watch",
        space,
        sessionId,
        watches: [{
          id: "watch-id",
          kind: "graph",
          query: {
            roots: [{ id: "of:timed", selector: { path: [], schema: true } }],
          },
        }],
      };
      expect((await server.watchAdd(request)).ok).toBeDefined();

      const before = watchAddCount();
      const rejected = await server.watchAdd({
        ...request,
        watches: [{
          id: "watch-id",
          kind: "graph",
          query: {
            roots: [{ id: "of:other", selector: { path: [], schema: true } }],
          },
        }],
      });
      expect(rejected.error?.name).toBe("ProtocolError");
      expect(watchAddCount() - before).toBe(1);
    } finally {
      await server.close();
    }
  });
  it("times a watch addition rejected before evaluation for an unknown session", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://frame-timing-watch-add-unknown-session"),
    });
    try {
      const before = watchAddCount();
      const rejected = await server.watchAdd({
        type: "session.watch.add",
        requestId: "watch",
        space: "did:key:z6Mk-frame-timing-watch-add-unknown-session",
        sessionId: "never-opened",
        watches: [],
      });
      expect(rejected.error?.name).toBe("SessionError");
      expect(watchAddCount() - before).toBe(1);
    } finally {
      await server.close();
    }
  });
  it("times a watch addition whose evaluation throws", async () => {
    const space = "did:key:z6Mk-frame-timing-watch-add-query-error";
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://frame-timing-watch-add-query-error"),
    });
    try {
      const { connection, sessionId, messages } = await openSession(
        server,
        space,
      );
      const before = watchAddCount();
      // A wire client can omit the required selector. Evaluation must answer
      // with a QueryError, and the failed work still belongs in the total.
      await connection.receive(encodeMemoryBoundary({
        type: "session.watch.add",
        requestId: "watch",
        space,
        sessionId,
        watches: [{
          id: "broken",
          kind: "graph",
          query: { roots: [{ id: "of:timed" }] },
        }],
      }));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: "response",
        requestId: "watch",
        error: { name: "QueryError" },
      });
      expect(watchAddCount() - before).toBe(1);
    } finally {
      await server.close();
    }
  });
  it("times a flush as one pass over every dirty space, not once per frame", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://frame-timing-flush"),
      subscriptionRefreshDelayMs: "manual",
    });
    try {
      const before = flushCounts();
      // Two spaces dirtied before a single flush. The pass fans out to
      // both, so a pair of counts that tracked SENDS would read two here.
      // Reading one is the property the walkthrough and the skill both
      // lean on: `memory/flush/refresh` is a batch cost, and dividing it
      // to recover what one frame cost is unsound.
      await server.writeDocument(
        "did:key:z6Mk-frame-timing-flush-a",
        "of:doc:a",
        { flushed: true },
      );
      await server.writeDocument(
        "did:key:z6Mk-frame-timing-flush-b",
        "of:doc:b",
        { flushed: true },
      );
      await server.flushSessions();

      const after = flushCounts();
      expect(after.queue - before.queue).toBe(1);
      expect(after.refresh - before.refresh).toBe(1);
    } finally {
      await server.close();
    }
  });
});
