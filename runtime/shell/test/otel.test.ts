import { assert, assertEquals } from "@std/assert";
import { initBrowserOtel } from "../src/lib/otel.ts";

// initBrowserOtel reports a setup failure by returning null, so a provider that
// no longer matches the SDK would turn telemetry off rather than raise
// anything. These drive the real web SDK and OTLP exporter against a receiver
// on the loopback interface and check what lands on the wire.

const TELEMETRY_ENABLED_KEY = "telemetryEnabled";

interface Request {
  path: string;
  body: string;
}

// Runs `body` against a receiver standing in for toolshed's OTLP proxy, and
// hands back every request it got.
async function withReceiver(
  body: (apiUrl: string) => Promise<void>,
): Promise<Request[]> {
  const requests: Request[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  // Bound to loopback so the receiver is never reachable from another host
  // while the test runs; the URL below uses the same address so the process
  // stays within a --allow-net=127.0.0.1 grant.
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      requests.push({
        path: new URL(request.url).pathname,
        body: decoder.decode(new Uint8Array(await request.arrayBuffer())),
      });
      return new Response(null, { status: 200 });
    },
  );
  try {
    await body(`http://127.0.0.1:${server.addr.port}`);
  } finally {
    await server.shutdown();
  }
  return requests;
}

Deno.test("browser telemetry stays off unless the flag is set", async () => {
  localStorage.removeItem(TELEMETRY_ENABLED_KEY);
  const requests = await withReceiver(async (apiUrl) => {
    const sink = await initBrowserOtel({
      apiUrl,
      userDid: "did:key:zTestUser",
      spaceDid: "did:key:zTestSpace",
      environment: "test",
    });
    assertEquals(sink, null);
  });
  assertEquals(requests.length, 0);
});

Deno.test(
  "a marker becomes a span carrying the merged resource",
  // The batch processor holds a flush timer until the sink is shut down, which
  // the body below performs.
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    localStorage.setItem(TELEMETRY_ENABLED_KEY, "true");
    try {
      const requests = await withReceiver(async (apiUrl) => {
        const sink = await initBrowserOtel({
          apiUrl,
          userDid: "did:key:zTestUser",
          spaceDid: "did:key:zTestSpace",
          environment: "test",
        });
        assert(sink !== null, "telemetry setup failed and was disabled");

        // The bridge only turns a completed run into a span once it lasted at
        // least actionRunSpanThresholdMs, which defaults to 10.
        sink.handleMarker({
          type: "scheduler.run.complete",
          actionId: "test-action",
          durationMs: 50,
          timeStamp: 1,
          // deno-lint-ignore no-explicit-any
        } as any);

        // Shutting the sink down flushes the processor, and the flush resolves
        // only once the exporter has its response, so the receiver has already
        // recorded the request by the time this returns.
        await sink.shutdown();
      });

      const traces = requests.find((r) =>
        r.path === "/api/telemetry/v1/traces"
      );
      assert(traces !== undefined, "no span export reached the proxy");

      // The payload holds these strings verbatim, so it can be checked for them
      // without decoding it.
      assert(
        traces.body.includes("toolshed-ui"),
        "the export did not carry service.name",
      );
      assert(
        traces.body.includes("did:key:zTestUser"),
        "the export did not carry user.did",
      );
      // Dropping these still exports spans, just anonymous ones, so nothing
      // else here would notice their absence.
      assert(
        traces.body.includes("telemetry.sdk.version"),
        "the export did not carry the SDK's default resource attributes",
      );
    } finally {
      localStorage.removeItem(TELEMETRY_ENABLED_KEY);
    }
  },
);
