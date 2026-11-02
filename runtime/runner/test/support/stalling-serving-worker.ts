/**
 * A serving worker's entry module whose verb named `stall` stops the worker's
 * thread for good, inside its host's wave cycle and holding the space's lease,
 * as an action that never returns does. Every other verb runs and returns
 * `served`.
 */

import type { PortLike } from "../../src/executor/serving-port-protocol.ts";
import { serveFromPort } from "../../src/executor/serving-worker-main.ts";

serveFromPort(self as unknown as PortLike, {
  runLifecycleVerb: async (host, space, verb) => {
    const receipt = await host.runLifecycleVerb(space, {
      name: verb.name,
      run: () => {
        if (verb.name === "stall") {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        return Promise.resolve("served");
      },
    });
    return { receipt, timings: [] };
  },
});
