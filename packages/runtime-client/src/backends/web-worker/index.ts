/**
 * This is an entry point for a worker script that runs a local RuntimeWorker
 * that can communicate with a corresponding RuntimeClient.
 *
 * Imports from `@commonfabric/runner` may be used freely in this directory.
 */

import "core-js/proposals/explicit-resource-management";
import "core-js/proposals/async-explicit-resource-management";

import { getLogger } from "@commonfabric/utils/logger";
import { unrefTimer } from "@commonfabric/utils/sleep";

import {
  TransportNotificationType,
  WORKER_CONSOLE_LEVELS,
  WorkerConsoleLevel,
} from "@/protocol/mod.ts";
import { RuntimeClients } from "@/backends/client-registry.ts";
import { postToClient } from "@/backends/post-to-client.ts";
import { holdLifetimeLock } from "@/backends/web-worker/lifetime-lock.ts";

// Worker event-loop lag probe (`runner.loop/workerLag`): each tick records how
// far past schedule the timer fired — long synchronous stretches (compile,
// large traverses, GC) and CPU starvation show up as its max/p95. Companion to
// the main-thread `loop/mainLag`; together they attribute a slow round-trip to
// a wedged thread rather than a slow handler. Lives for the worker's lifetime.
const LOOP_LAG_SAMPLE_MS = 100;
const loopLagLogger = getLogger("runner.loop", { enabled: false });
{
  let expected = performance.now() + LOOP_LAG_SAMPLE_MS;
  // Unref'd so that a unit test importing this worker entry to drive the
  // message handler (e.g. web-worker-console-bridge.test.ts), without
  // spawning/terminating a real worker, does not leak this interval or trip
  // Deno's op-leak sanitizer. In a real worker it runs for the worker's
  // lifetime as before.
  unrefTimer(setInterval(() => {
    const now = performance.now();
    const lag = now - expected;
    if (lag > 0) loopLagLogger.time(expected, now, "workerLag");
    expected = now + LOOP_LAG_SAMPLE_MS;
  }, LOOP_LAG_SAMPLE_MS));
}

type ConsoleMethod = (...args: unknown[]) => void;

// The worker's original console methods, saved while the bridge is installed.
// `undefined` means the bridge is off and `console` is untouched, so disabled
// forwarding adds no per-log cost.
let savedConsole: Record<WorkerConsoleLevel, ConsoleMethod> | undefined;

function formatConsoleArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  // Errors serialize to `{}` under JSON.stringify (message/stack are
  // non-enumerable), which would drop exactly the detail this bridge exists
  // to surface, so forward the stack (or name/message) instead.
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Patch the worker's `console.log`/`warn`/`error` so each call also posts a
 * `WorkerConsoleNotification` that the web-worker transport re-emits on the
 * page console. The original method is called first, so nothing is lost in the
 * worker's own console. No-op if already installed.
 */
function installWorkerConsoleBridge(): void {
  if (savedConsole) return;
  const saved: Record<WorkerConsoleLevel, ConsoleMethod> = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  savedConsole = saved;

  for (const level of WORKER_CONSOLE_LEVELS) {
    console[level] = (...args: unknown[]) => {
      saved[level].apply(console, args);
      try {
        postToClient({
          type: TransportNotificationType.WorkerConsole,
          level,
          text: args.map(formatConsoleArg).join(" "),
        });
      } catch {
        // A non-cloneable payload or a closed channel must not break the
        // logging call itself.
      }
    };
  }
}

/**
 * Restore the worker's native console methods, returning `console` to a state
 * with no forwarding overhead. No-op if the bridge is not installed.
 */
function uninstallWorkerConsoleBridge(): void {
  if (!savedConsole) return;
  for (const level of WORKER_CONSOLE_LEVELS) {
    console[level] = savedConsole[level];
  }
  savedConsole = undefined;
}

function setWorkerConsoleBridge(enabled: boolean): void {
  if (enabled) installWorkerConsoleBridge();
  else uninstallWorkerConsoleBridge();
}

// One runtime per worker, served to every client that reaches it. The owner
// speaks over the global this listener is installed on; a further client
// arrives as a port the owner transfers, and the same loop serves it.
const clients = new RuntimeClients({
  setConsoleBridge: setWorkerConsoleBridge,
});

self.addEventListener("message", (event: MessageEvent) => {
  void clients.handleMessage(clients.owner, event);
});

// `postMessage` is absent from a main-thread global, where a test importing
// this entry to drive the message handler runs.
if (
  (typeof self !== "undefined") && (typeof self.postMessage === "function")
) {
  const lifetimeLock = await holdLifetimeLock();

  // The transport's own traffic, not the runtime's: it tells the client this
  // entry has run and the listener above is installed.
  postToClient({
    type: TransportNotificationType.WorkerReady,
    ...(lifetimeLock === undefined ? {} : { lifetimeLock }),
  });
}
