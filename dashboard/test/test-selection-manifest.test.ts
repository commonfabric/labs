import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  sampleManifest,
  serializeManifest,
} from "@commonfabric/test-support/records";

import {
  newestManifest,
  TEST_SELECTION_PREFIX,
} from "../test-selection-manifest.ts";

describe("test-selection-manifest", () => {
  it("reads the public store with default settings and reports an empty listing", async () => {
    const prefix = TEST_SELECTION_PREFIX;
    const generatedAt = "2026-09-15T04:00:00.000Z";
    const name = `${prefix}manifest-${generatedAt}-latest.json.gz`;
    const expected = sampleManifest({ generatedAt });
    let available = true;

    using _fetch = stub(globalThis, "fetch", (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(request.headers.has("authorization")).toBe(false);
      expect(url.origin).toBe("https://storage.googleapis.com");
      if (url.pathname === "/storage/v1/b/cf-ci-metadata/o") {
        expect(url.searchParams.get("prefix")).toBe(prefix);
        return Promise.resolve(Response.json({
          items: available ? [{ name }] : [],
        }));
      }
      expect(decodeURIComponent(url.pathname)).toBe(`/cf-ci-metadata/${name}`);
      expect(available).toBe(true);
      return Promise.resolve(new Response(serializeManifest(expected)));
    });

    expect(await newestManifest()).toEqual(expected);
    available = false;
    expect(await newestManifest()).toBeUndefined();
  });
});
