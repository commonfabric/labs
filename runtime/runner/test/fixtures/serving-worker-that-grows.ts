/**
 * The runner's serving worker entry, whose heap grows without bound in a
 * message handler once the pool first tells its host of a space, so that the
 * worker reaches any heap limit while it serves (`serving-worker.test.ts`).
 * Only the first worker to start does: it creates the file the `marker`
 * parameter of this module's URL names, and a worker that finds the file
 * serves as the runner's entry does.
 */

import "../../src/executor/serving-worker.ts";
import { servingWorkerPort } from "../../src/executor/serving-thread.ts";

const marker = new URL(import.meta.url).searchParams.get("marker");
if (marker === null) throw new Error("the module URL names no marker file");
let first = true;
try {
  Deno.writeTextFileSync(marker, "", { createNew: true });
} catch (error) {
  if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  first = false;
}
if (first) {
  const held: number[][] = [];
  const port = servingWorkerPort();
  const grow = (event: MessageEvent) => {
    if (!JSON.stringify(event.data).includes("observer.")) return;
    port.removeEventListener("message", grow);
    for (;;) held.push(new Array(1_000_000).fill(Math.random()));
  };
  port.addEventListener("message", grow);
}
