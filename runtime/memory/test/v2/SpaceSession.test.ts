import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import { defer } from "@commonfabric/utils/defer";

import {
  type ClientMessage,
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type ServerMessage,
  type WatchAddRequest,
  type WatchRemoveRequest,
  type WatchSetRequest,
  type WatchSpec,
} from "../../v2.ts";
import {
  type Client,
  connect,
  loopback,
  type SpaceSession,
  type Transport,
} from "../../v2/client.ts";
import { Server } from "../../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "../v2-auth-test-helpers.ts";

/**
 * Builds a loopback with explicit watch-response holds and a failure of the
 * next removal, whether it replaces the watch set or names watch ids.
 */
function controlledWatchLoopback(server: Server) {
  const inner = loopback(server);
  const requests: Array<
    WatchSetRequest | WatchAddRequest | WatchRemoveRequest
  > = [];
  const holds = new Map<string, ReturnType<typeof defer<() => void>>>();
  let nextAddHold: ReturnType<typeof defer<() => void>> | undefined;
  let failNextRemoval = false;
  let receiver = (_payload: string) => {};
  const transport: Transport = {
    send(payload) {
      const message = decodeMemoryBoundary(payload) as ClientMessage;
      if (
        message.type === "session.watch.set" ||
        message.type === "session.watch.add" ||
        message.type === "session.watch.remove"
      ) {
        requests.push(message);
        if (message.type !== "session.watch.add" && failNextRemoval) {
          failNextRemoval = false;
          receiver(encodeMemoryBoundary({
            type: "response",
            requestId: message.requestId,
            error: { name: "Error", message: "injected cleanup failure" },
          }));
          return Promise.resolve();
        }
        if (message.type === "session.watch.add" && nextAddHold) {
          holds.set(message.requestId, nextAddHold);
          nextAddHold = undefined;
        }
      }
      return inner.send(payload);
    },
    close: () => inner.close(),
    setReceiver(next) {
      receiver = next;
      inner.setReceiver((payload) => {
        const message = decodeMemoryBoundary(payload) as ServerMessage;
        const hold = message.type === "response"
          ? holds.get(message.requestId)
          : undefined;
        if (hold && message.type === "response") {
          holds.delete(message.requestId);
          hold.resolve(() => receiver(payload));
        } else {
          receiver(payload);
        }
      });
    },
    setCloseReceiver: (next) => inner.setCloseReceiver?.(next),
  };
  return {
    transport,
    requests,
    failNextRemoval() {
      failNextRemoval = true;
    },
    holdNextAddResponse() {
      nextAddHold = defer<() => void>();
      return nextAddHold.promise;
    },
  };
}

/** Watches the whole document under a distinct subscription id. */
function rootSpec(id: string): WatchSpec {
  return {
    id,
    kind: "graph",
    query: { roots: [{ id, selector: { path: [], schema: false } }] },
  };
}

describe("SpaceSession", () => {
  const space = "did:key:z6Mk-watch-removal-order";
  let server: Server;
  let control: ReturnType<typeof controlledWatchLoopback>;
  let watcherClient: Client;
  let writerClient: Client;
  let watcher: SpaceSession;
  let writer: SpaceSession;

  beforeEach(async () => {
    server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://watch-removal-order"),
      subscriptionRefreshDelayMs: "manual",
    });
    control = controlledWatchLoopback(server);
    watcherClient = await connect({ transport: control.transport });
    writerClient = await connect({ transport: loopback(server) });
    watcher = await watcherClient.mount(space, {}, testSessionOpenAuthFactory);
    writer = await writerClient.mount(space, {}, testSessionOpenAuthFactory);
  });

  afterEach(async () => {
    await watcherClient.close();
    await writerClient.close();
    await server.close();
  });

  describe("instance members", () => {
    describe("ack()", () => {
      it("deduplicates acknowledged sequences without suppressing later progress", async () => {
        const first = await server.writeDocument(space, "of:ack", { n: 1 });
        expect(first.seq).toBeGreaterThan(0);
        using acknowledgments = spy(server, "ackSession");

        await watcher.ack(first.seq);
        await watcher.ack(first.seq);
        await watcher.ack(first.seq - 1);
        await watcher.ack(first.seq);

        const next = await server.writeDocument(space, "of:ack", { n: 2 });
        expect(next.seq).toBeGreaterThan(first.seq);
        await watcher.ack(next.seq);
        expect(acknowledgments.calls.map(({ args: [message] }) => ({
          sessionId: message.sessionId,
          seenSeq: message.seenSeq,
        }))).toEqual([
          { sessionId: watcher.sessionId, seenSeq: first.seq },
          { sessionId: watcher.sessionId, seenSeq: next.seq },
        ]);
      });
    });

    describe("watchRemoveSync()", () => {
      for (
        const [byId, concurrent] of [
          [true, false],
          [true, true],
          [false, false],
          [false, true],
        ]
      ) {
        describe(
          `${
            byId ? "by id" : "by replacing the set"
          }, with concurrent refresh ${concurrent ? "enabled" : "disabled"}`,
          () => {
            for (const retry of [false, true]) {
              it(`keeps earlier and later acquisitions subscribed during ${retry ? "a cleanup retry" : "cleanup"}`, async () => {
                if (!byId) watcherClient.serverFlags!.watchRemoveV1 = false;
                watcher.setConcurrentWatchRefresh(concurrent);
                const temporary = "of:temporary";
                const retained = ["of:kept", "of:earlier", "of:later"];
                await watcher.watchSetSync([
                  rootSpec(temporary),
                  rootSpec(retained[0]),
                ]);
                if (retry) {
                  control.failNextRemoval();
                  await expect(watcher.watchRemoveSync([temporary]))
                    .rejects.toThrow("injected cleanup failure");
                }

                const held = control.holdNextAddResponse();
                const earlier = watcher.watchAddSync([rootSpec(retained[1])]);
                const release = await held;
                // The server has installed the earlier watch, but the client
                // has not applied its response when we queue removal.
                const removal = watcher.watchRemoveSync([temporary]);
                const later = watcher.watchAddSync([rootSpec(retained[2])]);
                release();
                const [, , { view }] = await Promise.all([
                  earlier,
                  removal,
                  later,
                ]);

                const updates = view.subscribe();
                await writer.transact({
                  localSeq: 1,
                  reads: { confirmed: [], pending: [] },
                  operations: [...retained, temporary].map((id) => ({
                    op: "set" as const,
                    id,
                    value: { value: { n: 1 } },
                  })),
                });
                await server.flushSessions([space]);
                // Name the arrival (docs/development/waiting-in-tests.md): a
                // second write to the root that stayed watched throughout marks
                // the end of the fan-out. Frames deliver in order, so once the
                // marker lands every frame the first flush owed has landed too,
                // and a root the removal dropped is missing rather than late.
                const marker = retained[0];
                await writer.transact({
                  localSeq: 2,
                  reads: { confirmed: [], pending: [] },
                  operations: [{
                    op: "set" as const,
                    id: marker,
                    value: { value: { n: 2 } },
                  }],
                });
                await server.flushSessions([space]);
                const nOf = (id: string) =>
                  (view.entities.find((entity) => entity.id === id)?.document as
                    | { value?: { n?: number } }
                    | undefined)?.value?.n;
                while (nOf(marker) !== 2) {
                  const next = await updates.next();
                  expect(next.done).toBe(false);
                }
                expect(view.entities.map(({ id }) => id).sort()).toEqual(
                  [...retained].sort(),
                );
                for (const entity of view.entities) {
                  expect(entity.document).toEqual({
                    value: { n: entity.id === marker ? 2 : 1 },
                  });
                }

                const [first, removed, last] = control.requests.slice(-3);
                expect(first.type).toBe("session.watch.add");
                expect(last.type).toBe("session.watch.add");
                if (removed.type === "session.watch.remove") {
                  expect(byId).toBe(true);
                  expect(removed.watchIds).toEqual([temporary]);
                } else {
                  expect(byId).toBe(false);
                  expect(removed.type).toBe("session.watch.set");
                  expect(removed.watches.map(({ id }) => id)).toEqual(
                    retained.slice(0, 2),
                  );
                }
              });
            }
          },
        );
      }
    });

    describe("watchAddSync()", () => {
      it("issues a second acquisition while the first response is held", async () => {
        // The removal below replaces the watch set, so that the request
        // names every watch the session keeps.
        watcherClient.serverFlags!.watchRemoveV1 = false;
        watcher.setConcurrentWatchRefresh(true);
        const firstHeld = control.holdNextAddResponse();
        const first = watcher.watchAddSync([rootSpec("of:first")]);
        const releaseFirst = await firstHeld;
        const secondHeld = control.holdNextAddResponse();
        const second = watcher.watchAddSync([rootSpec("of:second")]);
        const releaseSecond = await secondHeld;
        releaseSecond();
        releaseFirst();
        await Promise.all([first, second]);
        await watcher.watchRemoveSync([]);
        const removal = control.requests.at(-1);
        expect(removal?.type).toBe("session.watch.set");
        expect(
          removal?.type === "session.watch.set"
            ? removal.watches.map(({ id }) => id)
            : undefined,
        ).toEqual([
          "of:first",
          "of:second",
        ]);
      });
    });
  });
});
