/**
 * The far side of a `postMessage()` benchmark: it receives what was sent, does
 * what the message asks, and acks.
 *
 * Lives under `fixtures/` rather than beside the benchmarks because a file
 * here is neither a `*.bench.ts` nor a test, and the coverage tooling counts
 * anything else under `packages/` as source a suite failed to reach.
 *
 * The ack carries one boolean and nothing else. What a benchmark wants to know
 * is what the send and the far-side work cost, and a reply carrying any part
 * of the decoded value would put a second clone of it on the return leg and
 * bury exactly that.
 */

import type { BenchWorkerAck } from "@commonfabric/test-support/bench-worker";

import type { RealmEncodedValue } from "@/codec-realm";
import { fabricFromRealmValue } from "@/codecs.ts";

/**
 * What a benchmark asks the far side to do with what it sent.
 *
 * Discriminated on `kind` rather than widened to cover both payload shapes:
 * `RealmEncodedValue | unknown` is just `unknown`, the top type absorbing
 * every other member, which would let a `decode` request carry anything at all
 * without a compile error and leave the far side casting on faith.
 */
export type IpcRequest =
  | {
    /**
     * `decode` reconstructs the value; `clone` leaves it alone, so that the
     * difference between the two is the decode and nothing else.
     */
    readonly kind: "decode" | "clone";

    /** The realm-encoded tree. */
    readonly payload: RealmEncodedValue;
  }
  | {
    /**
     * Neither: the payload arrived unencoded, as a connection relying on
     * structured cloning alone sends it, and there is nothing for this side
     * to do -- which is the point, that being the whole of that far side's
     * work.
     */
    readonly kind: "status-quo";

    /** The bare value, as it was handed to `postMessage()`. */
    readonly payload: unknown;
  };

self.onmessage = (ev: MessageEvent<IpcRequest>) => {
  const request = ev.data;

  try {
    if (request.kind === "decode") {
      // The result is dropped, but the walk has run in full: `decode()` is
      // eager, so there is no lazy remainder for dropping it to skip. No cast:
      // the discriminant is what says this payload is an encoding.
      fabricFromRealmValue(request.payload);
    }
    // `clone` and `status-quo` both do nothing here, for different reasons:
    // the first to isolate the decode, the second because the old far side
    // genuinely had no work to do.

    self.postMessage({ ok: true } satisfies BenchWorkerAck);
  } catch (e) {
    self.postMessage(
      { ok: false, error: (e as Error).message } satisfies BenchWorkerAck,
    );
  }
};
