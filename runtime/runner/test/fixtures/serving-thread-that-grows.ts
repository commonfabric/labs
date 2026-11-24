/**
 * A serving worker's thread that posts, on a timer, whether its heap has
 * reached its limit, as a serving worker's heartbeat does, and on a message
 * does what the message names (`serving-thread.test.ts`):
 *
 * - `handler`: grows its heap without bound in the message's handler;
 * - `continuation`: grows it without bound in a promise's continuation;
 * - `hold`: keeps 20 MB, and answers `held`;
 * - anything else: answers with the same data.
 */

import {
  servingWorkerPort,
  watchHeapLimit,
} from "../../src/executor/serving-thread.ts";

const port = servingWorkerPort();
const heapLimitReached = watchHeapLimit();
const held: unknown[] = [];

/** Grows the heap with small objects until something stops it. */
const grow = (): never => {
  for (;;) held.push({ at: held.length, of: [held.length] });
};

setInterval(
  () => port.postMessage({ heapLimitReached: heapLimitReached() }),
  20,
);
port.addEventListener("message", (event: MessageEvent) => {
  if (event.data === "handler") grow();
  if (event.data === "continuation") {
    Promise.resolve().then(grow);
    return;
  }
  if (event.data === "hold") {
    for (let i = 0; i < 20; i++) held.push(new Array(125_000).fill(i + 0.5));
    port.postMessage("held");
    return;
  }
  port.postMessage({ echo: event.data });
});
port.postMessage("listening");
