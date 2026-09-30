/**
 * Records which objects are runtimes, so that code handed an object claiming
 * to be one can check. A cell binds only to a genuine runtime: pattern code can
 * reach a cell's constructor, and a cell built around an object of its own
 * would have host code calling that object with host state. A module of its own
 * so that `cell.ts` and `runtime.ts` need not import each other.
 */

import type { Runtime } from "./runtime.ts";

const runtimes = new WeakSet<object>();

/** Records `runtime` as a runtime. The `Runtime` constructor calls this. */
export function brandRuntime(runtime: Runtime): void {
  runtimes.add(runtime);
}

/** Returns whether `value` is a runtime `brandRuntime()` recorded. */
export function isRuntime(value: unknown): value is Runtime {
  return typeof value === "object" && value !== null && runtimes.has(value);
}
