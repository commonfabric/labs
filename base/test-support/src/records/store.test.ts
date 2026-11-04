import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assert } from "@std/assert";

import { createObject, gunzipToText, gzipChunks, gzipText } from "./store.ts";

function fetchStub(
  status: number,
  onRequest?: (url: string, init: RequestInit) => void,
): typeof fetch {
  return ((input: URL | RequestInfo, init?: RequestInit) => {
    onRequest?.(String(input), init ?? {});
    return Promise.resolve(
      new Response(status === 200 ? "{}" : "denied", { status }),
    );
  }) as typeof fetch;
}

describe("store", () => {
  describe("gzipText()", () => {
    it("round-trips through gunzipToText()", async () => {
      const text = '{"line":"context"}\n{"line":"record"}\n';
      expect(await gunzipToText(await gzipText(text))).toBe(text);
    });
  });

  describe("gzipChunks()", () => {
    it("compresses a sequence into one member", async () => {
      const bytes = await gzipChunks(["one\n", "two\n", "three\n"]);
      expect(await gunzipToText(bytes)).toBe("one\ntwo\nthree\n");
    });

    it("takes chunks from an asynchronous source", async () => {
      async function* source() {
        yield await Promise.resolve("one\n");
        yield await Promise.resolve("two\n");
      }
      expect(await gunzipToText(await gzipChunks(source()))).toBe("one\ntwo\n");
    });

    it("builds an object larger than a string can be", async () => {
      // 600 MiB of record lines, against V8's limit of a little under 512
      // MiB per string. Compressing the chunks as they arrive holds one
      // chunk at a time; taking the same text back as one string is what
      // the limit stops, which is what the second half asserts.
      const line = '{"line":"record","test":{"k":"unit","s":"bakery",' +
        '"n":"glaze > sets"},"outcome":"pass","durationMs":4}\n';
      const chunk = line.repeat(640);
      const chunks = (600 * 1024 * 1024) / chunk.length;
      function* source() {
        for (let at = 0; at < chunks; at++) yield chunk;
      }
      const bytes = await gzipChunks(source());
      await expect(gunzipToText(bytes)).rejects.toThrow(RangeError);
    });
  });

  describe("createObject()", () => {
    it("returns created and sends a guarded multipart create", async () => {
      let seenUrl = "";
      let seenBody: Uint8Array | undefined;
      let seenHeaders: Record<string, string> = {};
      const result = await createObject({
        bucket: "cf-ci-metadata",
        name: "labs/test-records/submissions/ci/v1/2026/08/17/x.ndjson",
        body: new TextEncoder().encode("payload-bytes"),
        token: "token-123",
        contentType: "application/x-ndjson",
        contentEncoding: "gzip",
        fetch: fetchStub(200, (url, init) => {
          seenUrl = url;
          seenBody = init.body as Uint8Array;
          seenHeaders = init.headers as Record<string, string>;
        }),
      });
      expect(result).toBe("created");
      expect(seenUrl).toContain("/b/cf-ci-metadata/o");
      expect(seenUrl).toContain("uploadType=multipart");
      expect(seenUrl).toContain("ifGenerationMatch=0");
      expect(seenHeaders.authorization).toBe("Bearer token-123");
      assert(seenBody);
      const bodyText = new TextDecoder().decode(seenBody);
      expect(bodyText).toContain('"contentEncoding":"gzip"');
      expect(bodyText).toContain(
        '"name":"labs/test-records/submissions/ci/v1/2026/08/17/x.ndjson"',
      );
      expect(bodyText).toContain("payload-bytes");
    });

    it("returns exists on a precondition failure", async () => {
      const result = await createObject({
        bucket: "b",
        name: "n",
        body: new Uint8Array(0),
        token: "t",
        fetch: fetchStub(412),
      });
      expect(result).toBe("exists");
    });

    it("throws on any other error status", async () => {
      await expect(createObject({
        bucket: "b",
        name: "n",
        body: new Uint8Array(0),
        token: "t",
        fetch: fetchStub(403),
      })).rejects.toThrow("HTTP 403");
    });
  });
});
