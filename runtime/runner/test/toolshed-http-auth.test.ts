import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { sha256 } from "@commonfabric/content-hash";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import {
  FIRST_PARTY_HTTP_AUTH_HEADERS,
  isProtectedToolshedFirstPartyRoute,
  isToolshedApiOrigin,
  signFirstPartyHttpRequest,
  verifyFirstPartyHttpRequest,
} from "../src/toolshed-http-auth.ts";

const NOW_SECONDS = 1_800_000_000;
const signer = await Identity.fromPassphrase("toolshed http auth test");
const textEncoder = new TextEncoder();

async function signedRequest(
  url: string,
  init: RequestInit = {},
  options: { nowSeconds?: number; validForSeconds?: number } = {},
): Promise<Request> {
  const method = init.method ?? "POST";
  const headers = await signFirstPartyHttpRequest({
    url: new URL(url),
    method,
    headers: init.headers,
    body: init.body,
    signer,
    nowSeconds: options.nowSeconds ?? NOW_SECONDS,
    validForSeconds: options.validForSeconds,
  });
  return new Request(url, { ...init, method, headers });
}

async function expectAuthReject(
  request: Request,
  expectedMessage?: string,
): Promise<void> {
  let error: unknown;
  try {
    await verifyFirstPartyHttpRequest({
      request,
      nowSeconds: NOW_SECONDS,
    });
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof Error)) {
    throw new Error("expected first-party auth rejection");
  }
  if (expectedMessage !== undefined) {
    expect(error.message).toBe(expectedMessage);
  }
}

async function expectSignReject(
  params: Parameters<typeof signFirstPartyHttpRequest>[0],
  expectedMessage?: string,
): Promise<void> {
  let error: unknown;
  try {
    await signFirstPartyHttpRequest(params);
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof Error)) {
    throw new Error("expected first-party signing rejection");
  }
  if (expectedMessage !== undefined) {
    expect(error.message).toBe(expectedMessage);
  }
}

function expectUnpaddedBase64url(value: string | null): void {
  expect(value).toBeTruthy();
  expect(/^[A-Za-z0-9_-]+$/.test(value!)).toBe(true);
  expect(value).not.toContain("=");
}

function validAuthHeader(did: string = signer.did()): string {
  return `CF1 issued-at=${NOW_SECONDS}; valid-until=${
    NOW_SECONDS + 60
  }; proof-did=${encodeURIComponent(did)}; proof-kind=ed25519`;
}

function requestWithAuth(
  auth: string,
  headers: HeadersInit = {},
): Request {
  return new Request("http://toolshed.test/api/agent-tools/web-search", {
    method: "POST",
    headers: {
      [FIRST_PARTY_HTTP_AUTH_HEADERS.auth]: auth,
      [FIRST_PARTY_HTTP_AUTH_HEADERS.proof]: "AA",
      ...headers,
    },
  });
}

describe("first-party toolshed HTTP request proofs", () => {
  it("identifies protected first-party toolshed routes", () => {
    expect(isProtectedToolshedFirstPartyRoute(
      new URL("http://toolshed.test/api/agent-tools/web-search"),
      "POST",
    )).toBe(true);
    expect(isProtectedToolshedFirstPartyRoute(
      new URL("http://toolshed.test/api/agent-tools/web-read/"),
      "post",
    )).toBe(true);
    expect(isProtectedToolshedFirstPartyRoute(
      new URL("http://toolshed.test/api/agent-tools/web-search"),
      "GET",
    )).toBe(false);
    expect(isProtectedToolshedFirstPartyRoute(
      new URL("http://toolshed.test/api/agent-tools/not-protected"),
      "POST",
    )).toBe(false);
  });

  it("identifies the toolshed API origin", () => {
    const apiBase = new URL("https://toolshed.example/api/");

    expect(isToolshedApiOrigin(
      new URL("https://toolshed.example/api/agent-tools/web-search"),
      apiBase,
    )).toBe(true);
    expect(isToolshedApiOrigin(
      new URL("https://other.example/api/agent-tools/web-search"),
      apiBase,
    )).toBe(false);
  });

  it("accepts a POST with a covered body hash", async () => {
    const body = JSON.stringify({ query: "hello" });
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search?q=1",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Signature": "bogus",
          "Signature-Input": "bogus",
          "Content-Digest": "bogus",
        },
        body,
      },
    );

    const verified = await verifyFirstPartyHttpRequest({
      request,
      nowSeconds: NOW_SECONDS,
    });

    expect(verified.userDid).toBe(signer.did());
    expect(request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth))
      .toBeTruthy();
    expectUnpaddedBase64url(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.proof),
    );
    expectUnpaddedBase64url(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256),
    );
    expect(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256),
    ).toBe(toUnpaddedBase64url(sha256(textEncoder.encode(body))));
    expect(request.headers.get("Signature")).toBe(null);
    expect(request.headers.get("Signature-Input")).toBe(null);
    expect(request.headers.get("Content-Digest")).toBe(null);
    expect(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth),
    ).toContain("issued-at=");
    expect(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth),
    ).toContain("valid-until=");
    expect(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth),
    ).toContain("proof-did=");
    expect(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth),
    ).toContain("proof-kind=");
    expect(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth),
    ).not.toContain("created=");
    expect(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth),
    ).not.toContain("expires=");
    expect(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth),
    ).not.toContain("alg=");
  });

  it("rejects requests without a proof", async () => {
    await expectAuthReject(
      new Request("http://toolshed.test/api/agent-tools/web-search", {
        method: "POST",
        body: "{}",
      }),
    );
  });

  it("accepts requests without a body hash when the request has no body", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      { method: "POST" },
    );

    const verified = await verifyFirstPartyHttpRequest({
      request,
      nowSeconds: NOW_SECONDS,
    });

    expect(verified.userDid).toBe(signer.did());
    expect(request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256))
      .toBe(null);
  });

  it("accepts supported body input types", async () => {
    const cases: BodyInit[] = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]).buffer,
      new Uint16Array([0x0708, 0x090a]),
      new URLSearchParams({ q: "hello", page: "1" }),
      new Blob([new Uint8Array([10, 11, 12])]),
    ];

    for (const body of cases) {
      const request = await signedRequest(
        "http://toolshed.test/api/agent-tools/web-search",
        { method: "POST", body },
      );

      const verified = await verifyFirstPartyHttpRequest({
        request,
        nowSeconds: NOW_SECONDS,
      });

      expect(verified.userDid).toBe(signer.did());
      expect(request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256))
        .toBeTruthy();
    }
  });

  it("rejects unsupported body input types before signing", async () => {
    let signCalled = false;
    await expectSignReject({
      url: new URL("http://toolshed.test/api/agent-tools/web-search"),
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }) as BodyInit,
      signer: {
        did: () => signer.did(),
        sign: () => {
          signCalled = true;
          return { ok: new Uint8Array() };
        },
      },
      nowSeconds: NOW_SECONDS,
    }, "unsupported authenticated request body type");
    expect(signCalled).toBe(false);
  });

  it("rejects requests whose body cannot be read for verification", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        body: "{}",
      },
    );
    await request.text();

    await expectAuthReject(request);
  });

  it("rejects a tampered method", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );

    await expectAuthReject(
      new Request(request.url, {
        method: "PUT",
        headers: request.headers,
        body: "{}",
      }),
    );
  });

  it("rejects a tampered authority", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        body: "{}",
      },
    );

    await expectAuthReject(
      new Request("http://other.test/api/agent-tools/web-search", {
        method: "POST",
        headers: request.headers,
        body: "{}",
      }),
    );
  });

  it("rejects a tampered path", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        body: "{}",
      },
    );

    await expectAuthReject(
      new Request("http://toolshed.test/api/agent-tools/web-read", {
        method: "POST",
        headers: request.headers,
        body: "{}",
      }),
    );
  });

  it("rejects a tampered query string", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search?x=1",
      {
        method: "POST",
        body: "{}",
      },
    );

    await expectAuthReject(
      new Request("http://toolshed.test/api/agent-tools/web-search?x=2", {
        method: "POST",
        headers: request.headers,
        body: "{}",
      }),
    );
  });

  it("rejects a tampered body hash", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "original" }),
      },
    );

    await expectAuthReject(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({ query: "changed" }),
      }),
    );
  });

  it("rejects a body when the body hash header is missing", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        body: "{}",
      },
    );
    const headers = new Headers(request.headers);
    headers.delete(FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256);

    await expectAuthReject(
      new Request(request.url, {
        method: "POST",
        headers,
        body: "{}",
      }),
    );
  });

  it("rejects padded proof values", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        body: "{}",
      },
    );
    const headers = new Headers(request.headers);
    headers.set(
      FIRST_PARTY_HTTP_AUTH_HEADERS.proof,
      `${headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.proof)}=`,
    );

    await expectAuthReject(
      new Request(request.url, {
        method: "POST",
        headers,
        body: "{}",
      }),
    );
  });

  it("rejects proof values that are not decodable base64url", async () => {
    await expectAuthReject(
      requestWithAuth(validAuthHeader(), {
        [FIRST_PARTY_HTTP_AUTH_HEADERS.userDid]: signer.did(),
        [FIRST_PARTY_HTTP_AUTH_HEADERS.proof]: "A",
      }),
      "request proof is not valid unpadded base64url",
    );
  });

  it("rejects malformed auth metadata", async () => {
    const cases = [
      {
        auth: "CF2 issued-at=1",
        message: "request auth metadata has an unknown version",
      },
      {
        auth: "CF1 issued-at",
        message: "request auth metadata is malformed",
      },
      {
        auth: "CF1 issued-at=",
        message: "request auth metadata is malformed",
      },
      {
        auth: `${validAuthHeader()}; nonce=1`,
        message: "request auth metadata has an unknown field",
      },
      {
        auth:
          `CF1 issued-at=${NOW_SECONDS}; issued-at=${NOW_SECONDS}; valid-until=${
            NOW_SECONDS + 60
          }; proof-did=${encodeURIComponent(signer.did())}; proof-kind=ed25519`,
        message: "request auth metadata has a duplicate field",
      },
      {
        auth: `CF1 issued-at=soon; valid-until=${NOW_SECONDS + 60}; proof-did=${
          encodeURIComponent(signer.did())
        }; proof-kind=ed25519`,
        message: "request auth freshness fields must be integers",
      },
      {
        auth: `CF1 issued-at=${NOW_SECONDS}; valid-until=${
          NOW_SECONDS + 60
        }; proof-did=${encodeURIComponent(signer.did())}`,
        message: "request auth metadata is missing required fields",
      },
      {
        auth: `CF1 issued-at=${NOW_SECONDS}; valid-until=${
          NOW_SECONDS + 60
        }; proof-did=%E0%A4%A; proof-kind=ed25519`,
        message: "request auth metadata has invalid encoding",
      },
    ];

    for (const { auth, message } of cases) {
      await expectAuthReject(requestWithAuth(auth), message);
    }
  });

  it("rejects invalid proof metadata after auth metadata parses", async () => {
    await expectAuthReject(
      requestWithAuth(
        validAuthHeader().replace("proof-kind=ed25519", "proof-kind=rsa"),
        { [FIRST_PARTY_HTTP_AUTH_HEADERS.userDid]: signer.did() },
      ),
      "unsupported first-party proof algorithm",
    );

    await expectAuthReject(
      requestWithAuth(validAuthHeader("did:web:example"), {
        [FIRST_PARTY_HTTP_AUTH_HEADERS.userDid]: "did:web:example",
      }),
      "first-party auth DID must be a did:key",
    );

    await expectAuthReject(
      requestWithAuth(validAuthHeader(), {
        [FIRST_PARTY_HTTP_AUTH_HEADERS.userDid]: "did:key:other",
      }),
      "proof user DID does not match request auth DID",
    );
  });

  it("rejects expired proofs", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        body: "{}",
      },
      { nowSeconds: NOW_SECONDS - 120 },
    );

    await expectAuthReject(request);
  });

  it("rejects proofs issued too far in the future", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        body: "{}",
      },
      { nowSeconds: NOW_SECONDS + 120 },
    );

    await expectAuthReject(request);
  });

  it("rejects proofs whose valid-until is not after issued-at", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        body: "{}",
      },
      { validForSeconds: 0 },
    );

    await expectAuthReject(request);
  });

  it("rejects a replay across a different protected route", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/sandbox/exec",
      {
        method: "POST",
        body: "{}",
      },
    );

    await expectAuthReject(
      new Request("http://toolshed.test/api/agent-tools/web-search", {
        method: "POST",
        headers: request.headers,
        body: "{}",
      }),
    );
  });

  it("rejects proofs with excessive lifetime", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        body: "{}",
      },
      { validForSeconds: 600 },
    );

    await expectAuthReject(request);
  });

  it("rejects invalid signers and signer failures", async () => {
    await expectSignReject({
      url: new URL("http://toolshed.test/api/agent-tools/web-search"),
      method: "POST",
      signer: {
        did: () => "did:web:example",
        sign: () => ({ ok: new Uint8Array() }),
      },
      nowSeconds: NOW_SECONDS,
    }, "first-party HTTP authentication requires did:key signers");

    await expectSignReject({
      url: new URL("http://toolshed.test/api/agent-tools/web-search"),
      method: "POST",
      signer: {
        did: () => signer.did(),
        sign: () => ({ error: new Error("signing failed") }),
      },
      nowSeconds: NOW_SECONDS,
    }, "signing failed");
  });
});
