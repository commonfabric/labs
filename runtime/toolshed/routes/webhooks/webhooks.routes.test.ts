/**
 * Smoke tests: confirm each route is mounted and its first-line validation
 * returns a sensible error. These deliberately hit only the fast-fail paths
 * (bad input / missing auth) that reject *before* any runtime/storage access,
 * so they need no runtime fixture. End-to-end delivery is covered separately.
 *
 * Driven through the real `app`, to show the router `webhooks.index.ts` builds
 * is mounted. The handlers against a real runtime are tested in
 * webhooks.handlers.test.ts.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import env from "@/env.ts";
import app from "@/app.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

describe("Webhook routes (smoke: wired up + error paths)", () => {
  it("POST /api/webhooks rejects an invalid cellLink with 400", async () => {
    const res = await app.request("/api/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        cellLink: "not-a-cell-link",
        confidentialCellLink: "fcl1:{}",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/webhooks rejects a malformed body with 422", async () => {
    const res = await app.request("/api/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Missing `cellLink` and `confidentialCellLink` -> schema validation.
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /api/webhooks/:id without a bearer token is 401", async () => {
    const res = await app.request("/api/webhooks/wh_nope", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ any: "payload" }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/webhooks without a space is rejected (422)", async () => {
    const res = await app.request("/api/webhooks", { method: "GET" });
    expect(res.status).toBe(422);
  });

  it("DELETE /api/webhooks/:id without a space is rejected (422)", async () => {
    const res = await app.request("/api/webhooks/wh_nope", {
      method: "DELETE",
    });
    expect(res.status).toBe(422);
  });
});
