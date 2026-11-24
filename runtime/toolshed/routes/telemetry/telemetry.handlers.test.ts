import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Hono } from "@hono/hono";
import { forwardOtlp, type OtlpForwarding } from "./telemetry.handlers.ts";

const MAX_TELEMETRY_BYTES = 1024 * 1024;

interface Forwarded {
  url: string;
  contentType: string | null;
  body: Uint8Array | undefined;
}

// A collector that records each payload relayed to it, and answers each with
// the promise `respond` returns.
const fakeCollector = (
  respond: () => Promise<Response> = () =>
    Promise.resolve(new Response(null, { status: 200 })),
) => {
  const forwarded: Forwarded[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    forwarded.push({
      url: String(input),
      contentType: new Headers(init?.headers).get("content-type"),
      body: init?.body instanceof Uint8Array ? init.body : undefined,
    });
    return respond();
  };
  return { forwarded, fetch };
};

// An app relaying both signals through `forwarding`.
const proxy = (forwarding: OtlpForwarding) => {
  const app = new Hono();
  app.post("/v1/traces", (c) => forwardOtlp(c, "traces", forwarding));
  app.post("/v1/metrics", (c) => forwardOtlp(c, "metrics", forwarding));
  return app;
};

// A request whose body arrives as a stream, so it declares no length.
const streamed = (chunks: Uint8Array[]): Request =>
  new Request("http://toolshed.test/v1/traces", {
    method: "POST",
    body: ReadableStream.from(chunks),
  });

describe("telemetry.handlers", () => {
  describe("forwardOtlp()", () => {
    it("returns 204 and relays nothing when telemetry is disabled", async () => {
      const collector = fakeCollector();
      const app = proxy({
        enabled: false,
        endpoint: "http://collector.test",
        fetch: collector.fetch,
      });

      const response = await app.request("/v1/traces", {
        method: "POST",
        body: "{}",
      });

      expect(response.status).toBe(204);
      expect(collector.forwarded).toEqual([]);
    });

    it("returns 202 and relays the payload, with its content type, to the signal's collector path", async () => {
      const collector = fakeCollector();
      const app = proxy({
        enabled: true,
        endpoint: "http://collector.test:4318/",
        fetch: collector.fetch,
      });

      const response = await app.request("/v1/metrics", {
        method: "POST",
        headers: { "content-type": "application/x-protobuf" },
        body: new Uint8Array([1, 2, 3]),
      });

      expect(response.status).toBe(202);
      expect(collector.forwarded).toEqual([{
        url: "http://collector.test:4318/v1/metrics",
        contentType: "application/x-protobuf",
        body: new Uint8Array([1, 2, 3]),
      }]);
    });

    it("joins a streamed body's chunks and labels a payload with no content type as JSON", async () => {
      const collector = fakeCollector();
      const app = proxy({
        enabled: true,
        endpoint: "http://collector.test",
        fetch: collector.fetch,
      });

      const response = await app.request(
        streamed([new Uint8Array([1, 2]), new Uint8Array([3])]),
      );

      expect(response.status).toBe(202);
      expect(collector.forwarded).toEqual([{
        url: "http://collector.test/v1/traces",
        contentType: "application/json",
        body: new Uint8Array([1, 2, 3]),
      }]);
    });

    it("relays an empty payload for a request with no body", async () => {
      const collector = fakeCollector();
      const app = proxy({
        enabled: true,
        endpoint: "http://collector.test",
        fetch: collector.fetch,
      });

      const response = await app.request("/v1/traces", { method: "POST" });

      expect(response.status).toBe(202);
      expect(collector.forwarded.map((f) => f.body)).toEqual([
        new Uint8Array(0),
      ]);
    });

    it("returns 413 and relays nothing for a declared length over the cap", async () => {
      const collector = fakeCollector();
      const app = proxy({
        enabled: true,
        endpoint: "http://collector.test",
        fetch: collector.fetch,
      });

      const response = await app.request("/v1/traces", {
        method: "POST",
        headers: { "content-length": String(MAX_TELEMETRY_BYTES + 1) },
        body: "{}",
      });

      expect(response.status).toBe(413);
      expect(collector.forwarded).toEqual([]);
    });

    it("returns 413 and relays nothing once a streamed body passes the cap", async () => {
      const collector = fakeCollector();
      const app = proxy({
        enabled: true,
        endpoint: "http://collector.test",
        fetch: collector.fetch,
      });
      const half = new Uint8Array(MAX_TELEMETRY_BYTES / 2);

      const atCap = await app.request(streamed([half, half]));
      expect(atCap.status).toBe(202);

      const overCap = await app.request(
        streamed([half, half, new Uint8Array(1)]),
      );
      expect(overCap.status).toBe(413);
      expect(collector.forwarded).toHaveLength(1);
    });

    it("logs a body that fails to read, returns 202, and relays nothing", async () => {
      const collector = fakeCollector();
      const app = proxy({
        enabled: true,
        endpoint: "http://collector.test",
        fetch: collector.fetch,
      });
      const failure = new Error("connection torn down");
      const reported: unknown[][] = [];
      using _error = stub(console, "error", (...args: unknown[]) => {
        reported.push(args);
      });

      const response = await app.request(
        new Request("http://toolshed.test/v1/traces", {
          method: "POST",
          body: new ReadableStream({
            pull(controller) {
              controller.error(failure);
            },
          }),
        }),
      );

      expect(response.status).toBe(202);
      expect(collector.forwarded).toEqual([]);
      expect(reported).toEqual([
        ["[telemetry-proxy] failed to read request body:", failure],
      ]);
    });

    it("returns 202 before the collector answers, and logs a relay that fails", async () => {
      const answer = Promise.withResolvers<Response>();
      const collector = fakeCollector(() => answer.promise);
      const app = proxy({
        enabled: true,
        endpoint: "http://collector.test",
        fetch: collector.fetch,
      });
      const logged = Promise.withResolvers<unknown[]>();
      using _error = stub(console, "error", (...args: unknown[]) => {
        logged.resolve(args);
      });

      const response = await app.request("/v1/traces", {
        method: "POST",
        body: "{}",
      });
      expect(response.status).toBe(202);

      const failure = new TypeError("collector unreachable");
      answer.reject(failure);

      expect(await logged.promise).toEqual([
        "[telemetry-proxy] failed to forward traces to " +
        "http://collector.test/v1/traces:",
        failure,
      ]);
    });
  });
});
