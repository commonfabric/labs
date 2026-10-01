import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { PresenceJoinResult, WatchSetResult } from "../v2.ts";
import { Server } from "../v2/server.ts";
import {
  connectPeer,
  openSession,
  request,
  type WirePeer,
} from "./support/wire-peer.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-session-close";
const OTHER_SPACE = "did:key:z6Mk-session-close-other";
const DOC = "of:session-close-doc";
const ROOM = "room-0123456789abcdefghijklmnop";

const createServer = (name: string): Server =>
  new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://memory-v2-session-close-${name}`),
    subscriptionRefreshDelayMs: "manual",
  });

const close = (peer: WirePeer, space: string, sessionId: string) =>
  request<Record<string, never>>(peer, {
    type: "session.close",
    space,
    sessionId,
  });

const query = (peer: WirePeer, space: string, sessionId: string) =>
  request(peer, {
    type: "graph.query",
    space,
    sessionId,
    query: { roots: [] },
  });

const watchDoc = (peer: WirePeer, sessionId: string) =>
  request<WatchSetResult>(peer, {
    type: "session.watch.set",
    space: SPACE,
    sessionId,
    watches: [{
      id: "watch",
      kind: "graph",
      query: { roots: [{ id: DOC, selector: { path: [], schema: false } }] },
    }],
  });

const writeDoc = (peer: WirePeer, sessionId: string, localSeq: number) =>
  request(peer, {
    type: "transact",
    space: SPACE,
    sessionId,
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: DOC, value: { value: { n: localSeq } } }],
    },
  });

describe("session.close", () => {
  it("advertises `sessionClose`", async () => {
    const server = createServer("flag");
    try {
      const peer = await connectPeer(server);
      expect(peer.flags.sessionClose).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("responds with an empty result, after which the session's requests get a `SessionError`", async () => {
    const server = createServer("refuses");
    try {
      const peer = await connectPeer(server);
      const { sessionId } = await openSession(peer, SPACE);
      expect((await query(peer, SPACE, sessionId)).ok).toBeDefined();
      expect((await close(peer, SPACE, sessionId)).ok).toEqual({});
      expect((await query(peer, SPACE, sessionId)).error?.name).toBe(
        "SessionError",
      );
    } finally {
      await server.close();
    }
  });

  it("leaves the connection's other sessions open", async () => {
    const server = createServer("others");
    try {
      const peer = await connectPeer(server);
      const closing = await openSession(peer, SPACE);
      const sameSpace = await openSession(peer, SPACE);
      const otherSpace = await openSession(peer, OTHER_SPACE);
      await close(peer, SPACE, closing.sessionId);
      expect((await query(peer, SPACE, sameSpace.sessionId)).ok).toBeDefined();
      expect((await query(peer, OTHER_SPACE, otherSpace.sessionId)).ok)
        .toBeDefined();
    } finally {
      await server.close();
    }
  });

  it("responds with a `SessionError` for a session the connection does not hold", async () => {
    const server = createServer("unheld");
    try {
      const holder = await connectPeer(server);
      const other = await connectPeer(server);
      const { sessionId } = await openSession(holder, SPACE);
      expect((await close(other, SPACE, sessionId)).error?.name).toBe(
        "SessionError",
      );
      expect((await query(holder, SPACE, sessionId)).ok).toBeDefined();
    } finally {
      await server.close();
    }
  });

  it("sends the closed session no further sync", async () => {
    const server = createServer("fan-out");
    try {
      const watcher = await connectPeer(server);
      const writer = await connectPeer(server);
      const closing = await openSession(watcher, SPACE);
      const staying = await openSession(watcher, SPACE);
      const writing = await openSession(writer, SPACE);
      await watchDoc(watcher, closing.sessionId);
      await watchDoc(watcher, staying.sessionId);
      await close(watcher, SPACE, closing.sessionId);

      expect((await writeDoc(writer, writing.sessionId, 1)).ok).toBeDefined();
      await server.accessForTestingOnly.flushScheduledSessions();

      // The session that stayed is the control: the write reached this
      // connection, and only for that session.
      expect(
        watcher.messages.map((message) =>
          message.type === "session/effect" ? message.sessionId : message.type
        ),
      ).toEqual([staying.sessionId]);
    } finally {
      await server.close();
    }
  });

  it("leaves the session resumable under its token", async () => {
    const server = createServer("resume");
    try {
      const peer = await connectPeer(server);
      const opened = await openSession(peer, SPACE);
      await close(peer, SPACE, opened.sessionId);
      const resumed = await openSession(peer, SPACE, {
        sessionId: opened.sessionId,
        sessionToken: opened.sessionToken,
      });
      expect(resumed.resumed).toBe(true);
      expect(resumed.sessionId).toBe(opened.sessionId);
    } finally {
      await server.close();
    }
  });

  it("ends the session's presence memberships", async () => {
    const server = createServer("presence");
    try {
      const leaving = await connectPeer(server);
      const staying = await connectPeer(server);
      const left = await openSession(leaving, SPACE);
      const stayed = await openSession(staying, SPACE);
      for (
        const [peer, sessionId] of [
          [leaving, left.sessionId],
          [staying, stayed.sessionId],
        ] as const
      ) {
        const joined = await request<PresenceJoinResult>(peer, {
          type: "presence.join",
          space: SPACE,
          sessionId,
          room: ROOM,
        });
        expect(joined.ok).toBeDefined();
      }
      await request(leaving, {
        type: "presence.publish",
        space: SPACE,
        sessionId: left.sessionId,
        room: ROOM,
        revision: 1,
        name: "Ada",
        facets: {},
      });
      expect(staying.messages.map((message) => message.type)).toEqual([
        "presence/upsert",
      ]);
      staying.messages.length = 0;

      await close(leaving, SPACE, left.sessionId);

      expect(staying.messages.map((message) => message.type)).toEqual([
        "presence/remove",
      ]);
    } finally {
      await server.close();
    }
  });
});
