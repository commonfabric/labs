import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createRouter } from "@/lib/create-app.ts";
import { ingestGate } from "./gate.ts";
import { SPACE_BASE } from "./ingest-channels.routes.ts";

describe("gate", () => {
  // The gate's ROUTING consequence: what the router does with the flag.
  //
  // This mounts the REAL `ingestGate`, the same function the Gmail push route
  // mounts first, with the flag passed in. Only the flag is a stub; the
  // middleware under test is production code.

  const build = (enabled: boolean) => {
    const seen: string[] = [];
    const router = createRouter();
    router.use(`${SPACE_BASE}/*`, ingestGate(enabled));
    router.use(`${SPACE_BASE}/*`, async (_c, next) => {
      seen.push("downstream");
      await next();
    });
    router.post(`${SPACE_BASE}/mint`, (c) => c.json({ ok: true }));
    return { router, seen };
  };

  const BASE = SPACE_BASE.replace(
    ":space",
    "did:key:z6MkaaaabbbbccccddddeeeeffffgggghhhhAAAA",
  );

  const spellings = [
    `${BASE}/mint`,
    `${BASE}/./mint`,
    `${BASE}/x/../mint`,
    `${BASE}/%6Dint`,
    `${BASE}/`,
    BASE,
  ];

  it("404s every spelling of every verb when disabled", async () => {
    const { router, seen } = build(false);
    for (const path of spellings) {
      const res = await router.request(`http://localhost${path}`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    }
    // Nothing downstream of the gate runs — not the body limit, not the rate
    // limiter, not signature verification.
    expect(seen).toEqual([]);
  });

  it("passes through to the handler when enabled", async () => {
    const { router, seen } = build(true);
    const res = await router.request(`http://localhost${BASE}/mint`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["downstream"]);
  });
});
