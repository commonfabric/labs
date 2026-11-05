/**
 * What `assertJsonTransportSafe` puts in the error, which is the whole reason
 * it exists as a separate assertion rather than a bare boolean check.
 *
 * The value it rejects is about to cross into an external LLM provider, where
 * the loss would surface as altered output rather than as a failure, so the
 * throw has to be actionable on its own: it names the label it was given, the
 * JSON pointer to each offending value, and why that value cannot survive
 * ordinary JSON serialization. It reports every offender rather than stopping
 * at the first, so one round of fixes can address the whole value.
 */

import { assertEquals, assertThrows } from "@std/assert";

import { assertJsonTransportSafe } from "./schema-transport.ts";

Deno.test("assertJsonTransportSafe: returns for a safe value", () => {
  assertJsonTransportSafe({ type: "number", default: -1 }, "schema");
});

Deno.test("assertJsonTransportSafe: throws, naming label, pointer, and reason", () => {
  const err = assertThrows(
    () =>
      assertJsonTransportSafe(
        { properties: { n: { default: NaN } } },
        "The generateObject schema",
      ),
    Error,
  );
  assertEquals(err.message.includes("The generateObject schema"), true);
  assertEquals(err.message.includes("/properties/n/default"), true);
  assertEquals(err.message.includes("NaN"), true);
});

Deno.test("assertJsonTransportSafe: lists every offender", () => {
  const err = assertThrows(
    () =>
      assertJsonTransportSafe(
        { properties: { a: { default: NaN }, b: { default: -0 } } },
        "schema",
      ),
    Error,
  );
  assertEquals(err.message.includes("/properties/a/default"), true);
  assertEquals(err.message.includes("/properties/b/default"), true);
  assertEquals(err.message.includes("2 value(s)"), true);
});
