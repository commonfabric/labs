/**
 * The pass-end convergence-backoff clearing on a graph the size of a loaded
 * family root: thousands of registered nodes, a few of them backed off. The
 * clearing runs at the end of every execute pass, inside the synchronous
 * settle work that holds the event loop, so its cost scales the latency of
 * everything queued behind a pass.
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";

const signer = await Identity.fromPassphrase("bench operator");

const NODE_COUNT = 12_000;
const BACKED_OFF_COUNT = 8;
const NO_DEPENDENCIES = { reads: [], shallowReads: [], writes: [] };

const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
});
const scheduler = runtime.scheduler;
const internal = scheduler.accessForTestingOnly;

// Every node is clean, and the backed-off ones are dirty: a dirty node keeps
// its backoff through the clearing, so one setup serves every sample.
for (let index = 0; index < NODE_COUNT; index++) {
  const action: Action = () => {};
  scheduler.subscribe(action, NO_DEPENDENCIES, {});
  const backedOff = index < BACKED_OFF_COUNT;
  internal.nodes.setStatus(action, backedOff ? "invalid" : "clean");
  if (backedOff) {
    internal.gates.holdInitialRun(action, performance.now() + 3_600_000);
  }
}

Deno.bench(
  "clear backoff for clean nodes",
  { group: "scheduler-backoff-clearing" },
  () => {
    internal.clearBackoffForCleanNodes();
  },
);
