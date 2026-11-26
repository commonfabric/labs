// Run by `../registration.test.ts` as a test file of its own.

import { beforeAll, test } from "../../src/testing.ts";

beforeAll(() => {
  Deno.readTextFileSync(new URL(import.meta.url));
});

test("narrows its permissions", { permissions: { read: false } }, () => {});

test("keeps its permissions", () => {});
