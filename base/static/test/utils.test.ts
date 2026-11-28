// Flat `test()` cases: this package's tests also run in a browser through
// `deno-web-test`, where `describe()` is not available.

import { expect } from "@std/expect";

import { createTestStaticCache, TEST_ASSET } from "../utils.ts";
import { test } from "@commonfabric/test-support/test";

test("createTestStaticCache outside Deno resolves assets under /static on the page origin", () => {
  const first = createTestStaticCache({
    location: { origin: "https://first.example" },
  });
  const second = createTestStaticCache({
    location: { origin: "https://second.example:8000" },
  });

  expect(first.getUrl(TEST_ASSET).href).toBe(
    `https://first.example/static/${TEST_ASSET}`,
  );
  expect(second.getUrl(TEST_ASSET).href).toBe(
    `https://second.example:8000/static/${TEST_ASSET}`,
  );
});
