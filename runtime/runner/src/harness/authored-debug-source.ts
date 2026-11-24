/**
 * Debug-only authored source metadata for verified builder implementations.
 * Nothing in this module participates in identity, authorization, or
 * scheduling.
 */

import { resolveOriginal } from "../builder/pattern-metadata.ts";

/** Authored debug fields served by a builder implementation. */
export interface AuthoredDebugSource {
  /** Canonical `cf:module/.../<path>:<line>:<col>` source location. */
  readonly src?: string;

  /** Authored declaration name, when the function has one. */
  readonly bindingName?: string;
}

const authoredDebugSourceByFn = new WeakMap<object, AuthoredDebugSource>();

/** Records debug source metadata for a function, with first write winning. */
export function recordAuthoredDebugSource(
  fn: unknown,
  entry: AuthoredDebugSource,
): void {
  if (typeof fn !== "function") return;
  if (!authoredDebugSourceByFn.has(fn)) {
    authoredDebugSourceByFn.set(fn, entry);
  }
}

/**
 * Returns the authored debug metadata recorded for `fn` — the exact function
 * first, then its derivation root.
 *
 * The fallback matters for `PatternFactory.asScope(...)` / `.inSpace(...)`,
 * which mint FRESH factory objects: the provenance walk records the module's
 * exported root, so a derived factory has no entry of its own. This mirrors
 * how `getArtifactEntryRef` / `getPatternSourcePath` resolve through
 * `resolveOriginal`, and stays debug-only — `resolveOriginal` is a pure walk
 * of the runner-private derivation link and grants nothing.
 */
export function getAuthoredDebugSource(
  fn: unknown,
): AuthoredDebugSource | undefined {
  if (typeof fn !== "function") return undefined;
  const own = authoredDebugSourceByFn.get(fn);
  if (own !== undefined) return own;
  const root = resolveOriginal(fn as object);
  return root === fn ? undefined : authoredDebugSourceByFn.get(root);
}

/**
 * Installs lazy `.src` and `.name` accessors while `fn` is still extensible.
 * The engine records their values only after the defining module evaluates.
 */
export function defineAuthoredDebugAccessors(
  fn: (...args: any[]) => unknown,
): void {
  const fallbackName = fn.name;
  defineDebugAccessor(
    fn,
    "src",
    () => getAuthoredDebugSource(fn)?.src,
  );
  defineDebugAccessor(
    fn,
    "name",
    () => getAuthoredDebugSource(fn)?.bindingName ?? fallbackName,
  );
}

/** Defines one lazy debug property when its existing descriptor permits it. */
function defineDebugAccessor(
  fn: (...args: any[]) => unknown,
  property: "src" | "name",
  get: () => string | undefined,
): void {
  const existing = Object.getOwnPropertyDescriptor(fn, property);
  if (existing !== undefined && existing.configurable !== true) return;
  Object.defineProperty(fn, property, {
    get,
    enumerable: false,
    configurable: true,
  });
}
