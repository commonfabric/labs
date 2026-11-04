/**
 * These pin the distinctions the schema formatters need but that their previous
 * `JSON.stringify` / `Set` comparisons could not make. The formatter call sites
 * take their values from the type system, which cannot express `-0` / `NaN` /
 * `±Infinity`, so the conflations are unreachable through a real pattern today.
 * `dedupeByValueEqual` is exercised directly here instead, the same way
 * `valueEqual` itself is pinned against `Object.is`: feed it the edge values and
 * assert the honest result, so the guarantee holds if the schema system ever
 * does route such values through these paths.
 */

import { assertEquals } from "@std/assert";

import { dedupeByValueEqual } from "../src/value-equality.ts";

Deno.test("dedupeByValueEqual: keeps -0 and 0 as distinct values", () => {
  // A `Set` (SameValueZero) or a `JSON.stringify` key ("0" for both) would
  // collapse these into one. The value model keeps them apart.
  assertEquals(dedupeByValueEqual([0, -0]), [0, -0]);
});

Deno.test("dedupeByValueEqual: treats NaN as equal to itself", () => {
  assertEquals(dedupeByValueEqual([NaN, NaN]).length, 1);
});

Deno.test("dedupeByValueEqual: keeps NaN, Infinity, and null distinct", () => {
  // `JSON.stringify` renders all three as `null`, so a stringify key would
  // merge them; each is its own value.
  const deduped = dedupeByValueEqual([NaN, Infinity, -Infinity, null]);
  assertEquals(deduped.length, 4);
});

Deno.test("dedupeByValueEqual: is not sensitive to object key order", () => {
  // `JSON.stringify` would emit different text for these and keep both; they are
  // the same value.
  const deduped = dedupeByValueEqual([{ a: 1, b: 2 }, { b: 2, a: 1 }]);
  assertEquals(deduped, [{ a: 1, b: 2 }]);
});

Deno.test("dedupeByValueEqual: keeps schemas that differ only by a -0 default", () => {
  // The `maybeWrapInAnyOf` / anyOf-dedup case: two number schemas whose only
  // difference is a signed-zero default. A stringify key ("...0...") would drop
  // one; both survive.
  const a = { type: "number", default: -0 };
  const b = { type: "number", default: 0 };
  assertEquals(dedupeByValueEqual([a, b]), [a, b]);
});

Deno.test("dedupeByValueEqual: collapses genuinely equal schemas", () => {
  // The dedup still does its job for real duplicates, including equal ones
  // written in different key order.
  const deduped = dedupeByValueEqual([
    { type: "number", default: 5 },
    { default: 5, type: "number" },
    { type: "string" },
  ]);
  assertEquals(deduped, [{ type: "number", default: 5 }, { type: "string" }]);
});

Deno.test("contrast: JSON.stringify and Set conflate what dedupeByValueEqual separates", () => {
  // An executable statement of why the previous comparisons were wrong, so that
  // if these ever start passing the refactor is no longer load-bearing and can
  // be revisited.

  // JSON.stringify collides the values the value model distinguishes...
  assertEquals(JSON.stringify(-0), JSON.stringify(0)); // both "0"
  assertEquals(JSON.stringify(NaN), JSON.stringify(null)); // both "null"
  assertEquals(JSON.stringify(Infinity), JSON.stringify(null)); // both "null"
  assertEquals(
    JSON.stringify({ a: 1, b: 2 }) === JSON.stringify({ b: 2, a: 1 }),
    false, // ...and splits equal values by key order
  );
  // ...and a Set merges -0 with 0 (SameValueZero).
  assertEquals([...new Set([0, -0])].length, 1);
});
