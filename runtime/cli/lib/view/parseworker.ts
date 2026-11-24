/**
 * A parse worker's entry: loaded in a Deno Worker by `workerParser`, it gives
 * each message the pager sends to a {@link parseWorkerReceiver}, which sends
 * the pager each outcome once the pager has read the one before. The
 * protocol is in `backgroundparse.ts`; nothing outside a worker imports this
 * module.
 */

import {
  type ParseWorkerMessage,
  parseWorkerReceiver,
} from "./backgroundparse.ts";

const receive = parseWorkerReceiver((answer) => self.postMessage(answer));

self.onmessage = (event: MessageEvent<ParseWorkerMessage>) =>
  receive(event.data);
