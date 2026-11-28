// Run by `../registration.test.ts` as a test file of its own.

import { test } from "../../src/testing.ts";

test("a", () => {});

Promise.reject(new Error("rejected as the file loaded"));
await new Promise((resolve) => setTimeout(resolve, 10));

test("b", () => {});
