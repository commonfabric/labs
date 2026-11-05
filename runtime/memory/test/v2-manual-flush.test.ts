import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
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

// `subscriptionRefreshDelayMs: "manual"` is the fan-out gate for
// controlled-staleness tests: the refresh timer is never armed, so dirty
// spaces accumulate and fan out only through an explicit `flushSessions()`.
// The FakeTime advances below are the structural negative — firing every
// armed timer in the system delivers nothing, because there is no timer to
// fire — paired with a timed-mode control that delivers through the same
// advance.

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  expect(message).toBeDefined();
  return message!;
};

const openWatchingSession = async (
  server: Server,
  space: string,
  docId: string,
): Promise<ServerMessage[]> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary(HELLO));
  const hello = shiftMessage(messages) as {
    sessionOpen?: SessionOpenAuthMetadata;
  };
  const sessionOpen = hello.sessionOpen!;
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
  const sessionId =
    (shiftMessage(messages) as ResponseMessage<{ sessionId: string }>)
      .ok!.sessionId;
  await connection.receive(encodeMemoryBoundary({
    type: "session.watch.set",
    requestId: "watch",
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
  shiftMessage(messages);
  return messages;
};

const deliveredDocIds = (messages: ServerMessage[]): string[] =>
  messages
    .filter((message) => message.type === "session/effect")
    .flatMap((message) =>
      ((message as SessionEffectMessage).effect as SessionSync).upserts
        .map((upsert) => upsert.id)
    );

describe("v2 server manual flush mode", () => {
  let time: FakeTime;

  beforeEach(() => {
    time = new FakeTime();
  });

  afterEach(() => {
    time.restore();
  });

  it("holds fan-out until an explicit flush delivers it", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://manual-flush-holds"),
      subscriptionRefreshDelayMs: "manual",
    });
    try {
      const space = "did:key:z6Mk-manual-flush-holds";
      const messages = await openWatchingSession(server, space, "of:doc:m");

      await server.writeDocument(space, "of:doc:m", { held: true });
      // The structural negative: advance far past any plausible coalescing
      // delay, firing every armed timer — twice, matching the drive the
      // timed-mode control delivers under. Manual mode armed none.
      await time.tickAsync(60_000);
      await time.tickAsync(60_000);
      expect(deliveredDocIds(messages)).toEqual([]);

      await server.flushSessions([space]);
      expect(deliveredDocIds(messages)).toEqual(["of:doc:m"]);
    } finally {
      await server.close();
    }
  });

  it("delivers through the same advance when a numeric delay is set", async () => {
    // The control for the negative above: identical drive, timed mode — the
    // advance alone must deliver, proving the observation channel works.
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://manual-flush-control"),
      subscriptionRefreshDelayMs: 1,
    });
    try {
      const space = "did:key:z6Mk-manual-flush-control";
      const messages = await openWatchingSession(server, space, "of:doc:c");

      await server.writeDocument(space, "of:doc:c", { timed: true });
      // Two advances: the first fires the refresh timer; the flush chain may
      // arm a further zero-delay hop before delivering, which the second
      // advance fires.
      await time.tickAsync(60_000);
      await time.tickAsync(60_000);
      expect(deliveredDocIds(messages)).toEqual(["of:doc:c"]);
    } finally {
      await server.close();
    }
  });

  it("drains held fan-out at idle()", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://manual-flush-idle"),
      subscriptionRefreshDelayMs: "manual",
    });
    try {
      const space = "did:key:z6Mk-manual-flush-idle";
      const messages = await openWatchingSession(server, space, "of:doc:i");

      await server.writeDocument(space, "of:doc:i", { held: true });
      await time.tickAsync(60_000);
      expect(deliveredDocIds(messages)).toEqual([]);

      // idle() is an explicit synchronization point like flushSessions():
      // returning with held fan-out would break its quiescence contract.
      await server.idle();
      expect(deliveredDocIds(messages)).toEqual(["of:doc:i"]);
    } finally {
      await server.close();
    }
  });

  it("keeps other dirty spaces held across a partial flush", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://manual-flush-partial"),
      subscriptionRefreshDelayMs: "manual",
    });
    try {
      const spaceA = "did:key:z6Mk-manual-partial-a";
      const spaceB = "did:key:z6Mk-manual-partial-b";
      const messagesA = await openWatchingSession(server, spaceA, "of:doc:a");
      const messagesB = await openWatchingSession(server, spaceB, "of:doc:b");

      await server.writeDocument(spaceA, "of:doc:a", { space: "a" });
      await server.writeDocument(spaceB, "of:doc:b", { space: "b" });

      await server.flushSessions([spaceA]);
      expect(deliveredDocIds(messagesA)).toEqual(["of:doc:a"]);
      expect(deliveredDocIds(messagesB)).toEqual([]);

      // The partial flush must not have re-armed anything for the residue.
      await time.tickAsync(60_000);
      await time.tickAsync(60_000);
      expect(deliveredDocIds(messagesB)).toEqual([]);

      await server.flushSessions([spaceB]);
      expect(deliveredDocIds(messagesB)).toEqual(["of:doc:b"]);
    } finally {
      await server.close();
    }
  });

  it("evaluates no watch set for a flush naming a space nothing dirtied", async () => {
    // A caller that flushes after its own write finds the batch already sent
    // whenever an earlier flush took it first.

    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://manual-flush-clean"),
      subscriptionRefreshDelayMs: "manual",
    });
    try {
      const space = "did:key:z6Mk-manual-flush-clean";
      const messages = await openWatchingSession(server, space, "of:doc:k");
      await server.writeDocument(space, "of:doc:k", { sent: true });
      await server.flushSessions([space]);
      expect(deliveredDocIds(messages)).toEqual(["of:doc:k"]);
      messages.length = 0;

      const evaluations = spy(server, "evaluateWatchSet");
      try {
        await server.flushSessions([space]);
        expect(evaluations.calls).toEqual([]);
      } finally {
        evaluations.restore();
      }
      expect(messages).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
