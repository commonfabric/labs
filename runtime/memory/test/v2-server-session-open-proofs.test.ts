/**
 * The v2 `Server` admitting a `session.open` that presents a UCAN proof
 * chain, exercised over the session protocol: the capability such a session
 * acts under, what the server advertises, and what it refuses.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { type Delegation, issueDelegation } from "@commonfabric/identity";

import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type Operation,
  type ResponseMessage,
  type ServerMessage,
  type SessionDescriptor,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionOpenResult,
  type SessionSync,
} from "../v2.ts";
import { alice, bob, mallory, space } from "./principal.ts";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

const TEST_AUDIENCE = "did:key:z6Mk-proofs-test-audience";

function expectExists<T>(
  value: T,
  message?: string,
): asserts value is NonNullable<T> {
  expect(value, message).toBeDefined();
  expect(value, message).not.toBeNull();
}

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  expectExists(message, "expected a server message");
  return message;
};

// Marker-only catch-up frames ride the next batched frame after a transact
// verdict; this suite is not about them, so it shifts past them.
const nextResponse = <Result>(
  messages: ServerMessage[],
): ResponseMessage<Result> => {
  while (true) {
    const message = shiftMessage(messages);
    if (message.type !== "session/effect") {
      expect(message.type).toBe("response");
      return message as ResponseMessage<Result>;
    }
    const effect = (message as SessionEffectMessage)
      .effect as unknown as SessionSync;
    if (
      effect.upserts.length > 0 || effect.removes.length > 0 ||
      effect.caughtUpLocalSeq === undefined
    ) {
      throw new Error(
        "nextResponse skipped a non-marker-only sync frame; consume it explicitly",
      );
    }
  }
};

/** A server whose session principal is taken, untested-crypto and test-only,
 *  from `invocation.iss`, as the ACL suite's server does. Its clock is
 *  `clock.now`, which a test advances. */
const createServer = (
  store: string,
  acl: {
    mode: "off" | "observe" | "enforce";
    delegations?: boolean;
    delegatingDids?: readonly string[];
  },
  clock: { now: number } = { now: 1_000_000 },
) =>
  new Server({
    store: new URL(store),
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen: (message) => {
      const iss = message.invocation?.iss;
      return typeof iss === "string" ? iss : undefined;
    },
    sessionOpenAuth: { audience: TEST_AUDIENCE, nowSeconds: () => clock.now },
    acl,
  });

type Harness = {
  messages: ServerMessage[];
  connection: ReturnType<Server["connect"]>;
  sessionOpen: SessionOpenAuthMetadata;
  hello: HelloOkMessage;
};

const connect = async (server: Server): Promise<Harness> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary(HELLO));
  const hello = shiftMessage(messages) as HelloOkMessage;
  expect(hello.type).toBe("hello.ok");
  expectExists(hello.sessionOpen);
  return { messages, connection, sessionOpen: hello.sessionOpen, hello };
};

let requestCounter = 0;
const nextRequestId = (label: string): string => `${label}-${++requestCounter}`;

/**
 * Opens `space` as `principal`, presenting `chain` when one is given. A
 * challenge admits one open, so the harness takes the next challenge from a
 * successful response; a refused open leaves the connection with none.
 */
const openSession = async (
  harness: Harness,
  principal: string,
  chain: Delegation[] = [],
  session: SessionDescriptor = {},
): Promise<ResponseMessage<SessionOpenResult>> => {
  const { connection, messages, sessionOpen } = harness;
  await connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: nextRequestId("open"),
    space: space.did(),
    session,
    invocation: {
      iss: principal,
      aud: sessionOpen.audience,
      challenge: sessionOpen.challenge.value,
      ...(chain.length === 0 ? {} : { prf: chain.map((d) => d.cid) }),
    },
    ...(chain.length === 0 ? {} : {
      authorization: {
        proofs: chain.map((d) => new FabricBytes(d.bytes)),
      },
    }),
  }));
  const response = nextResponse<SessionOpenResult>(messages);
  if (response.ok !== undefined) harness.sessionOpen = response.ok.sessionOpen;
  return response;
};

const transactSet = async (
  { connection, messages }: Harness,
  sessionId: string,
  id: string,
  value: unknown,
  localSeq: number,
): Promise<ResponseMessage<{ seq: number }>> => {
  await connection.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: nextRequestId("tx"),
    space: space.did(),
    sessionId,
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id, value: { value } } as unknown as Operation],
    },
  }));
  return nextResponse<{ seq: number }>(messages);
};

/** Makes the space its own owner, as a profile space is, and nobody else
 *  anything: the one write the space identity may make without a grant. */
const initializeSelfOwnedSpace = async (server: Server): Promise<void> => {
  const authority = await connect(server);
  const opened = await openSession(authority, space.did());
  expectExists(opened.ok, "the space identity should open its own space");
  const initialized = await transactSet(
    authority,
    opened.ok.sessionId,
    `of:${space.did()}`,
    { [space.did()]: "OWNER" },
    1,
  );
  expectExists(initialized.ok, "the space identity should initialize the ACL");
};

const spaceToAlice = () =>
  issueDelegation(space, {
    aud: alice.did(),
    sub: space.did(),
    cmd: "/memory",
    pol: [],
  });

const aliceToBob = () =>
  issueDelegation(alice, {
    aud: bob.did(),
    sub: space.did(),
    cmd: "/memory",
    pol: [],
  });

describe("v2-server-session-open-proofs", () => {
  it("advertises `sessionOpenProofs` exactly when its policy admits delegations", async () => {
    const admitting = createServer("memory://proofs-advertise-on", {
      mode: "enforce",
      delegations: true,
    });
    const refusing = createServer("memory://proofs-advertise-off", {
      mode: "enforce",
      delegations: false,
    });
    try {
      expect((await connect(admitting)).hello.flags.sessionOpenProofs).toBe(
        true,
      );
      expect((await connect(refusing)).hello.flags.sessionOpenProofs).toBe(
        false,
      );
    } finally {
      await admitting.close();
      await refusing.close();
    }
  });

  it("admits a principal the access list does not name through a chain from the owner, with the owner's capability", async () => {
    const server = createServer("memory://proofs-chain-of-one", {
      mode: "enforce",
      delegations: true,
    });
    try {
      await initializeSelfOwnedSpace(server);

      const bare = await openSession(await connect(server), alice.did());
      expect(bare.error?.name, "alice holds no grant of her own").toBe(
        "AuthorizationError",
      );

      const harness = await connect(server);
      const opened = await openSession(harness, alice.did(), [
        await spaceToAlice(),
      ]);
      expectExists(
        opened.ok,
        `the chain admits alice: ${opened.error?.message ?? ""}`,
      );
      const written = await transactSet(
        harness,
        opened.ok.sessionId,
        "of:doc:1",
        { hello: "world" },
        1,
      );
      expectExists(written.ok, "the chain carries the owner's WRITE");

      // OWNER through the chain: alice replaces the access list.
      const replaced = await transactSet(
        harness,
        opened.ok.sessionId,
        `of:${space.did()}`,
        { [space.did()]: "OWNER", [bob.did()]: "READ" },
        2,
      );
      expectExists(replaced.ok, "the chain carries the owner's OWNER");
    } finally {
      await server.close();
    }
  });

  it("admits the end of a chain of two with the root's capability", async () => {
    const server = createServer("memory://proofs-chain-of-two", {
      mode: "enforce",
      delegations: true,
    });
    try {
      await initializeSelfOwnedSpace(server);
      const harness = await connect(server);
      const opened = await openSession(harness, bob.did(), [
        await spaceToAlice(),
        await aliceToBob(),
      ]);
      expectExists(opened.ok, "the chain admits bob");
      const written = await transactSet(
        harness,
        opened.ok.sessionId,
        "of:doc:2",
        { hello: "bob" },
        1,
      );
      expectExists(written.ok);
    } finally {
      await server.close();
    }
  });

  it("returns `AuthorizationError` for a chain whose last audience is not the opener", async () => {
    const server = createServer("memory://proofs-wrong-audience", {
      mode: "enforce",
      delegations: true,
    });
    try {
      await initializeSelfOwnedSpace(server);
      const harness = await connect(server);
      const opened = await openSession(harness, mallory.did(), [
        await spaceToAlice(),
      ]);
      expect(opened.error?.name).toBe("AuthorizationError");
      expect(opened.error?.message).toContain("last audience");
    } finally {
      await server.close();
    }
  });

  it("returns `AuthorizationError` for a chain rooted at a principal the access list does not grant", async () => {
    const server = createServer("memory://proofs-ungranted-root", {
      mode: "enforce",
      delegations: true,
    });
    try {
      await initializeSelfOwnedSpace(server);
      const harness = await connect(server);
      const opened = await openSession(harness, bob.did(), [
        await aliceToBob(),
      ]);
      expect(opened.error?.name).toBe("AuthorizationError");
      expect(opened.error?.message).toContain("lacks READ");
    } finally {
      await server.close();
    }
  });

  it("returns `AuthorizationError` for any chain when its policy admits no delegations", async () => {
    const server = createServer("memory://proofs-policy-off", {
      mode: "enforce",
      delegations: false,
    });
    try {
      await initializeSelfOwnedSpace(server);
      const harness = await connect(server);
      const opened = await openSession(harness, alice.did(), [
        await spaceToAlice(),
      ]);
      expect(opened.error?.name).toBe("AuthorizationError");
      expect(opened.error?.message).toContain("admits no delegations");
    } finally {
      await server.close();
    }
  });

  it("returns `AuthorizationError` for a chain presented with an `actingAs` binding", async () => {
    const server = createServer("memory://proofs-with-acting-as", {
      mode: "enforce",
      delegations: true,
      delegatingDids: [alice.did()],
    });
    try {
      await initializeSelfOwnedSpace(server);
      const harness = await connect(server);
      const opened = await openSession(
        harness,
        alice.did(),
        [await spaceToAlice()],
        { actingAs: "space-owner" },
      );
      expect(opened.error?.name).toBe("AuthorizationError");
      expect(opened.error?.message).toContain("cannot both be presented");
    } finally {
      await server.close();
    }
  });

  it("refuses and ends an open session once its chain's expiry has passed", async () => {
    const clock = { now: 1_000_000 };
    const server = createServer(
      "memory://proofs-expiry-after-open",
      { mode: "enforce", delegations: true },
      clock,
    );
    try {
      await initializeSelfOwnedSpace(server);
      const harness = await connect(server);
      const expiring = await issueDelegation(space, {
        aud: alice.did(),
        sub: space.did(),
        cmd: "/memory",
        pol: [],
        exp: clock.now + 100,
      });
      const opened = await openSession(harness, alice.did(), [expiring]);
      expectExists(opened.ok, "the chain holds at open");
      const before = await transactSet(
        harness,
        opened.ok.sessionId,
        "of:doc:3",
        { at: "before" },
        1,
      );
      expectExists(before.ok, "the chain holds before its expiry");

      // One second past the expiry, on the same connection.
      // The session is ended before the refusal, so the client learns
      // rather than retries: `session/revoked` precedes the response.
      clock.now += 101;
      await harness.connection.receive(encodeMemoryBoundary({
        type: "transact",
        requestId: nextRequestId("tx"),
        space: space.did(),
        sessionId: opened.ok.sessionId,
        commit: {
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [
            {
              op: "set",
              id: "of:doc:3",
              value: { at: "after" },
            } as unknown as Operation,
          ],
        },
      }));
      const revoked = shiftMessage(harness.messages);
      expect(revoked.type).toBe("session/revoked");
      const after = nextResponse<{ seq: number }>(harness.messages);
      expect(after.error?.name).toBe("AuthorizationError");
      expect(after.error?.message).toContain("proof chain has expired");
      expect(after.error?.retriable).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("sends an idle presence member nothing once its chain's expiry has passed", async () => {
    // The member makes no request after its expiry, so nothing ends its
    // session or its membership; delivery alone has to withhold the push.

    const clock = { now: 1_000_000 };
    const server = createServer(
      "memory://proofs-expiry-presence",
      { mode: "enforce", delegations: true },
      clock,
    );
    const room = "room-0123456789abcdefghijklmnop";
    const presence = async (
      { connection, messages }: Harness,
      sessionId: string,
      request: Record<string, unknown>,
    ) => {
      await connection.receive(encodeMemoryBoundary({
        requestId: nextRequestId("presence"),
        space: space.did(),
        sessionId,
        room,
        ...request,
      }));
      return nextResponse(messages);
    };
    try {
      await initializeSelfOwnedSpace(server);
      const owner = await connect(server);
      const ownerOpened = await openSession(owner, space.did());
      expectExists(ownerOpened.ok, "the space identity opens its own space");
      const member = await connect(server);
      const expiring = await issueDelegation(space, {
        aud: alice.did(),
        sub: space.did(),
        cmd: "/memory",
        pol: [],
        exp: clock.now + 100,
      });
      const memberOpened = await openSession(member, alice.did(), [expiring]);
      expectExists(memberOpened.ok, "the chain holds at open");
      const memberId = memberOpened.ok.sessionId;
      const ownerId = ownerOpened.ok.sessionId;

      expectExists(
        (await presence(member, memberId, { type: "presence.join" })).ok,
      );
      expectExists(
        (await presence(owner, ownerId, { type: "presence.join" })).ok,
      );
      const publish = (revision: number) =>
        presence(owner, ownerId, {
          type: "presence.publish",
          revision,
          name: "Owner",
          facets: { caret: { focused: true } },
        });

      expectExists((await publish(1)).ok);
      expect(member.messages.map((message) => message.type)).toEqual([
        "presence/upsert",
      ]);
      member.messages.length = 0;

      clock.now += 101;
      expectExists((await publish(2)).ok);
      expect(member.messages).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("takes the deadline of the chain a same-connection reopen presents, in both directions", async () => {
    const clock = { now: 1_000_000 };
    const server = createServer(
      "memory://proofs-reopen-deadline",
      { mode: "enforce", delegations: true },
      clock,
    );
    try {
      await initializeSelfOwnedSpace(server);
      const lasting = await spaceToAlice();
      const expiring = await issueDelegation(space, {
        aud: alice.did(),
        sub: space.did(),
        cmd: "/memory",
        pol: [],
        exp: clock.now + 100,
      });

      // Opened without a deadline, reopened with one: the reopen's deadline
      // holds, and the session ends once it passes.
      const first = await connect(server);
      const opened = await openSession(first, alice.did(), [lasting]);
      expectExists(opened.ok);
      const reopened = await openSession(first, alice.did(), [expiring], {
        sessionId: opened.ok.sessionId,
        sessionToken: opened.ok.sessionToken,
      });
      expectExists(reopened.ok, "the reopen is admitted");
      clock.now += 101;
      await first.connection.receive(encodeMemoryBoundary({
        type: "transact",
        requestId: nextRequestId("tx"),
        space: space.did(),
        sessionId: reopened.ok.sessionId,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            {
              op: "set",
              id: "of:doc:4",
              value: { at: "late" },
            } as unknown as Operation,
          ],
        },
      }));
      expect(shiftMessage(first.messages).type).toBe("session/revoked");
      const refused = nextResponse<{ seq: number }>(first.messages);
      expect(refused.error?.message).toContain("proof chain has expired");

      // Opened with a deadline, reopened without one: the deadline is
      // cleared, and the session outlives it.
      clock.now = 1_000_000;
      const second = await connect(server);
      const dated = await openSession(second, alice.did(), [expiring]);
      expectExists(dated.ok);
      const renewed = await openSession(second, alice.did(), [lasting], {
        sessionId: dated.ok.sessionId,
        sessionToken: dated.ok.sessionToken,
      });
      expectExists(renewed.ok, "the reopen is admitted");
      clock.now += 1_000;
      const written = await transactSet(
        second,
        renewed.ok.sessionId,
        "of:doc:5",
        { at: "late" },
        1,
      );
      expectExists(written.ok, "the lasting chain's reopen holds");
    } finally {
      await server.close();
    }
  });

  it("drops the chain on a resume that presents none, leaving the session to the opener's own grant", async () => {
    const server = createServer("memory://proofs-resume-without", {
      mode: "enforce",
      delegations: true,
    });
    try {
      await initializeSelfOwnedSpace(server);
      const harness = await connect(server);
      const opened = await openSession(harness, alice.did(), [
        await spaceToAlice(),
      ]);
      expectExists(opened.ok);
      const resumed = await openSession(harness, alice.did(), [], {
        sessionId: opened.ok.sessionId,
        sessionToken: opened.ok.sessionToken,
      });
      expect(resumed.error?.name, "alice's own grant admits nothing").toBe(
        "AuthorizationError",
      );
    } finally {
      await server.close();
    }
  });
});
