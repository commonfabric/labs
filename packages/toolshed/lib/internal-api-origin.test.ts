/**
 * The internal API origin (OW55): the fetch that sends this process's
 * self-addressed requests to its own listener, the startup probe that
 * establishes the listener is this process, the gate the listener runs
 * behind meanwhile, and the order the startup sequence keeps.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  admitInternalApiOrigin,
  describeError,
  type InternalApiOriginVerdict,
  rewritingFetch,
  selfDirectedFetch,
  STARTUP_PROBE_HEADER,
  startupGate,
  verifyInternalApiOrigin,
} from "@/lib/internal-api-origin.ts";

const PUBLIC = "https://toolshed.example";
const INTERNAL = "http://127.0.0.1:8007";
const TOKEN = "probe-token";

/** Runs `body` with `globalThis.fetch` replaced by a recorder. */
async function withRecordedFetch(
  body: (requests: Request[]) => Promise<void>,
): Promise<void> {
  const requests: Request[] = [];
  const platform = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Promise.resolve(new Response("ok"));
  }) as typeof fetch;
  try {
    await body(requests);
  } finally {
    globalThis.fetch = platform;
  }
}

Deno.test("rewritingFetch sends requests addressed to the public origin to the internal one and nothing else", async () => {
  await withRecordedFetch(async (requests) => {
    const fetch = rewritingFetch(PUBLIC, INTERNAL);
    // A string, a URL and a Request addressed to the public origin: the
    // path, query and method travel; only the origin changes.
    await fetch(`${PUBLIC}/api/patterns/x.tsx?v=2`);
    await fetch(new URL(`${PUBLIC}/api/storage/blobby/a`));
    await fetch(
      new Request(`${PUBLIC}/api/patterns/compile`, {
        method: "POST",
        body: "src",
        headers: { "x-example": "kept" },
      }),
    );
    // Addressed elsewhere: untouched, loopback included.
    await fetch("https://api.anthropic.com/v1/messages");
    await fetch(`${INTERNAL}/api/meta`);
    assertEquals(
      requests.map((request) => `${request.method} ${request.url}`),
      [
        `GET ${INTERNAL}/api/patterns/x.tsx?v=2`,
        `GET ${INTERNAL}/api/storage/blobby/a`,
        `POST ${INTERNAL}/api/patterns/compile`,
        "GET https://api.anthropic.com/v1/messages",
        `GET ${INTERNAL}/api/meta`,
      ],
    );
    assertEquals(requests[2].headers.get("x-example"), "kept");
    assertEquals(await requests[2].text(), "src");
  });
});

Deno.test("rewritingFetch reads the platform fetch at call time, and selfDirectedFetch is nothing when no internal origin is set", async () => {
  // Late binding: a test or harness that replaces `globalThis.fetch` after
  // construction is honored, as the Runtime's own default fetch does.
  const fetch = rewritingFetch(PUBLIC, INTERNAL);
  await withRecordedFetch(async (requests) => {
    await fetch(`${PUBLIC}/api/meta`);
    assertEquals(requests[0].url, `${INTERNAL}/api/meta`);
  });
  assertEquals(
    selfDirectedFetch({ API_URL: PUBLIC, API_INTERNAL_URL: undefined }),
    undefined,
  );
  assert(
    selfDirectedFetch({ API_URL: PUBLIC, API_INTERNAL_URL: INTERNAL }) !==
      undefined,
  );
});

/** A fetch answering with `respond`, recording what it was asked. */
function answering(
  respond: (request: Request) => Response | Promise<Response>,
): { fetch: typeof fetch; requests: Request[] } {
  const requests: Request[] = [];
  const impl = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(respond(request));
  };
  return { fetch: impl as typeof fetch, requests };
}

Deno.test("verifyInternalApiOrigin accepts the origin whose answer followed the probe's arrival here", async () => {
  const meta = answering(() => Response.json({ did: "did:key:z6MkSelf" }));
  const verdict = await verifyInternalApiOrigin({
    origin: INTERNAL,
    token: TOKEN,
    probeArrived: () => true,
    fetch: meta.fetch,
  });
  assertEquals(verdict, { verified: true });
  // The probe is the origin's meta document, asked as JSON, carrying the
  // token, and not following a redirect: an origin that sends its callers
  // elsewhere is not the listener it was meant to name.
  assertEquals(meta.requests.length, 1);
  assertEquals(meta.requests[0].url, `${INTERNAL}/api/meta`);
  assertEquals(meta.requests[0].headers.get("accept"), "application/json");
  assertEquals(meta.requests[0].headers.get(STARTUP_PROBE_HEADER), TOKEN);
  assertEquals(meta.requests[0].redirect, "error");
});

Deno.test("verifyInternalApiOrigin refuses an answer that did not come through this process, a non-answer and a failure", async () => {
  const probe = `${INTERNAL}/api/meta`;
  const verify = (
    respond: (request: Request) => Response | Promise<Response>,
    probeArrived = () => false,
  ) =>
    verifyInternalApiOrigin({
      origin: INTERNAL,
      token: TOKEN,
      probeArrived,
      fetch: answering(respond).fetch,
    });

  // The decisive case: a listener that answers /api/meta well, this
  // deployment's own DID included, but is not this process. Its bytes must
  // not be compiled here.
  assertEquals(
    await verify(() => Response.json({ did: "did:key:z6MkSelf" })),
    {
      verified: false,
      reason: `${probe} answered, but the request did not reach this ` +
        "process: another listener answers there",
    },
  );
  // Nothing bound there: Deno reports "fetch failed" and keeps the reason in
  // the cause, which the verdict carries.
  assertEquals(
    await verify(() => {
      throw new TypeError("fetch failed", {
        cause: new Error(
          "tcp connect error: Connection refused (os error 111)",
        ),
      });
    }),
    {
      verified: false,
      reason: `${probe} did not answer: fetch failed: tcp connect error: ` +
        "Connection refused (os error 111)",
    },
  );
  // A listener that is not a toolshed, or one that refuses the probe.
  assertEquals(
    await verify(() => new Response("not here", { status: 404 }), () => true),
    { verified: false, reason: `${probe} answered 404` },
  );
});

Deno.test("verifyInternalApiOrigin gives up on an origin that does not answer in time", async () => {
  const verdict = await verifyInternalApiOrigin({
    origin: INTERNAL,
    token: TOKEN,
    probeArrived: () => false,
    timeoutMs: 10,
    fetch: ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () =>
            reject(init.signal!.reason),
        );
      })) as typeof fetch,
  });
  assert(!verdict.verified);
  assert(
    verdict.reason.startsWith(`${INTERNAL}/api/meta did not answer:`),
    verdict.reason,
  );
});

Deno.test("describeError joins an error with its causes and tolerates non-errors", () => {
  assertEquals(
    describeError(
      new TypeError("fetch failed", {
        cause: new Error("invalid peer certificate: UnknownIssuer"),
      }),
    ),
    "fetch failed: invalid peer certificate: UnknownIssuer",
  );
  assertEquals(describeError(new Error("plain")), "plain");
  assertEquals(describeError("a string"), "a string");
  // A cause repeating its parent's message is not repeated.
  assertEquals(
    describeError(new Error("same", { cause: new Error("same") })),
    "same",
  );
});

Deno.test("startupGate passes only the token-bearing probe until admitted, and records it", async () => {
  const served: string[] = [];
  const handler = (request: Request, info: { peer: string }) => {
    served.push(
      `${request.method} ${new URL(request.url).pathname} ${info.peer}`,
    );
    return new Response("served");
  };
  const gate = startupGate(handler, TOKEN);
  const info = { peer: "p" };
  assertEquals(gate.probeArrived(), false);

  // Everything waits, /api/meta without the token or with another token
  // included: a request that needs a runtime cannot be served yet, a Memory
  // session opened now would precede the serving host, and a meta document
  // read now would report no posture.
  for (
    const request of [
      new Request(`${INTERNAL}/api/meta`),
      new Request(`${INTERNAL}/api/meta`, {
        headers: { [STARTUP_PROBE_HEADER]: "another" },
      }),
      new Request(`${INTERNAL}/api/meta`, {
        method: "POST",
        headers: { [STARTUP_PROBE_HEADER]: TOKEN },
      }),
      new Request(`${INTERNAL}/api/health`),
      new Request(`${INTERNAL}/api/storage/memory`),
      new Request(`${INTERNAL}/api/webhooks/wh_1`, { method: "POST" }),
    ]
  ) {
    const held = await gate.fetch(request, info);
    assertEquals(held.status, 503, request.url);
    assertEquals(held.headers.get("retry-after"), "1");
    await held.body?.cancel();
  }
  assertEquals(served, []);
  assertEquals(gate.probeArrived(), false);

  // The server's own probe gets through to the real document, and its
  // arrival is what the verification reads.
  const meta = await gate.fetch(
    new Request(`${INTERNAL}/api/meta`, {
      headers: { [STARTUP_PROBE_HEADER]: TOKEN },
    }),
    info,
  );
  assertEquals(meta.status, 200);
  assertEquals(gate.probeArrived(), true);
  assertEquals(served, ["GET /api/meta p"]);

  gate.admit();
  const admitted = await gate.fetch(
    new Request(`${INTERNAL}/api/storage/memory`),
    info,
  );
  assertEquals(admitted.status, 200);
  assertEquals(served[1], "GET /api/storage/memory p");
});

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/** Runs the startup sequence with recorders for every effect. */
function runSequence(
  verdict: () => Promise<InternalApiOriginVerdict>,
  options: { shuttingDown?: boolean; startRuntimesThrows?: boolean } = {},
) {
  const events: string[] = [];
  const run = admitInternalApiOrigin({
    origin: INTERNAL,
    verify: () => {
      events.push("verify");
      return verdict();
    },
    startRuntimes: () => {
      events.push("startRuntimes");
      if (options.startRuntimesThrows) throw new Error("no storage");
    },
    admit: () => void events.push("admit"),
    onListening: () => void events.push("onListening"),
    shuttingDown: () => options.shuttingDown ?? false,
    exit: (code) => {
      events.push(`exit ${code}`);
      throw new Exited(code);
    },
    log: (line) => void events.push(`log ${line}`),
    error: (line) => void events.push(`error ${line}`),
  });
  return { run, events };
}

Deno.test("admitInternalApiOrigin starts the runtimes, admits the listener and signals readiness, in that order, once verified", async () => {
  const { run, events } = runSequence(() =>
    Promise.resolve({ verified: true })
  );
  await run;
  assertEquals(events, [
    "verify",
    `log Internal API origin ${INTERNAL} reaches this server`,
    "startRuntimes",
    "admit",
    "onListening",
  ]);
});

Deno.test("admitInternalApiOrigin exits without a runtime when the origin is refused or the probe throws", async () => {
  for (
    const verdict of [
      () => Promise.resolve({ verified: false, reason: "answered 404" }),
      () => Promise.reject(new Error("probe exploded")),
    ]
  ) {
    const { run, events } = runSequence(verdict);
    await assertRejects(() => run, Exited);
    assertEquals(events.length, 3);
    assertEquals(events[0], "verify");
    assert(
      events[1].startsWith(
        `error API_INTERNAL_URL ${INTERNAL} is not this server: `,
      ),
      events[1],
    );
    assertEquals(events[2], "exit 1");
  }
});

Deno.test("admitInternalApiOrigin exits when the runtimes fail to start, and ends quietly during a shutdown", async () => {
  const failing = runSequence(
    () => Promise.resolve({ verified: true }),
    { startRuntimesThrows: true },
  );
  await assertRejects(() => failing.run, Exited);
  assertEquals(failing.events.slice(2), [
    "startRuntimes",
    "error Failed to start runtimes:",
    "exit 1",
  ]);

  // A shutdown aborted the listener, so the probe failed for that reason,
  // not the origin's: no verdict, no exit code of this sequence's own.
  const stopping = runSequence(
    () => Promise.resolve({ verified: false, reason: "did not answer" }),
    { shuttingDown: true },
  );
  await stopping.run;
  assertEquals(stopping.events, ["verify"]);
});
