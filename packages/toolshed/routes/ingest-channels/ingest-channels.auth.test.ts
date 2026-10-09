import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import env from "@/env.ts";
import app from "@/app.ts";
import { CALLER_BASE, SPACE_BASE } from "./ingest-channels.routes.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

describe("Ingest channels route (authenticated)", () => {
  // The POSITIVE auth path, which nothing else covers: a genuinely signed
  // first-party request reaching a handler. Everything before this asserted
  // only that bad requests are rejected — "the real thing is accepted" is the
  // half that actually has to work.
  //
  // Under test the `runtime` singleton these handlers import is uninitialized,
  // so any path touching storage answers 502. That is itself the storage-error
  // contract, and it proves the request cleared the signature check, the rate
  // limiter, and body validation to get there. The authorization logic proper
  // is tested against a real ACL-enforcing memory server in
  // ingest-channels.utils.test.ts.

  // A distinct client per request: the limiters are module-level, so sharing a
  // key across tests turns a later 502 expectation into a 429.
  let clientCounter = 0;

  const BASE = SPACE_BASE.replace(
    ":space",
    "did:key:z6MkaaaabbbbccccddddeeeeffffgggghhhhAAAA",
  );

  const signedRequest = async (
    verb: string,
    payload: unknown,
    base = BASE,
  ) => {
    const identity = await Identity.generate();
    const url = new URL(`${base}/${verb}`, "http://localhost");
    const body = JSON.stringify(payload);
    const headers = await signFirstPartyHttpRequest({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": `10.0.0.${++clientCounter}`,
      },
      body,
      signer: identity,
    });
    return await app.request(url.toString(), {
      method: "POST",
      headers,
      body,
    });
  };

  it("accepts a validly signed mint and reaches the handler", async () => {
    const res = await signedRequest("mint", {
      installId: "phone-1",
      requestId: crypto.randomUUID(),
    });
    // Not 401: the signature was accepted. Not 429: the limiter let it by.
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(429);
    expect([403, 502]).toContain(res.status);
  });

  it("accepts a validly signed list", async () => {
    const res = await signedRequest("list", {}, CALLER_BASE);
    expect(res.status).not.toBe(401);
    expect([200, 502]).toContain(res.status);
  });

  it("returns a status other than 401 for a validly signed list of one space", async () => {
    const res = await signedRequest("list", {});
    expect(res.status).not.toBe(401);
    expect([403, 502]).toContain(res.status);
  });

  it("returns 422 for a signed request for the caller's own list that names a space", async () => {
    // That body is strict. A `space` sent there would otherwise be dropped,
    // and the caller handed its own list in place of the one it asked for.

    const res = await signedRequest(
      "list",
      { space: "did:key:z6MkaaaabbbbccccddddeeeeffffgggghhhhAAAA" },
      CALLER_BASE,
    );
    expect(res.status).toBe(422);
  });

  it("accepts a validly signed rotate and revoke", async () => {
    for (const verb of ["rotate", "revoke"]) {
      const res = await signedRequest(verb, {
        id: "ing_whatever",
        requestId: crypto.randomUUID(),
        ...(verb === "revoke" ? { expectedRevision: 1 } : {}),
      });
      expect(res.status).not.toBe(401);
      expect([403, 502]).toContain(res.status);
    }
  });

  it("rejects a signed revoke that omits requestId", async () => {
    // The revoke replay defense is only as strong as the request id being part
    // of what was signed. If the field were optional, a captured revoke would
    // carry no id to spend and the middle box could add its own.

    const res = await signedRequest("revoke", {
      id: "ing_whatever",
      expectedRevision: 1,
    });
    expect(res.status).toBe(422);
  });

  it("rejects a signed revoke that omits expectedRevision", async () => {
    // The generation binding is the half that stops a captured-and-withheld
    // revoke, so it has to be part of what was signed rather than something a
    // middle box can supply or drop.

    const res = await signedRequest("revoke", {
      id: "ing_whatever",
      requestId: crypto.randomUUID(),
    });
    expect(res.status).toBe(422);
  });

  it("rejects a signed request whose body fails schema validation", async () => {
    // Request validation runs after auth, so a signed request with a bad body
    // is the only way to reach schema validation at all. stoker's `defaultHook`
    // answers 422 for a zod failure, not 400.

    const res = await signedRequest("mint", { installId: "phone-1" });
    expect(res.status).toBe(422);
  });

  it("rejects a signed request whose body was altered after signing", async () => {
    // Tamper: the proof commits to the body hash, so changing the body after
    // signing must not verify.

    const identity = await Identity.generate();
    const url = new URL(`${CALLER_BASE}/list`, "http://localhost");
    const headers = await signFirstPartyHttpRequest({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": `10.0.1.${++clientCounter}`,
      },
      body: JSON.stringify({}),
      signer: identity,
    });
    const res = await app.request(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({ space: "did:key:zTampered" }),
    });
    expect(res.status).toBe(401);
  });
});
