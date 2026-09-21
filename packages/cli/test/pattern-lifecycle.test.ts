// Drives the pattern-lifecycle client (lib/pattern-lifecycle.ts) against a
// stubbed fetch, so the wire contract the serving side verifies is
// exercised without a live toolshed: the request carries the CF1
// first-party proof headers, the body sent is the body signed, and a
// refusal comes back with the server's code and message.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { sha256 } from "@commonfabric/content-hash";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import {
  instantiatePieceOnServer,
  type LifecycleClientConfig,
  lifecycleUrl,
  ServedLifecycleError,
  setPieceSourceOnServer,
  wireProgram,
} from "../lib/pattern-lifecycle.ts";

const API_URL = new URL("http://pattern-lifecycle-test.invalid:9999/fabric/");
const SPACE_DID = "did:key:z6MkPatternLifecycleTestSpaceAAAAAAAAAAAAAAAAAAA";

const AUTH_HEADER = "CF-Request-Auth";
const PROOF_HEADER = "CF-Request-Proof";
const USER_DID_HEADER = "CF-User-DID";
const BODY_SHA256_HEADER = "CF-Request-Body-SHA256";

const PROGRAM = {
  main: "/main.tsx",
  mainExport: "default",
  files: [{ name: "/main.tsx", contents: "export default 1;" }],
};

interface RecordedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: string;
}

interface StubReply {
  status?: number;
  body?: unknown;
  raw?: string;
}

/**
 * Runs `fn` with `globalThis.fetch` replaced by a recorder that answers with
 * `reply`, and always puts the real fetch back.
 */
async function withStubbedFetch<T>(
  reply: StubReply,
  fn: (calls: RecordedRequest[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: RecordedRequest[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: new URL(typeof input === "string" ? input : input.toString()),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return Promise.resolve(
      new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
      }),
    );
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const bodySha256 = async (body: string): Promise<string> =>
  toUnpaddedBase64url(await sha256(new TextEncoder().encode(body)));

describe("pattern-lifecycle client", () => {
  let config: LifecycleClientConfig | undefined;

  const configured = async (): Promise<LifecycleClientConfig> => {
    config ??= { apiUrl: API_URL, identity: await Identity.generate() };
    return config;
  };

  describe("lifecycleUrl", () => {
    it("keeps the API base's own path ahead of the verb's", () => {
      expect(lifecycleUrl(API_URL, "instantiate").pathname).toBe(
        "/fabric/api/pattern-lifecycle/instantiate",
      );
      expect(
        lifecycleUrl(new URL("http://host.invalid"), "upload").pathname,
      ).toBe("/api/pattern-lifecycle/upload");
    });
  });

  describe("wireProgram", () => {
    it("carries the entry, its export, the files, the source roots, and the data files, and nothing else", () => {
      const carried = wireProgram({
        ...PROGRAM,
        sourceRoots: ["/main.test.tsx"],
        dataFiles: ["/data/cities.json"],
        // A field the wire does not take.
        extra: 1,
      } as never);
      expect(carried).toEqual({
        ...PROGRAM,
        sourceRoots: ["/main.test.tsx"],
        dataFiles: ["/data/cities.json"],
      });
    });
  });

  describe("instantiatePieceOnServer", () => {
    it("carries the same creation key across explicit retries", async () => {
      const cfg = await configured();
      await withStubbedFetch(
        { body: { pieceId: "p1", pattern: { identity: "i", symbol: "s" } } },
        async (calls) => {
          const input = {
            space: SPACE_DID,
            program: PROGRAM,
            requestKey: "stable-request",
          };
          await instantiatePieceOnServer(cfg, input);
          await instantiatePieceOnServer(cfg, input);
          expect(calls.map((call) => JSON.parse(call.body).requestKey)).toEqual(
            [
              "stable-request",
              "stable-request",
            ],
          );
        },
      );
    });

    it("signs the request with the identity and sends the bytes it signed", async () => {
      const cfg = await configured();
      await withStubbedFetch(
        { body: { pieceId: "p1", pattern: { identity: "i", symbol: "s" } } },
        async (calls) => {
          const receipt = await instantiatePieceOnServer(cfg, {
            space: SPACE_DID,
            program: PROGRAM,
            argument: { seed: 1 },
            repository: "https://example.invalid/repo",
          });
          expect(receipt.pieceId).toBe("p1");
          expect(calls).toHaveLength(1);
          const [call] = calls;
          expect(call.method).toBe("POST");
          expect(call.url.pathname).toBe(
            "/fabric/api/pattern-lifecycle/instantiate",
          );
          expect(call.headers.get(USER_DID_HEADER)).toBe(cfg.identity.did());
          expect(call.headers.get(AUTH_HEADER)).toMatch(/^CF1 /);
          expect(call.headers.get(PROOF_HEADER)).toMatch(/\S/);
          expect(call.headers.get(BODY_SHA256_HEADER)).toBe(
            await bodySha256(call.body),
          );
          expect(JSON.parse(call.body)).toEqual({
            space: SPACE_DID,
            program: PROGRAM,
            argument: { seed: 1 },
            repository: "https://example.invalid/repo",
          });
        },
      );
    });

    it("raises the server's refusal with its code, status, and message", async () => {
      const cfg = await configured();
      await withStubbedFetch(
        {
          status: 422,
          body: { error: "main.tsx:1 nope", code: "compile-failed" },
        },
        async () => {
          const failure = await instantiatePieceOnServer(cfg, {
            space: SPACE_DID,
            program: PROGRAM,
          }).then(() => undefined, (error) => error);
          expect(failure).toBeInstanceOf(ServedLifecycleError);
          expect(failure.code).toBe("compile-failed");
          expect(failure.status).toBe(422);
          expect(failure.message).toBe("main.tsx:1 nope");
        },
      );
    });

    it("names the status when the answer is not JSON", async () => {
      const cfg = await configured();
      await withStubbedFetch(
        { status: 502, raw: "<html>bad gateway</html>" },
        async () => {
          const failure = await instantiatePieceOnServer(cfg, {
            space: SPACE_DID,
            program: PROGRAM,
          }).then(() => undefined, (error) => error);
          expect(failure).toBeInstanceOf(ServedLifecycleError);
          expect(failure.code).toBe("http-502");
          expect(failure.message).toContain("instantiate failed (502)");
        },
      );
    });
  });

  describe("setPieceSourceOnServer", () => {
    it("signs the request, names the piece, and carries the override and the start flag only when set", async () => {
      const cfg = await configured();
      await withStubbedFetch(
        {
          body: {
            pieceId: "p1",
            pattern: { identity: "i", symbol: "s" },
            revisionId: "r1",
            seq: 7,
            detachedOrigin: null,
          },
        },
        async (calls) => {
          const receipt = await setPieceSourceOnServer(cfg, {
            space: SPACE_DID,
            piece: "p1",
            program: PROGRAM,
            repository: "https://example.invalid/repo",
          });
          expect(receipt.revisionId).toBe("r1");
          expect(receipt.seq).toBe(7);
          expect(calls).toHaveLength(1);
          const [call] = calls;
          expect(call.url.pathname).toBe(
            "/fabric/api/pattern-lifecycle/setsrc",
          );
          expect(call.headers.get(AUTH_HEADER)).toMatch(/^CF1 /);
          expect(call.headers.get(BODY_SHA256_HEADER)).toBe(
            await bodySha256(call.body),
          );
          expect(JSON.parse(call.body)).toEqual({
            space: SPACE_DID,
            piece: "p1",
            program: PROGRAM,
            repository: "https://example.invalid/repo",
          });
          await setPieceSourceOnServer(cfg, {
            space: SPACE_DID,
            piece: "p1",
            program: PROGRAM,
            dangerouslyAllowIncompatibleSchema: true,
            start: false,
          });
          expect(JSON.parse(calls[1].body)).toEqual({
            space: SPACE_DID,
            piece: "p1",
            program: PROGRAM,
            dangerouslyAllowIncompatibleSchema: true,
            start: false,
          });
        },
      );
    });

    it("raises the server's refusal with its code", async () => {
      const cfg = await configured();
      await withStubbedFetch(
        {
          status: 409,
          body: { error: "the piece moved", code: "source-moved" },
        },
        async () => {
          const failure = await setPieceSourceOnServer(cfg, {
            space: SPACE_DID,
            piece: "p1",
            program: PROGRAM,
          }).then(() => undefined, (error) => error);
          expect(failure).toBeInstanceOf(ServedLifecycleError);
          expect(failure.code).toBe("source-moved");
          expect(failure.status).toBe(409);
        },
      );
    });
  });
});
