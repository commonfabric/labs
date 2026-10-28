/** SDK protocol failures use a synthetic transport; authority is tested separately. */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { expect } from "@std/expect";
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
import { ROUTED_HOLDINGS_LIMIT } from "../v2/routed-parser.ts";
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
  greeting: string | ((hello: number) => string | undefined),
  respond?: (
    body: Record<string, unknown>,
    push: (body: unknown) => void,
  ) => void,
) {
  let receiver = (_: string) => {};
  let closeReceiver = (_?: Error) => {};
  let closed = 0;
  let hellos = 0;
  let enabled = false;
  const push = (body: unknown) => receiver(frame(body));
  const transport: Transport = {
    setReceiver: (value) => {
      receiver = value;
    },
    setCloseReceiver: (value) => {
      closeReceiver = value;
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
      if (body.type === "hello") {
        hellos++;
        // A greeting function that returns nothing leaves the hello
        // unanswered, for the test to answer with `raw`.
        const answer = typeof greeting === "string"
          ? greeting
          : greeting(hellos);
        if (answer !== undefined) receiver(answer);
      } else respond?.(body, push);
      return Promise.resolve();
    },
  };
  return {
    transport,
    push,
    raw: (payload: string) => receiver(payload),
    /** Drops the connection; the client's next hello is greeted again. */
    drop: () => closeReceiver(new Error("connection dropped")),
    closed: () => closed,
    /** How many handshakes the client has sent. */
    hellos: () => hellos,
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

Deno.test("an automatic renewal refused for now sends the same statement again a second or more later", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  let auths = 0, challenges = 0;
  const sent: { at: number; statement: unknown }[] = [];
  const p = peer(frame(hello()), (body, push) => {
    if (body.type === "connection.challenge") {
      challenges++;
      push({
        type: "response",
        requestId: body.requestId,
        ok: { challenge: challenge() },
      });
    } else if (body.type === "connection.auth") {
      // The first renewal is refused for now at the router's rate, and so
      // is its first retry; the second is admitted.
      auths++;
      sent.push({ at: Date.now(), statement: body.statement });
      push({
        type: "response",
        requestId: body.requestId,
        ...(auths === 2 || auths === 3
          ? {
            error: {
              name: "AuthorizationError",
              message: "Routed memory request denied",
              retriable: true,
            },
          }
          : {
            ok: {
              principal: identity.did(),
              expiresAt: Math.floor(Date.now() / 1000) + 4,
            },
          }),
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
    } else push({ type: "response", requestId: body.requestId, ok: {} });
  });
  const client = await connect({ transport: p.transport });
  try {
    const session = await client.mount(identity.did(), {}, principal());
    // The renewal at two seconds asks for one challenge; refused before the
    // router spent it, the same statement is sent again, a second or more
    // after each refusal, until it is admitted.
    for (let i = 0; i < 400 && auths < 4; i++) await time.tickAsync(25);
    assertEquals(auths, 4);
    assertEquals(challenges, 1);
    assertEquals(sent[2].statement, sent[1].statement);
    assertEquals(sent[3].statement, sent[1].statement);
    assert(sent[2].at - sent[1].at >= 1000, `${sent[2].at - sent[1].at} ms`);
    assert(sent[3].at - sent[2].at >= 1000, `${sent[3].at - sent[2].at} ms`);
    // Admitted, it is not kept: the next renewal signs a new challenge.
    for (let i = 0; i < 400 && auths < 5; i++) await time.tickAsync(25);
    assertEquals(challenges, 2);
    assert(sent[4].statement !== sent[3].statement);
    assertEquals(session.closeError, undefined);
    assertEquals(client.isConnected(), true);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a ten-minute lease is renewed two minutes ahead of each expiry, over several leases", async () => {
  setModernCellRepConfig(true);
  const start = Date.UTC(2026, 9, 1);
  const time = new FakeTime(start);
  const renewedAt: number[] = [];
  const p = peer(frame(hello()), (body, push) => {
    if (body.type === "connection.challenge") {
      push({
        type: "response",
        requestId: body.requestId,
        ok: { challenge: challenge() },
      });
    } else if (body.type === "connection.auth") {
      renewedAt.push((Date.now() - start) / 1000);
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
    } else push({ type: "response", requestId: body.requestId, ok: {} });
  });
  const client = await connect({ transport: p.transport });
  try {
    const session = await client.mount(identity.did(), {}, principal());
    for (let i = 0; i < 2000 && renewedAt.length < 5; i++) {
      await time.tickAsync(1000);
    }
    // Each grant of 600 s is renewed at 480 s, before it lapses.
    assertEquals(renewedAt.length, 5);
    for (let i = 1; i < renewedAt.length; i++) {
      const gap = renewedAt[i] - renewedAt[i - 1];
      assert(gap >= 479 && gap <= 481, `renewal ${i} came after ${gap} s`);
    }
    assertEquals(session.closeError, undefined);
    assertEquals(client.isConnected(), true);
  } finally {
    await client.close();
    time.restore();
  }
});

/**
 * A peer that admits the mount's `connection.auth` and refuses the rest for
 * now, answering challenges that last `challengeLife` seconds; it records
 * when each challenge and statement came.
 */
function refusingPeer(challengeLife = 60) {
  const log: { type: string; at: number; statement?: unknown }[] = [];
  let auths = 0;
  const p = peer(frame(hello()), (body, push) => {
    if (body.type === "connection.challenge") {
      log.push({ type: "challenge", at: Date.now() });
      push({
        type: "response",
        requestId: body.requestId,
        ok: {
          challenge: {
            value: "11".repeat(32),
            expiresAt: Math.floor(Date.now() / 1000) + challengeLife,
          },
        },
      });
    } else if (body.type === "connection.auth") {
      log.push({ type: "auth", at: Date.now(), statement: body.statement });
      push({
        type: "response",
        requestId: body.requestId,
        ...(++auths === 1
          ? {
            ok: {
              principal: identity.did(),
              expiresAt: Math.floor(Date.now() / 1000) + 4,
            },
          }
          : {
            error: {
              name: "AuthorizationError",
              message: "Routed memory request denied",
              retriable: true,
            },
          }),
      });
    } else push({ type: "response", requestId: body.requestId, ok: {} });
  });
  return { p, log };
}

Deno.test("a renewal refused for now waits a second, and takes a new challenge when its own is nearly gone", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  // Challenges last four seconds, under the five a resend needs left.
  const { p, log } = refusingPeer(4);
  const client = await connect({ transport: p.transport });
  try {
    await client.mount(identity.did(), {}, principal());
    for (
      let i = 0;
      i < 400 && log.filter((e) => e.type === "challenge").length < 2;
      i++
    ) await time.tickAsync(25);
    const [, refusal] = log.filter((e) => e.type === "auth");
    const second = log.filter((e) => e.type === "challenge")[1];
    assert(second.at - refusal.at >= 1000, `${second.at - refusal.at} ms`);
  } finally {
    await client.close();
    time.restore();
  }
});

const elsewhere = (await Identity.fromRaw(new Uint8Array(32).fill(153))).did();
const elsewhereToo = (await Identity.fromRaw(new Uint8Array(32).fill(154)))
  .did();

/** A router that refuses every `connection.auth` for now, its hello's
 * challenge lasting `helloLife` seconds. */
function refusingFromTheStart(helloLife: number) {
  const log: { type: string; at: number; statement?: unknown }[] = [];
  const seconds = () => Math.floor(Date.now() / 1000);
  const p = peer(
    frame(hello({
      ...metadata(),
      challenge: { value: "11".repeat(32), expiresAt: seconds() + helloLife },
    })),
    (body, push) => {
      if (body.type === "connection.challenge") {
        log.push({ type: "challenge", at: Date.now() });
        push({
          type: "response",
          requestId: body.requestId,
          ok: {
            challenge: { value: "22".repeat(32), expiresAt: seconds() + 60 },
          },
        });
      } else if (body.type === "connection.auth") {
        log.push({ type: "auth", at: Date.now(), statement: body.statement });
        push({
          type: "response",
          requestId: body.requestId,
          error: {
            name: "AuthorizationError",
            message: "Routed memory request denied",
            retriable: true,
          },
        });
      } else push({ type: "response", requestId: body.requestId, ok: {} });
    },
  );
  return { p, log };
}

/** Mounts two spaces as one key, the second as the first's statement is
 * refused, and returns once that refusal is in the log. */
async function mountTwice(
  client: Awaited<ReturnType<typeof connect>>,
  log: { type: string }[],
  time: FakeTime,
) {
  void client.mount(identity.did(), {}, principal()).catch(() => {});
  for (let i = 0; i < 20 && log.length < 1; i++) await time.tickAsync(0);
  void client.mount(elsewhere, {}, principal()).catch(() => {});
  await time.tickAsync(0);
}

Deno.test("a second mount right after a refusal for now sends the refused statement a second later", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  const { p, log } = refusingFromTheStart(60);
  const client = await connect({ transport: p.transport });
  try {
    await mountTwice(client, log, time);
    for (
      let i = 0;
      i < 400 && log.filter((e) => e.type === "auth").length < 2;
      i++
    ) await time.tickAsync(25);
    const [refused, again] = log.filter((e) => e.type === "auth");
    assertEquals(again.statement, refused.statement);
    assert(again.at - refused.at >= 1000, `${again.at - refused.at} ms`);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a refused statement whose challenge will not last takes a new challenge at once", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  // Four seconds, under the five a resend needs left.
  const { p, log } = refusingFromTheStart(4);
  const client = await connect({ transport: p.transport });
  try {
    await mountTwice(client, log, time);
    for (
      let i = 0;
      i < 400 && !log.some((e) => e.type === "challenge");
      i++
    ) await time.tickAsync(25);
    const refused = log.find((e) => e.type === "auth")!;
    const challenge = log.find((e) => e.type === "challenge")!;
    assert(challenge.at - refused.at < 1000, `${challenge.at - refused.at} ms`);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a refused statement whose wait ran late takes a new challenge instead", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  // Seven seconds: six left once the second's wait is over, under five
  // once that wait has run two seconds late.
  const { p, log } = refusingFromTheStart(7);
  const client = await connect({ transport: p.transport });
  try {
    await mountTwice(client, log, time);
    // The wait's timer fires within this tick, but what follows it runs
    // only after the whole tick, three seconds on.
    time.tick(3000);
    for (
      let i = 0;
      i < 40 && log.filter((e) => e.type === "auth").length < 2;
      i++
    ) await time.tickAsync(0);
    const [refused, next] = log.filter((e) => e.type === "auth");
    assert(next.statement !== refused.statement);
    assert(log.some((e) => e.type === "challenge"));
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a refused statement is sent again at most three times, then signed anew", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  const { p, log } = refusingPeer();
  const client = await connect({ transport: p.transport });
  try {
    await client.mount(identity.did(), {}, principal());
    for (
      let i = 0;
      i < 4000 && log.filter((e) => e.type === "challenge").length < 2;
      i++
    ) await time.tickAsync(25);
    const challenges = log.filter((e) => e.type === "challenge");
    assertEquals(challenges.length, 2);
    const between = log.filter((e) =>
      e.type === "auth" && e.at >= challenges[0].at && e.at < challenges[1].at
    );
    // The refused statement, then the same statement three more times.
    assertEquals(between.length, 4);
    assert(between.every((e) => e.statement === between[0].statement));
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a direct server's renewal refused for now is retried at the reconnect backoff", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  const auths: number[] = [];
  const p = peer(
    frame(hello({ audience: identity.did(), challenge: challenge() }, {
      ...flags(),
      routedAuthV1: false,
    })),
    (body, push) => {
      if (body.type === "connection.challenge") {
        push({
          type: "response",
          requestId: body.requestId,
          ok: { challenge: challenge() },
        });
      } else if (body.type === "connection.auth") {
        auths.push(Date.now());
        push({
          type: "response",
          requestId: body.requestId,
          ...(auths.length === 1
            ? {
              ok: {
                principal: identity.did(),
                expiresAt: Math.floor(Date.now() / 1000) + 4,
              },
            }
            : {
              error: {
                name: "AuthorizationError",
                message: "Memory request denied",
                retriable: true,
              },
            }),
        });
      } else push({ type: "response", requestId: body.requestId, ok: {} });
    },
  );
  const direct: SessionPrincipal = {
    did: identity.did(),
    authorizeSessionOpen: () => {
      throw new Error("Direct session uses connection authority");
    },
    authorizeConnection: () =>
      Promise.resolve({ statement: "direct" } as never),
  };
  const client = await connect({ transport: p.transport });
  try {
    await client.mount(identity.did(), {}, direct);
    for (let i = 0; i < 400 && auths.length < 3; i++) await time.tickAsync(25);
    // The second a router's refusal waits does not apply.
    assert(auths[2] - auths[1] < 1000, `${auths[2] - auths[1]} ms`);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a released key's refused statement is not sent again", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  const { p, log } = refusingPeer();
  const client = await connect({ transport: p.transport });
  try {
    await client.mount(identity.did(), {}, principal());
    for (
      let i = 0;
      i < 400 && log.filter((e) => e.type === "auth").length < 2;
      i++
    ) await time.tickAsync(25);
    await client.release(identity.did());
    void client.mount(identity.did(), {}, principal()).catch(() => {});
    for (
      let i = 0;
      i < 400 && log.filter((e) => e.type === "auth").length < 3;
      i++
    ) await time.tickAsync(25);
    // Signed anew for a challenge of its own rather than sent again.
    assertEquals(log.filter((e) => e.type === "challenge").length, 2);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a pushed challenge's signature refused for good ends only that key's sessions", async () => {
  setModernCellRepConfig(true);
  let refuse = false;
  let pushed = false;
  const p = peer(frame(hello()), (body, push) => {
    if (body.type === "connection.auth") {
      push({
        type: "response",
        requestId: body.requestId,
        ...(refuse
          ? {
            error: {
              name: "AuthorizationError",
              message: "Routed memory request denied",
            },
          }
          : {
            ok: {
              principal: identity.did(),
              expiresAt: Math.floor(Date.now() / 1000) + 600,
            },
          }),
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
    } else if (body.requestId === "commit-in-flight") {
      refuse = true;
      pushed = true;
      push({
        type: "connection/challenge",
        principal: identity.did(),
        challenge: challenge(),
      });
    }
  });
  const client = await connect({ transport: p.transport });
  try {
    const session = await client.mount(identity.did(), {}, principal());
    let settled = false;
    const inFlight = client.request({
      type: "transact",
      requestId: "commit-in-flight",
    }).finally(() => {
      settled = true;
    });
    inFlight.catch(() => {});
    for (let i = 0; i < 50 && session.closeError === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert(pushed);
    assert(session.closeError !== undefined, "the key's session went on");
    assertEquals(settled, false, "the refusal failed a request in flight");
    assertEquals(client.isConnected(), true);
  } finally {
    await client.close();
  }
});

Deno.test("a pushed challenge's signature refused for now leaves the connection's other requests alone", async () => {
  setModernCellRepConfig(true);
  let refuse = false;
  let pushed = false;
  const p = peer(frame(hello()), (body, push) => {
    if (body.type === "connection.auth") {
      push({
        type: "response",
        requestId: body.requestId,
        ...(refuse
          ? {
            error: {
              name: "AuthorizationError",
              message: "Routed memory request denied",
              retriable: true,
            },
          }
          : {
            ok: {
              principal: identity.did(),
              expiresAt: Math.floor(Date.now() / 1000) + 600,
            },
          }),
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
    } else if (body.requestId === "commit-in-flight") {
      // Forwarded by the router; its answer has not come yet.
      refuse = true;
      pushed = true;
      // A challenge in its last second: the refused signature is not sent
      // again, and the refusal reaches the challenge's handler.
      push({
        type: "connection/challenge",
        principal: identity.did(),
        challenge: {
          value: "11".repeat(32),
          expiresAt: Math.floor(Date.now() / 1000) + 1,
        },
      });
    }
  });
  const client = await connect({ transport: p.transport });
  try {
    await client.mount(identity.did(), {}, principal());
    let settled = false;
    const inFlight = client.request({
      type: "transact",
      requestId: "commit-in-flight",
    }).finally(() => {
      settled = true;
    });
    inFlight.catch(() => {});
    for (let i = 0; i < 50 && !pushed; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(pushed);
    assertEquals(settled, false, "the refusal failed a request in flight");
    assertEquals(client.isConnected(), true);
  } finally {
    await client.close();
  }
});

/**
 * A router that refuses for now the statements `refused` picks, counting
 * them from 1, and admits the rest for ten minutes. It logs when each
 * statement, challenge request and open came. The options pick requests by
 * type and that type's count.
 */
function routedPeer(
  refused: (statement: number) => boolean,
  {
    held = () => false,
    refusedToo = () => false,
    helloLife = 60,
    laterFlags,
    ungreeted = () => false,
    onAuth = () => {},
  }: {
    /** Answers sent only when the test calls `release`. */
    held?: (type: string, count: number) => boolean;
    /** Challenge requests and opens refused for now as well. */
    refusedToo?: (type: string, count: number) => boolean;
    /** How long the hello's challenge lasts, in seconds. */
    helloLife?: number;
    /** The flags every hello after the first is greeted with. */
    laterFlags?: ReturnType<typeof flags>;
    /** Hellos left unanswered until the test calls `greet`. */
    ungreeted?: (hello: number) => boolean;

    /** Reports each authentication after its response is sent or held. */
    onAuth?: (count: number) => void;
  } = {},
) {
  const log: { type: string; at: number; statement?: unknown }[] = [];
  const counts = new Map<string, number>();
  const waiting: (() => void)[] = [];
  const forNow = {
    error: {
      name: "AuthorizationError",
      message: "Routed memory request denied",
      retriable: true,
    },
  };
  const greeting = (selected = flags()) =>
    frame(hello({
      ...metadata(),
      challenge: {
        value: "11".repeat(32),
        expiresAt: Math.floor(Date.now() / 1000) + helloLife,
      },
    }, selected));
  const first = greeting();
  const greet = (n: number) =>
    ungreeted(n)
      ? undefined
      : n === 1 || laterFlags === undefined
      ? first
      : greeting(laterFlags);
  const p = peer(greet, (body, push) => {
    const type = String(body.type);
    const count = (counts.get(type) ?? 0) + 1;
    counts.set(type, count);
    const respond = (result: () => Record<string, unknown>) => {
      const answer = () =>
        push({ type: "response", requestId: body.requestId, ...result() });
      if (held(type, count)) waiting.push(answer);
      else answer();
    };
    if (type === "connection.challenge") {
      log.push({ type: "challenge", at: Date.now() });
      respond(() =>
        refusedToo(type, count) ? forNow : {
          ok: {
            challenge: {
              value: "22".repeat(32),
              expiresAt: Math.floor(Date.now() / 1000) + 60,
            },
          },
        }
      );
    } else if (type === "connection.auth") {
      log.push({ type: "auth", at: Date.now(), statement: body.statement });
      respond(() =>
        refused(count) ? forNow : {
          ok: {
            principal: identity.did(),
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          },
        }
      );
      onAuth(count);
    } else if (type === "session.open") {
      log.push({ type: "open", at: Date.now() });
      respond(() =>
        refusedToo(type, count) ? forNow : {
          ok: {
            sessionId: `sdk-session-${body.space}`,
            sessionToken: "sdk-token",
            serverSeq: 0,
          },
        }
      );
    } else respond(() => ({ ok: {} }));
  });
  return {
    p,
    log,
    /** The statements sent so far, in order. */
    auths: () => log.filter((e) => e.type === "auth"),
    /** Answers a hello that was left unanswered. */
    greet: () => p.raw(first),
    /** Sends the answers held back so far. */
    release: () => {
      for (const answer of waiting.splice(0)) answer();
    },
    /** Pushes a challenge that lasts a minute, as for a toolshed's new link. */
    pushChallenge: () =>
      p.push({
        type: "connection/challenge",
        principal: identity.did(),
        challenge: {
          value: "33".repeat(32),
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        },
      }),
  };
}

/** Records how `promise` settles, for a test that advances the clock until it has. */
function settling(promise: Promise<unknown>) {
  const state: { settled: boolean; failure?: unknown } = { settled: false };
  promise.then(() => {
    state.settled = true;
  }, (error) => {
    state.settled = true;
    state.failure = error;
  });
  return state;
}

/** Advances the fake clock in `stepMs` steps until `done` holds, at most `steps` times. */
async function tickUntil(
  time: FakeTime,
  done: () => boolean,
  stepMs = 25,
  steps = 400,
) {
  for (let i = 0; i < steps && !done(); i++) await time.tickAsync(stepMs);
}

Deno.test("a pushed challenge's signature refused for now is sent again a second later, with no open waiting for it", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  const { p, log, auths, pushChallenge } = routedPeer((n) => n === 2);
  const client = await connect({ transport: p.transport });
  try {
    const session = await client.mount(identity.did(), {}, principal());
    // The mount is over, so no open waits for this signature and no session
    // retries when it is refused.
    pushChallenge();
    await tickUntil(time, () => auths().length >= 2, 0, 40);
    assertEquals(auths().length, 2);
    // The challenge cancelled the key's renewal. The refusal arms another
    // attempt, so the statement is sent once more, a second or more later.
    await tickUntil(time, () => auths().length >= 3);
    const sent = auths();
    assertEquals(sent.length, 3);
    assertEquals(sent[2].statement, sent[1].statement);
    // A second, and the first step of the backoff on top of it: the
    // backoff's jitter is what keeps keys refused together apart.
    assert(sent[2].at - sent[1].at >= 1025, `${sent[2].at - sent[1].at} ms`);
    assertEquals(log.filter((e) => e.type === "challenge").length, 0);
    // Admitted, the key is renewed two minutes before its new lease ends.
    await time.tickAsync(470_000);
    await tickUntil(time, () => auths().length >= 4, 1000, 30);
    assertEquals(auths().length, 4);
    const gap = (auths()[3].at - sent[2].at) / 1000;
    assert(gap >= 479 && gap <= 481, `renewed after ${gap} s`);
    assertEquals(session.closeError, undefined);
    assertEquals(client.isConnected(), true);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("an attempt armed after a refusal for now waits for an authentication already under way", async (t) => {
  setModernCellRepConfig(true);
  for (
    const refusedAttempt of [
      "a pushed challenge's answer",
      "a renewal",
    ] as const
  ) {
    await t.step(refusedAttempt, async () => {
      const time = new FakeTime(Date.UTC(2026, 9, 1));
      // The answer to the third statement is held back, so that
      // authentication is still under way when the armed attempt comes due.
      const { p, auths, pushChallenge, release } = routedPeer((n) => n === 2, {
        held: (type, count) => type === "connection.auth" && count === 3,
      });
      const client = await connect({ transport: p.transport });
      try {
        await client.mount(identity.did(), {}, principal());
        if (refusedAttempt === "a renewal") {
          // The lease's renewal, eight minutes in.
          await time.tickAsync(479_000);
          await tickUntil(time, () => auths().length >= 2);
        } else {
          pushChallenge();
          await tickUntil(time, () => auths().length >= 2, 0, 40);
        }
        assertEquals(auths().length, 2);
        // A mount as the same key, made before the refused statement may be
        // sent again, is the one that sends it, a second after the refusal.
        const mount = settling(client.mount(elsewhere, {}, principal()));
        await tickUntil(time, () => auths().length >= 3);
        // The attempt armed by the refusal comes due a few milliseconds
        // later, while that statement is unanswered, and must not send it
        // too: a router closes the connection on a second statement for a
        // challenge it has accepted.
        await tickUntil(time, () => false, 25, 8);
        assertEquals(auths().length, 3);
        release();
        await tickUntil(time, () => mount.settled);
        assertEquals(mount, { settled: true });
        // Nothing more is sent in the seconds after that.
        await tickUntil(time, () => false, 1000, 2);
        const sent = auths();
        assertEquals(sent.length, 3);
        assertEquals(sent[2].statement, sent[1].statement);
        assert(
          sent[2].at - sent[1].at >= 1000,
          `${sent[2].at - sent[1].at} ms`,
        );
      } finally {
        await client.close();
        time.restore();
      }
    });
  }
});

Deno.test("a key released while a refusal for now is on its way is not authenticated again", async (t) => {
  setModernCellRepConfig(true);
  for (
    const refusedAttempt of [
      "a pushed challenge's answer",
      "a renewal",
    ] as const
  ) {
    await t.step(refusedAttempt, async () => {
      const time = new FakeTime(Date.UTC(2026, 9, 1));
      // The second statement's refusal is held back until the key is
      // released.
      const { p, auths, pushChallenge, release } = routedPeer(
        (n) => n === 2,
        { held: (type, count) => type === "connection.auth" && count === 2 },
      );
      const client = await connect({ transport: p.transport });
      try {
        await client.mount(identity.did(), {}, principal());
        if (refusedAttempt === "a renewal") {
          await time.tickAsync(479_000);
          await tickUntil(time, () => auths().length >= 2);
        } else {
          pushChallenge();
          await tickUntil(time, () => auths().length >= 2, 0, 40);
        }
        assertEquals(auths().length, 2);
        await client.release(identity.did());
        release();
        // No attempt is armed for the released key: three seconds pass and
        // nothing is sent.
        await tickUntil(time, () => false, 1000, 3);
        assertEquals(auths().length, 2);
        assertEquals(client.isConnected(), true);
      } finally {
        await client.close();
        time.restore();
      }
    });
  }
});

Deno.test("a key released while its authentication is unanswered is not renewed when the answer admits it", async (t) => {
  setModernCellRepConfig(true);
  for (
    const attempt of ["a pushed challenge's answer", "a renewal"] as const
  ) {
    await t.step(attempt, async () => {
      const time = new FakeTime(Date.UTC(2026, 9, 1));
      // The second statement is admitted, but only after the key is
      // released.
      const { p, auths, pushChallenge, release } = routedPeer(() => false, {
        held: (type, count) => type === "connection.auth" && count === 2,
      });
      const client = await connect({ transport: p.transport });
      try {
        await client.mount(identity.did(), {}, principal());
        if (attempt === "a renewal") {
          await time.tickAsync(479_000);
          await tickUntil(time, () => auths().length >= 2);
        } else {
          pushChallenge();
          await tickUntil(time, () => auths().length >= 2, 0, 40);
        }
        assertEquals(auths().length, 2);
        await client.release(identity.did());
        release();
        await time.tickAsync(0);
        // No renewal is armed for the released key: the client has no
        // timer left, and nothing is sent through the lease just admitted.
        assertEquals(time.next(), false);
        await tickUntil(time, () => false, 60_000, 11);
        assertEquals(auths().length, 2);
      } finally {
        await client.close();
        time.restore();
      }
    });
  }
});

Deno.test("a held session's retry after its key is refused for now waits a second and the backoff", async () => {
  setModernCellRepConfig(true);
  const random = Math.random;
  // No jitter, so the first step of the backoff is 25 ms.
  Math.random = () => 0;
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  // The statement the reconnect signs is refused for now.
  const { p, auths } = routedPeer((n) => n === 2);
  const client = await connect({ transport: p.transport });
  try {
    const session = await client.mount(
      identity.did(),
      {},
      namedSigner(identity.did()),
    );
    p.drop();
    await tickUntil(time, () => session.held, 0, 40);
    assertEquals(auths().length, 2);
    await tickUntil(time, () => !session.held);
    assertEquals(auths().length, 3);
    // The backoff is on top of the second, as for a renewal and a mount,
    // so sessions held together do not all retry in the same millisecond.
    assertEquals(auths()[2].at - auths()[1].at, 1025);
  } finally {
    await client.close();
    time.restore();
    Math.random = random;
  }
});

Deno.test("a lease's renewal signs a challenge of its own while a refused statement's resend is unanswered", async () => {
  setModernCellRepConfig(true);
  const random = Math.random;
  // No jitter: a held mount sends its refused statement again 1,025 ms on.
  Math.random = () => 0;
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  // Statement 1 is the first mount's, admitted. 2 is the first renewal's,
  // admitted late. 3 answers a pushed challenge and is refused for now. 4 is
  // a second mount's, refused for now. 5 is its resend, and from there on
  // nothing is answered.
  const { p, auths, pushChallenge, release } = routedPeer(
    (n) => n === 3 || n === 4,
    {
      held: (type, count) =>
        type === "connection.auth" &&
        (count === 2 || count === 3 || count >= 5),
    },
  );
  const client = await connect({ transport: p.transport });
  try {
    const key = namedSigner(identity.did());
    await client.mount(identity.did(), {}, key);
    await time.tickAsync(480_000);
    await tickUntil(time, () => auths().length >= 2, 0, 40);
    pushChallenge();
    await tickUntil(time, () => auths().length >= 3, 0, 40);
    assertEquals(auths().length, 3);
    // The renewal's lease is admitted now, so it is renewed 480 s from now.
    const fires = (Math.floor(Date.now() / 1000) + 600) * 1000 - 120_000;
    release();
    await tickUntil(time, () => false, 0, 10);
    // A mount as the same key 1.1 s before that renewal: its statement is
    // refused for now, and it sends the statement again 1,025 ms later.
    await time.tickAsync(fires - 1100 - Date.now());
    const mount = settling(client.mount(elsewhere, {}, key));
    await tickUntil(time, () => auths().length >= 4, 0, 40);
    await time.tickAsync(1030);
    await tickUntil(time, () => auths().length >= 5, 0, 40);
    assertEquals(auths().length, 5);
    assertEquals(auths()[4].statement, auths()[3].statement);
    // The renewal comes due while that resend is unanswered. It must not
    // send the kept statement a second time: a router closes the
    // connection on a second statement for a challenge it has accepted.
    await time.tickAsync(fires - Date.now() + 5);
    await tickUntil(time, () => auths().length >= 6, 0, 40);
    assertEquals(auths().length, 6);
    assert(auths()[5].statement !== auths()[4].statement);
    assertEquals(mount, { settled: false });
  } finally {
    await client.close();
    time.restore();
    Math.random = random;
  }
});

Deno.test("a renewal refused for now after a pushed challenge was admitted leaves the admitted lease's renewal armed", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  const renewed = Promise.withResolvers<void>();
  // The renewal's request for a challenge is answered late, after the
  // router has pushed a challenge and admitted its answer; the statement
  // the renewal then signs is the third, and is refused for now.
  const { p, log, auths, pushChallenge, release } = routedPeer(
    (n) => n === 3,
    {
      held: (type, count) => type === "connection.challenge" && count === 1,
      onAuth: (count) => {
        if (count === 4) renewed.resolve();
      },
    },
  );
  const client = await connect({ transport: p.transport });
  try {
    // The synthetic signer settles in microtasks, so advancing the clock
    // measures the renewal timer independently of native signing work.
    const session = await client.mount(
      identity.did(),
      {},
      namedSigner(identity.did()),
    );
    await time.tickAsync(480_000);
    expect(log.filter((e) => e.type === "challenge").length).toBe(1);
    pushChallenge();
    await time.tickAsync(0);
    expect(auths().length).toBe(2);
    release();
    await time.tickAsync(0);
    expect(auths().length).toBe(3);
    // The key holds the lease its second statement was admitted for, and
    // that lease's renewal is armed, so the refusal arms no retry: nothing
    // is sent in the next ten seconds.
    await time.tickAsync(10_000);
    expect(auths().length).toBe(3);
    // The admitted lease is renewed two minutes before it ends.
    await time.tickAsync(469_999);
    expect(auths().length).toBe(3);
    await time.tickAsync(1);
    await renewed.promise;
    expect(auths().length).toBe(4);
    expect(auths()[3].at - auths()[1].at).toBe(480_000);
    expect(session.closeError).toBeUndefined();
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a mount whose statement is refused for now sends it again a second later and resolves", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  // Refused once, as at the source's authentication rate, then admitted.
  const { p, log, auths } = routedPeer((n) => n === 1);
  const client = await connect({ transport: p.transport });
  try {
    // The caller mounts once and does not retry.
    const mounting = client.mount(identity.did(), {}, principal());
    let failure: unknown;
    mounting.catch((error) => {
      failure = error;
    });
    await tickUntil(
      time,
      () => failure !== undefined || log.some((e) => e.type === "open"),
    );
    assertEquals(failure, undefined);
    const session = await mounting;
    const [refused, again] = auths();
    assertEquals(auths().length, 2);
    assertEquals(again.statement, refused.statement);
    // It waited one second, not two.
    const waited = again.at - refused.at;
    assert(waited >= 1000 && waited < 1100, `${waited} ms`);
    assertEquals(log.filter((e) => e.type === "challenge").length, 0);
    assertEquals(session.closeError, undefined);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("two mounts as one key both resolve after a refusal for now of the statement they share", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  const { p, log, auths } = routedPeer((n) => n === 1);
  const client = await connect({ transport: p.transport });
  try {
    // The second mount waits for the first's `connection.auth` and is
    // refused with it.
    const mounting = Promise.allSettled([
      client.mount(identity.did(), {}, principal()),
      client.mount(elsewhere, {}, principal()),
    ]);
    await tickUntil(
      time,
      () => log.filter((e) => e.type === "open").length >= 2,
    );
    assertEquals(
      (await mounting).map((result) => result.status),
      ["fulfilled", "fulfilled"],
    );
    // The statement was sent twice in all: neither mount signed another.
    assertEquals(auths().length, 2);
    assertEquals(auths()[1].statement, auths()[0].statement);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("mounts waiting to send one refused statement all resolve when the connection drops first", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  const { p, log, auths } = routedPeer((n) => n === 1);
  const client = await connect({ transport: p.transport });
  try {
    // The first mount is refused and held. The second, made right after,
    // is the one that will send the refused statement again, a second
    // after the refusal; the third waits for the second's authentication.
    const mounts = [settling(client.mount(identity.did(), {}, principal()))];
    await tickUntil(time, () => auths().length >= 1, 0, 40);
    assertEquals(auths().length, 1);
    mounts.push(
      settling(client.mount(elsewhere, {}, principal())),
      settling(client.mount(elsewhereToo, {}, principal())),
    );
    // Half way through that second the connection drops and the client
    // connects again. The refused statement answered a challenge of the
    // connection that is gone, so it is not sent: each mount waits for the
    // new connection, and one statement is signed for it.
    await time.tickAsync(500);
    p.drop();
    await tickUntil(time, () => mounts.every((mount) => mount.settled));
    assertEquals(mounts, [
      { settled: true },
      { settled: true },
      { settled: true },
    ]);
    assertEquals(log.filter((e) => e.type === "open").length, 3);
    assertEquals(auths().length, 2);
    assert(auths()[1].statement !== auths()[0].statement);
    assertEquals(client.isConnected(), true);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a refused statement whose wait outlasts its connection asks the next connection for no challenge", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  // Seven seconds: the refused statement may be sent again a second later,
  // and may not once that wait has run two seconds late.
  const { p, log, auths } = routedPeer((n) => n === 1, { helloLife: 7 });
  const client = await connect({ transport: p.transport });
  try {
    // The first mount is refused and held. The second, made right after,
    // waits to send the refused statement again.
    const mounts = [settling(client.mount(identity.did(), {}, principal()))];
    await tickUntil(time, () => auths().length >= 1, 0, 40);
    mounts.push(settling(client.mount(elsewhere, {}, principal())));
    // The connection drops and comes back during that wait, and the wait
    // then runs late. Its statement belongs to the connection that is
    // gone, and so would a challenge asked for in its place.
    await time.tickAsync(500);
    p.drop();
    time.tick(3000);
    await tickUntil(time, () => mounts.every((mount) => mount.settled));
    assertEquals(mounts, [{ settled: true }, { settled: true }]);
    assertEquals(log.filter((e) => e.type === "challenge").length, 0);
    assertEquals(auths().length, 2);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a mount whose refused statement may not be sent again signs a new challenge and goes on", async (t) => {
  setModernCellRepConfig(true);
  await t.step("after three resends", async () => {
    const time = new FakeTime(Date.UTC(2026, 9, 1));
    // The statement and its three resends are refused, and so is the first
    // statement over the new challenge; that one's resend is admitted.
    const { p, log, auths } = routedPeer((n) => n <= 5);
    const client = await connect({ transport: p.transport });
    try {
      const mount = settling(client.mount(identity.did(), {}, principal()));
      await tickUntil(time, () => mount.settled);
      assertEquals(mount, { settled: true });
      const sent = auths();
      assertEquals(sent.length, 6);
      assert(sent.slice(0, 4).every((e) => e.statement === sent[0].statement));
      assert(sent[4].statement !== sent[0].statement);
      assertEquals(sent[5].statement, sent[4].statement);
      // Each statement is sent a second or more after the one before it.
      for (let i = 1; i < sent.length; i++) {
        const waited = sent[i].at - sent[i - 1].at;
        assert(waited >= 1000, `statement ${i + 1} after ${waited} ms`);
      }
      // One challenge was asked for, once the first statement was spent.
      const challenges = log.filter((e) => e.type === "challenge");
      assertEquals(challenges.length, 1);
      assert(challenges[0].at > sent[3].at);
    } finally {
      await client.close();
      time.restore();
    }
  });
  await t.step("when its challenge will not last", async () => {
    const time = new FakeTime(Date.UTC(2026, 9, 1));
    // The hello's challenge lasts four seconds, under the five a resend
    // needs left, so the refused statement is not sent again.
    const { p, log, auths } = routedPeer((n) => n === 1, { helloLife: 4 });
    const client = await connect({ transport: p.transport });
    try {
      const mount = settling(client.mount(identity.did(), {}, principal()));
      await tickUntil(time, () => mount.settled);
      assertEquals(mount, { settled: true });
      const sent = auths();
      assertEquals(sent.length, 2);
      assert(sent[1].statement !== sent[0].statement);
      // The mount still waits a second before it asks for the challenge.
      const challenges = log.filter((e) => e.type === "challenge");
      assertEquals(challenges.length, 1);
      const waited = challenges[0].at - sent[0].at;
      assert(waited >= 1000 && waited < 1100, `${waited} ms`);
    } finally {
      await client.close();
      time.restore();
    }
  });
});

Deno.test("a mount whose request for a challenge is refused for now asks again a second later", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  // The first request for a challenge is refused, as when the connection
  // holds all the unexpired challenges it may.
  const { p, log, auths } = routedPeer(() => false, {
    refusedToo: (type, count) => type === "connection.challenge" && count === 1,
  });
  const client = await connect({ transport: p.transport });
  try {
    // The hello's challenge has expired, so the mount asks for one.
    await time.tickAsync(61_000);
    const mount = settling(client.mount(identity.did(), {}, principal()));
    await tickUntil(time, () => mount.settled);
    assertEquals(mount, { settled: true });
    const challenges = log.filter((e) => e.type === "challenge");
    assertEquals(challenges.length, 2);
    const waited = challenges[1].at - challenges[0].at;
    assert(waited >= 1000 && waited < 1100, `${waited} ms`);
    assertEquals(auths().length, 1);
    assertEquals(client.isConnected(), true);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a mount whose open is refused for now is tried again on the same connection until it is admitted", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  // The space's toolshed is down for the first three opens.
  const { p, log, auths } = routedPeer(() => false, {
    refusedToo: (type, count) => type === "session.open" && count <= 3,
  });
  const client = await connect({ transport: p.transport });
  try {
    const mount = settling(client.mount(identity.did(), {}, principal()));
    await tickUntil(time, () => mount.settled);
    assertEquals(mount, { settled: true });
    const opens = log.filter((e) => e.type === "open");
    assertEquals(opens.length, 4);
    // Each wait is a second and a step of the backoff on top of it.
    for (let i = 1; i < opens.length; i++) {
      const waited = opens[i].at - opens[i - 1].at;
      assert(waited >= 1025, `open ${i + 1} after ${waited} ms`);
    }
    // The key authenticated once, and the connection was not replaced.
    assertEquals(auths().length, 1);
    assertEquals(p.hellos(), 1);
    assertEquals(client.isConnected(), true);
  } finally {
    await client.close();
    time.restore();
  }
});

/**
 * A router that keeps the worker's rule for principals: a `session.open`
 * naming a key its connection has not authenticated is denied for good, and
 * one for a space in `down` is denied for now. `flagsOf` gives the flags
 * each hello is greeted with, by its number. The log names the connection
 * each request came on.
 */
function principalRouter(
  flagsOf: (hello: number) => ReturnType<typeof flags> = flags,
) {
  let hellos = 0;
  const authenticated = new Set<string>();
  const down = new Set<string>();
  let challenges = 0;
  const log: {
    connection: number;
    type: string;
    principal?: string;
    /** The challenge a statement signs, or the one a request was given. */
    challenge?: string;
    answer?: string;
    spaceKind?: unknown;
  }[] = [];
  const p = peer(
    (hello) => {
      hellos = hello;
      authenticated.clear();
      return frame(hello_(flagsOf(hello)));
    },
    (body, push) => {
      const respond = (rest: Record<string, unknown>) =>
        push({ type: "response", requestId: body.requestId, ...rest });
      const denied = (retriable: boolean) =>
        respond({
          error: {
            name: "AuthorizationError",
            message: "Routed memory request denied",
            ...(retriable ? { retriable: true } : {}),
          },
        });
      if (body.type === "connection.challenge") {
        const value = (++challenges).toString(16).padStart(64, "0");
        log.push({ connection: hellos, type: "challenge", challenge: value });
        respond({
          ok: {
            challenge: {
              value,
              expiresAt: Math.floor(Date.now() / 1000) + 60,
            },
          },
        });
      } else if (body.type === "connection.auth") {
        // The statement names its key and its challenge; see `namedSigner`.
        const [principal, challenge] = String(body.statement).split("|");
        authenticated.add(principal);
        log.push({ connection: hellos, type: "auth", principal, challenge });
        respond({
          ok: {
            principal,
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          },
        });
      } else if (body.type === "session.open") {
        const principal = String(body.principal);
        const answer = !authenticated.has(principal)
          ? "denied for good"
          : down.has(String(body.space))
          ? "denied for now"
          : "admitted";
        log.push({
          connection: hellos,
          type: "open",
          principal,
          answer,
          spaceKind: (body.session as { spaceKind?: unknown }).spaceKind,
        });
        if (answer !== "admitted") denied(answer === "denied for now");
        else {
          respond({
            ok: {
              sessionId: (body.session as { sessionId?: string }).sessionId ??
                `sdk-session-${body.space}`,
              sessionToken: "sdk-token",
              serverSeq: 0,
            },
          });
        }
      } else respond({ ok: {} });
    },
  );
  const hello_ = (selected: ReturnType<typeof flags>) =>
    selected.routedAuthV1
      ? hello(metadata(), selected)
      // A direct server's hello names no deployment.
      : hello({ audience: identity.did(), challenge: challenge() }, selected);
  return { p, down, log };
}

/** A signer whose statement names its key and challenge, for `principalRouter`. */
function namedSigner(did: string): SessionPrincipal {
  let signed = 0;
  return {
    did,
    authorizeSessionOpen: () => {
      throw new Error("Routed session uses connection authority");
    },
    authorizeConnection: (context) =>
      Promise.resolve(
        { statement: `${did}|${context.challenge.value}|${signed++}` } as never,
      ),
  };
}

Deno.test("a held mount that wakes between a drop and the next hello signs for the next connection", async (t) => {
  setModernCellRepConfig(true);
  for (
    const [name, laterFlags, mounted] of [
      // The mount's key is authenticated on the next connection before its
      // open goes there; the space is still down, so the mount stays held.
      ["as a key the next connection has not authenticated", flags(), {
        settled: false,
      }],
      // The next connection's server does not seal a space's kind, which
      // the mount declares.
      ["against the next connection's capabilities", {
        ...flags(),
        spaceKind: false,
      }, undefined],
    ] as const
  ) {
    await t.step(name, async () => {
      const random = Math.random;
      // No jitter: a held mount waits 1,025 ms, and a reconnect while a
      // session is held waits 25 ms before its hello.
      Math.random = () => 0;
      const time = new FakeTime(Date.UTC(2026, 9, 1));
      const { p, down, log } = principalRouter((hello) =>
        hello < 3 ? flags() : laterFlags
      );
      const client = await connect({ transport: p.transport });
      try {
        // A session whose toolshed goes down and whose connection drops is
        // held by the reconnect, so the next reconnect waits before its
        // hello.
        const session = await client.mount(
          identity.did(),
          {},
          namedSigner(identity.did()),
        );
        down.add(identity.did());
        down.add(elsewhere);
        p.drop();
        await tickUntil(time, () => session.held, 0, 40);
        assertEquals(p.hellos(), 2);
        // A mount as another key, of a space whose toolshed is down too.
        const held = Date.now();
        const mount = settling(
          client.mount(
            elsewhere,
            { spaceKind: "notes" },
            namedSigner(elsewhere),
          ),
        );
        await tickUntil(
          time,
          () => log.some((e) => e.principal === elsewhere && e.type === "open"),
          0,
          40,
        );
        assertEquals(mount, { settled: false });
        // The connection drops 10 ms before the mount's wait ends, and the
        // next hello goes 25 ms after the drop: the mount wakes in between.
        await time.tickAsync(1015 - (Date.now() - held));
        p.drop();
        await time.tickAsync(10);
        assertEquals(p.hellos(), 2);
        await time.tickAsync(100);
        await tickUntil(time, () => false, 0, 20);
        assertEquals(p.hellos(), 3);
        const onThird = log.filter((e) =>
          e.connection === 3 && e.principal === elsewhere
        ).map((e) => [e.type, e.answer]);
        if (mounted !== undefined) {
          assertEquals(onThird, [["auth", undefined], [
            "open",
            "denied for now",
          ]]);
          assertEquals(mount, mounted);
        } else {
          // No open that declares a kind reaches that server.
          assertEquals(onThird.filter(([type]) => type === "open"), []);
          assertEquals((mount.failure as Error)?.name, "ProtocolError");
        }
      } finally {
        await client.close();
        time.restore();
        Math.random = random;
      }
    });
  }
});

/** The DIDs of `count` keys no other test uses. */
const manyKeys = (count: number) =>
  Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const seed = new Uint8Array(32).fill(7);
      seed[0] = i;
      return (await Identity.fromRaw(seed)).did();
    }),
  );

Deno.test("new keys on a routed connection sign a challenge one of them asked for", async (t) => {
  setModernCellRepConfig(true);
  const keys = await manyKeys(40);
  const helloChallenge = "11".repeat(32);
  for (
    const [name, wait, together, challenges] of [
      // The hello's challenge has expired, so the first key asks for one,
      // 31 more sign it, and the 33rd asks for the next.
      [
        "one after another, once the hello's challenge has expired",
        61,
        false,
        2,
      ],
      ["all at once, once the hello's challenge has expired", 61, true, 2],
      // The hello's own challenge takes 32 signers too.
      ["one after another, on the hello's challenge", 0, false, 1],
    ] as const
  ) {
    await t.step(name, async () => {
      const time = new FakeTime(Date.UTC(2026, 9, 1));
      const { p, log } = principalRouter();
      const client = await connect({ transport: p.transport });
      try {
        await time.tickAsync(wait * 1000);
        const mount = (did: string) => client.mount(did, {}, namedSigner(did));
        if (together) await Promise.all(keys.map(mount));
        else for (const did of keys) await mount(did);
        const asked = log.filter((e) => e.type === "challenge");
        assertEquals(asked.length, challenges);
        const signed = log.filter((e) => e.type === "auth");
        assertEquals(signed.length, 40);
        // Each challenge was signed by at most 32 keys, in the order the
        // challenges came, and no key signed one challenge twice.
        const order = wait === 0
          ? [helloChallenge, asked[0].challenge]
          : asked.map((e) => e.challenge);
        assertEquals(
          order.map((value) =>
            signed.filter((e) => e.challenge === value).length
          ),
          [32, 8],
        );
        assertEquals(
          new Set(signed.map((e) => `${e.principal} ${e.challenge}`)).size,
          40,
        );
      } finally {
        await client.close();
        time.restore();
      }
    });
  }
});

Deno.test("a direct connection's keys do not share a challenge one of them asked for", async () => {
  setModernCellRepConfig(true);
  const keys = await manyKeys(40);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  const { p, log } = principalRouter(() => ({
    ...flags(),
    routedAuthV1: false,
  }));
  const client = await connect({ transport: p.transport });
  try {
    const mount = (did: string) => client.mount(did, {}, namedSigner(did));
    // The hello's challenge takes every key, with no bound on its signers.
    for (const did of keys.slice(0, 36)) await mount(did);
    assertEquals(log.filter((e) => e.type === "challenge").length, 0);
    // Once it has expired, each key asks for its own.
    await time.tickAsync(61_000);
    for (const did of keys.slice(36)) await mount(did);
    assertEquals(log.filter((e) => e.type === "challenge").length, 4);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a challenge a renewal asked for is signed by the next new key", async () => {
  setModernCellRepConfig(true);
  const [first, second] = await manyKeys(2);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  const { p, log } = principalRouter();
  const client = await connect({ transport: p.transport });
  try {
    await client.mount(first, {}, namedSigner(first));
    const challenges = () => log.filter((e) => e.type === "challenge");
    // The lease's renewal, eight minutes in, asks for a challenge of its
    // own: the hello's is one its key has signed.
    await time.tickAsync(479_000);
    await tickUntil(time, () => challenges().length >= 1);
    await tickUntil(time, () => false, 0, 5);
    await client.mount(second, {}, namedSigner(second));
    // The new key signs that challenge and asks for none.
    assertEquals(challenges().length, 1);
    assertEquals(
      log.filter((e) => e.type === "auth").map((e) => [
        e.principal,
        e.challenge,
      ]),
      [
        [first, "11".repeat(32)],
        [first, challenges()[0].challenge],
        [second, challenges()[0].challenge],
      ],
    );
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a mount held after a refusal for now starts over on the next connection when this one drops", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  const { p, log, auths } = routedPeer(() => false, {
    refusedToo: (type, count) => type === "session.open" && count === 1,
  });
  const client = await connect({ transport: p.transport });
  try {
    const mount = settling(client.mount(identity.did(), {}, principal()));
    const opens = () => log.filter((e) => e.type === "open").length;
    await tickUntil(time, () => opens() >= 1, 0, 40);
    assertEquals(mount, { settled: false });
    // The connection drops while the mount waits. A new connection has
    // authenticated nobody, so the mount signs for it before it opens.
    await time.tickAsync(500);
    p.drop();
    await tickUntil(time, () => mount.settled);
    assertEquals(mount, { settled: true });
    assertEquals(p.hellos(), 2);
    assertEquals(auths().length, 2);
    assertEquals(opens(), 2);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a mount held after a refusal for now ends when its caller cancels it or the client closes", async (t) => {
  setModernCellRepConfig(true);
  for (
    const ending of [
      "the caller's signal aborts",
      "the caller's signal aborts while an open is unanswered",
      "the client closes",
    ] as const
  ) {
    await t.step(ending, async () => {
      const time = new FakeTime(Date.UTC(2026, 9, 1));
      // The spaces' toolshed stays down: every open is refused for now. In
      // the second ending the refusal of the fifth open is held back.
      const { p, log, release } = routedPeer(() => false, {
        refusedToo: (type) => type === "session.open",
        held: (type, count) =>
          ending.endsWith("unanswered") && type === "session.open" &&
          count === 5,
      });
      const client = await connect({ transport: p.transport });
      try {
        const caller = new AbortController();
        // Two mounts are held at once, as one key.
        const mounts = [identity.did(), elsewhere].map((space) =>
          settling(client.mount(space, {}, principal(), caller.signal))
        );
        const opens = () => log.filter((e) => e.type === "open").length;
        await tickUntil(time, () => opens() >= 6);
        // Held, not failed.
        assertEquals(mounts, [{ settled: false }, { settled: false }]);
        if (ending === "the client closes") await client.close();
        else {
          caller.abort(new Error("the spaces were closed"));
          // With the key released, its renewal is not on a timer either.
          await client.release(identity.did());
        }
        // The refusal held back reaches a mount that is already cancelled.
        release();
        await time.tickAsync(0);
        await tickUntil(time, () => mounts.every((m) => m.settled), 0, 40);
        const message = ending === "the client closes"
          ? "memory client closed"
          : "the spaces were closed";
        assertEquals(
          mounts.map((mount) => (mount.failure as Error).message),
          [message, message],
        );
        // The waits are over with the mounts: the client has no timer left,
        // and a minute passes with no open sent.
        const sent = opens();
        assertEquals(time.next(), false);
        await tickUntil(time, () => false, 1000, 60);
        assertEquals(opens(), sent);
      } finally {
        await client.close();
        time.restore();
      }
    });
  }
});

Deno.test("a mount cancelled while its refused statement waits sends nothing more", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  const { p, log, auths } = routedPeer((n) => n === 1);
  const client = await connect({ transport: p.transport });
  try {
    const caller = new AbortController();
    const mount = settling(
      client.mount(identity.did(), {}, principal(), caller.signal),
    );
    await tickUntil(time, () => auths().length >= 1, 0, 40);
    assertEquals(mount, { settled: false });
    // Half a second into the wait the caller gives the mount up and
    // releases its key.
    await time.tickAsync(500);
    caller.abort(new Error("the space was closed"));
    await client.release(identity.did());
    // The wait ended with the mount, so the client has no timer left; the
    // statement is not sent again and no open follows.
    assertEquals(time.next(), false);
    await tickUntil(time, () => false, 1000, 10);
    assertEquals((mount.failure as Error).message, "the space was closed");
    assertEquals(auths().length, 1);
    assertEquals(log.filter((e) => e.type === "open").length, 0);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a mount cancelled while its key is being authenticated sends no open", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  const { p, log, auths } = routedPeer((n) => n === 1);
  const client = await connect({ transport: p.transport });
  try {
    // The first mount is refused and held. The second, made right after,
    // is the one waiting to send the refused statement again.
    const first = settling(client.mount(identity.did(), {}, principal()));
    await tickUntil(time, () => auths().length >= 1, 0, 40);
    const caller = new AbortController();
    const second = settling(
      client.mount(elsewhere, {}, principal(), caller.signal),
    );
    // The second mount's caller cancels it before the statement is sent.
    // The statement is still sent, for the first mount, but the second
    // opens nothing.
    await time.tickAsync(500);
    caller.abort(new Error("the space was closed"));
    await tickUntil(time, () => first.settled);
    await tickUntil(time, () => false, 1000, 3);
    assertEquals(first, { settled: true });
    assertEquals((second.failure as Error)?.message, "the space was closed");
    assertEquals(auths().length, 2);
    assertEquals(log.filter((e) => e.type === "open").length, 1);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a mount cancelled while it waits for the reconnect sends nothing on the next connection", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  // The reconnect's hello is answered only when the test says.
  const { p, log, auths, greet } = routedPeer(() => false, {
    ungreeted: (hello) => hello === 2,
  });
  const client = await connect({ transport: p.transport });
  try {
    p.drop();
    await time.tickAsync(0);
    assertEquals(p.hellos(), 2);
    const caller = new AbortController();
    const mount = settling(
      client.mount(identity.did(), {}, principal(), caller.signal),
    );
    await time.tickAsync(0);
    caller.abort(new Error("the space was closed"));
    greet();
    await tickUntil(time, () => false, 1000, 3);
    assertEquals(client.isConnected(), true);
    assertEquals((mount.failure as Error)?.message, "the space was closed");
    assertEquals(auths().length, 0);
    assertEquals(log.filter((e) => e.type === "open").length, 0);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a signed open's round after a reconnect is checked as its first round is", async (t) => {
  setModernCellRepConfig(true);
  // A direct server without connection authentication: each open is signed.
  const signedFlags = (spaceKind: boolean) => ({
    ...flags(),
    connectionAuth: false,
    routedAuthV1: false,
    spaceKind,
  });
  const direct = () => ({ audience: identity.did(), challenge: challenge() });
  /** A peer that greets its second hello as `second` says, and counts opens. */
  const signedPeer = (second: () => string | undefined) => {
    let opens = 0;
    const p = peer(
      (hello_) =>
        hello_ === 1 ? frame(hello(direct(), signedFlags(true))) : second(),
      (body, push) => {
        if (body.type === "session.open") opens++;
        push({
          type: "response",
          requestId: body.requestId,
          ok: body.type === "session.open"
            ? {
              sessionId: "sdk-session",
              sessionToken: "sdk-token",
              serverSeq: 0,
              sessionOpen: direct(),
            }
            : {},
        });
      },
    );
    return { p, opens: () => opens };
  };
  await t.step(
    "a mount cancelled while it waits for the reconnect signs nothing",
    async () => {
      const time = new FakeTime(Date.UTC(2026, 9, 1));
      // The reconnect's hello is answered only when the test says.
      const { p, opens } = signedPeer(() => undefined);
      const client = await connect({ transport: p.transport });
      try {
        let signs = 0;
        p.drop();
        await time.tickAsync(0);
        assertEquals(p.hellos(), 2);
        const caller = new AbortController();
        const mount = settling(
          client.mount(identity.did(), {}, () => {
            signs++;
            return undefined;
          }, caller.signal),
        );
        await time.tickAsync(0);
        caller.abort(new Error("the space was closed"));
        p.raw(frame(hello(direct(), signedFlags(true))));
        await tickUntil(time, () => false, 1000, 3);
        assertEquals(client.isConnected(), true);
        assertEquals((mount.failure as Error)?.message, "the space was closed");
        assertEquals(signs, 0);
        assertEquals(opens(), 0);
      } finally {
        await client.close();
        time.restore();
      }
    },
  );
  await t.step(
    "a mount that declares a kind fails against a next server that seals none",
    async () => {
      const time = new FakeTime(Date.UTC(2026, 9, 1));
      const { p, opens } = signedPeer(() =>
        frame(hello(direct(), signedFlags(false)))
      );
      const client = await connect({ transport: p.transport });
      try {
        // The connection drops while the open is being signed.
        let signs = 0;
        const signing = Promise.withResolvers<undefined>();
        const mount = settling(
          client.mount(identity.did(), { spaceKind: "notes" }, () => {
            signs++;
            return signing.promise;
          }),
        );
        await tickUntil(time, () => signs >= 1, 0, 40);
        p.drop();
        await time.tickAsync(0);
        assertEquals(p.hellos(), 2);
        signing.resolve(undefined);
        await tickUntil(time, () => mount.settled, 0, 40);
        assertEquals((mount.failure as Error)?.name, "ProtocolError");
        // The open that declares a kind is neither signed again nor sent.
        assertEquals(signs, 1);
        assertEquals(opens(), 0);
      } finally {
        await client.close();
        time.restore();
      }
    },
  );
});

Deno.test("a mount held through a reconnect is held to the next connection's capabilities", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  // The server the client reconnects to does not seal a space's kind.
  const { p, log } = routedPeer(() => false, {
    refusedToo: (type, count) => type === "session.open" && count === 1,
    laterFlags: { ...flags(), spaceKind: false },
  });
  const client = await connect({ transport: p.transport });
  try {
    const mount = settling(
      client.mount(identity.did(), { spaceKind: "notes" }, principal()),
    );
    const opens = () => log.filter((e) => e.type === "open").length;
    await tickUntil(time, () => opens() >= 1, 0, 40);
    assertEquals(mount, { settled: false });
    await time.tickAsync(500);
    p.drop();
    await tickUntil(time, () => mount.settled);
    assertEquals((mount.failure as Error)?.name, "ProtocolError");
    // The open that declares a kind is not sent to that server.
    assertEquals(opens(), 1);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a mount held after a refusal for now fails when the connection fails for good", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  // The server the client reconnects to cannot be used at all.
  const { p, log } = routedPeer(() => false, {
    refusedToo: (type) => type === "session.open",
    laterFlags: { ...flags(), stableExpressionResultIds: false },
  });
  const client = await connect({ transport: p.transport });
  try {
    const mount = settling(client.mount(identity.did(), {}, principal()));
    await tickUntil(
      time,
      () => log.filter((e) => e.type === "open").length >= 1,
      0,
      40,
    );
    assertEquals(mount, { settled: false });
    p.drop();
    await tickUntil(time, () => mount.settled, 0, 40);
    // The mount fails with the connection, not when its wait would end,
    // and no timer is left.
    assertEquals((mount.failure as Error)?.name, "ProtocolError");
    assertEquals(client.connectionState, "failed");
    assertEquals(time.next(), false);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a mount whose open is refused for good, or by a direct server, fails at once", async (t) => {
  setModernCellRepConfig(true);
  const direct: SessionPrincipal = {
    did: identity.did(),
    authorizeSessionOpen: () => {
      throw new Error("Direct session uses connection authority");
    },
    authorizeConnection: () =>
      Promise.resolve({ statement: "direct" } as never),
  };
  for (
    const [name, greeting, signer, retriable] of [
      ["a router's refusal for good", frame(hello()), principal(), false],
      [
        "a direct server's refusal marked retriable",
        frame(hello({ audience: identity.did(), challenge: challenge() }, {
          ...flags(),
          routedAuthV1: false,
        })),
        direct,
        true,
      ],
    ] as const
  ) {
    await t.step(name, async () => {
      const time = new FakeTime(Date.UTC(2026, 9, 1));
      let opens = 0;
      const p = peer(greeting, (body, push) => {
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
          opens++;
          push({
            type: "response",
            requestId: body.requestId,
            error: {
              name: "AuthorizationError",
              message: "Memory request denied",
              ...(retriable ? { retriable: true } : {}),
            },
          });
        } else push({ type: "response", requestId: body.requestId, ok: {} });
      });
      const client = await connect({ transport: p.transport });
      try {
        let failure: unknown;
        client.mount(identity.did(), {}, signer).catch((error) => {
          failure = error;
        });
        await tickUntil(time, () => failure !== undefined, 0, 40);
        assertEquals((failure as Error).message, "Memory request denied");
        // It is not tried again.
        await tickUntil(time, () => false, 1000, 10);
        assertEquals(opens, 1);
      } finally {
        await client.close();
        time.restore();
      }
    });
  }
});

Deno.test("a routed connection is sent at most the holdings one frame may name", async (t) => {
  setModernCellRepConfig(true);
  const direct: SessionPrincipal = {
    did: identity.did(),
    authorizeSessionOpen: () => {
      throw new Error("Direct session uses connection authority");
    },
    authorizeConnection: () =>
      Promise.resolve({ statement: "direct" } as never),
  };
  const holdings = Array.from(
    { length: ROUTED_HOLDINGS_LIMIT + 1 },
    (_, i) => ({ id: `of:h${i}` as const, seq: 1 }),
  );
  for (
    const [name, greeting, signer, sent] of [
      ["a routed connection", frame(hello()), principal(), holdings.length - 1],
      [
        "a direct connection",
        frame(hello({ audience: identity.did(), challenge: challenge() }, {
          ...flags(),
          routedAuthV1: false,
        })),
        direct,
        holdings.length,
      ],
    ] as const
  ) {
    await t.step(name, async () => {
      // What each request that declares holdings carried.
      const declared: { type: unknown; holdings: unknown[] }[] = [];
      const p = peer(greeting, (body, push) => {
        if (Array.isArray(body.holdings)) {
          declared.push({ type: body.type, holdings: body.holdings });
        }
        const ok = body.type === "connection.auth"
          ? {
            principal: identity.did(),
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          }
          : body.type === "session.open"
          ? {
            sessionId: "sdk-session",
            sessionToken: "sdk-token",
            serverSeq: 0,
          }
          : body.type === "session.watch.set"
          ? {
            serverSeq: 0,
            sync: {
              type: "sync",
              fromSeq: 0,
              toSeq: 0,
              upserts: [],
              removes: [],
            },
          }
          : {};
        push({ type: "response", requestId: body.requestId, ok });
      });
      const client = await connect({ transport: p.transport });
      try {
        // An open that declares holdings, as a reopen does.
        await client.openSession(identity.did(), {}, signer, holdings);
        const session = await client.mount(identity.did(), {}, signer);
        // A watch set that declares them, and a view set, which declares
        // what the session's consumer holds.
        await session.watchSetSync([], holdings);
        session.holdingsProvider = () => holdings;
        await session.viewSetSync([]);
        assertEquals(
          declared.map((request) => [request.type, request.holdings.length]),
          [
            ["session.open", sent],
            ["session.watch.set", sent],
            ["session.watch.set", sent],
          ],
        );
        // The holdings sent are the first of the list, unchanged.
        assertEquals(declared[0].holdings, holdings.slice(0, sent));
      } finally {
        await client.close();
      }
    });
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
