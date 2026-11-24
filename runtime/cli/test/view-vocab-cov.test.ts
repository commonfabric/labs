import { assertEquals } from "@std/assert";
import {
  CF_DATA_HELPER_IDENTIFIER,
  CF_HELPERS_IDENTIFIER,
  describeSynthetic,
  FUNCTION_HARDENING_HELPER_PREFIX,
  SYNTHETIC_LIFT_HOIST_PREFIX,
  SYNTHETIC_MODULE_CALLBACK_PREFIX,
} from "../lib/view/languages/typescript/vocab.ts";

Deno.test("describeSynthetic: helpers and data-helper identifiers describe as Common Fabric helpers", () => {
  // Both the bare helpers object and the data helper resolve to one descriptor.
  assertEquals(
    describeSynthetic(CF_HELPERS_IDENTIFIER),
    "Common Fabric helpers",
  );
  assertEquals(
    describeSynthetic(CF_DATA_HELPER_IDENTIFIER),
    "Common Fabric helpers",
  );
});

Deno.test("describeSynthetic: hoisted lift and function-hardening helpers", () => {
  assertEquals(
    describeSynthetic(`${SYNTHETIC_LIFT_HOIST_PREFIX}_1`),
    "hoisted lift helper",
  );
  assertEquals(
    describeSynthetic(`${FUNCTION_HARDENING_HELPER_PREFIX}_2`),
    "function-hardening helper",
  );
});

Deno.test("describeSynthetic: hoisted module callback", () => {
  assertEquals(
    describeSynthetic(`${SYNTHETIC_MODULE_CALLBACK_PREFIX}_0`),
    "hoisted module callback",
  );
});

Deno.test("describeSynthetic: handler, action and pattern-input prefixes", () => {
  assertEquals(describeSynthetic("__cfHandler_3"), "hoisted handler helper");
  assertEquals(describeSynthetic("__cfAction_4"), "hoisted action helper");
  assertEquals(describeSynthetic("__cf_pattern_input"), "pattern input");
});

Deno.test("describeSynthetic: module scaffolding names matched exactly", () => {
  // Listed by exact name (no __cf prefix), e.g. `define` / `runtimeDeps`.
  assertEquals(describeSynthetic("define"), "module scaffolding");
  assertEquals(describeSynthetic("runtimeDeps"), "module scaffolding");
});

Deno.test("describeSynthetic: authored names are not part of the vocabulary", () => {
  // No prefix, no exact scaffolding match: falls through to null.
  assertEquals(describeSynthetic("myPattern"), null);
  assertEquals(describeSynthetic("token"), null);
  assertEquals(describeSynthetic(""), null);
});
