/**
 * The receiving side of a whole-crossing benchmark: it takes what the worker
 * posted, does what that side of the connection does with it, and acks.
 *
 * Under `fixtures/` rather than beside the benchmark because a file here is
 * neither a `*.bench.ts` nor a test, and the coverage tooling counts anything
 * else in a package as source a suite failed to reach.
 *
 * The ack carries one boolean. What the benchmark wants to know is what the
 * send and this side's work cost, and a reply carrying any part of the
 * received value would put a second clone of it on the return leg and bury
 * exactly that.
 */

import type { BenchWorkerAck } from "@commonfabric/test-support/bench-worker";

import type { RealmEncodedValue } from "@commonfabric/data-model/codec-realm";
import { fabricFromRealmValue } from "@commonfabric/data-model/codecs";

import { CellHandle } from "@/cell-handle.ts";
import { $conn, type RuntimeClient } from "@/runtime-client.ts";

/** What the benchmark asks this side to do with what it sent. */
export type CrossingRequest =
  | {
    /**
     * The envelope arm: the payload is an encoding, so this side decodes it
     * before hydrating.
     */
    readonly kind: "envelope";

    /** The realm-encoded tree. */
    readonly payload: RealmEncodedValue;
  }
  | {
    /**
     * The status-quo arm: the payload arrived unencoded, as a connection
     * relying on structured cloning alone sends it, so there is nothing to
     * decode and the hydration runs on what arrived.
     */
    readonly kind: "status-quo";

    /** The bare value, as it was handed to `postMessage()`. */
    readonly payload: unknown;
  };

/**
 * A handle for the hydration to walk from. `deserialize()` reads its ref, to
 * rebase a relative link, and its client, to hand to a hydrated child -- so a
 * stand-in serves, and building a real `RuntimeClient` here would put a
 * connection this benchmark does not use behind every iteration.
 */
const base = new CellHandle(
  { [$conn]: () => ({}) } as unknown as RuntimeClient,
  {
    id: `of:${"0".repeat(64)}`,
    space: `did:key:z${"a".repeat(47)}`,
    scope: "space",
    path: [],
  },
);

self.onmessage = (ev: MessageEvent<CrossingRequest>) => {
  const request = ev.data;

  try {
    // No cast on the decode: the discriminant is what says this payload is an
    // encoding. The result is dropped, but both walks have run in full --
    // `decode()` is eager and so is the hydration, so there is no lazy
    // remainder for dropping the result to skip.
    const received = request.kind === "envelope"
      ? fabricFromRealmValue(request.payload)
      : request.payload;

    CellHandle.deserialize(base, received);

    self.postMessage({ ok: true } satisfies BenchWorkerAck);
  } catch (e) {
    self.postMessage(
      { ok: false, error: (e as Error).message } satisfies BenchWorkerAck,
    );
  }
};
