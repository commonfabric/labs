/**
 * A compile worker that compiles nothing (`module-compile-worker.test.ts`).
 * It answers a request for a program whose entry is `/garbled.ts` with an
 * answer that does not decode, a request for `/stranger.ts` under an id it
 * was never sent, and every other request with no modules.
 */

import { isPlainObject } from "@commonfabric/js-values/types";

const diagnostics = {
  timeOrigin: performance.timeOrigin,
  timingStats: {},
  loggerCounts: {},
};

self.addEventListener("message", (event: MessageEvent) => {
  const data: unknown = event.data;
  if (
    !isPlainObject(data) || typeof data.id !== "number" ||
    !isPlainObject(data.request) || !isPlainObject(data.request.program)
  ) {
    throw new Error("This compile worker was sent no request");
  }
  const { id } = data;
  const main = data.request.program.main;
  if (main === "/garbled.ts") {
    self.postMessage({ kind: "compiled", id });
  } else if (main === "/stranger.ts") {
    self.postMessage({
      kind: "compiled",
      id: id + 1000,
      modules: [],
      diagnostics,
    });
  } else {
    self.postMessage({ kind: "compiled", id, modules: [], diagnostics });
  }
});

self.postMessage({ kind: "ready" });
