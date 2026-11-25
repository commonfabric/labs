import { expect } from "@std/expect";

import type { ClientCommit } from "@commonfabric/memory/v2";
import { describe, it } from "@commonfabric/test-support/test";

import { EventAppendQueue } from "../../src/storage/event-append-queue.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";

const space: MemorySpace = "did:key:z6Mk-event-append-queue-eviction";

describe("EventAppendQueue", () => {
  describe("instance members", () => {
    describe("enqueue()", () => {
      it("forgets the buckets of streams that have refilled once it holds more than 64, and none that have not", async () => {
        // Each stream sends once, spending the one token its bucket starts
        // with; a bucket refills in a second of the queue's clock.

        let clock = 0;
        const sent: (string | undefined)[] = [];
        let localSeq = 1;
        const queue = new EventAppendQueue({
          space,
          transact: (commit: ClientCommit) => {
            sent.push(commit.eventAppends?.[0]?.eventId);
            return Promise.resolve();
          },
          nextLocalSeq: () => localSeq++,
          pacing: { ratePerSecond: 1, burst: 1, now: () => clock },
        });
        const send = (stream: number) =>
          queue.enqueue({
            sidecarId: `of:stream-events:stream-${stream}`,
            stream: { id: `of:stream-${stream}`, path: [] },
            eventId: `event-${stream}`,
            payload: { stream },
          });

        for (let stream = 0; stream < 70; stream++) {
          expect(await send(stream)).toEqual({ delivered: true });
        }
        expect(queue.accessForTestingOnly.buckets.size).toBe(70);

        clock = 1_000;
        expect(await send(70)).toEqual({ delivered: true });

        expect(queue.accessForTestingOnly.buckets.size).toBe(1);
        expect(sent).toHaveLength(71);
        expect(queue.pacedHoldCount).toBe(0);
        queue.close();
      });
    });
  });
});
