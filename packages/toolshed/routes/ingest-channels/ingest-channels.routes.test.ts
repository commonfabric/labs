import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import env from "@/env.ts";
import app from "@/app.ts";
import { CALLER_BASE, SPACE_BASE } from "./ingest-channels.routes.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

describe("Ingest channels route (transport + middleware)", () => {
  // Smoke tests for the mounted router. The authorization contract itself is
  // tested against a real ACL-enforcing memory server in
  // ingest-channels.utils.test.ts; what can only be checked HERE is the
  // middleware stack — which is the most novel part of this route package and
  // was otherwise asserted by nothing but a comment. NOTE: the rate limiters
  // are module-level in .index.ts, so every request in this file spends real
  // tokens from a bucket shared across the whole test process
  // (mint/rotate/revoke: capacity 10, refill 0.1/s). Adding many more requests
  // here will silently turn 401 expectations into 429s. Keep it small, or give
  // the new assertions their own verb.

  const BASE = SPACE_BASE.replace(
    ":space",
    "did:key:z6MkaaaabbbbccccddddeeeeffffgggghhhhAAAA",
  );

  const post = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      ...init,
    });

  it("rejects an unsigned request on every verb", async () => {
    for (const verb of ["mint", "list", "rotate", "revoke"]) {
      const res = await post(`${BASE}/${verb}`);
      expect(res.status).toBe(401);
    }
  });

  it("returns 401 for an unsigned request for the caller's own list", async () => {
    const res = await post(`${CALLER_BASE}/list`);
    expect(res.status).toBe(401);
  });

  it("returns 404 for a verb other than `list` at the prefix that names no space", async () => {
    for (const verb of ["mint", "rotate", "revoke", "gmail-bind"]) {
      const res = await post(`${CALLER_BASE}/${verb}`, {
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "10.8.0.1",
        },
      });
      expect(res.status).toBe(404);
    }
  });

  it("rejects a malformed request proof without reaching the handler", async () => {
    const res = await post(`${BASE}/mint`, {
      headers: {
        "Content-Type": "application/json",
        "CF-Request-Auth": "CF1 issued-at=1; valid-until=2; proof-did=x",
        "CF-Request-Proof": "not-base64url!!",
      },
    });
    expect(res.status).toBe(401);
  });

  it("caps an oversized body before authenticating it", async () => {
    // The body limit is mounted BEFORE the auth middleware on purpose:
    // signature verification buffers the whole body to hash it before it
    // verifies anything, so an unauthenticated caller must not be able to force
    // a large allocation. A 401 here would mean the cap ran too late.

    const res = await post(`${BASE}/mint`, { body: "x".repeat(64_000) });
    expect(res.status).toBe(413);
  });

  it("does not let a cross-origin POST through the preflight", async () => {
    // NOTE: an absent `access-control-allow-origin` is NOT the property to
    // assert, and believing it was is what this test caught. `routes/static`
    // and `routes/shell` both register `cors({ origin: "*" })` on `"*"` /
    // `"/*"`, which — because every router is mounted at `app.route("/", ...)`
    // — applies app-wide, including here. Not mounting `cors()` on this router
    // does not remove it.
    //
    // The property that actually holds is narrower, and it is the method: the
    // preflight answers `access-control-allow-methods: GET,OPTIONS` (and echoes
    // the requested headers, which is irrelevant once the method is refused),
    // so a browser blocks the cross-origin POST. Asserting the method is
    // asserting the real defense.

    const res = await app.request(`${BASE}/mint`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "cf-request-auth,cf-request-proof",
      },
    });
    const methods = res.headers.get("access-control-allow-methods") ?? "";
    expect(methods.toUpperCase()).not.toContain("POST");
  });

  it("does not shadow the data plane", () => {
    // Separate prefixes, not sub-paths: `/api/ingest/channels` would collide
    // with `POST /api/ingest/:id` and inherit its middleware, and so would an
    // `ingest` segment under a space.

    expect(CALLER_BASE.startsWith("/api/ingest/")).toBe(false);
    expect(SPACE_BASE.split("/")).not.toContain("ingest");
  });
});
