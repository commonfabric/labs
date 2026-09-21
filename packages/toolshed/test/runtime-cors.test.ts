import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import meta from "@/routes/meta/meta.index.ts";

describe("runtime-cors", () => {
  it("serves public runtime metadata to an independent browser origin without credentials", async () => {
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: () => {},
    }, (request) => meta.fetch(request));
    try {
      const url = `http://127.0.0.1:${server.addr.port}/api/meta`;
      const response = await fetch(url, {
        headers: { Origin: "https://shell.example" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.has("access-control-allow-credentials")).toBe(
        false,
      );
      expect((await response.json()).did).toMatch(/^did:key:/);
      const preflight = await fetch(url, {
        method: "OPTIONS",
        headers: {
          Origin: "https://shell.example",
          "Access-Control-Request-Method": "GET",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-methods")).toContain(
        "GET",
      );
      await preflight.body?.cancel();
    } finally {
      await server.shutdown();
    }
  });
});
