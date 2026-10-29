/**
 * The worker side of a DOM-event crossing: it decodes what the main thread
 * posted, does what the event ingress does with it, and acks.
 *
 * Under `fixtures/` rather than beside the benchmark because a file here is
 * neither a `*.bench.ts` nor a test, and the coverage tooling counts anything
 * else in a package as source a suite failed to reach.
 *
 * The ack carries one boolean. What the benchmark wants to know is what the
 * send and this side's work cost, and a reply carrying any part of the received
 * event would put a second clone of it on the return leg and bury exactly that.
 */

import type { BenchWorkerAck } from "@commonfabric/test-support/bench-worker";

import type { RealmEncodedValue } from "@commonfabric/data-model/codec-realm";
import { fabricFromRealmValue } from "@commonfabric/data-model/codecs";
import { stripSigilCfcLabelViews } from "@commonfabric/runner/cfc";

/** What the benchmark posts, in the shape the connection posts it. */
export type EventRequest = {
  /** The `dom-event` message, encoded as the transport encodes it. */
  readonly payload: RealmEncodedValue;
};

self.onmessage = (ev: MessageEvent<EventRequest>) => {
  try {
    // What `handleVDomEvent()` does before the reconciler sees the event: the
    // transport's decode, then the ingress strip that keeps a main-thread
    // label view from becoming worker label state.
    const message = fabricFromRealmValue(ev.data.payload) as {
      event: unknown;
    };

    stripSigilCfcLabelViews(message.event);

    self.postMessage({ ok: true } satisfies BenchWorkerAck);
  } catch (e) {
    self.postMessage(
      { ok: false, error: (e as Error).message } satisfies BenchWorkerAck,
    );
  }
};
