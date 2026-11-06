/**
 * Helper for `RuntimeClients.test.ts`. Runs in its own process so that it can
 * force a collection (`--v8-flags=--expose-gc`) and cross a real task
 * boundary, which a `WeakRef` needs before it can report its target
 * collected.
 *
 * It has the worker's message loop handle a request whose handler throws an
 * error from a closure holding an object, as a failed piece start's error
 * holds the cells its frames were working on, lets the loop log the failure,
 * and prints one line of JSON saying whether that object could then be
 * collected: `collected`.
 */

import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import type { DID } from "@commonfabric/identity";

import type { RuntimeProcessor } from "@/backends/mod.ts";
import { RuntimeClients } from "@/backends/client-registry.ts";
import type { WorkerClient } from "@/backends/worker-client.ts";
import { type InitializationData, RequestType } from "@/protocol/mod.ts";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --v8-flags=--expose-gc");

let held: WeakRef<object> | undefined;

/** Throws from a frame whose closure holds an object, as a handler would. */
function failRequest(): never {
  const captured = { cells: new Array(1000).fill(0) };
  held = new WeakRef(captured);
  const start = () => {
    void captured.cells.length;
    throw new Error("Cannot start: no pattern identity");
  };
  start();
  throw new Error("unreachable");
}

const processor = {
  isDisposed: () => false,
  reportClientUpdateRequired: () => {},
  handleRequest: () => Promise.resolve().then(failRequest),
} as unknown as RuntimeProcessor;

const owner: WorkerClient = { id: 0, post: () => true };
const clients = new RuntimeClients({
  owner,
  setConsoleBridge: () => {},
  initializeRuntime: () => Promise.resolve(processor),
});
const deliver = (message: unknown) =>
  clients.handleMessage(
    owner,
    new MessageEvent("message", {
      data: realmFromFabricValue(message as never),
    }),
  );

await deliver({
  msgId: 1,
  data: {
    type: RequestType.Initialize,
    data: {
      apiUrl: "http://failed-request-gc.test/",
      identity: { placeholder: true },
      spaceDid: "did:key:z6Mk-failed-request-gc" as DID,
    } as unknown as InitializationData,
  },
});
// The loop logs the failure to the console, which is the record under test.
await deliver({ msgId: 2, data: { type: RequestType.Idle } });

// A `WeakRef` target reached in a turn survives that turn whatever holds it,
// so cross one task boundary before collecting. This is an event-loop yield,
// not a wait.
await new Promise((resolve) => setTimeout(resolve, 0));
gc();
gc();
console.log(JSON.stringify({ collected: held?.deref() === undefined }));
