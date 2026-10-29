/**
 * Whether the code running now is a serving loop's work, carried per async
 * context. A process that hosts a serving loop beside client runtimes, as
 * `cf test` does on the server-execution arm, reads it to tell the loop's
 * output apart from the clients'.
 *
 * The context is entered where work crosses from one side to the other,
 * since everything else inherits it across its awaits and timers. An
 * `ExecutorHost` enters it wherever the memory server or its owner starts
 * work on it: an admitted commit, a session opening, a lifecycle verb, and
 * its close. Each in-process session takes its server frames through
 * {@link servingContextLoopback}: the serving runtimes' in the context, an
 * emulated client's outside it. The memory server's own work runs in the
 * context of the session whose request it is handling, and a callback one
 * side hands the other runs in the context of whichever side calls it.
 *
 * The context rides `AsyncLocalStorage` where the host provides it (Deno). A
 * browser has none, and hosts no serving loop; there the promise-aware
 * fallback keeps the context current until a promise run in it settles.
 *
 * This module imports nothing from the runner: the top-level `await` that
 * picks the store would stall module evaluation inside an import cycle.
 */

import * as MemoryClient from "@commonfabric/memory/v2/client";
import type { Server as MemoryServer } from "@commonfabric/memory/v2/server";
import { isDeno } from "@commonfabric/utils/env";
import {
  type AsyncLocalStore,
  FallbackAsyncLocalStore,
} from "@commonfabric/utils/async-local-store";

// Deno/Node `AsyncLocalStorage` when available, the promise-aware fallback
// otherwise. The `await import` stays here (not in the shared utils module): a
// top-level await in widely-imported utils stalls Deno module evaluation.
const ServingContextStorage = (isDeno()
  // deno-lint-ignore cf-imports/no-inline-module-import
  ? (await import("node:async_hooks")).AsyncLocalStorage
  : FallbackAsyncLocalStore) as new <T>() => AsyncLocalStore<T>;

const servingContext = new ServingContextStorage<boolean>();

/** Indicates whether the caller is running a serving loop's work. */
export function inServingContext(): boolean {
  return servingContext.getStore() === true;
}

/**
 * Calls `fn` as a serving loop's work, or with `serving === false` as work
 * outside any serving loop, and returns what it returns.
 */
export function runInServingContext<R>(serving: boolean, fn: () => R): R {
  return servingContext.run(serving, fn);
}

/**
 * Returns a loopback transport to `server` whose receiver takes each server
 * frame in the serving context when `serving` is `true`, and outside it when
 * `false`. The memory server sends each frame on a turn armed by whichever
 * session's request caused it, and the context that turn carries is set
 * aside here.
 */
export function servingContextLoopback(
  server: MemoryServer,
  serving: boolean,
): MemoryClient.Transport {
  const inner = MemoryClient.loopback(server);
  return {
    ...inner,
    setReceiver: (next) =>
      inner.setReceiver((payload) =>
        runInServingContext(serving, () => next(payload))
      ),
  };
}
