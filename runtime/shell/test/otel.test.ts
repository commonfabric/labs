import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import type { RuntimeTelemetryMarkerResult } from "@commonfabric/runtime-client";
import type { RuntimeTelemetryOtelBridge } from "@commonfabric/runner/telemetry-otel-bridge";

import { browserTelemetrySink, initBrowserOtel } from "../src/lib/otel.ts";

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

/** Runs `body` with `console.error` captured, returning what it logged. */
async function capturingErrors(
  body: () => Promise<void>,
): Promise<unknown[][]> {
  const logged: unknown[][] = [];
  const error = stub(console, "error", (...args: unknown[]) => {
    logged.push(args);
  });
  try {
    await body();
  } finally {
    error.restore();
  }
  return logged;
}

const OPTIONS = {
  userDid: "did:key:zTestUser",
  spaceDid: "did:key:zTestSpace",
  environment: "test",
};

/** A run long enough for the bridge to make a span of it. */
const RUN_COMPLETE: RuntimeTelemetryMarkerResult = {
  type: "scheduler.run.complete",
  actionId: "test-action",
  durationMs: 50,
  timeStamp: 1,
};

describe("otel", () => {
  describe("initBrowserOtel()", () => {
    // `initBrowserOtel()` reports a setup failure by returning `null`, so a
    // provider that no longer matches the SDK would turn telemetry off rather
    // than raise anything. These drive the real web SDK and OTLP exporter
    // against a receiver on the loopback interface and check what lands on
    // the wire.

    it("returns `null`, sending nothing, unless the flag is set", async () => {
      localStorage.removeItem(TELEMETRY_ENABLED_KEY);
      const requests = await withReceiver(async (apiUrl) => {
        expect(await initBrowserOtel({ apiUrl, ...OPTIONS })).toBe(null);
      });
      expect(requests.length).toBe(0);
    });

    it("returns `null` when `localStorage` cannot be read", async () => {
      localStorage.setItem(TELEMETRY_ENABLED_KEY, "true");
      const getItem = stub(Storage.prototype, "getItem", () => {
        throw new DOMException("Storage is disabled.", "SecurityError");
      });
      try {
        const requests = await withReceiver(async (apiUrl) => {
          expect(await initBrowserOtel({ apiUrl, ...OPTIONS })).toBe(null);
        });
        expect(requests.length).toBe(0);
      } finally {
        getItem.restore();
        localStorage.removeItem(TELEMETRY_ENABLED_KEY);
      }
    });

    it("returns `null`, logging the failure, when setup throws", async () => {
      class UnprintableUrl extends URL {
        override toString(): string {
          throw new Error("Unprintable.");
        }
      }
      localStorage.setItem(TELEMETRY_ENABLED_KEY, "true");
      try {
        let sink: unknown;
        const logged = await capturingErrors(async () => {
          sink = await initBrowserOtel({
            apiUrl: new UnprintableUrl("http://127.0.0.1/"),
            ...OPTIONS,
          });
        });
        expect(sink).toBe(null);
        expect(logged).toEqual([[
          "[otel] browser OpenTelemetry init failed:",
          new Error("Unprintable."),
        ]]);
      } finally {
        localStorage.removeItem(TELEMETRY_ENABLED_KEY);
      }
    });

    it(
      "exports a marker as a span carrying the merged resource",
      // The batch processor holds a flush timer until the sink is shut down,
      // which the body below performs.
      { sanitizeOps: false, sanitizeResources: false },
      async () => {
        localStorage.setItem(TELEMETRY_ENABLED_KEY, "true");
        try {
          const requests = await withReceiver(async (apiUrl) => {
            const sink = await initBrowserOtel({ apiUrl, ...OPTIONS });
            if (sink === null) {
              throw new Error("telemetry setup failed and was disabled");
            }

            // The bridge only turns a completed run into a span once it
            // lasted at least `actionRunSpanThresholdMs`, which defaults to 10.
            sink.handleMarker(RUN_COMPLETE);

            // Shutting the sink down flushes the processor, and the flush
            // resolves only once the exporter has its response, so the
            // receiver has already recorded the request by the time this
            // returns.
            await sink.shutdown();
          });

          const traces = requests.find((r) =>
            r.path === "/api/telemetry/v1/traces"
          );
          // The payload holds these strings verbatim, so it can be checked for
          // them without decoding it. Dropping the SDK's default attributes
          // still exports spans, just anonymous ones, so nothing else here
          // would notice their absence.
          expect(traces?.body).toContain("toolshed-ui");
          expect(traces?.body).toContain("did:key:zTestUser");
          expect(traces?.body).toContain("telemetry.sdk.version");
        } finally {
          localStorage.removeItem(TELEMETRY_ENABLED_KEY);
        }
      },
    );
  });

  describe("browserTelemetrySink()", () => {
    /** A bridge and provider that log to `steps`, failing where told to. */
    function parts(fail: { bridge?: boolean; provider?: boolean } = {}) {
      const steps: string[] = [];
      const bridge: RuntimeTelemetryOtelBridge = {
        handleMarker: (marker) => steps.push(`marker ${marker.type}`),
        shutdown: () => {
          steps.push("bridge shutdown");
          if (fail.bridge) throw new Error("bridge refused");
        },
      };
      const provider = {
        shutdown: () => {
          steps.push("provider shutdown");
          return fail.provider
            ? Promise.reject(new Error("provider refused"))
            : Promise.resolve();
        },
      };
      return { steps, bridge, provider };
    }

    it("passes each marker to the bridge", () => {
      const { steps, bridge, provider } = parts();
      const sink = browserTelemetrySink(bridge, provider, {});

      sink.handleMarker(RUN_COMPLETE);

      expect(steps).toEqual(["marker scheduler.run.complete"]);
    });

    it("stamps later spans with the space it is given, and with none once cleared", () => {
      const { bridge, provider } = parts();
      const attributes = { "user.did": "did:key:zUser" };
      const sink = browserTelemetrySink(bridge, provider, attributes);

      sink.setSpace("did:key:zOther");
      expect(attributes).toEqual({
        "user.did": "did:key:zUser",
        "space.did": "did:key:zOther",
      });

      sink.setSpace(undefined);
      expect(attributes).toEqual({ "user.did": "did:key:zUser" });
    });

    it("shuts the bridge down, then the provider, logging nothing", async () => {
      const { steps, bridge, provider } = parts();
      const sink = browserTelemetrySink(bridge, provider, {});

      const logged = await capturingErrors(() => sink.shutdown());

      expect(steps).toEqual(["bridge shutdown", "provider shutdown"]);
      expect(logged).toEqual([]);
    });

    it("still shuts the provider down, logging both failures, when each step throws", async () => {
      const { steps, bridge, provider } = parts({
        bridge: true,
        provider: true,
      });
      const sink = browserTelemetrySink(bridge, provider, {});

      const logged = await capturingErrors(() => sink.shutdown());

      expect(steps).toEqual(["bridge shutdown", "provider shutdown"]);
      expect(logged).toEqual([
        ["[otel] bridge shutdown failed:", new Error("bridge refused")],
        ["[otel] provider shutdown failed:", new Error("provider refused")],
      ]);
    });
  });
});
