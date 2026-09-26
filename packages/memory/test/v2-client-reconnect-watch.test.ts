import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import {
  type Client,
  connect,
  loopback,
  type SpaceSession,
  type Transport,
} from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import { decodeMemoryBoundary, type EntitySnapshot } from "../v2.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-client-reconnect-watch";
const SECOND_SPACE = "did:key:z6Mk-client-reconnect-watch-second";

/** A graph watch on the whole of document `of:<id>`. */
const graphWatch = (id: string) => ({
  id,
  kind: "graph" as const,
  query: {
    roots: [{
      id: `of:${id}`,
      selector: { path: [], schema: false },
    }],
  },
});

/**
 * A transport whose host can be taken down and brought back as a different
 * server process. While the host is down every send rejects, as a WebSocket to
 * a closed port does, so the client's reconnect loop keeps retrying its
 * handshake until `comeBack()`. `onSend` sees each decoded frame after it has
 * been handed to the live server, and `watchSets` holds the watch ids of each
 * `session.watch.set` frame handed to one, in wire order.
 */
function outageTransport(server: Server) {
  let active: Transport | null = loopback(server);
  let receiver = (_payload: string) => {};
  let disconnected = (_error?: Error) => {};
  const sent: string[] = [];
  const watchSets: string[][] = [];
  let onSend = (_message: { type: string }) => {};
  const transport: Transport = {
    async send(payload) {
      if (active === null) throw new Error("connection refused");
      const message = decodeMemoryBoundary(payload) as {
        type: string;
        watches?: { id: string }[];
      };
      sent.push(message.type);
      if (message.type === "session.watch.set") {
        watchSets.push((message.watches ?? []).map((watch) => watch.id));
      }
      await active.send(payload);
      onSend(message);
    },
    close: () => active?.close() ?? Promise.resolve(),
    setReceiver(next) {
      receiver = next;
      active?.setReceiver(next);
    },
    setCloseReceiver(next) {
      disconnected = next;
    },
  };
  return {
    transport,
    sent,
    watchSets,
    set onSend(next: (message: { type: string }) => void) {
      onSend = next;
    },
    async goDown(): Promise<void> {
      const down = active;
      active = null;
      await down?.close();
      disconnected(new Error("synthetic outage"));
    },
    comeBack(next: Server): void {
      active = loopback(next);
      active.setReceiver(receiver);
    },
  };
}

/**
 * Two servers standing for one host before and after it restarts: the second
 * holds none of the first's sessions, so a reconnect to it cannot resume one
 * and has to re-open it, which is when `restore()` re-establishes the session's
 * watch set.
 */
function restartedServers(
  name: string,
  options: { subscriptionRefreshDelayMs?: number } = {},
): { before: Server; after: Server } {
  const server = (phase: string) =>
    new Server({
      ...testSessionOpenServerOptions,
      store: new URL(`memory://reconnect-watch-${name}-${phase}`),
      ...options,
    });
  return { before: server("before"), after: server("after") };
}

/**
 * Writes document `of:<id>` in `space` through `writerClient`, and returns the
 * ids of the entities in the next update `session` receives. The document is
 * among them only if the server holds a watch of `session`'s on it.
 */
async function idsInNextUpdateAfterWrite(
  session: SpaceSession,
  writerClient: Client,
  space: string,
  id: string,
): Promise<string[]> {
  const updates = (await session.watchAddSync([])).view.subscribe();
  const writer = await writerClient.mount(
    space,
    {},
    testSessionOpenAuthFactory,
  );
  await writer.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: `of:${id}`,
      value: { value: { written: true } },
    }],
  });
  const next = await updates.next();
  return (next.value?.entities ?? []).map((entity: EntitySnapshot) =>
    entity.id
  );
}

describe("v2-client-reconnect-watch", () => {
  // A watch mutation whose turn comes while its session is disconnected or
  // not yet reopened waits in its turn for the restore. `restore()`
  // re-establishes the watch set only when the server that comes back no
  // longer knows the session — which is what a fresh `Server` here stands
  // for — so most cases reconnect to a second server rather than the first.
  // A case that regresses into a wait that cannot end leaves nothing
  // scheduled, and Deno fails it with "Promise resolution is still pending but
  // the event loop has already resolved".

  for (const concurrentWatchRefresh of [false, true]) {
    describe(`with concurrentWatchRefresh ${concurrentWatchRefresh}`, () => {
      it("completes the reconnect when a watch was added while the host was down", async () => {
        const { before, after } = restartedServers("outage");
        const host = outageTransport(before);
        const client = await connect({ transport: host.transport });
        try {
          const session = await client.mount(
            SPACE,
            {},
            testSessionOpenAuthFactory,
          );
          session.setConcurrentWatchRefresh(concurrentWatchRefresh);
          await session.watchAddSync([graphWatch("before")]);

          await host.goDown();
          expect(client.isConnected()).toBe(false);
          const duringOutage = session.watchAddSync([graphWatch("during")]);
          host.comeBack(after);
          host.sent.length = 0;

          await client.restoreConnection();
          await duringOutage;
          expect(client.connectionState).toBe("connected");
          // The reopen was not a resume, so the restore re-established the
          // watch set: the path the wait has to stay clear of was taken.
          expect(host.sent).toContain("session.watch.set");
          expect(host.sent.lastIndexOf("session.watch.add")).toBeGreaterThan(
            host.sent.indexOf("session.watch.set"),
          );
        } finally {
          await client.close();
          await before.close();
          await after.close();
        }
      });

      it("completes the reconnect when a mutation was queued behind one the drop rejected", async () => {
        // The removal is queued behind an acquisition whose request is on the
        // wire when the connection drops, so its turn comes only after the
        // drop, with the connection already down.

        const { before, after } = restartedServers("queued");
        const host = outageTransport(before);
        const client = await connect({ transport: host.transport });
        try {
          const session = await client.mount(
            SPACE,
            {},
            testSessionOpenAuthFactory,
          );
          session.setConcurrentWatchRefresh(concurrentWatchRefresh);
          // `kept` survives the removal, so the restore has a watch set to
          // re-establish. With none, `restore()` never touches the chain.
          await session.watchAddSync([
            graphWatch("removed"),
            graphWatch("kept"),
          ]);

          let dropped: Promise<void> | undefined;
          host.onSend = (message) => {
            if (dropped === undefined && message.type === "session.watch.add") {
              dropped = host.goDown();
            }
          };
          const onTheWire = session.watchAddSync([graphWatch("on-the-wire")]);
          // A removal sends only after every earlier mutation has applied, in
          // both chain modes.
          const queued = session.watchRemoveSync(["removed"]);
          await expect(onTheWire).rejects.toThrow();
          await dropped;
          expect(client.isConnected()).toBe(false);
          host.comeBack(after);
          host.sent.length = 0;

          await client.restoreConnection();
          await queued;
          expect(client.connectionState).toBe("connected");
          expect(host.sent).toContain("session.watch.set");
        } finally {
          await client.close();
          await before.close();
          await after.close();
        }
      });

      it("keeps a watch added while the reconnect reopens the session installed on the server", async () => {
        // The watch is added once the reconnect's handshake has succeeded and
        // while the reopen is being authorized, before `session.open` reaches
        // the server: the client is connected and its session is not yet
        // open there. The case then writes the watched document from a second
        // client and reads the update back, which it can only do if the
        // server holds the watch.

        const { before, after } = restartedServers("reopen", {
          subscriptionRefreshDelayMs: 0,
        });
        const host = outageTransport(before);
        const client = await connect({ transport: host.transport });
        const writerClient = await connect({ transport: loopback(after) });
        try {
          let reopening = false;
          let connectedAtReopen: boolean | undefined;
          let added: Promise<unknown> | undefined;
          const session = await client.mount(SPACE, {}, (...args) => {
            if (reopening && added === undefined) {
              connectedAtReopen = client.isConnected();
              added = session.watchAddSync([graphWatch("during")]);
              // Awaited below; observed here so that a rejection before then
              // fails the case rather than surfacing as unhandled.
              added.catch(() => {});
            }
            return testSessionOpenAuthFactory(...args);
          });
          session.setConcurrentWatchRefresh(concurrentWatchRefresh);
          await session.watchAddSync([graphWatch("before")]);

          await host.goDown();
          reopening = true;
          host.comeBack(after);

          await client.restoreConnection();
          // The watch went in during the reopen, on a connected client.
          expect(connectedAtReopen).toBe(true);
          await added;

          expect(
            await idsInNextUpdateAfterWrite(
              session,
              writerClient,
              SPACE,
              "during",
            ),
          ).toContain("of:during");
        } finally {
          await client.close();
          await writerClient.close();
          await before.close();
          await after.close();
        }
      });

      it("keeps a watch added on a session the reconnect has not reopened yet installed on the server", async () => {
        // One client holds two sessions, and the reconnect restores them one
        // after the other. The watch is added on the second while the first
        // is reopening: the client is connected, and the second session has
        // neither reopened nor started its restore.

        const { before, after } = restartedServers("second", {
          subscriptionRefreshDelayMs: 0,
        });
        const host = outageTransport(before);
        const client = await connect({ transport: host.transport });
        const writerClient = await connect({ transport: loopback(after) });
        try {
          let reopening = false;
          let connectedAtReopen: boolean | undefined;
          let added: Promise<unknown> | undefined;
          const first = await client.mount(SPACE, {}, (...args) => {
            if (reopening && added === undefined) {
              connectedAtReopen = client.isConnected();
              added = second.watchAddSync([graphWatch("during")]);
              // Awaited below; observed here so that a rejection before then
              // fails the case rather than surfacing as unhandled.
              added.catch(() => {});
            }
            return testSessionOpenAuthFactory(...args);
          });
          const second = await client.mount(
            SECOND_SPACE,
            {},
            testSessionOpenAuthFactory,
          );
          first.setConcurrentWatchRefresh(concurrentWatchRefresh);
          second.setConcurrentWatchRefresh(concurrentWatchRefresh);
          await first.watchAddSync([graphWatch("before")]);
          await second.watchAddSync([graphWatch("before")]);

          await host.goDown();
          reopening = true;
          host.comeBack(after);

          await client.restoreConnection();
          expect(connectedAtReopen).toBe(true);
          await added;

          expect(
            await idsInNextUpdateAfterWrite(
              second,
              writerClient,
              SECOND_SPACE,
              "during",
            ),
          ).toContain("of:during");
        } finally {
          await client.close();
          await writerClient.close();
          await before.close();
          await after.close();
        }
      });

      for (const reopen of [false, true]) {
        const how = reopen ? "re-opened" : "resumed";

        it(`sends watch mutations made across a reconnect in call order when the session is ${how}`, async () => {
          // One mutation is made while the host is down and a second while
          // the reopen is being authorized. Both replace the whole watch set,
          // so the server keeps whichever reaches it last.

          const { before, after } = restartedServers(`order-${how}`);
          const host = outageTransport(before);
          const client = await connect({ transport: host.transport });
          try {
            let reopening = false;
            let later: Promise<unknown> | undefined;
            const session = await client.mount(SPACE, {}, (...args) => {
              if (reopening && later === undefined) {
                later = session.watchSetSync([graphWatch("later")]);
                // Awaited below; observed here so that a rejection before
                // then fails the case rather than surfacing as unhandled.
                later.catch(() => {});
              }
              return testSessionOpenAuthFactory(...args);
            });
            session.setConcurrentWatchRefresh(concurrentWatchRefresh);
            await session.watchAddSync([graphWatch("before")]);

            await host.goDown();
            const earlier = session.watchSetSync([graphWatch("earlier")]);
            reopening = true;
            const server = reopen ? after : before;
            host.comeBack(server);

            await client.restoreConnection();
            await earlier;
            expect(later).toBeDefined();
            await later;
            expect(
              server.demandedInstancesForSpace(SPACE).map((row) => row.id),
            ).toEqual(["of:later"]);
          } finally {
            await client.close();
            await before.close();
            await after.close();
          }
        });
      }

      it("leaves a watch removed while the host was down out of the watch set it restores", async () => {
        const { before, after } = restartedServers("removed");
        const host = outageTransport(before);
        const client = await connect({ transport: host.transport });
        try {
          const session = await client.mount(
            SPACE,
            {},
            testSessionOpenAuthFactory,
          );
          session.setConcurrentWatchRefresh(concurrentWatchRefresh);
          await session.watchAddSync([
            graphWatch("removed"),
            graphWatch("kept"),
          ]);

          await host.goDown();
          const removal = session.watchRemoveSync(["removed"]);
          host.comeBack(after);
          host.watchSets.length = 0;

          await client.restoreConnection();
          await removal;
          // The restore's `watch.set`, then the removal's.
          expect(host.watchSets).toEqual([["kept"], ["kept"]]);
        } finally {
          await client.close();
          await before.close();
          await after.close();
        }
      });

      it("completes the reconnect when the connection drops while the session reopens", async () => {
        // The drop lands while the reopen is being authorized, so the
        // reopen's `session.open` is issued on a disconnected client. The
        // host is then brought back, and the reconnect has to reach it.

        const { before, after } = restartedServers("reopen-drop");
        const host = outageTransport(before);
        const client = await connect({ transport: host.transport });
        try {
          let reopening = false;
          const droppedDuringReopen = Promise.withResolvers<void>();
          const session = await client.mount(SPACE, {}, async (...args) => {
            if (reopening) {
              reopening = false;
              await host.goDown();
              droppedDuringReopen.resolve();
            }
            return await testSessionOpenAuthFactory(...args);
          });
          session.setConcurrentWatchRefresh(concurrentWatchRefresh);
          await session.watchAddSync([graphWatch("before")]);

          await host.goDown();
          reopening = true;
          host.comeBack(after);
          await droppedDuringReopen.promise;
          host.comeBack(after);
          host.sent.length = 0;

          await client.restoreConnection();
          expect(client.connectionState).toBe("connected");
          expect(host.sent).toContain("session.watch.set");
        } finally {
          await client.close();
          await before.close();
          await after.close();
        }
      });

      it("re-establishes a watch whose request was on the wire when the restore began", async () => {
        // `restore()` runs on a live connection while an acquisition's request
        // is on the wire and its response is held back. The response is let
        // through as the restore builds the watch set it re-establishes, so
        // that set holds the acquisition only if the restore waits for the
        // response to be applied before sending it.

        const server = new Server({
          ...testSessionOpenServerOptions,
          store: new URL("memory://reconnect-watch-in-flight"),
        });
        const inner = loopback(server);
        let inFlightRequestId: string | undefined;
        let heldResponse: string | undefined;
        let deliver = (_payload: string) => {};
        const transport: Transport = {
          send(payload) {
            const message = decodeMemoryBoundary(payload) as {
              type: string;
              requestId?: string;
              watches?: { id: string }[];
            };
            if (
              message.type === "session.watch.add" &&
              message.watches?.some((watch) => watch.id === "in-flight")
            ) {
              inFlightRequestId = message.requestId;
            }
            return inner.send(payload);
          },
          close: () => inner.close(),
          setReceiver(next) {
            deliver = next;
            inner.setReceiver((payload) => {
              const { requestId } = decodeMemoryBoundary(payload) as {
                requestId?: string;
              };
              if (requestId !== undefined && requestId === inFlightRequestId) {
                heldResponse = payload;
                responseHeld.resolve();
                return;
              }
              next(payload);
            });
          },
          setCloseReceiver() {},
        };
        const responseHeld = Promise.withResolvers<void>();
        const client = await connect({ transport });
        try {
          const session = await client.mount(
            SPACE,
            {},
            testSessionOpenAuthFactory,
          );
          session.setConcurrentWatchRefresh(concurrentWatchRefresh);
          await session.watchAddSync([graphWatch("before")]);
          const inFlight = session.watchAddSync([graphWatch("in-flight")]);
          await responseHeld.promise;

          let restoring = false;
          let holdingsRequests = 0;
          session.holdingsProvider = () => {
            // The first request is the reopen's, the second the
            // re-establishment's.
            if (restoring && ++holdingsRequests === 2) {
              deliver(heldResponse!);
            }
            return [];
          };
          const open = client.openSession.bind(client);
          const reopened = stub(client, "openSession", async (...args) => ({
            ...await open(...args),
            resumed: false,
          }));
          try {
            restoring = true;
            await session.restore();
          } finally {
            reopened.restore();
          }
          await inFlight;

          expect(holdingsRequests).toBe(2);
          expect(
            server.demandedInstancesForSpace(SPACE).map((row) => row.id),
          ).toContain("of:in-flight");
        } finally {
          await client.close();
          await server.close();
        }
      });

      it("keeps out a watch removed while the restore's watch set is on the wire", async () => {
        // The removal's turn comes after the restore has sent the watch set it
        // re-establishes and before that set's response has been applied. A
        // later removal then sends the session's whole watch set again, which
        // shows what the session holds.

        const { before, after } = restartedServers("removed-mid-restore");
        const host = outageTransport(before);
        const client = await connect({ transport: host.transport });
        try {
          const session = await client.mount(
            SPACE,
            {},
            testSessionOpenAuthFactory,
          );
          session.setConcurrentWatchRefresh(concurrentWatchRefresh);
          await session.watchAddSync([
            graphWatch("removed"),
            graphWatch("kept"),
            graphWatch("unrelated"),
          ]);

          await host.goDown();
          let removal: Promise<unknown> | undefined;
          host.onSend = (message) => {
            if (removal === undefined && message.type === "session.watch.set") {
              removal = session.watchRemoveSync(["removed"]);
              // Awaited below; observed here so that a rejection before then
              // fails the case rather than surfacing as unhandled.
              removal.catch(() => {});
            }
          };
          host.comeBack(after);

          await client.restoreConnection();
          expect(removal).toBeDefined();
          await removal;
          await session.watchRemoveSync(["unrelated"]);
          expect(
            after.demandedInstancesForSpace(SPACE).map((row) => row.id),
          ).toEqual(["of:kept"]);
        } finally {
          await client.close();
          await before.close();
          await after.close();
        }
      });

      it("completes the reconnect wherever the drop lands as a queued mutation takes its turn", async () => {
        // The drop is placed each of the first several microtasks after the
        // mutation is made, so it lands between any two steps of the
        // mutation's turn: its check that the session may send, and the send.

        for (let delay = 0; delay < 9; delay++) {
          const { before, after } = restartedServers(`drop-at-${delay}`);
          const host = outageTransport(before);
          const client = await connect({ transport: host.transport });
          try {
            const session = await client.mount(
              SPACE,
              {},
              testSessionOpenAuthFactory,
            );
            session.setConcurrentWatchRefresh(concurrentWatchRefresh);
            await session.watchAddSync([graphWatch("before")]);

            const mutation = session.watchAddSync([graphWatch("queued")]);
            // Rejected when the drop catches its request on the wire.
            mutation.catch(() => {});
            for (let tick = 0; tick < delay; tick++) await Promise.resolve();
            await host.goDown();
            host.comeBack(after);
            host.sent.length = 0;

            await client.restoreConnection();
            expect(client.connectionState).toBe("connected");
            expect(host.sent).toContain("session.watch.set");
          } finally {
            await client.close();
            await before.close();
            await after.close();
          }
        }
      });
    });
  }
});
