/**
 * Deferred access to the TypeScript compiler stack (see compiler-stack.ts for
 * why it must not load at worker boot).
 *
 * Flows that compile, resolve, or parse source `await ensureCompilerStack()`
 * once at their (async) entry point; the sync code under them reaches values
 * through `compilerStack()`, which throws — loudly, with the fix — when a
 * flow forgot its ensure. Boot-path code must do neither.
 */

import type * as CompilerStackModule from "./compiler-stack.ts";

export type CompilerStack = typeof CompilerStackModule;

let loaded: CompilerStack | undefined;
let loading: Promise<CompilerStack> | undefined;

type CompilerStackLoader = () => Promise<CompilerStack>;
const loadCompilerStack: CompilerStackLoader = () =>
  // deno-lint-ignore cf-imports/no-inline-module-import
  import("./compiler-stack.ts");

/** A worker-global module-fetch failure that requires a fresh module map. */
export class CompilerStackLoadError extends Error {
  override name = "CompilerStackLoadError";

  constructor(cause: unknown) {
    super("Failed to load the compiler stack", { cause });
  }
}

const demandObservers = new Set<() => void>();

/**
 * Calls `observer` on every later {@link ensureCompilerStack} call, until the
 * returned function is called. The load is memoized for the life of the
 * process, so once any test has compiled, whether the stack is loaded says
 * nothing about a later flow; observing the calls is how a test pins a flow
 * as one that never asks for the compiler.
 */
export function observeCompilerStackDemandsForTestingOnly(
  observer: () => void,
): () => void {
  demandObservers.add(observer);
  return () => {
    demandObservers.delete(observer);
  };
}

/** Load (once) the compiler stack; idempotent and cheap when already loaded. */
export function ensureCompilerStack(
  load: CompilerStackLoader = loadCompilerStack,
): Promise<CompilerStack> {
  for (const observer of demandObservers) observer();
  return loading ??= load()
    .then((module) => (loaded = module))
    .catch((error) => {
      // Browsers cache failed module URLs in the current worker's module map,
      // so retrying this same import cannot recover. Preserve a distinct error
      // identity for the host to replace the worker with a fresh module map.
      throw new CompilerStackLoadError(error);
    });
}

/** Whether some flow has loaded the compiler stack in this process. */
export function compilerStackLoaded(): boolean {
  return loaded !== undefined;
}

/**
 * The loaded compiler stack. Throws when no flow has awaited
 * {@link ensureCompilerStack} yet — a missed ensure on a new flow fails loud
 * here rather than silently re-eagering the compiler into the boot path.
 */
export function compilerStack(): CompilerStack {
  if (loaded === undefined) {
    throw new Error(
      "compiler stack not loaded — this flow must `await ensureCompilerStack()` before parsing/compiling",
    );
  }
  return loaded;
}
