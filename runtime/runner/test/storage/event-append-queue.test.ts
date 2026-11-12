import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { getLoggerCountsBreakdown } from "@commonfabric/logger";
import type { ClientCommit } from "@commonfabric/memory/v2";

import {
  EventAppendQueue,
  type EventAppendQueueStore,
  memoryEventAppendQueueStore,
  type QueuedEventAppend,
} from "../../src/storage/event-append-queue.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";

const space: MemorySpace = "did:key:z6Mk-event-append-queue";

const appendOf = (
  eventId: string,
  stream = "flood",
): Omit<QueuedEventAppend, "clientSeq"> => ({
  sidecarId: `of:stream-events:${stream}`,
  stream: { id: "of:stream", path: ["s"] },
  eventId,
  payload: { eventId },
});

/** The event ids of the appends `commits` carried, in the order sent. */
const sentIds = (commits: ClientCommit[]) =>
  commits.map((commit) => commit.eventAppends?.[0]?.eventId);

/** A queue over `store` and `pacing`, recording each commit it sends. */
const recordingQueue = (
  options: {
    store?: EventAppendQueueStore;
    pacing?: { ratePerSecond: number; burst: number } | false;
  } = {},
) => {
  const commits: ClientCommit[] = [];
  let localSeq = 1;
  const queue = new EventAppendQueue({
    space,
    transact: (commit: ClientCommit) => {
      commits.push(commit);
      return Promise.resolve();
    },
    nextLocalSeq: () => localSeq++,
    ...options,
  });
  return { queue, commits };
};

/** How many warnings `messageKey` has logged on the queue's logger. */
const warnings = (messageKey: string): number =>
  (getLoggerCountsBreakdown()["event-append-queue"]?.[messageKey] as
    | { warn?: number }
    | undefined)?.warn ?? 0;

/**
 * Runs `body` with `console.warn` captured rather than printed, and returns
 * the text of each warning it printed.
 */
const capturingWarnings = async (body: () => Promise<void>) => {
  const warn = console.warn;
  const printed: string[] = [];
  console.warn = (...args: unknown[]) => printed.push(args.join(" "));
  try {
    await body();
  } finally {
    console.warn = warn;
  }
  return printed;
};

describe("EventAppendQueue", () => {
  describe("constructor()", () => {
    it("runs unpaced, warning once, for pacing whose rate or burst cannot pace", async () => {
      const invalid = [
        { ratePerSecond: 0, burst: 1 },
        { ratePerSecond: Infinity, burst: 1 },
        { ratePerSecond: 1, burst: 0.5 },
      ];
      for (const pacing of invalid) {
        const printed = await capturingWarnings(async () => {
          const before = warnings("event-queue-pacing-invalid");
          const { queue, commits } = recordingQueue({ pacing });
          const outcomes = await Promise.all(
            ["a", "b", "c"].map((id) => queue.enqueue(appendOf(id))),
          );
          expect(warnings("event-queue-pacing-invalid")).toBe(before + 1);
          expect(outcomes).toEqual([
            { delivered: true },
            { delivered: true },
            { delivered: true },
          ]);
          expect(sentIds(commits)).toEqual(["a", "b", "c"]);
          expect(queue.pacedHoldCount).toBe(0);
          queue.close();
        });
        expect(printed).toEqual([
          expect.stringContaining(
            `(ratePerSecond=${pacing.ratePerSecond}, burst=${pacing.burst}); running UNPACED`,
          ),
        ]);
      }
    });

    it("does not warn for pacing that can pace", async () => {
      const before = warnings("event-queue-pacing-invalid");
      const { queue } = recordingQueue({
        pacing: { ratePerSecond: 1, burst: 1 },
      });
      await queue.loaded;
      expect(warnings("event-queue-pacing-invalid")).toBe(before);
      queue.close();
    });

    it("warns and still delivers what it is given when the store fails to load its backlog", async () => {
      const printed = await capturingWarnings(async () => {
        const before = warnings("event-queue-load-failed");
        const failing: EventAppendQueueStore = {
          load: () => Promise.reject(new Error("store unavailable")),
          save: () => Promise.resolve(),
        };
        const { queue, commits } = recordingQueue({
          store: failing,
          pacing: false,
        });
        await queue.loaded;
        expect(warnings("event-queue-load-failed")).toBe(before + 1);

        expect(await queue.enqueue(appendOf("after-failed-load"))).toEqual({
          delivered: true,
        });
        expect(sentIds(commits)).toEqual(["after-failed-load"]);
        queue.close();
      });
      expect(printed).toEqual([
        expect.stringContaining(
          `event queue load for ${space} failed; queued intents from a replaced predecessor replica (if any) are not recovered Error: store unavailable`,
        ),
      ]);
    });
  });

  describe("instance members", () => {
    describe("enqueue()", () => {
      it("sends an entry enqueued as the one before it settles", async () => {
        // The second entry is queued from the first one's outcome, which
        // the queue settles as its loop finds nothing else to send.

        const { queue, commits } = recordingQueue({
          store: memoryEventAppendQueueStore(),
          pacing: false,
        });
        const second = await queue.enqueue(appendOf("first")).then(() =>
          queue.enqueue(appendOf("second"))
        );
        expect(second).toEqual({ delivered: true });
        expect(sentIds(commits)).toEqual(["first", "second"]);
        expect(queue.pending).toEqual([]);
        queue.close();
      });

      it("sends an entry its refusal callback enqueues as the loop winds down", async () => {
        // The refusal of the first entry is reported from inside the loop's
        // last step, so the second entry is queued after the loop has looked
        // at the queue for the last time and before it has finished.

        const commits: ClientCommit[] = [];
        let localSeq = 1;
        let second: Promise<unknown> | undefined;
        const queue: EventAppendQueue = new EventAppendQueue({
          space,
          store: memoryEventAppendQueueStore(),
          pacing: false,
          transact: (commit: ClientCommit) => {
            commits.push(commit);
            if (commits.length > 1) return Promise.resolve();
            const refusal = new Error("refused");
            refusal.name = "ProtocolError";
            return Promise.reject(refusal);
          },
          nextLocalSeq: () => localSeq++,
          onRefused: () => {
            second = queue.enqueue(appendOf("second"));
          },
        });

        await queue.enqueue(appendOf("first"));

        expect(await second).toEqual({ delivered: true });
        expect(sentIds(commits)).toEqual(["first", "second"]);
        expect(queue.pending).toEqual([]);
        queue.close();
      });
    });
  });
});
