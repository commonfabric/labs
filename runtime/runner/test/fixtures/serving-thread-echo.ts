/**
 * A serving worker's thread that answers each message on its port with the
 * same data, and `exit` by exiting (`serving-thread.test.ts`).
 */

import { servingWorkerPort } from "../../src/executor/serving-thread.ts";

const port = servingWorkerPort();
port.addEventListener("message", (event: MessageEvent) => {
  if (event.data === "exit") Deno.exit(3);
  port.postMessage({ echo: event.data });
});
port.postMessage("listening");
