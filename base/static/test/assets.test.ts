import { assert } from "@std/assert";

import {
  createTestStaticCache,
  TEST_ASSET,
  TEST_ASSET_CONTENT,
} from "../utils.ts";
import { test } from "@commonfabric/test-support/test";

test("get() and getText() returns static data", async () => {
  const cache = createTestStaticCache();
  const blob = await cache.get(TEST_ASSET);
  const text = await cache.getText(TEST_ASSET);
  assert(await blob.text() === text, "blob and text match");
  assert(text.includes(TEST_ASSET_CONTENT), "Expected asset contents");
});

test("getUrl() returns asset URL", async () => {
  const cache = createTestStaticCache();
  const url = await cache.getUrl(TEST_ASSET);
  assert(url.pathname.endsWith(`/${TEST_ASSET}`), "Expected URL path");
});
