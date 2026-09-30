import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { defer } from "@commonfabric/utils/defer";

import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
} from "../v2.ts";
import { Server } from "../v2/server.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

const SLOW_SPACE = "did:key:z6Mk-receive-order-slow";
const FAST_SPACE = "did:key:z6Mk-receive-order-fast";

type TestConnection = ReturnType<Server["connect"]>;

/** One connection with a session in each of the two spaces. */
type Peer = {
  connection: TestConnection;
  messages: ServerMessage[];

  /** Session id per space. */
  sessions: Map<string, string>;
};

const createServer = (name: string): Server =>
  new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://memory-v2-receive-order-${name}`),
    subscriptionRefreshDelayMs: "manual",
  });

const responseIds = (messages: ServerMessage[]): string[] =>
  messages
    .filter((message) => message.type === "response")
    .map((message) => (message as ResponseMessage<unknown>).requestId);

/** Opens one connection holding a session in each of the two spaces. */
const openPeer = async (server: Server): Promise<Peer> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary(HELLO));
  let sessionOpen = (messages.shift() as { sessionOpen: unknown })
    .sessionOpen as SessionOpenAuthMetadata;
  const sessions = new Map<string, string>();
  for (const space of [SLOW_SPACE, FAST_SPACE]) {
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: `open-${space}`,
      space,
      session: {},
      invocation: {
        aud: sessionOpen.audience,
        challenge: sessionOpen.challenge.value,
      },
    }));
    const opened = messages.shift() as ResponseMessage<{
      sessionId: string;
      sessionOpen: SessionOpenAuthMetadata;
    }>;
    if (opened.ok === undefined) {
      throw new Error(`session open failed: ${opened.error?.message}`);
    }
    sessions.set(space, opened.ok.sessionId);
    sessionOpen = opened.ok.sessionOpen;
  }
  return { connection, messages, sessions };
};

/** Hands a `graph.query` for `space` to the connection. */
const query = (
  peer: Peer,
  space: string,
  requestId: string,
): Promise<void> =>
  peer.connection.receive(encodeMemoryBoundary({
    type: "graph.query",
    requestId,
    space,
    sessionId: peer.sessions.get(space)!,
    query: { roots: [] },
  }));

describe("Connection receive order", () => {
  it("handles a frame for one space while a frame for another space waits", async () => {
    const server = createServer("across-spaces");
    const gate = defer<void>();
    try {
      const peer = await openPeer(server);
      server.accessForTestingOnly.engineOpener = (opening, open) =>
        opening === SLOW_SPACE
          ? gate.promise.then(() => open(opening))
          : open(opening);
      const slow = query(peer, SLOW_SPACE, "slow");
      await query(peer, FAST_SPACE, "fast");
      expect(responseIds(peer.messages)).toEqual(["fast"]);
      gate.resolve();
      await slow;
      expect(responseIds(peer.messages)).toEqual(["fast", "slow"]);
    } finally {
      gate.resolve();
      await server.close();
    }
  });

  it("handles the frames for one space in the order they were handed over", async () => {
    const server = createServer("within-space");
    const gate = defer<void>();
    try {
      const peer = await openPeer(server);
      let opens = 0;
      // Only the first open waits, so a second frame handled out of turn
      // would respond ahead of the first.
      server.accessForTestingOnly.engineOpener = (opening, open) =>
        opening === SLOW_SPACE && opens++ === 0
          ? gate.promise.then(() => open(opening))
          : open(opening);
      const first = query(peer, SLOW_SPACE, "first");
      const second = query(peer, SLOW_SPACE, "second");
      await query(peer, FAST_SPACE, "fast");
      expect(responseIds(peer.messages)).toEqual(["fast"]);
      gate.resolve();
      await Promise.all([first, second]);
      expect(responseIds(peer.messages)).toEqual(["fast", "first", "second"]);
    } finally {
      gate.resolve();
      await server.close();
    }
  });

  it("handles a space's frame after the `hello` handed over before it", async () => {
    const server = createServer("after-hello");
    try {
      const messages: ServerMessage[] = [];
      const connection = server.connect((message) => messages.push(message));
      const hello = connection.receive(encodeMemoryBoundary(HELLO));
      // Handed over before the `hello` has been handled. It carries no
      // challenge, so what it is refused for says which came first.
      const open = connection.receive(encodeMemoryBoundary({
        type: "session.open",
        requestId: "open",
        space: FAST_SPACE,
        session: {},
        invocation: {
          aud: testSessionOpenServerOptions.sessionOpenAuth.audience,
        },
      }));
      await Promise.all([hello, open]);
      expect(messages.map((message) => message.type)).toEqual([
        "hello.ok",
        "response",
      ]);
      expect((messages[1] as ResponseMessage<unknown>).error?.message).toBe(
        "memory session.open requires challenge",
      );
    } finally {
      await server.close();
    }
  });
});
