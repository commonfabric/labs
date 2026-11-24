import { assert, assertEquals } from "@std/assert";

import {
  COMMONFABRIC_BUILDER_EXPORT_NAMES,
  COMMONFABRIC_CALL_EXPORT_NAMES,
} from "@commonfabric/ts-transformers/runtime-registry";

import {
  BUILDER_NAMES,
  CALL_NAMES,
  CF_HELPERS_IDENTIFIER,
  describeSynthetic,
  FUNCTION_HARDENING_HELPER_PREFIX,
  isBuilderName,
  isCallName,
  isSyntheticName,
  SYNTHETIC_LIFT_HOIST_PREFIX,
  SYNTHETIC_MODULE_CALLBACK_PREFIX,
  SYNTHETIC_PATTERN_HOIST_PREFIX,
} from "../lib/view/languages/typescript/vocab.ts";

Deno.test("vocab: builders and calls come straight from the transformer registry", () => {
  // Drift guard: the pager's name sets ARE the transformer's registry sets.
  assertEquals(BUILDER_NAMES, COMMONFABRIC_BUILDER_EXPORT_NAMES);
  assertEquals(CALL_NAMES, COMMONFABRIC_CALL_EXPORT_NAMES);
  // Stable vocabulary the coloring depends on.
  for (const name of ["pattern", "lift", "handler", "computed"]) {
    assert(isBuilderName(name), `${name} should be a builder`);
  }
});

Deno.test("vocab: reactive call helpers are recognized", () => {
  // ifElse is a canonical reactive call in the registry.
  assert(isCallName("ifElse") || CALL_NAMES.size === 0);
  assert(!isBuilderName("totallyNotABuilder"));
});

Deno.test("vocab: synthetic identifiers are detected by prefix", () => {
  assert(isSyntheticName(CF_HELPERS_IDENTIFIER));
  assert(isSyntheticName(`${SYNTHETIC_LIFT_HOIST_PREFIX}_3`));
  assert(isSyntheticName(`${FUNCTION_HARDENING_HELPER_PREFIX}`));
  assert(isSyntheticName(`${SYNTHETIC_MODULE_CALLBACK_PREFIX}_1`));
  assert(isSyntheticName("__cf_pattern_input"));
  assert(!isSyntheticName("regularName"));
  assert(!isSyntheticName("pattern"));
});

Deno.test("vocab: hoisted pattern helpers are recognized and described", () => {
  // The transformer hoists the bare pattern call in `mapWithPattern(pattern(...))`
  // to `const __cfPattern_N = __cfHelpers.pattern(...)`. Without the prefix the
  // pager would treat that synthetic helper as an authored identifier.
  assert(isSyntheticName(`${SYNTHETIC_PATTERN_HOIST_PREFIX}_1`));
  assert(isSyntheticName("__cfPattern_42"));
  assertEquals(
    describeSynthetic(`${SYNTHETIC_PATTERN_HOIST_PREFIX}_1`),
    "hoisted pattern helper",
  );
  // The mirrored literal must track the transformer's documented prefix.
  assertEquals(SYNTHETIC_PATTERN_HOIST_PREFIX, "__cfPattern");
});

Deno.test("vocab: synthetic prefix literals match the documented transformer names", () => {
  // Pins the mirrored literals so a typo cannot silently break coloring.
  assertEquals(CF_HELPERS_IDENTIFIER, "__cfHelpers");
  assertEquals(SYNTHETIC_LIFT_HOIST_PREFIX, "__cfLift");
  assertEquals(FUNCTION_HARDENING_HELPER_PREFIX, "__cfHardenFn");
  assertEquals(SYNTHETIC_MODULE_CALLBACK_PREFIX, "__cfModuleCallback");
});
