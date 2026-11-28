import { expect } from "@std/expect";
import { describe, it } from "@commonfabric/test-support/test";

import { transportWorkerUrl } from "@/client/transports/web-worker/transport-web-worker.ts";

describe("transportWorkerUrl()", () => {
  // A scope with Deno's globals and one without, as `isDeno()` tells them
  // apart.
  const denoScope = { Deno: { build: {} } };
  const browserScope = { fetch };
  const given = new URL("http://localhost/worker.js");

  it("returns a given URL as it is, in Deno and outside it", () => {
    expect(transportWorkerUrl(given, denoScope)).toBe(given);
    expect(transportWorkerUrl(given, browserScope)).toBe(given);
  });

  it("returns the backend's entry module in Deno when given no URL", async () => {
    const url = transportWorkerUrl(undefined, denoScope);
    expect(url.href).toBe(
      new URL("../../src/backends/web-worker/index.ts", import.meta.url).href,
    );
    expect((await Deno.stat(url)).isFile).toBe(true);
    expect(transportWorkerUrl(undefined).href).toBe(url.href);
  });

  it("throws outside Deno when given no URL", () => {
    expect(() => transportWorkerUrl(undefined, browserScope)).toThrow(
      "RuntimeClient `workerUrl` must be explicitly defined in non-Deno environments.",
    );
    expect(() => transportWorkerUrl(undefined, {})).toThrow(
      "must be explicitly defined",
    );
  });
});
