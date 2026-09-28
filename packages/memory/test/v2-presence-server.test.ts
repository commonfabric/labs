import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { defer } from "@commonfabric/utils/defer";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type PresenceFacets,
  type PresenceJoinResult,
  type PresenceRecord,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
} from "../v2.ts";
import { MAX_PRESENCE_ROOM_MEMBERS } from "../v2/presence.ts";
import { Server } from "../v2/server.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

const ROOM = "room-0123456789abcdefghijklmnop";
const OTHER_ROOM = "room-zyxwvutsrqponmlkjihgfedcba";

type TestConnection = ReturnType<Server["connect"]>;

/** One connection to the server together with everything it was sent. */
type Peer = {
  connection: TestConnection;
  messages: ServerMessage[];
  space: string;
  sessionId: string;
  sessionToken: string;

  /** The challenge the connection's next `session.open` must carry. */
  nextSessionOpen: SessionOpenAuthMetadata;
};

const createServer = (name: string): Server =>
  new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://memory-v2-presence-${name}`),
    subscriptionRefreshDelayMs: "manual",
  });

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  if (message === undefined) throw new Error("expected a server message");
  return message;
};

const shiftResponse = <Result>(
  messages: ServerMessage[],
): ResponseMessage<Result> => {
  const message = shiftMessage(messages);
  expect(message.type).toBe("response");
  return message as ResponseMessage<Result>;
};

/** Opens a connection with a session on `space`. */
const openPeer = async (
  server: Server,
  space: string,
  label: string,
): Promise<Peer> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary(HELLO));
  const hello = shiftMessage(messages) as { sessionOpen?: unknown };
  const sessionOpen = hello.sessionOpen as SessionOpenAuthMetadata;
  await connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: `${label}-open`,
    space,
    session: {},
    invocation: {
      aud: sessionOpen.audience,
      challenge: sessionOpen.challenge.value,
    },
  }));
  const opened = shiftResponse<{
    sessionId: string;
    sessionToken: string;
    sessionOpen: SessionOpenAuthMetadata;
  }>(messages);
  if (opened.ok === undefined) {
    throw new Error(`session open failed: ${opened.error?.message}`);
  }
  return {
    connection,
    messages,
    space,
    sessionId: opened.ok.sessionId,
    sessionToken: opened.ok.sessionToken,
    nextSessionOpen: opened.ok.sessionOpen,
  };
};

const join = async (
  peer: Peer,
  room = ROOM,
  requestId = `${peer.sessionId}-join`,
): Promise<ResponseMessage<PresenceJoinResult>> => {
  await peer.connection.receive(encodeMemoryBoundary({
    type: "presence.join",
    requestId,
    space: peer.space,
    sessionId: peer.sessionId,
    room,
  }));
  return shiftResponse<PresenceJoinResult>(peer.messages);
};

const publish = async (
  peer: Peer,
  revision: number,
  name: string,
  facets: PresenceFacets = { caret: { focused: true } },
  extra: Record<string, unknown> = {},
): Promise<ResponseMessage<Record<PropertyKey, never>>> => {
  await peer.connection.receive(encodeMemoryBoundary({
    type: "presence.publish",
    requestId: `${peer.sessionId}-publish-${revision}`,
    space: peer.space,
    sessionId: peer.sessionId,
    room: ROOM,
    revision,
    name,
    facets,
    ...extra,
  }));
  return shiftResponse(peer.messages);
};

const leave = async (peer: Peer): Promise<ResponseMessage<unknown>> => {
  await peer.connection.receive(encodeMemoryBoundary({
    type: "presence.leave",
    requestId: `${peer.sessionId}-leave`,
    space: peer.space,
    sessionId: peer.sessionId,
    room: ROOM,
  }));
  return shiftResponse(peer.messages);
};

describe("v2-presence-server", () => {
  describe("presence.join", () => {
    it("returns every other member's published record and not the joiner's", async () => {
      const server = createServer("join-snapshot");
      const space = "did:key:z6Mk-presence-join";
      try {
        const a = await openPeer(server, space, "a");
        const b = await openPeer(server, space, "b");
        const joinedA = await join(a);
        expect(joinedA.ok).toEqual({
          participantId: joinedA.ok!.participantId,
          participants: [],
        });
        expect(await publish(a, 1, "Ada")).toEqual({
          type: "response",
          requestId: `${a.sessionId}-publish-1`,
          ok: {},
        });
        const joinedB = await join(b);
        expect(joinedB.ok!.participants).toEqual([{
          participantId: joinedA.ok!.participantId,
          principal: TEST_SESSION_OPEN_PRINCIPAL,
          revision: 1,
          name: "Ada",
          facets: { caret: { focused: true } },
        }]);
        expect(joinedB.ok!.participantId).not.toBe(joinedA.ok!.participantId);
        expect(a.messages).toEqual([]);
      } finally {
        await server.close();
      }
    });

    it("returns the same participant id to a connection joining twice", async () => {
      const server = createServer("join-twice");
      const space = "did:key:z6Mk-presence-join-twice";
      try {
        const a = await openPeer(server, space, "a");
        const first = await join(a, ROOM, "first");
        const second = await join(a, ROOM, "second");
        expect(second.ok!.participantId).toBe(first.ok!.participantId);
        expect(server.presenceMemberCount(space, ROOM)).toBe(1);
      } finally {
        await server.close();
      }
    });

    it("refuses a join once the room holds its member bound", async () => {
      const server = createServer("room-full");
      const space = "did:key:z6Mk-presence-room-full";
      try {
        for (let index = 0; index < MAX_PRESENCE_ROOM_MEMBERS; index++) {
          const peer = await openPeer(server, space, `member-${index}`);
          expect((await join(peer)).ok).toBeDefined();
        }
        const late = await openPeer(server, space, "late");
        expect((await join(late)).error?.name).toBe("PresenceError");
        expect(server.presenceMemberCount(space, ROOM)).toBe(
          MAX_PRESENCE_ROOM_MEMBERS,
        );
      } finally {
        await server.close();
      }
    });

    it("refuses a malformed room id, and a session not open on the connection", async () => {
      const server = createServer("join-refused");
      const space = "did:key:z6Mk-presence-join-refused";
      try {
        const a = await openPeer(server, space, "a");
        expect((await join(a, "short")).error?.name).toBe("PresenceError");
        await a.connection.receive(encodeMemoryBoundary({
          type: "presence.join",
          requestId: "foreign",
          space,
          sessionId: "session:not-mine",
          room: ROOM,
        }));
        expect(shiftResponse(a.messages).error?.name).toBe("SessionError");
        expect((await join(a)).ok).toBeDefined();
      } finally {
        await server.close();
      }
    });

    it("refuses a presence request sent before `hello`", async () => {
      const server = createServer("before-hello");
      try {
        const messages: ServerMessage[] = [];
        const connection = server.connect((message) => messages.push(message));
        await connection.receive(encodeMemoryBoundary({
          type: "presence.join",
          requestId: "early",
          space: "did:key:z6Mk-presence-before-hello",
          sessionId: "session:none",
          room: ROOM,
        }));
        expect(shiftResponse(messages)).toEqual({
          type: "response",
          requestId: "early",
          error: {
            name: "ProtocolError",
            message: "memory hello is required first",
          },
        });
      } finally {
        await server.close();
      }
    });
  });

  describe("presence.publish", () => {
    it("reaches every other member on its own session and not the publisher", async () => {
      const server = createServer("publish-broadcast");
      const space = "did:key:z6Mk-presence-publish";
      try {
        const a = await openPeer(server, space, "a");
        const b = await openPeer(server, space, "b");
        const c = await openPeer(server, space, "c");
        const joinedA = await join(a);
        await join(b);
        await join(c);
        expect((await publish(a, 1, "Ada", { caret: { focused: false } })).ok)
          .toEqual({});
        const participant: PresenceRecord = {
          participantId: joinedA.ok!.participantId,
          principal: TEST_SESSION_OPEN_PRINCIPAL,
          revision: 1,
          name: "Ada",
          facets: { caret: { focused: false } },
        };
        expect(b.messages).toEqual([{
          type: "presence/upsert",
          space,
          sessionId: b.sessionId,
          room: ROOM,
          participant,
        }]);
        expect(c.messages).toEqual([{
          type: "presence/upsert",
          space,
          sessionId: c.sessionId,
          room: ROOM,
          participant,
        }]);
        expect(a.messages).toEqual([]);
      } finally {
        await server.close();
      }
    });

    it("stamps the session's principal and ignores one the client claims", async () => {
      const server = createServer("principal");
      const space = "did:key:z6Mk-presence-principal";
      try {
        const a = await openPeer(server, space, "a");
        const b = await openPeer(server, space, "b");
        await join(a);
        await join(b);
        await publish(a, 1, "Ada", { caret: {} }, {
          principal: "did:key:z6Mk-claimed",
          participantId: "claimed",
        });
        const pushed = shiftMessage(b.messages) as {
          participant: PresenceRecord;
        };
        expect(pushed.participant.principal).toBe(TEST_SESSION_OPEN_PRINCIPAL);
        expect(pushed.participant.participantId).not.toBe("claimed");
      } finally {
        await server.close();
      }
    });

    it("fails only the request for a publish before a join, a stale revision, and a bound", async () => {
      const server = createServer("publish-refused");
      const space = "did:key:z6Mk-presence-publish-refused";
      try {
        const a = await openPeer(server, space, "a");
        const b = await openPeer(server, space, "b");
        await join(b);
        expect((await publish(a, 1, "Ada")).error?.name).toBe("PresenceError");
        await join(a);
        expect((await publish(a, 2, "Ada")).ok).toEqual({});
        expect((await publish(a, 2, "Ada again")).error?.name).toBe(
          "PresenceError",
        );
        expect((await publish(a, 3, "")).error?.name).toBe("PresenceError");
        // A facet name the relay does not accept fails at the parser, as a
        // message that does not parse at all does.
        expect((await publish(a, 3, "Ada", { "Caret": {} })).error?.name).toBe(
          "InvalidMessageError",
        );
        expect(
          (await publish(a, 3, "Ada", { caret: { fill: "x".repeat(9000) } }))
            .error?.name,
        ).toBe("PresenceError");
        expect((await publish(a, 3, "Ada, still here")).ok).toEqual({});
        const names = b.messages.map((message) =>
          (message as { participant: PresenceRecord }).participant.name
        );
        expect(names).toEqual(["Ada", "Ada, still here"]);
      } finally {
        await server.close();
      }
    });

    it("is relayed while an ordered frame ahead of it is still waiting", async () => {
      const server = createServer("ordering");
      const space = "did:key:z6Mk-presence-ordering";
      const slowSpace = "did:key:z6Mk-presence-ordering-slow";
      const gate = defer<void>();
      server.accessForTestingOnly.engineOpener = (opening, open) =>
        opening === slowSpace
          ? gate.promise.then(() => open(opening))
          : open(opening);
      try {
        const a = await openPeer(server, space, "a");
        const b = await openPeer(server, space, "b");
        await join(a);
        await join(b);
        // The open is admitted, then waits at the gate for its engine; the
        // publish behind it in the connection's frame order is handled
        // without waiting for it.
        const slowOpen = a.connection.receive(encodeMemoryBoundary({
          type: "session.open",
          requestId: "slow-open",
          space: slowSpace,
          session: {},
          invocation: {
            aud: a.nextSessionOpen.audience,
            challenge: a.nextSessionOpen.challenge.value,
          },
        }));
        await publish(a, 1, "Ada");
        expect(b.messages.map((message) => message.type)).toEqual([
          "presence/upsert",
        ]);
        expect(a.messages).toEqual([]);
        gate.resolve();
        await slowOpen;
        expect(a.messages.map((message) => message.type)).toEqual([
          "response",
        ]);
      } finally {
        gate.resolve();
        await server.close();
      }
    });
  });

  describe("another session on the same connection", () => {
    // One connection may hold two sessions on a space; a membership belongs
    // to the session that joined, and the other cannot touch it.

    const openSecondSession = async (peer: Peer): Promise<string> => {
      await peer.connection.receive(encodeMemoryBoundary({
        type: "session.open",
        requestId: "second-open",
        space: peer.space,
        session: {},
        invocation: {
          aud: peer.nextSessionOpen.audience,
          challenge: peer.nextSessionOpen.challenge.value,
        },
      }));
      const opened = shiftResponse<{ sessionId: string }>(peer.messages);
      return opened.ok!.sessionId;
    };

    const asSession = async (
      peer: Peer,
      sessionId: string,
      message: Record<string, unknown>,
    ) => {
      await peer.connection.receive(encodeMemoryBoundary({
        ...message,
        space: peer.space,
        sessionId,
        room: ROOM,
      }));
      return shiftResponse(peer.messages);
    };

    it("refuses to join, publish to, or leave a room another session joined", async () => {
      const server = createServer("cross-session");
      const space = "did:key:z6Mk-presence-cross-session";
      try {
        const a = await openPeer(server, space, "a");
        const b = await openPeer(server, space, "b");
        await join(a);
        await join(b);
        await publish(a, 1, "Ada");
        b.messages.length = 0;
        const other = await openSecondSession(a);
        expect(
          (await asSession(a, other, {
            type: "presence.join",
            requestId: "other-join",
          })).error?.name,
        ).toBe("PresenceError");
        expect(
          (await asSession(a, other, {
            type: "presence.publish",
            requestId: "other-publish",
            revision: 2,
            name: "Mallory",
            facets: {},
          })).error?.name,
        ).toBe("PresenceError");
        expect(
          (await asSession(a, other, {
            type: "presence.leave",
            requestId: "other-leave",
          })).error?.name,
        ).toBe("PresenceError");
        expect(b.messages).toEqual([]);
        expect(server.presenceMemberCount(space, ROOM)).toBe(2);
        expect((await publish(a, 2, "Ada, still")).ok).toEqual({});
        expect(b.messages).toHaveLength(1);
      } finally {
        await server.close();
      }
    });
  });

  describe("membership end", () => {
    it("tells the others when a published member leaves, and nothing for one that never published", async () => {
      const server = createServer("leave");
      const space = "did:key:z6Mk-presence-leave";
      try {
        const a = await openPeer(server, space, "a");
        const b = await openPeer(server, space, "b");
        const c = await openPeer(server, space, "c");
        const joinedA = await join(a);
        await join(b);
        await join(c);
        await publish(a, 1, "Ada");
        b.messages.length = 0;
        c.messages.length = 0;
        expect((await leave(c)).ok).toEqual({});
        expect(b.messages).toEqual([]);
        expect((await leave(a)).ok).toEqual({});
        expect(b.messages).toEqual([{
          type: "presence/remove",
          space,
          sessionId: b.sessionId,
          room: ROOM,
          participantId: joinedA.ok!.participantId,
        }]);
        expect(server.presenceMemberCount(space, ROOM)).toBe(1);
        expect((await publish(a, 2, "Ada")).error?.name).toBe("PresenceError");
      } finally {
        await server.close();
      }
    });

    it("ends every membership of a connection that closes", async () => {
      const server = createServer("close");
      const space = "did:key:z6Mk-presence-close";
      try {
        const a = await openPeer(server, space, "a");
        const b = await openPeer(server, space, "b");
        const joinedA = await join(a);
        await join(a, OTHER_ROOM, "other");
        await join(b);
        await publish(a, 1, "Ada");
        b.messages.length = 0;
        a.connection.close();
        expect(b.messages).toEqual([{
          type: "presence/remove",
          space,
          sessionId: b.sessionId,
          room: ROOM,
          participantId: joinedA.ok!.participantId,
        }]);
        expect(server.presenceMemberCount(space, ROOM)).toBe(1);
        expect(server.presenceMemberCount(space, OTHER_ROOM)).toBe(0);
      } finally {
        await server.close();
      }
    });

    it("ends the memberships of a session another connection takes over", async () => {
      const server = createServer("takeover");
      const space = "did:key:z6Mk-presence-takeover";
      try {
        const a = await openPeer(server, space, "a");
        const b = await openPeer(server, space, "b");
        const joinedA = await join(a);
        await join(b);
        await publish(a, 1, "Ada");
        b.messages.length = 0;
        const messages: ServerMessage[] = [];
        const successor = server.connect((message) => messages.push(message));
        await successor.receive(encodeMemoryBoundary(HELLO));
        const hello = shiftMessage(messages) as { sessionOpen?: unknown };
        const sessionOpen = hello.sessionOpen as SessionOpenAuthMetadata;
        await successor.receive(encodeMemoryBoundary({
          type: "session.open",
          requestId: "successor-open",
          space,
          session: { sessionId: a.sessionId, sessionToken: a.sessionToken },
          invocation: {
            aud: sessionOpen.audience,
            challenge: sessionOpen.challenge.value,
          },
        }));
        expect(shiftResponse(messages).ok).toBeDefined();
        expect(a.messages).toEqual([{
          type: "session/revoked",
          space,
          sessionId: a.sessionId,
          reason: "taken-over",
        }]);
        expect(b.messages).toEqual([{
          type: "presence/remove",
          space,
          sessionId: b.sessionId,
          room: ROOM,
          participantId: joinedA.ok!.participantId,
        }]);
        expect(server.presenceMemberCount(space, ROOM)).toBe(1);
      } finally {
        await server.close();
      }
    });
  });
});
