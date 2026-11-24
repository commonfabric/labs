// Server-execution v2 Phase 6: push priority on the subscription
// channel (protocol.md §3 — "when flushing a batch to a client socket,
// `derived` commits touching docs that client subscribes to go first;
// everything else follows"; verification-coverage.md OW8).
//
// The mechanism under test: `noteExecutorCommit` classifies a derived
// commit's dirty keys; the fan-out then runs TWO PHASES over every
// connection — derived-subscribed sessions evaluate and send first,
// bulk-only sessions follow — so a big authored blob's evaluation never
// heads-of-line a derived frame anywhere in the serialized chain. Each
// session still gets its ONE frame per cycle — priority reorders the
// chain, never frame content or catch-up-marker semantics.
//
// The ordering pin is registration-order-adversarial: the BULK
// connection opens first, so pre-feature fan-out order (connection
// registration order) would send bulk first — the assertion fails on
// exactly the reverted two-phase split (the mutation probe).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionSync,
} from "../v2.ts";
import { Server } from "../v2/server.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

type TaggedMessage = { tag: string; message: ServerMessage };

/** Take the response for `requestId` out of a sink, leaving any
 * session/effect frames (initial watch syncs) in place. */
const takeResponse = <T>(
  messages: ServerMessage[],
  requestId: string,
): ResponseMessage<T> => {
  const index = messages.findIndex((message) =>
    message.type === "response" &&
    (message as ResponseMessage<T>).requestId === requestId
  );
  expect(index).toBeGreaterThanOrEqual(0);
  return messages.splice(index, 1)[0] as ResponseMessage<T>;
};

/** Open one connection + one watching session, recording sends into the
 * SHARED ordered sink (tagged) so cross-connection send order is
 * observable. */
const openTaggedWatchingSession = async (
  server: Server,
  shared: TaggedMessage[],
  tag: string,
  space: string,
  docId: string,
): Promise<string> => {
  const own: ServerMessage[] = [];
  const connection = server.connect((message) => {
    own.push(message);
    shared.push({ tag, message });
  });
  await connection.receive(encodeMemoryBoundary(HELLO));
  const hello = own.shift() as { sessionOpen?: SessionOpenAuthMetadata };
  const sessionOpen = hello.sessionOpen!;
  await connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: `open-${tag}`,
    space,
    session: {},
    invocation: {
      aud: sessionOpen.audience,
      challenge: sessionOpen.challenge.value,
    },
  }));
  const opened = takeResponse<{ sessionId: string }>(own, `open-${tag}`);
  expect(opened.error).toBeUndefined();
  const sessionId = opened.ok!.sessionId;
  await connection.receive(encodeMemoryBoundary({
    type: "session.watch.set",
    requestId: `watch-${tag}`,
    space,
    sessionId,
    watches: [{
      id: "root",
      kind: "graph",
      query: {
        roots: [{ id: docId, selector: { path: [], schema: false } }],
      },
    }],
  }));
  takeResponse(own, `watch-${tag}`);
  return sessionId;
};

/** The (tag, docIds) of each non-empty session/effect frame in the
 * shared sink, in send order. */
const effectFrames = (
  shared: TaggedMessage[],
): Array<{ tag: string; docIds: string[] }> =>
  shared
    .filter(({ message }) => message.type === "session/effect")
    .map(({ tag, message }) => ({
      tag,
      docIds:
        (((message as SessionEffectMessage).effect as SessionSync).upserts ??
          []).map((upsert) => upsert.id),
    }))
    .filter((frame) => frame.docIds.length > 0);

describe("v2 push priority (Phase 6, protocol.md §3)", () => {
  let time: FakeTime;

  beforeEach(() => {
    time = new FakeTime();
  });

  afterEach(() => {
    time.restore();
  });

  it("flushes the session subscribed to derived novelty before the bulk session, and counts the reorder", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://push-priority-order"),
      subscriptionRefreshDelayMs: "manual",
    });
    try {
      const space = "did:key:z6Mk-push-priority-order";
      const shared: TaggedMessage[] = [];
      // ADVERSARIAL registration order: the bulk connection first — the
      // pre-feature fan-out order (connection registration order) is
      // bulk-first.
      await openTaggedWatchingSession(
        server,
        shared,
        "bulk",
        space,
        "of:doc:bulk",
      );
      await openTaggedWatchingSession(
        server,
        shared,
        "derived",
        space,
        "of:doc:derived",
      );

      // Seed both docs and deliver the initial state, so the measured
      // flush is the incremental one.
      await server.writeDocument(space, "of:doc:bulk", { seeded: true });
      await server.writeDocument(space, "of:doc:derived", { seeded: true });
      await server.flushSessions([space]);
      shared.length = 0;

      const statsBefore = server.pushPriorityStats();

      // One mixed batch: bulk novelty (a direct write — "everything
      // else") and derived novelty (the wave-commit report path used by
      // the serving loop's own commits).
      await server.writeDocument(space, "of:doc:bulk", { round: 2 });
      await server.writeDocument(space, "of:doc:derived", { round: 2 });
      server.noteExecutorCommit({
        space,
        seq: 999,
        class: "derived",
        sessionId: "loopback:test",
        writes: [{ id: "of:doc:derived", scopeKey: "space" }],
      });
      await server.flushSessions([space]);

      const frames = effectFrames(shared);
      expect(frames.length).toBe(2);
      // The derived-subscribed session's frame is SENT first (protocol.md
      // §3's push priority), despite the bulk connection registering
      // first.
      expect(frames[0].tag).toBe("derived");
      expect(frames[0].docIds).toEqual(["of:doc:derived"]);
      expect(frames[1].tag).toBe("bulk");
      expect(frames[1].docIds).toEqual(["of:doc:bulk"]);

      // The reorder is counted (testing.md §4: gates assert counters).
      const statsAfter = server.pushPriorityStats();
      expect(statsAfter.mixedFlushes).toBe(statsBefore.mixedFlushes + 1);
      expect(statsAfter.prioritizedSessions).toBe(
        statsBefore.prioritizedSessions + 1,
      );
      expect(statsAfter.followerSessions).toBe(
        statsBefore.followerSessions + 1,
      );
    } finally {
      await server.close();
    }
  });

  it("stays vacuous — single pass, no counter movement — when a batch carries no derived novelty", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://push-priority-vacuous"),
      subscriptionRefreshDelayMs: "manual",
    });
    try {
      const space = "did:key:z6Mk-push-priority-vacuous";
      const shared: TaggedMessage[] = [];
      await openTaggedWatchingSession(
        server,
        shared,
        "bulk",
        space,
        "of:doc:bulk",
      );
      await openTaggedWatchingSession(
        server,
        shared,
        "other",
        space,
        "of:doc:other",
      );
      await server.writeDocument(space, "of:doc:bulk", { seeded: true });
      await server.writeDocument(space, "of:doc:other", { seeded: true });
      await server.flushSessions([space]);
      shared.length = 0;

      const statsBefore = server.pushPriorityStats();
      await server.writeDocument(space, "of:doc:bulk", { round: 2 });
      await server.writeDocument(space, "of:doc:other", { round: 2 });
      await server.flushSessions([space]);

      // Both sessions still get their frames, in registration order
      // (delivery is priority-agnostic; no derived novelty = today's
      // single pass)…
      const frames = effectFrames(shared);
      expect(frames.length).toBe(2);
      expect(frames[0].tag).toBe("bulk");
      expect(frames[1].tag).toBe("other");
      // …and nothing counted (all-zero OFF by construction — only
      // derived-classed batches reorder).
      expect(server.pushPriorityStats()).toEqual(statsBefore);
    } finally {
      await server.close();
    }
  });

  it("counts nothing for a derived-only batch (the two-phase path runs with an EMPTY follower group — a vacuous split)", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://push-priority-pure"),
      subscriptionRefreshDelayMs: "manual",
    });
    try {
      const space = "did:key:z6Mk-push-priority-pure";
      const shared: TaggedMessage[] = [];
      await openTaggedWatchingSession(
        server,
        shared,
        "derived",
        space,
        "of:doc:derived",
      );
      await server.writeDocument(space, "of:doc:derived", { seeded: true });
      await server.flushSessions([space]);
      shared.length = 0;

      const statsBefore = server.pushPriorityStats();
      await server.writeDocument(space, "of:doc:derived", { round: 2 });
      server.noteExecutorCommit({
        space,
        seq: 1000,
        class: "derived",
        sessionId: "loopback:test",
        writes: [{ id: "of:doc:derived", scopeKey: "space" }],
      });
      await server.flushSessions([space]);

      // Delivered — and the split stayed vacuous (prioritized sessions
      // existed, followers did not), so no counter movement.
      expect(effectFrames(shared).length).toBe(1);
      expect(server.pushPriorityStats()).toEqual(statsBefore);
    } finally {
      await server.close();
    }
  });
});
