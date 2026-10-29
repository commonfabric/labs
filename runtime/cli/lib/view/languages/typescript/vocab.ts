/**
 * Common Fabric naming vocabulary used to give the transformed output its
 * domain-aware coloring (highlighting `pattern`/`lift`/`handler` builders and
 * the synthetic helpers the transformer injects).
 *
 * The builder/call name sets are imported from the transformer's own registry
 * so new builders are recognized automatically and we never drift out of sync.
 * The synthetic-name prefixes are stable internal strings declared alongside
 * the transformer that emits them; they are mirrored here (with citations) to
 * avoid pulling the heavy `ast/call-kind.ts` graph into the pager. A unit test
 * (`test/view/vocab.test.ts`) pins them against the transformer source.
 */

import {
  COMMONFABRIC_BUILDER_EXPORT_NAMES,
  COMMONFABRIC_CALL_EXPORT_NAMES,
} from "@commonfabric/ts-transformers/runtime-registry";

/** Builder calls, e.g. `pattern`, `lift`, `handler`, `computed`, `render`. */
export const BUILDER_NAMES: ReadonlySet<string> =
  COMMONFABRIC_BUILDER_EXPORT_NAMES;

/** Reactive call helpers, e.g. `ifElse`, `when`, `cell`, `wish`. */
export const CALL_NAMES: ReadonlySet<string> = COMMONFABRIC_CALL_EXPORT_NAMES;

//
// Synthetic identifiers emitted by ts-transformers
//
// Mirrors of constants in `base/ts-transformers/src`. Kept as literals so
// the pager does not import the transformer's analysis graph. See vocab.test.ts.
//

/** `base/ts-transformers/src/core/cf-helpers.ts` `CF_HELPERS_IDENTIFIER`. */
export const CF_HELPERS_IDENTIFIER = "__cfHelpers";

/** `cf-helpers.ts` `CF_DATA_HELPER_IDENTIFIER`. */
export const CF_DATA_HELPER_IDENTIFIER = "__cfDataHelper";

/** `ast/call-kind.ts` `SYNTHETIC_LIFT_HOIST_PREFIX` (`const __cfLift_N = …`). */
export const SYNTHETIC_LIFT_HOIST_PREFIX = "__cfLift";

/** `ast/call-kind.ts` `SYNTHETIC_PATTERN_HOIST_PREFIX` (`const __cfPattern_N = …`). */
export const SYNTHETIC_PATTERN_HOIST_PREFIX = "__cfPattern";

/** `ast/call-kind.ts` `FUNCTION_HARDENING_HELPER_PREFIX`. */
export const FUNCTION_HARDENING_HELPER_PREFIX = "__cfHardenFn";

/** `ast/call-kind.ts` `SYNTHETIC_MODULE_CALLBACK_PREFIX`. */
export const SYNTHETIC_MODULE_CALLBACK_PREFIX = "__cfModuleCallback";

/** Prefixes that mark a transformer-synthesised identifier. */
const SYNTHETIC_PREFIXES = [
  SYNTHETIC_LIFT_HOIST_PREFIX,
  SYNTHETIC_PATTERN_HOIST_PREFIX,
  FUNCTION_HARDENING_HELPER_PREFIX,
  SYNTHETIC_MODULE_CALLBACK_PREFIX,
  "__cfHandler",
  "__cfAction",
  "__cfBindVerifiedBinding",
  "__cf_pattern_input",
  "__cfAmdHooks",
];

/**
 * Names the transformer emits for the module wrapper itself. These are ordinary
 * identifiers (no `__cf` prefix), so they are listed by exact name rather than
 * recognized by prefix.
 */
const SCAFFOLDING_NAMES: ReadonlySet<string> = new Set([
  "define",
  "runtimeDeps",
  "__cfAmdHooks",
]);

/** True if `name` is a synthetic helper/identifier produced by the transformer. */
export function isSyntheticName(name: string): boolean {
  if (name === CF_HELPERS_IDENTIFIER || name === CF_DATA_HELPER_IDENTIFIER) {
    return true;
  }
  return SYNTHETIC_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * A human-readable descriptor of what the transformer generates a given name
 * for, or `null` when the name is not part of the transformer's vocabulary. A
 * non-null result is a *fact*: the name matches the transformer's own constants,
 * so the node is certainly generated rather than authored.
 */
export function describeSynthetic(name: string): string | null {
  if (name === CF_HELPERS_IDENTIFIER || name === CF_DATA_HELPER_IDENTIFIER) {
    return "Common Fabric helpers";
  }
  if (name.startsWith(SYNTHETIC_LIFT_HOIST_PREFIX)) {
    return "hoisted lift helper";
  }
  if (name.startsWith(SYNTHETIC_PATTERN_HOIST_PREFIX)) {
    return "hoisted pattern helper";
  }
  if (name.startsWith(FUNCTION_HARDENING_HELPER_PREFIX)) {
    return "function-hardening helper";
  }
  if (name.startsWith(SYNTHETIC_MODULE_CALLBACK_PREFIX)) {
    return "hoisted module callback";
  }
  if (name.startsWith("__cfHandler")) return "hoisted handler helper";
  if (name.startsWith("__cfAction")) return "hoisted action helper";
  if (name.startsWith("__cf_pattern_input")) return "pattern input";
  if (SCAFFOLDING_NAMES.has(name)) return "module scaffolding";
  return null;
}

/** True if `name` is a Common Fabric builder (`pattern`, `lift`, …). */
export function isBuilderName(name: string): boolean {
  return BUILDER_NAMES.has(name);
}

/** True if `name` is a Common Fabric reactive call helper (`ifElse`, …). */
export function isCallName(name: string): boolean {
  return CALL_NAMES.has(name);
}
