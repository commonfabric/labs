/**
 * A serving worker's thread that, given a run beacon and a gate, runs a body
 * that holds the thread until the gate opens, marking the beacon as a serving
 * runtime's scheduler does and posting what the run's number stands for before
 * the body starts; it posts `released` once the body has returned
 * (`serving-thread.test.ts`).
 */

import { RunBeacon } from "../../src/executor/run-beacon.ts";
import { servingWorkerPort } from "../../src/executor/serving-thread.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";

const port = servingWorkerPort();
port.addEventListener("message", (event: MessageEvent) => {
  const { beacon, gate } = event.data as {
    beacon: SharedArrayBuffer;
    gate: SharedArrayBuffer;
  };
  const marks = new RunBeacon(
    beacon,
    (identity) => port.postMessage(identity),
    () => {},
  ).forSpace("did:key:z6MkServingThreadBeacon" as MemorySpace);
  marks.hold(() => {}, "held", () => {
    Atomics.wait(new Int32Array(gate), 0, 0);
  });
  port.postMessage("released");
});
port.postMessage("listening");
