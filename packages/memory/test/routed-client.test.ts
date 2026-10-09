/** SDK protocol failures use a synthetic transport; authority is tested separately. */
import { assert, assertEquals, assertRejects } from "@std/assert";
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
  let closeReceiver = (_?: Error) => {};
  let closed = 0;
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
      if (body.type === "hello") receiver(greeting);
      else respond?.(body, push);
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

Deno.test("a second mount right after a refusal for now waits for the statement the first mount sends again a second later", async () => {
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
 * statement, challenge request and open came. The answers `held` picks, by
 * request type and that type's count, are sent only when the test calls
 * `release`.
 */
function routedPeer(
  refused: (statement: number) => boolean,
  held: (type: string, count: number) => boolean = () => false,
) {
  const log: { type: string; at: number; statement?: unknown }[] = [];
  const counts = new Map<string, number>();
  const waiting: (() => void)[] = [];
  const p = peer(frame(hello()), (body, push) => {
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
      respond(() => ({ ok: { challenge: challenge() } }));
    } else if (type === "connection.auth") {
      log.push({ type: "auth", at: Date.now(), statement: body.statement });
      respond(() =>
        refused(count)
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
          }
      );
    } else if (type === "session.open") {
      log.push({ type: "open", at: Date.now() });
      respond(() => ({
        ok: {
          sessionId: `sdk-session-${body.space}`,
          sessionToken: "sdk-token",
          serverSeq: 0,
        },
      }));
    } else respond(() => ({ ok: {} }));
  });
  return {
    p,
    log,
    /** The statements sent so far, in order. */
    auths: () => log.filter((e) => e.type === "auth"),
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
    assert(sent[2].at - sent[1].at >= 1000, `${sent[2].at - sent[1].at} ms`);
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
      const { p, auths, pushChallenge } = routedPeer((n) => n === 2);
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
        // sent again, is the one that sends it. The attempt armed by the
        // refusal comes due in the same millisecond and must not send it
        // too: a router closes the connection on a second statement for a
        // challenge it has accepted.
        let mounted = false;
        const mounting = client.mount(elsewhere, {}, principal()).then(() => {
          mounted = true;
        });
        await tickUntil(time, () => mounted, 25, 120);
        await mounting;
        // Nothing more is sent in the second after that.
        await tickUntil(time, () => false, 25, 40);
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
        (type, count) => type === "connection.auth" && count === 2,
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
        // No attempt is armed for the released key: two seconds pass and
        // nothing is sent.
        await tickUntil(time, () => false, 25, 80);
        assertEquals(auths().length, 2);
        assertEquals(client.isConnected(), true);
      } finally {
        await client.close();
        time.restore();
      }
    });
  }
});

Deno.test("a renewal refused for now after a pushed challenge was admitted leaves the admitted lease's renewal armed", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  // The renewal's request for a challenge is answered late, after the
  // router has pushed a challenge and admitted its answer; the statement
  // the renewal then signs is the third, and is refused for now.
  const { p, log, auths, pushChallenge, release } = routedPeer(
    (n) => n === 3,
    (type, count) => type === "connection.challenge" && count === 1,
  );
  const client = await connect({ transport: p.transport });
  try {
    const session = await client.mount(identity.did(), {}, principal());
    await time.tickAsync(470_000);
    await tickUntil(
      time,
      () => log.some((e) => e.type === "challenge"),
      1000,
      30,
    );
    assertEquals(log.filter((e) => e.type === "challenge").length, 1);
    pushChallenge();
    await tickUntil(time, () => auths().length >= 2, 0, 40);
    assertEquals(auths().length, 2);
    release();
    await tickUntil(time, () => auths().length >= 3, 0, 40);
    assertEquals(auths().length, 3);
    // The key holds the lease its second statement was admitted for, and
    // that lease's renewal is armed, so the refusal arms no retry: nothing
    // is sent in the next ten seconds.
    await tickUntil(time, () => false, 25, 400);
    assertEquals(auths().length, 3);
    // The admitted lease is renewed two minutes before it ends.
    await time.tickAsync(460_000);
    await tickUntil(time, () => auths().length >= 4, 1000, 30);
    assertEquals(auths().length, 4);
    const gap = (auths()[3].at - auths()[1].at) / 1000;
    assert(gap >= 479 && gap <= 481, `renewed after ${gap} s`);
    assertEquals(session.closeError, undefined);
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

Deno.test("two mounts as one key both resolve when the connection drops before their statement is sent again", async () => {
  setModernCellRepConfig(true);
  const time = new FakeTime(Date.UTC(2026, 9, 1));
  const { p, log, auths } = routedPeer((n) => n === 1);
  const client = await connect({ transport: p.transport });
  try {
    const mounting = Promise.allSettled([
      client.mount(identity.did(), {}, principal()),
      client.mount(elsewhere, {}, principal()),
    ]);
    await tickUntil(time, () => auths().length >= 1, 0, 40);
    assertEquals(auths().length, 1);
    // Half way through the second both mounts wait, the connection drops
    // and the client connects again. The refused statement answered a
    // challenge of the connection that is gone, so neither mount sends it:
    // each waits for the new connection and signs for it.
    await time.tickAsync(500);
    p.drop();
    await tickUntil(
      time,
      () => log.filter((e) => e.type === "open").length >= 2,
    );
    assertEquals(
      (await mounting).map((result) => result.status),
      ["fulfilled", "fulfilled"],
    );
    assertEquals(auths().length, 2);
    assert(auths()[1].statement !== auths()[0].statement);
    assertEquals(client.isConnected(), true);
  } finally {
    await client.close();
    time.restore();
  }
});

Deno.test("a mount fails with the refusal once its statement may not be sent again", async (t) => {
  setModernCellRepConfig(true);
  for (
    const [name, helloLife, statements] of [
      // The refused statement, then the same statement three more times.
      ["after three resends", 60, 4],
      // Four seconds, under the five a resend needs left.
      ["at once when its challenge will not last", 4, 1],
    ] as const
  ) {
    await t.step(name, async () => {
      const time = new FakeTime(Date.UTC(2026, 9, 1));
      const { p, log } = refusingFromTheStart(helloLife);
      const client = await connect({ transport: p.transport });
      try {
        let failure: unknown;
        client.mount(identity.did(), {}, principal()).catch((error) => {
          failure = error;
        });
        await tickUntil(time, () => failure !== undefined);
        // The caller gets the router's refusal, marked as one that passes.
        assertEquals((failure as Error).name, "AuthorizationError");
        assertEquals((failure as { retriable?: boolean }).retriable, true);
        const auths = log.filter((e) => e.type === "auth");
        assertEquals(auths.length, statements);
        assert(auths.every((e) => e.statement === auths[0].statement));
        for (let i = 1; i < auths.length; i++) {
          const waited = auths[i].at - auths[i - 1].at;
          assert(waited >= 1000 && waited < 1100, `${waited} ms`);
        }
        // The mount asked for no challenge of its own.
        assertEquals(log.filter((e) => e.type === "challenge").length, 0);
      } finally {
        await client.close();
        time.restore();
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
