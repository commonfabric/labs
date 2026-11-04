import { assertEquals, assertGreaterOrEqual } from "@std/assert";
import {
  getSlowQueries,
  recordSlowQueryDurationForTesting,
} from "../v2/server.ts";

Deno.test("memory v2 records slow-query diagnostics deterministically", () => {
  const operation = "test.slow-query";
  const space = `did:key:slow-query-${crypto.randomUUID()}`;

  recordSlowQueryDurationForTesting(
    operation,
    space,
    performance.now() - 101,
    { roots: 2 },
  );

  const entry = getSlowQueries().at(-1);
  assertEquals(entry?.operation, operation);
  assertEquals(entry?.space, space);
  assertEquals(entry?.roots, 2);
  assertGreaterOrEqual(entry?.elapsed ?? 0, 100);
});
