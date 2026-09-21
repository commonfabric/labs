import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { fromFileUrl } from "@std/path";
import { aclDocId } from "@commonfabric/memory/acl";
import { Server } from "@commonfabric/memory/v2/server";
import { verifySessionOpenAuthorization } from "@commonfabric/memory/v2/session-open-auth";
import { resolveSpaceStoreUrl } from "@commonfabric/memory/v2/storage-path";
import {
  startServerExecutionHost,
  stopServerExecutionHost,
} from "@/lib/server-execution.ts";
import { memoryEngineStoreUrl, memoryServer } from "@/routes/storage/memory.ts";
import { Identity } from "@commonfabric/identity";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import env from "@/env.ts";
import app from "@/app.ts";
import { createRouter } from "@/lib/create-app.ts";
import { createRateLimiter, rateLimit } from "@/middlewares/rate-limit.ts";
import { BASE, MAX_BODY_BYTES } from "./pattern-lifecycle.routes.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

describe("pattern-lifecycle route (transport + middleware)", () => {
  // The mounted router's middleware stack: what runs before a handler and
  // in what order. The verbs themselves are tested against a real serving
  // host in pattern-lifecycle.utils.test.ts. The rate limiter is
  // module-level and keyed by client address, so each signed request below
  // names a distinct address.

  let clientCounter = 0;

  const post = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      ...init,
    });

  const signedRequest = async (verb: string, payload: unknown) => {
    const identity = await Identity.generate();
    const url = new URL(`${BASE}/${verb}`, "http://localhost");
    const body = JSON.stringify(payload);
    const headers = await signFirstPartyHttpRequest({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": `10.1.0.${++clientCounter}`,
      },
      body,
      signer: identity,
    });
    return await app.request(url.toString(), { method: "POST", headers, body });
  };

  it("rejects an unsigned request on every verb", async () => {
    for (const verb of ["upload", "instantiate", "setsrc"]) {
      const res = await post(`${BASE}/${verb}`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: "Unauthorized",
        code: "unauthorized",
      });
    }
  });

  it("caps an oversized body before authenticating it", async () => {
    const res = await post(`${BASE}/instantiate`, {
      body: "x".repeat(MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
  });

  it("accepts a validly signed request and answers for the deployment's posture", async () => {
    // Under test no serving host runs, so a request that cleared the
    // signature check, the limiter, and body validation is answered with
    // the route's own 503 rather than by anything downstream.
    const res = await signedRequest("instantiate", {
      space: "did:key:z6MkaaaabbbbccccddddeeeeffffgggghhhhAAAA",
      program: { main: "/main.tsx", files: [] },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: expect.stringContaining("serving loop"),
      code: "server-execution-off",
    });
  });

  it("routes a signed setsrc to its handler, which answers for the posture too", async () => {
    const res = await signedRequest("setsrc", {
      space: "did:key:z6MkaaaabbbbccccddddeeeeffffgggghhhhAAAA",
      piece: "fid1:piece",
      program: { main: "/main.tsx", files: [] },
    });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("server-execution-off");
  });

  it("routes a signed upload to its handler, which answers for the posture too", async () => {
    const res = await signedRequest("upload", {
      space: "did:key:z6MkaaaabbbbccccddddeeeeffffgggghhhhAAAA",
      program: { main: "/main.tsx", files: [] },
    });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("server-execution-off");
  });

  it("refuses an over-budget caller with the rate limiter's own code", async () => {
    // The limiter as this router mounts it, over a bucket of one token and a
    // frozen clock, so the second post is the refused one whatever the box
    // is doing: a timing-dependent test of a rate limiter is flaky by
    // construction (lib/rate-limit.ts).
    const router = createRouter();
    router.use(
      "/limited/*",
      rateLimit(
        createRateLimiter({ capacity: 1, refillPerSecond: 0, now: () => 0 }),
        { code: "rate-limited" },
      ),
    );
    router.post("/limited/verb", (c) => c.json({ ok: true }, 200));
    const send = () =>
      router.request("/limited/verb", {
        method: "POST",
        headers: { "X-Forwarded-For": "10.2.0.1" },
      });
    expect((await send()).status).toBe(200);
    const refused = await send();
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "Too many requests",
      code: "rate-limited",
    });
  });

  it("reads the hosted ACL through the memory service before refusing a read-only caller", async () => {
    const space = (await Identity.generate()).did();
    const owner = await Identity.generate();
    const isolated = new Server({
      store: new URL(`memory://route-acl-${crypto.randomUUID()}`),
      authorizeSessionOpen: verifySessionOpenAuthorization,
      sessionOpenAuth: { audience: owner.did() },
    });
    const file = await Deno.makeTempFile();
    const fileInfo = await Deno.stat(file);
    const storePath = fromFileUrl(
      resolveSpaceStoreUrl(memoryEngineStoreUrl, space),
    );
    const stat = Deno.statSync.bind(Deno);
    using _hosted = stub(
      Deno,
      "statSync",
      (path) => String(path) === storePath ? fileInfo : stat(path),
    );
    using read = stub(memoryServer, "readDocument", (target, id) => {
      expect(target).toBe(space);
      expect(id).toBe(aclDocId(space));
      return Promise.resolve({
        value: { [owner.did()]: "OWNER", "*": "READ" },
      });
    });
    try {
      startServerExecutionHost({
        server: isolated,
        identity: owner,
        apiUrl: new URL("http://route-acl.invalid"),
        envGet: (name) =>
          name === "EXPERIMENTAL_SERVER_EXECUTION"
            ? "true"
            : name === "SERVER_EXECUTION_ENSURE_SPACE_ROOTS"
            ? "false"
            : undefined,
      });
      const response = await signedRequest("upload", {
        space,
        program: { main: "/main.tsx", files: [] },
      });
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe("forbidden");
      expect(read.calls).toHaveLength(1);
    } finally {
      await stopServerExecutionHost();
      await isolated.close();
      await Deno.remove(file);
    }
  });

  it("rejects a signed request whose body fails schema validation", async () => {
    const res = await signedRequest("upload", { space: "did:key:z6Mk" });
    expect(res.status).toBe(422);
  });
});
