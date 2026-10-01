import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import env from "@/env.ts";
import app from "@/app.ts";
import { BASE } from "./ingest-push.routes.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

describe("ingest-push.routes", () => {
  // Driven through the real `app`, to show the routes are mounted with their
  // middleware. None of these requests carries a token that could verify, so
  // none reaches storage or fetches Google's keys; the verification and
  // delivery rules are tested against a real runtime in
  // gmail-push.utils.test.ts.

  const push = (init: RequestInit) =>
    app.request(`${BASE}/gmail`, { method: "POST", ...init });

  it("sits apart from the `/api/ingest/` prefix", () => {
    expect(BASE.startsWith("/api/ingest/")).toBe(false);
  });

  it("returns 401 for a push without a bearer token", async () => {
    const res = await push({ body: "{}" });
    expect(res.status).toBe(401);
  });

  it("returns 401 for a push whose bearer token is not a JWT", async () => {
    const res = await push({
      headers: { Authorization: "Bearer not-a-jwt" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("returns 413 for an oversized body before verifying anything", async () => {
    const res = await push({
      headers: { Authorization: "Bearer not-a-jwt" },
      body: "x".repeat(20_000),
    });
    expect(res.status).toBe(413);
  });

  it("returns 401 for an unsigned `gmail-bind` request", async () => {
    const res = await app.request("/api/ingest-channels/gmail-bind", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "10.9.0.1",
      },
      body: JSON.stringify({ id: "ing_x", accessToken: "t", requestId: "r" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an unsigned `gmail-unbind` request", async () => {
    const res = await app.request("/api/ingest-channels/gmail-unbind", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "10.9.0.2",
      },
      body: JSON.stringify({ id: "ing_x", requestId: "r" }),
    });
    expect(res.status).toBe(401);
  });
});
