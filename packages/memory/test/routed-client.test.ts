/** SDK protocol failures use a synthetic transport; authority is tested separately. */
import { assertEquals, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { Identity } from "@commonfabric/identity";
import { setModernCellRepConfig } from "@commonfabric/data-model/cell-rep";
import { getMemoryProtocolFlags, type SessionSync } from "../v2.ts";
import {
  connect,
  type SessionPrincipal,
  type Transport,
  WatchView,
} from "../v2/client.ts";
import {
  readRoutedHex,
  routedBase64,
  routedStatementPayload,
  RoutedWriter,
} from "../v2/routed-wire.ts";

const identity = await Identity.fromRaw(new Uint8Array(32).fill(151));
const challenge = () => ({
  value: "11".repeat(32),
  expiresAt: Math.floor(Date.now() / 1000) + 60,
});
const metadata = () => ({
  audience: identity.did(),
  deployment: "sdk-unit",
  challenge: challenge(),
});
const flags = () => ({
  ...getMemoryProtocolFlags(),
  modernCellRep: true,
  connectionAuth: true,
  routedAuthV1: true,
});
const frame = (body: unknown) => `fvj1:${JSON.stringify(body)}`;
const hello = (sessionOpen: unknown = metadata(), selected = flags()) => ({
  type: "hello.ok",
  protocol: "memory",
  flags: selected,
  sessionOpen,
});

function peer(
  greeting: string,
  respond?: (
    body: Record<string, unknown>,
    push: (body: unknown) => void,
  ) => void,
) {
  let receiver = (_: string) => {};
  let closed = 0;
  let enabled = false;
  const push = (body: unknown) => receiver(frame(body));
  const transport: Transport = {
    setReceiver: (value) => {
      receiver = value;
    },
    setRoutedMessagesEnabled: (value) => {
      enabled = value;
    },
    close: () => {
      closed++;
      return Promise.resolve();
    },
    send: (payload) => {
      const body = JSON.parse(payload.slice(5));
      if (body.type === "hello") receiver(greeting);
      else respond?.(body, push);
      return Promise.resolve();
    },
  };
  return {
    transport,
    push,
    raw: (payload: string) => receiver(payload),
    closed: () => closed,
    enabled: () => enabled,
  };
}

Deno.test("routed hello rejects malformed audiences, deployments and inconsistent capabilities", async (t) => {
  setModernCellRepConfig(true);
  const cases: [string, unknown, ReturnType<typeof flags>][] = [
    [
      "invalid DID",
      { ...metadata(), audience: "did:key:z6Mk-invalid" },
      flags(),
    ],
    ["empty deployment", { ...metadata(), deployment: "" }, flags()],
    ["non-string deployment", { ...metadata(), deployment: 1 }, flags()],
    ["deployment contains whitespace", {
      ...metadata(),
      deployment: "other deployment",
    }, flags()],
    ["malformed challenge", {
      ...metadata(),
      challenge: { value: 1, expiresAt: "soon" },
    }, flags()],
    ["routed capability without deployment", {
      audience: identity.did(),
      challenge: challenge(),
    }, flags()],
    ["deployment without routed capability", metadata(), {
      ...flags(),
      routedAuthV1: false,
    }],
    ["routed without connection authentication", metadata(), {
      ...flags(),
      connectionAuth: false,
    }],
  ];
  for (const [name, sessionOpen, selected] of cases) {
    await t.step(name, async () => {
      const p = peer(frame(hello(sessionOpen, selected)));
      await assertRejects(() => connect({ transport: p.transport }), Error);
      assertEquals(p.closed(), 1);
      assertEquals(p.enabled(), false);
    });
  }
});

Deno.test("invalid hello frames and malformed response frames reject pending SDK work", async (t) => {
  setModernCellRepConfig(true);
  for (
    const greeting of [
      "fvj1:{",
      frame(null),
      frame({ type: "hello.ok", protocol: "memory", flags: null }),
      frame({ type: "response", requestId: "handshake", ok: {} }),
    ]
  ) {
    await t.step(greeting, async () => {
      const p = peer(greeting);
      await assertRejects(() => connect({ transport: p.transport }), Error);
      assertEquals(p.closed(), 1);
    });
  }
  const p = peer(frame(hello()), (_body, _push) => p.raw("fvj1:{"));
  const client = await connect({ transport: p.transport });
  try {
    await assertRejects(
      () => client.request({ type: "graph.query", requestId: "pending" }),
      Error,
      "Unable to parse memory server message",
    );
  } finally {
    await client.close();
  }
});

function principal(): SessionPrincipal {
  return {
    did: identity.did(),
    authorizeSessionOpen: () => {
      throw new Error("Routed session uses connection authority");
    },
    authorizeConnection: async (context) => ({
      statement: routedBase64(
        await routedStatementPayload({
          principal: identity.did(),
          router: context.audience,
          deployment: context.deployment!,
          challenge: readRoutedHex(context.challenge.value, 32),
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
        }).sign(identity),
      ),
    }),
  };
}

Deno.test("unsolicited, malformed and failed pushed renewals reject pending SDK work", async (t) => {
  setModernCellRepConfig(true);
  for (
    const failure of [
      "unknown principal",
      "malformed challenge",
      "signer failure",
    ] as const
  ) {
    await t.step(failure, async () => {
      let signatures = 0;
      const original = principal();
      const signer: SessionPrincipal = {
        ...original,
        authorizeConnection: (context) => {
          if (++signatures > 1 && failure === "signer failure") {
            throw new Error("Signer unavailable");
          }
          return original.authorizeConnection(context);
        },
      };
      const p = peer(frame(hello()), (body, push) => {
        if (body.type === "connection.auth") {
          push({
            type: "response",
            requestId: body.requestId,
            ok: {
              principal: identity.did(),
              expiresAt: Math.floor(Date.now() / 1000) + 600,
            },
          });
        } else if (body.type === "session.open") {
          push({
            type: "response",
            requestId: body.requestId,
            ok: {
              sessionId: "sdk-session",
              sessionToken: "sdk-token",
              serverSeq: 0,
            },
          });
        } else if (body.type === "graph.query") {
          push({
            type: "connection/challenge",
            principal: failure === "unknown principal"
              ? "did:key:unknown"
              : identity.did(),
            challenge: failure === "malformed challenge" ? null : challenge(),
          });
        }
      });
      const client = await connect({ transport: p.transport });
      try {
        await client.openSession(identity.did(), {}, signer);
        await assertRejects(
          () => client.request({ type: "graph.query", requestId: "waiting" }),
          Error,
        );
        assertEquals(signatures, failure === "signer failure" ? 2 : 1);
      } finally {
        await client.close();
      }
    });
  }
});

Deno.test("a permanent automatic renewal denial terminates only its mounted principal", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  let authenticated = false;
  const p = peer(frame(hello()), (body, push) => {
    if (body.type === "connection.challenge") {
      push({
        type: "response",
        requestId: body.requestId,
        ok: { challenge: challenge() },
      });
    } else if (body.type === "connection.auth") {
      push({
        type: "response",
        requestId: body.requestId,
        ...(authenticated
          ? {
            error: { name: "AuthorizationError", message: "Revoked principal" },
          }
          : {
            ok: {
              principal: identity.did(),
              expiresAt: Math.floor(Date.now() / 1000) + 4,
            },
          }),
      });
      authenticated = true;
    } else if (body.type === "session.open") {
      push({
        type: "response",
        requestId: body.requestId,
        ok: {
          sessionId: "sdk-session",
          sessionToken: "sdk-token",
          serverSeq: 0,
        },
      });
    } else push({ type: "response", requestId: body.requestId, ok: {} });
  });
  const client = await connect({ transport: p.transport });
  try {
    const session = await client.mount(identity.did(), {}, principal());
    await time.tickAsync(3000);
    // Signing is asynchronous WebCrypto work even under the fake clock.
    for (let i = 0; i < 50 && session.closeError === undefined; i++) {
      await time.tickAsync(1);
    }
    assertEquals(session.closeError?.message, "Revoked principal");
    assertEquals(client.isConnected(), true);
    await assertRejects(() => session.watchSet([]), Error, "Revoked principal");
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("closing a routed watch consumer settles queued and waiting iterators", async () => {
  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [],
    removes: [],
  };
  const view = WatchView.fromSync(sync);
  const snapshots = view.subscribe(), syncs = view.subscribeSync();
  const snapshotWait = snapshots.next(), syncWait = syncs.next();
  view.emit(sync);
  assertEquals((await snapshotWait).done, false);
  assertEquals((await syncWait).value, sync);
  const pendingSnapshot = snapshots.next(), pendingSync = syncs.next();
  view.close();
  assertEquals((await pendingSnapshot).done, true);
  assertEquals((await pendingSync).done, true);
  assertEquals((await snapshots.next()).done, true);
  assertEquals((await syncs.next()).done, true);
  view.push({ serverSeq: 2, entities: [] });
  view.pushSync(sync);
  view.close();
  assertEquals((await snapshots.return!()).done, true);
  assertEquals((await snapshots.return!()).done, true);
  assertEquals(view.snapshot().serverSeq, 1);
  assertEquals(view.serverSeq, 1);
});

Deno.test("routed session binding covers presence pushes, refused joins and event attention", async () => {
  setModernCellRepConfig(true);
  const events: string[] = [];
  let joins = 0, leaves = 0;
  const refusedPublication = Promise.withResolvers<void>();
  const room = "room-0123456789abcdefghijklmnop";
  const p = peer(
    frame(hello(metadata(), { ...flags(), presenceV1: true })),
    (body, push) => {
      if (body.type === "connection.auth") {
        push({
          type: "response",
          requestId: body.requestId,
          ok: {
            principal: identity.did(),
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          },
        });
      } else if (body.type === "session.open") {
        push({
          type: "response",
          requestId: body.requestId,
          ok: {
            sessionId: "sdk-session",
            sessionToken: "sdk-token",
            serverSeq: 0,
          },
        });
      } else {
        assertEquals(body.space, identity.did());
        assertEquals(body.sessionId, "sdk-session");
        if (body.type === "presence.publish") {
          push({
            type: "response",
            requestId: body.requestId,
            error: { name: "PresenceError", message: "Publication refused" },
          });
        } else if (body.type === "presence.join" && ++joins === 1) {
          push({
            type: "response",
            requestId: body.requestId,
            error: { name: "PresenceError", message: "Room denied" },
          });
        } else {
          if (body.type === "presence.leave") leaves++;
          push({
            type: "response",
            requestId: body.requestId,
            ok: body.type === "presence.join"
              ? { participantId: "participant", participants: [] }
              : { serverSeq: 7 },
          });
        }
      }
    },
  );
  const client = await connect({ transport: p.transport });
  try {
    const session = await client.mount(identity.did(), {}, principal());
    await assertRejects(
      () => session.joinPresenceRoom("invalid", () => {}),
      Error,
      "invalid",
    );
    await assertRejects(
      () => session.joinPresenceRoom(room, () => {}),
      Error,
      "Room denied",
    );
    const first = await session.joinPresenceRoom(room, (event) => {
      events.push(event.kind);
      if (event.kind === "failure") refusedPublication.resolve();
    });
    const second = await session.joinPresenceRoom(room, () => {});
    assertEquals(first.participantId, "participant");
    const participant = {
      participantId: "other",
      revision: 1,
      name: "Other",
      facets: {},
    };
    p.push({
      type: "presence/upsert",
      space: identity.did(),
      sessionId: "old-session",
      room,
      participant,
    });
    p.push({
      type: "presence/upsert",
      space: identity.did(),
      sessionId: session.sessionId,
      room,
      participant,
    });
    p.push({
      type: "presence/upsert",
      space: identity.did(),
      sessionId: session.sessionId,
      room,
      participant,
    });
    p.push({
      type: "presence/remove",
      space: identity.did(),
      sessionId: session.sessionId,
      room,
      participantId: "other",
    });
    p.push({
      type: "presence/remove",
      space: identity.did(),
      sessionId: session.sessionId,
      room,
      participantId: "other",
    });
    assertEquals(events, ["snapshot", "upsert", "remove"]);
    first.publish({ name: "Refused publication", facets: {} });
    await refusedPublication.promise;
    assertEquals(events.at(-1), "failure");
    await first.leave();
    await first.leave();
    assertEquals(leaves, 0);
    first.publish({ name: "Already left", facets: {} });
    await second.leave();
    assertEquals(leaves, 1);
    const attention = await session.resolveEventAttention(
      "event",
      7,
      "sidecar",
      "dismiss",
    );
    assertEquals(attention.serverSeq, 7);
    assertEquals(session.serverSeq, 7);
    await session.whenRestored();
    await session.close();
    await session.close();
    await session.ack(8);
    session.handleEffect({
      type: "sync",
      fromSeq: 7,
      toSeq: 8,
      upserts: [],
      removes: [],
    });
    await session.restore();
    await client.close();
    await assertRejects(
      () =>
        client.request({ type: "graph.query", requestId: "closed" }, {
          whileConnected: true,
        }),
      Error,
    );
    await assertRejects(
      () =>
        client.openSession(identity.did(), {}, principal(), undefined, {
          restoring: true,
        }),
      Error,
    );
  } finally {
    await client.close();
  }
});

Deno.test("a cancelled routed mount closes its unheld toolshed session", async () => {
  setModernCellRepConfig(true);
  const abort = new AbortController();
  const abandoned = Promise.withResolvers<void>();
  const p = peer(frame(hello()), (body, push) => {
    if (body.type === "connection.auth") {
      push({
        type: "response",
        requestId: body.requestId,
        ok: {
          principal: identity.did(),
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        },
      });
    } else if (body.type === "session.open") {
      push({
        type: "response",
        requestId: body.requestId,
        ok: { sessionId: "abandoned", sessionToken: "token", serverSeq: 0 },
      });
      abort.abort(new Error("Route cancelled"));
    } else if (body.type === "session.close") {
      assertEquals(body.space, identity.did());
      assertEquals(body.sessionId, "abandoned");
      push({ type: "response", requestId: body.requestId, ok: {} });
      abandoned.resolve();
    }
  });
  const client = await connect({ transport: p.transport });
  try {
    await assertRejects(
      () => client.mount(identity.did(), {}, principal(), abort.signal),
      Error,
      "Route cancelled",
    );
    await abandoned.promise;
    assertEquals(client.isConnected(), true);
  } finally {
    await client.close();
  }
});

Deno.test("handshake refusals retain the server error and signature custody propagates signer failure", async () => {
  const p = peer(
    frame({
      type: "response",
      requestId: "handshake",
      error: { name: "AuthorizationError", message: "Router disabled" },
    }),
  );
  await assertRejects(
    () => connect({ transport: p.transport }),
    Error,
    "Router disabled",
  );
  assertEquals(p.closed(), 1);
  await assertRejects(
    () =>
      new RoutedWriter("mrc1").sign({
        sign: () => Promise.resolve({ error: new Error("Key unavailable") }),
      } as unknown as Identity),
    Error,
    "Key unavailable",
  );
});
