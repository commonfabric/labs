import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import env from "@/env.ts";
import app from "@/app.ts";
import { ingestServiceSpace } from "@/routes/ingest/service-space.ts";
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

  const OTHER_SPACE = "did:key:z6MkaaaabbbbccccddddeeeeffffgggghhhhAAAA";

  const push = (init: RequestInit, space = ingestServiceSpace) =>
    app.request(`${BASE.replace(":space", space)}/gmail`, {
      method: "POST",
      ...init,
    });

  it("sits apart from the `/api/ingest/` prefix", () => {
    expect(BASE.split("/")).not.toContain("ingest");
  });

  it("returns 404 for a push addressed to a space other than the one holding the registry", async () => {
    const res = await push(
      { headers: { Authorization: "Bearer not-a-jwt" }, body: "{}" },
      OTHER_SPACE,
    );
    expect(res.status).toBe(404);
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
});
