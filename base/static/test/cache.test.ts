import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { StaticCache } from "../cache.ts";
import { generateETag } from "../etag.ts";
import { TEST_ASSET } from "../utils.ts";

const BASE = "https://assets.example/static";

describe("cache", () => {
  describe("StaticCache", () => {
    // Each case answers the cache's requests itself, so a base that is not a
    // `file:` URL reaches no network.

    const originalFetch = globalThis.fetch;
    let requested: string[];
    let respond: () => Response;

    beforeEach(() => {
      requested = [];
      respond = () => new Response("asset bytes");
      globalThis.fetch = (input) => {
        requested.push(String(input));
        return Promise.resolve(respond());
      };
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("fetches an asset from a base that is not a file, once", async () => {
      const cache = new StaticCache(new URL(BASE));

      const first = await cache.getWithETag(TEST_ASSET);
      const second = await cache.getWithETag(TEST_ASSET);

      expect(second).toBe(first);
      expect(requested).toEqual([`${BASE}/${TEST_ASSET}`]);
      expect(await first.blob.text()).toBe("asset bytes");
      expect(first.etag).toBe(
        await generateETag(new TextEncoder().encode("asset bytes")),
      );
    });

    it("rejects naming the asset and its location when the fetch fails", async () => {
      respond = () => new Response("missing", { status: 404 });
      const cache = new StaticCache(new URL(BASE));

      await expect(cache.get(TEST_ASSET)).rejects.toThrow(
        `Could not retrieve "${TEST_ASSET}" at "${BASE}/${TEST_ASSET}".`,
      );
    });

    it("throws for an asset the package does not ship, fetching nothing", () => {
      const cache = new StaticCache(new URL(BASE));

      expect(() => cache.getUrl("types/missing.d.ts")).toThrow(
        'No static asset "types/missing.d.ts" found.',
      );
      expect(requested).toEqual([]);
    });
  });
});
