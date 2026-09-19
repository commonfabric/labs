/**
 * The debug renderers of `value-debug`, as this package's own modules reach
 * them: each function here forwards to the renderer of the same name, which
 * `value-debug` hands over when it loads. The import map points `@/value-debug`
 * here, so that is what a module of this package writes.
 *
 * This module imports nothing at run time, its one import being of types. A
 * module anywhere in the package can therefore import it without causing a
 * circular load-time dependency, including a module which `value-debug` itself
 * loads, such as the root class every `FabricSpecialObject` extends.
 *
 * What that costs is an order: a renderer works once `value-debug` has been
 * loaded, and throws before then. Every entry in the package's export map
 * loads it, and loads it first, apart from the two which are a single module
 * that renders nothing (`api.ts` and `frozen-builtins.ts`). So a program which
 * imports the package has it. A unit test which imports one module by its path
 * may not, and gets it by importing `@/for-testing-only.ts`.
 */

import type * as valueDebug from "@/value-debug/index.ts";

/** The renderers `value-debug` installs, by the names it exports them under. */
export type DebugRenderers = Pick<
  typeof valueDebug,
  | "debugStr"
  | "toCompactDebugString"
  | "toDebugKindString"
  | "toIndentedDebugString"
  | "toLongQuotedDebugString"
  | "toShortQuotedDebugString"
  | "toStructuredDebugValue"
>;

/** The installed renderers, or `undefined` until `value-debug` has loaded. */
let installedRenderers: DebugRenderers | undefined;

/**
 * Installs the renderers the functions of this module forward to. `value-debug`
 * calls this as it loads, and nothing else does.
 */
export function installDebugRenderers(renderers: DebugRenderers): void {
  installedRenderers = renderers;
}

/** Whether the renderers are installed, which is to say `value-debug` loaded. */
export function areDebugRenderersInstalled(): boolean {
  return installedRenderers !== undefined;
}

/**
 * Returns the installed renderers.
 *
 * @throws {Error} if `value-debug` has not been loaded.
 */
function renderers(): DebugRenderers {
  if (installedRenderers === undefined) {
    throw new Error(
      "The debug renderers are not installed: nothing has loaded " +
        "`value-debug`. A unit test gets them by importing " +
        "`@/for-testing-only.ts`.",
    );
  }

  return installedRenderers;
}

/** Forwards to `debugStr` of `value-debug`. */
export const debugStr: DebugRenderers["debugStr"] = (strings, ...values) =>
  renderers().debugStr(strings, ...values);

/** Forwards to `toCompactDebugString()` of `value-debug`. */
export const toCompactDebugString: DebugRenderers["toCompactDebugString"] = (
  value,
  options,
) => renderers().toCompactDebugString(value, options);

/** Forwards to `toDebugKindString()` of `value-debug`. */
export const toDebugKindString: DebugRenderers["toDebugKindString"] = (
  value,
) => renderers().toDebugKindString(value);

/** Forwards to `toIndentedDebugString()` of `value-debug`. */
export const toIndentedDebugString: DebugRenderers["toIndentedDebugString"] = (
  value,
  options,
) => renderers().toIndentedDebugString(value, options);

/** Forwards to `toLongQuotedDebugString()` of `value-debug`. */
export const toLongQuotedDebugString:
  DebugRenderers["toLongQuotedDebugString"] = (value) =>
    renderers().toLongQuotedDebugString(value);

/** Forwards to `toShortQuotedDebugString()` of `value-debug`. */
export const toShortQuotedDebugString:
  DebugRenderers["toShortQuotedDebugString"] = (value) =>
    renderers().toShortQuotedDebugString(value);

/** Forwards to `toStructuredDebugValue()` of `value-debug`. */
export const toStructuredDebugValue: DebugRenderers["toStructuredDebugValue"] =
  (value, options) => renderers().toStructuredDebugValue(value, options);
