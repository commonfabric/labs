import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { servingRuntimeFactory } from "../../src/executor/serving-runtime.ts";
import type { RuntimeFetch } from "../../src/runtime.ts";
import { newLoopbackServer } from "../../src/storage/v2-emulate.ts";

describe("servingRuntimeFactory fetch", () => {
  it("gives each serving runtime the fetch it was handed, and the platform fetch otherwise", async () => {
    // Toolshed hands the factory a fetch that sends requests addressed to
    // its public origin to its own listener (API_INTERNAL_URL). Every source
    // load and network builtin of a serving runtime goes through
    // `runtime.fetch`, so this is the one seam that decides where they are
    // sent; `apiUrl` is left as the public origin it records and compares.
    const service = await Identity.fromPassphrase("serving-runtime-fetch");
    const space = (await Identity.fromPassphrase("space")).did() as MemorySpace;
    const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    const apiUrl = new URL("https://public.example/");
    const fetch: RuntimeFetch = () => Promise.resolve(new Response("own"));
    try {
      const handed = await servingRuntimeFactory({
        server,
        identity: service,
        apiUrl,
        fetch,
      })(space, {});
      try {
        expect(handed.runtime.fetch).toBe(fetch);
        expect(handed.runtime.apiUrl.href).toBe(apiUrl.href);
      } finally {
        await handed.dispose();
      }
      const platform = await servingRuntimeFactory({
        server,
        identity: service,
        apiUrl,
      })(space, {});
      try {
        expect(platform.runtime.fetch).not.toBe(fetch);
        expect(platform.runtime.apiUrl.href).toBe(apiUrl.href);
      } finally {
        await platform.dispose();
      }
    } finally {
      await server.close();
    }
  });
});
