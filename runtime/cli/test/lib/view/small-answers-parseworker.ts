/**
 * A parse worker that sends any result holding more than four spans and
 * structure nodes in parts, so that a test can show the pager puts a result
 * sent in parts back together as the worker had it.
 */

import {
  type ParseWorkerMessage,
  parseWorkerReceiver,
} from "../../../lib/view/backgroundparse.ts";

const receive = parseWorkerReceiver(
  (answer) => self.postMessage(answer),
  undefined,
  4,
);

self.onmessage = (event: MessageEvent<ParseWorkerMessage>) =>
  receive(event.data);
