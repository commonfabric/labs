// Flat `test()` cases: this package's tests also run in a browser through
// `deno-web-test`, where `describe()` is not available.

import { expect } from "@std/expect";

import { StaticCache } from "../cache.ts";
import { generateETag } from "../etag.ts";
import { TEST_ASSET, TEST_ASSET_CONTENT } from "../utils.ts";
import { isDeno } from "@commonfabric/platform/env";
import { test } from "@commonfabric/test-support/test";

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

test("StaticCache fetches an asset from a base that is not a file, once", async () => {
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

test("StaticCache rejects naming the asset and its location when the fetch fails", async () => {
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

test("StaticCache keeps no entry for a name the package does not ship, and keeps one for an asset it does", async () => {
  const cache = new StaticCache(new URL(BASE));
  const names = Array.from({ length: 50 }, (_, i) => `types/missing-${i}.d.ts`);

  const requested = await withFetch(
    () => new Response("asset bytes"),
    async () => {
      for (const name of names) {
        await expect(cache.getWithETag(name)).rejects.toThrow(
          `No static asset "${name}" found.`,
        );
      }
      expect(cache.accessForTestingOnly.cache.size).toBe(0);

      const asset = await cache.getWithETag(TEST_ASSET);
      expect([...cache.accessForTestingOnly.cache.keys()]).toEqual([
        TEST_ASSET,
      ]);
      expect(await cache.getWithETag(TEST_ASSET)).toBe(asset);
    },
  );

  expect(requested).toEqual([`${BASE}/${TEST_ASSET}`]);
});

test("StaticCache fetches an asset again after a fetch for it fails, and keeps the one that succeeds", async () => {
  const cache = new StaticCache(new URL(BASE));
  const responses = [
    new Response("missing", { status: 404 }),
    new Response("asset bytes"),
  ];

  const requested = await withFetch(
    () => responses.shift()!,
    async () => {
      // Two calls made while the failing fetch is pending share it.
      const first = cache.getWithETag(TEST_ASSET);
      const second = cache.getWithETag(TEST_ASSET);
      expect(second).toBe(first);
      await expect(first).rejects.toThrow(
        `Could not retrieve "${TEST_ASSET}"`,
      );
      expect(cache.accessForTestingOnly.cache.size).toBe(0);

      const asset = await cache.getWithETag(TEST_ASSET);
      expect(await asset.blob.text()).toBe("asset bytes");
      expect(await cache.getWithETag(TEST_ASSET)).toBe(asset);
    },
  );

  expect(requested).toEqual([
    `${BASE}/${TEST_ASSET}`,
    `${BASE}/${TEST_ASSET}`,
  ]);
});

test("StaticCache has() returns whether the package ships the named asset", () => {
  const cache = new StaticCache(new URL(BASE));

  expect(cache.has(TEST_ASSET)).toBe(true);
  expect(cache.has("types/missing.d.ts")).toBe(false);
  expect(cache.has(`../${TEST_ASSET}`)).toBe(false);
});

test("StaticCache throws for an asset the package does not ship, fetching nothing", async () => {
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

test("StaticCache.fromFileSystem refuses a scope that is not Deno", () => {
  expect(() => StaticCache.fromFileSystem({})).toThrow(
    "`StaticCache.fromFileSystem()` is only available in Deno.",
  );
  expect(() => StaticCache.fromFileSystem({ Deno: {} })).toThrow(
    "`StaticCache.fromFileSystem()` is only available in Deno.",
  );
});

test({
  name: "StaticCache.fromFileSystem reads the bundled assets under Deno",
  ignore: !isDeno(),
  fn: async () => {
    const cache = StaticCache.fromFileSystem();
    const url = cache.getUrl(TEST_ASSET);

    expect(url.protocol).toBe("file:");
    expect(url.pathname.endsWith(`/assets/${TEST_ASSET}`)).toBe(true);
    expect(await cache.getText(TEST_ASSET)).toContain(TEST_ASSET_CONTENT);
  },
});
