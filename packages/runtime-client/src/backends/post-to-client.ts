import { debugStr } from "@commonfabric/data-model";
import { realmFromFabricValue } from "@commonfabric/data-model/codecs";

import { type IPCRemotePost, NotificationType } from "@/protocol/mod.ts";
import { describeFailure } from "@/shared/utils.ts";

/**
 * Posts one message from the worker to its client, reporting whether what was
 * asked for is what went. This is the whole of the worker's outbound side:
 * every response, error, and notification crosses here, and is encoded here.
 *
 * `false` says a substitute went instead, the encoding having refused the
 * message. A caller that records what it answered needs to know which, so that
 * a failure is not counted as the reply it replaced.
 *
 * The message is encoded whole rather than field by field, which is what lets
 * a payload carry the entire `FabricValue` domain -- a `bigint` as itself, a
 * `FabricBytes` as bytes, an instance with its class -- where structured clone
 * alone would strip an instance to `{}`. The envelope is a record of fabric
 * values and so is a `FabricValue` itself, which is what makes encoding it
 * whole well-defined.
 *
 * No `LiveEnvironment` is given, so a value that asks for a cell throws here.
 * Nothing should: `convertCellsToLinks()` turns every live cell into a link
 * before a payload reaches this point, and a throw would say that something
 * does not.
 */
export function postToClient(message: IPCRemotePost): boolean {
  // `self` is read at call time rather than captured at module load, so that a
  // test driving this without a real worker can substitute its own.
  return postThrough((encoded) => self.postMessage(encoded), message);
}

/**
 * Posts one message through `send`, which is what a client other than the
 * worker's owner is reached by: its own port rather than the worker's global.
 * Everything the doc above says of {@link postToClient} is said of this, which
 * is where it happens.
 */
export function postThrough(
  send: (encoded: unknown) => void,
  message: IPCRemotePost,
): boolean {
  try {
    send(realmFromFabricValue(message));
    return true;
  } catch (error) {
    // Defense in depth, and the mirror of the two decodes. Both steps above
    // can refuse: a value can pass every `FabricValue` check and still have
    // no encoding -- an object forged onto a `FabricPrimitive`'s prototype is
    // one -- and the post can fail for reasons no encoding anticipates. One
    // guard covers both because the answer is the same either way.
    //
    // This is the only place a worker speaks, and the notification paths
    // reach it from a `queueMicrotask` callback, outside any caller's `try`,
    // where a throw is an uncaught error rather than something that becomes
    // an error reply. Losing one message loudly beats taking the worker's
    // dispatch with it.
    send(realmFromFabricValue(undeliverableMessageFrom(message, error)));
    return false;
  }
}

/**
 * Builds what stands in for a message the encoding refused.
 *
 * A reply is answered as a failure rather than dropped: the client is awaiting
 * one, and dropping it would leave that request pending until disposal. A
 * notification has nobody waiting, so it becomes an error report carrying a
 * rendering of what could not be sent -- degraded rather than silent, which
 * matters most for the console, whose whole job is to say what happened.
 *
 * What this returns is built from strings and numbers alone, which neither
 * the encoding nor `postMessage` can refuse, so the caller sends it without a
 * guard of its own.
 */
function undeliverableMessageFrom(
  message: IPCRemotePost,
  error: unknown,
): IPCRemotePost {
  const reason = debugStr`Undeliverable message: ${
    describeFailure(error)
  }: $quote,long${message}`;
  const msgId = (message as { msgId?: unknown }).msgId;

  return typeof msgId === "number"
    ? { msgId, error: reason }
    : { type: NotificationType.ErrorReport, message: reason };
}
