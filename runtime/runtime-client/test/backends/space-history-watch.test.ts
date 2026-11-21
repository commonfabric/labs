/**
 * `RuntimeProcessor.handleSpaceHistoryWatch()`, driven against a storage
 * stand-in whose provider hands its seq observers to the test, so that a case
 * reports a seq itself and reads what each client was posted.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { WorkerClient } from "@/backends/worker-client.ts";
import { NotificationType, RequestType } from "@/protocol/mod.ts";
import { buildProcessor } from "./build-processor.ts";

const space = "did:key:z6Mk-history-watch-space";
const otherSpace = "did:key:z6Mk-history-watch-other";

type Watch = { space: string; observer: (seq: number) => void };

/**
 * A runtime stand-in whose providers record each observer they are given and
 * each one cancelled. A cancelled observer stays callable, so a case can show
 * what the processor does with a report that arrives after the cancel.
 */
const watchingRuntime = (options: { serveHistory?: boolean } = {}) => {
  const watches: Watch[] = [];
  const cancelled: Watch[] = [];
  const runtime = {
    storageManager: {
      open: (opened: string) =>
        options.serveHistory === false ? {} : {
          subscribeServerSeq: (observer: (seq: number) => void) => {
            const watch = { space: opened, observer };
            watches.push(watch);
            return () => cancelled.push(watch);
          },
        },
      synced: () => Promise.resolve(),
    },
    dispose: () => Promise.resolve(),
    releaseUnreadDocuments: () => Promise.resolve(),
  };
  return { runtime, watches, cancelled };
};

const postingClient = (id: number) => {
  const posted: unknown[] = [];
  const client: WorkerClient = {
    id,
    post: (message) => {
      posted.push(message);
      return true;
    },
  };
  return { client, posted };
};

const watchRequest = (watched: string, watch: boolean) => ({
  type: RequestType.SpaceHistoryWatch as const,
  space: watched as never,
  watch,
});

describe("RuntimeProcessor", () => {
  describe("instance members", () => {
    describe("handleSpaceHistoryWatch()", () => {
      it("posts each seq the space's provider reports to the watching client", () => {
        const { runtime, watches } = watchingRuntime();
        const processor = buildProcessor({ runtime });
        const { client, posted } = postingClient(1);

        processor.handleSpaceHistoryWatch(watchRequest(space, true), client);
        watches[0].observer(4);
        watches[0].observer(7);

        expect(watches.map((watch) => watch.space)).toEqual([space]);
        expect(posted).toEqual([
          { type: NotificationType.SpaceSeqAdvanced, space, seq: 4 },
          { type: NotificationType.SpaceSeqAdvanced, space, seq: 7 },
        ]);
      });

      it("is routed by `handleRequest()` to the asking client", async () => {
        const { runtime, watches } = watchingRuntime();
        const processor = buildProcessor({ runtime });
        const { client, posted } = postingClient(1);

        await processor.handleRequest(watchRequest(space, true), client);
        watches[0].observer(2);

        expect(posted).toEqual([
          { type: NotificationType.SpaceSeqAdvanced, space, seq: 2 },
        ]);
      });

      it("subscribes once for a repeated watch by the same client", () => {
        const { runtime, watches } = watchingRuntime();
        const processor = buildProcessor({ runtime });
        const { client } = postingClient(1);

        processor.handleSpaceHistoryWatch(watchRequest(space, true), client);
        processor.handleSpaceHistoryWatch(watchRequest(space, true), client);

        expect(watches).toHaveLength(1);
      });

      it("posts a space's seq only to the clients that watch it", () => {
        const { runtime, watches } = watchingRuntime();
        const processor = buildProcessor({ runtime });
        const first = postingClient(1);
        const second = postingClient(2);
        const third = postingClient(3);

        processor.handleSpaceHistoryWatch(
          watchRequest(space, true),
          first.client,
        );
        processor.handleSpaceHistoryWatch(
          watchRequest(otherSpace, true),
          second.client,
        );
        watches[0].observer(3);

        expect(first.posted).toHaveLength(1);
        expect(second.posted).toEqual([]);
        expect(third.posted).toEqual([]);
      });

      it("cancels the client's watch of the space when asked to stop, and keeps another client's", () => {
        const { runtime, watches, cancelled } = watchingRuntime();
        const processor = buildProcessor({ runtime });
        const first = postingClient(1);
        const second = postingClient(2);
        processor.handleSpaceHistoryWatch(
          watchRequest(space, true),
          first.client,
        );
        processor.handleSpaceHistoryWatch(
          watchRequest(space, true),
          second.client,
        );

        processor.handleSpaceHistoryWatch(
          watchRequest(space, false),
          first.client,
        );

        expect(cancelled).toEqual([watches[0]]);
      });

      it("watches again after a stop", () => {
        const { runtime, watches } = watchingRuntime();
        const processor = buildProcessor({ runtime });
        const { client } = postingClient(1);
        processor.handleSpaceHistoryWatch(watchRequest(space, true), client);
        processor.handleSpaceHistoryWatch(watchRequest(space, false), client);

        processor.handleSpaceHistoryWatch(watchRequest(space, true), client);

        expect(watches).toHaveLength(2);
      });

      it("returns without effect when asked to stop a watch it does not hold", () => {
        const { runtime, cancelled } = watchingRuntime();
        const processor = buildProcessor({ runtime });
        const { client } = postingClient(1);

        expect(() =>
          processor.handleSpaceHistoryWatch(watchRequest(space, false), client)
        ).not.toThrow();
        expect(cancelled).toEqual([]);
      });

      it("throws for a space that is not a DID", () => {
        const { runtime } = watchingRuntime();
        const processor = buildProcessor({ runtime });
        const { client } = postingClient(1);

        expect(() =>
          processor.handleSpaceHistoryWatch(
            watchRequest("not-a-did", true),
            client,
          )
        ).toThrow("space history requires a space DID");
      });

      it("throws for a space whose storage serves no history", () => {
        const { runtime } = watchingRuntime({ serveHistory: false });
        const processor = buildProcessor({ runtime });
        const { client } = postingClient(1);

        expect(() =>
          processor.handleSpaceHistoryWatch(watchRequest(space, true), client)
        ).toThrow("the space's storage serves no history");
      });

      it("cancels a departed client's watches, and posts it nothing after", () => {
        const { runtime, watches, cancelled } = watchingRuntime();
        const processor = buildProcessor({ runtime });
        const first = postingClient(1);
        const second = postingClient(2);
        processor.handleSpaceHistoryWatch(
          watchRequest(space, true),
          first.client,
        );
        processor.handleSpaceHistoryWatch(
          watchRequest(space, true),
          second.client,
        );

        processor.disposeClient(first.client);
        watches[0].observer(5);
        watches[1].observer(5);

        expect(cancelled).toEqual([watches[0]]);
        expect(first.posted).toEqual([]);
        expect(second.posted).toHaveLength(1);
      });

      it("cancels every watch when the processor is disposed, and posts nothing after", async () => {
        const { runtime, watches, cancelled } = watchingRuntime();
        const processor = buildProcessor({ runtime });
        const { client, posted } = postingClient(1);
        processor.handleSpaceHistoryWatch(watchRequest(space, true), client);
        processor.handleSpaceHistoryWatch(
          watchRequest(otherSpace, true),
          client,
        );

        await processor.dispose();
        watches[0].observer(5);

        expect(cancelled).toEqual(watches);
        expect(posted).toEqual([]);
      });
    });
  });
});
