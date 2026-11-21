// Flat `Deno.test` cases: this package's tests also run in a browser through
// `deno-web-test`, which does not support `@std/testing/bdd`.

import { expect } from "@std/expect";

import { StaticCache } from "../cache.ts";
import { generateETag } from "../etag.ts";
import { TEST_ASSET } from "../utils.ts";

const BASE = "https://assets.example/static";

/**
 * Runs `body` with `respond` answering every `fetch`, so a cache whose base is
 * not a `file:` URL reaches no network. Resolves with the URLs requested.
 */
async function withFetch(
  respond: () => Response,
  body: () => void | Promise<void>,
): Promise<string[]> {
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    requested.push(String(input));
    return Promise.resolve(respond());
  };
  try {
    await body();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return requested;
}

Deno.test("StaticCache fetches an asset from a base that is not a file, once", async () => {
  const cache = new StaticCache(new URL(BASE));

  const requested = await withFetch(
    () => new Response("asset bytes"),
    async () => {
      const first = await cache.getWithETag(TEST_ASSET);
      const second = await cache.getWithETag(TEST_ASSET);

      expect(second).toBe(first);
      expect(await first.blob.text()).toBe("asset bytes");
      expect(first.etag).toBe(
        await generateETag(new TextEncoder().encode("asset bytes")),
      );
    },
  );

  expect(requested).toEqual([`${BASE}/${TEST_ASSET}`]);
});

Deno.test("StaticCache rejects naming the asset and its location when the fetch fails", async () => {
  const cache = new StaticCache(new URL(BASE));

  await withFetch(
    () => new Response("missing", { status: 404 }),
    async () => {
      await expect(cache.get(TEST_ASSET)).rejects.toThrow(
        `Could not retrieve "${TEST_ASSET}" at "${BASE}/${TEST_ASSET}".`,
      );
    },
  );
});

Deno.test("StaticCache throws for an asset the package does not ship, fetching nothing", async () => {
  const cache = new StaticCache(new URL(BASE));

  const requested = await withFetch(
    () => new Response("asset bytes"),
    () => {
      expect(() => cache.getUrl("types/missing.d.ts")).toThrow(
        'No static asset "types/missing.d.ts" found.',
      );
    },
  );

  expect(requested).toEqual([]);
});
