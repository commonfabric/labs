import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import {
  type Client,
  connect,
  connectionDeliveryOf,
  connectionError,
  isNotSentError,
  isUnacknowledgedError,
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

/** A frame the client sends, as `outageTransport()` decodes it. */
type SentFrame = {
  type: string;
  requestId?: string;
  watches?: { id: string }[];
  watchIds?: string[];
};

/** Whether `frame` is a `session.watch.add` naming the watch `id`. */
const addsWatch = (frame: SentFrame, id: string): boolean =>
  frame.type === "session.watch.add" &&
  (frame.watches ?? []).some((watch) => watch.id === id);

/**
 * A transport whose host can be taken down and brought back as a different
 * server process. While the host is down every send rejects with a
 * `ConnectionError`, as a WebSocket transport's does on a closed port, so the
 * client's reconnect loop keeps retrying its handshake until `comeBack()`.
 * `onSend` sees each decoded frame after it has been handed to the live
 * server, and `onDeliver` each request id the client receives a response to.
 * `watchSets` holds the watch ids of each `session.watch.set` frame handed to
 * one, in wire order, and `watchRemovals` holds the ids each
 * `session.watch.remove` frame names. The client never receives the response
 * to a frame `losesResponse` picks out.
 */
function outageTransport(server: Server) {
  let host = server;
  let receiver = (_payload: string) => {};
  let disconnected = (_error?: Error) => {};
  const sent: string[] = [];
  const watchSets: string[][] = [];
  const watchRemovals: string[][] = [];
  const lostResponses = new Set<string>();
  let onSend = (_message: SentFrame) => {};
  let onDeliver = (_requestId: string) => {};
  let losesResponse = (_message: SentFrame) => false;
  const deliver = (payload: string) => {
    const { requestId } = decodeMemoryBoundary(payload) as {
      requestId?: string;
    };
    if (requestId !== undefined && lostResponses.has(requestId)) return;
    receiver(payload);
    if (requestId !== undefined) onDeliver(requestId);
  };
  const connect = (next: Server): Transport => {
    const connection = loopback(next);
    connection.setReceiver(deliver);
    return connection;
  };
  let active: Transport | null = connect(server);
  const transport: Transport = {
    async send(payload) {
      if (active === null) throw connectionError("connection refused");
      const message = decodeMemoryBoundary(payload) as SentFrame;
      if (message.requestId !== undefined && losesResponse(message)) {
        lostResponses.add(message.requestId);
      }
      sent.push(message.type);
      if (message.type === "session.watch.set") {
        watchSets.push((message.watches ?? []).map((watch) => watch.id));
      }
      if (message.type === "session.watch.remove") {
        watchRemovals.push(message.watchIds ?? []);
      }
      await active.send(payload);
      onSend(message);
    },
    close: () => active?.close() ?? Promise.resolve(),
    reset() {
      if (active === null) return;
      void active.close();
      active = connect(host);
    },
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver(next) {
      disconnected = next;
    },
  };
  return {
    transport,
    sent,
    watchSets,
    watchRemovals,
    set onSend(next: (message: SentFrame) => void) {
      onSend = next;
    },
    set onDeliver(next: (requestId: string) => void) {
      onDeliver = next;
    },
    set losesResponse(next: (message: SentFrame) => boolean) {
      losesResponse = next;
    },
    async goDown(): Promise<void> {
      const down = active;
      active = null;
      await down?.close();
      disconnected(new Error("synthetic outage"));
    },
    comeBack(next: Server): void {
      host = next;
      active = connect(next);
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

/** The ids of the documents `server` holds a watch on in `space`, sorted. */
const demandedIds = (server: Server, space = SPACE): string[] =>
  server.demandedInstancesForSpace(space).map((row) => row.id).sort();

/**
 * Writes documents `of:<id>` for each of `ids` in `space` through
 * `writerClient`, in one commit, and returns the ids of the entities in the
 * next update `session` receives, sorted. A document is among them only if the
 * server holds a watch of `session`'s on it, so at least one of `ids` has to be
 * watched for an update to arrive.
 */
async function idsInNextUpdateAfterWrite(
  session: SpaceSession,
  writerClient: Client,
  space: string,
  ids: string[],
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
    operations: ids.map((id) => ({
      op: "set" as const,
      id: `of:${id}`,
      value: { value: { written: true } },
    })),
  });
  const next = await updates.next();
  return (next.value?.entities ?? []).map((entity: EntitySnapshot) => entity.id)
    .sort();
}

describe("v2-client-reconnect-watch", () => {
  // A watch change made while the client is connecting fails at once as
  // never sent, and one whose connection drops fails with it; nothing is sent
  // again on the next connection. One made on a live connection before its
  // session has reopened there waits for the restore. `restore()`
  // re-establishes the watch set the session holds when the server that
  // comes back no longer knows the session — which is what a fresh `Server`
  // here stands for — or when a change went unanswered at the drop, so most
  // cases reconnect to a second server rather than the first. A case that
  // regresses into a wait that cannot end leaves nothing scheduled, and Deno
  // fails it with "Promise resolution is still pending but the event loop has
  // already resolved".

  for (const concurrentWatchRefresh of [false, true]) {
    describe(`with concurrentWatchRefresh ${concurrentWatchRefresh}`, () => {
      it("rejects a watch added while the host is down as never sent, and restores the watch set held before it", async () => {
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
          const duringOutage = await session.watchAddSync([
            graphWatch("during"),
          ]).catch((e) => e);
          expect(isNotSentError(duringOutage)).toBe(true);
          host.comeBack(after);
          host.sent.length = 0;

          await client.restoreConnection();
          expect(client.connectionState).toBe("connected");
          // The reopen was not a resume, so the restore re-established the
          // watch set the session holds, which the failed change is not in,
          // and nothing sent the change itself.
          expect(host.watchSets).toEqual([["before"]]);
          expect(host.sent).not.toContain("session.watch.add");
          expect(demandedIds(after)).toEqual(["of:before"]);
        } finally {
          await client.close();
          await before.close();
          await after.close();
        }
      });

      it("fails a watch change the drop caught on the wire as unacknowledged and a removal queued behind it as never sent, and restores the watch set held before both", async () => {
        // The removal is queued behind an acquisition whose request is on the
        // wire when the connection drops, so its turn comes only after the
        // drop, with the connection already down. the client fails the removal as never sent, yet its restore
        // sends `["kept"]`, without the watch the failed removal named. The
        // removal's `onTurn` takes the watch out of the held set as its turn
        // comes, before the turn finds the connection gone; a removal made
        // while the host is down fails before its turn and leaves the set
        // alone (the "rejects a watch removal made while the host is down"
        // case below).

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
          await session.watchAddSync([
            graphWatch("removed"),
            graphWatch("kept"),
          ]);

          const dropped = Promise.withResolvers<void>();
          host.onSend = (message) => {
            if (addsWatch(message, "on-the-wire")) {
              host.onSend = () => {};
              dropped.resolve(host.goDown());
            }
          };
          const onTheWire = session.watchAddSync([graphWatch("on-the-wire")])
            .catch((e) => e);
          // A removal sends only after every earlier mutation has applied, in
          // both chain modes.
          const queued = session.watchRemoveSync(["removed"]).catch((e) => e);
          await dropped.promise;
          expect(client.isConnected()).toBe(false);
          expect(isUnacknowledgedError(await onTheWire)).toBe(true);
          expect(isNotSentError(await queued)).toBe(true);
          host.comeBack(after);
          host.sent.length = 0;

          await client.restoreConnection();
          expect(client.connectionState).toBe("connected");
          expect(host.watchSets).toEqual([["removed", "kept"]]);
          expect(host.watchRemovals).toEqual([]);
          expect(host.sent).not.toContain("session.watch.add");
          expect(demandedIds(after)).toEqual(["of:kept", "of:removed"]);
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
              ["during"],
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
              ["during"],
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

        it(`rejects a watch set made while the host is down as never sent, and installs one made as the session reopens, when the session is ${how}`, async () => {
          // One watch set is made while the host is down and a second while
          // the reopen is being authorized, on a connected client. Both
          // replace the whole watch set, so the sets the server is sent show
          // which of them reached it.

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
            const earlier = await session.watchSetSync([graphWatch("earlier")])
              .catch((e) => e);
            expect(isNotSentError(earlier)).toBe(true);
            reopening = true;
            const server = reopen ? after : before;
            host.comeBack(server);
            host.watchSets.length = 0;

            await client.restoreConnection();
            expect(later).toBeDefined();
            await later;
            // A re-opened session's restore first re-establishes the set it
            // held before the outage; a resumed one's server still holds it.
            expect(host.watchSets).toEqual(
              reopen ? [["before"], ["later"]] : [["later"]],
            );
            expect(demandedIds(server)).toEqual(["of:later"]);
          } finally {
            await client.close();
            await before.close();
            await after.close();
          }
        });
      }

      it("rejects a watch removal made while the host is down as never sent, and restores the watch set with that watch still in it", async () => {
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
          const removal = await session.watchRemoveSync(["removed"]).catch((
            e,
          ) => e);
          expect(isNotSentError(removal)).toBe(true);
          host.comeBack(after);
          host.watchSets.length = 0;

          await client.restoreConnection();
          // The restore's `watch.set`, and no removal.
          expect(host.watchSets).toEqual([["removed", "kept"]]);
          expect(host.watchRemovals).toEqual([]);
          expect(demandedIds(after)).toEqual(["of:kept", "of:removed"]);
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

      it("waits, as a restore on a live connection, for the answer to a watch change in flight before building the watch set it sends", async () => {
        // `restore()` runs on a live connection, as a held session's retry
        // does, while an acquisition's request is on the wire and its answer
        // is held back. The answer is let through right behind the reopen's
        // response, so the restore resumes from the reopen before the answer
        // applies.
        // The server handled the acquisition before the set the restore
        // re-establishes, which replaces its whole set, so the server keeps
        // the acquisition the client holds only if the restore waits for that
        // answer before reading the set it sends.

        const server = new Server({
          ...testSessionOpenServerOptions,
          store: new URL("memory://reconnect-watch-in-flight"),
        });
        const inner = loopback(server);
        let inFlightRequestId: string | undefined;
        let reopenRequestId: string | undefined;
        let restoring = false;
        let heldResponse: string | undefined;
        const transport: Transport = {
          send(payload) {
            const message = decodeMemoryBoundary(payload) as {
              type: string;
              requestId?: string;
              watches?: { id: string }[];
            };
            if (
              inFlightRequestId === undefined &&
              message.type === "session.watch.add" &&
              message.watches?.some((watch) => watch.id === "in-flight")
            ) {
              inFlightRequestId = message.requestId;
            }
            if (restoring && message.type === "session.open") {
              reopenRequestId = message.requestId;
            }
            return inner.send(payload);
          },
          close: () => inner.close(),
          setReceiver(next) {
            inner.setReceiver((payload) => {
              const { requestId } = decodeMemoryBoundary(payload) as {
                requestId?: string;
              };
              if (
                requestId !== undefined && requestId === inFlightRequestId
              ) {
                heldResponse = payload;
                responseHeld.resolve();
                return;
              }
              next(payload);
              if (requestId !== undefined && requestId === reopenRequestId) {
                next(heldResponse!);
              }
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
          // Awaited below; observed here so that a rejection before then
          // fails the case rather than surfacing as unhandled.
          inFlight.catch(() => {});
          await responseHeld.promise;

          let holdingsRequests = 0;
          session.holdingsProvider = () => {
            // The first request is the reopen's, the second the
            // re-establishment's.
            if (restoring) holdingsRequests++;
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
          expect(demandedIds(server)).toEqual(["of:before", "of:in-flight"]);
        } finally {
          await client.close();
          await server.close();
        }
      });

      for (const reopen of [false, true]) {
        const how = reopen ? "re-opened" : "resumed";

        it(`fails a watch whose answer the drop lost as unacknowledged, and restores the watch set held without it, when the session is ${how}`, async () => {
          // The server handles the acquisition, and the connection drops
          // before its answer reaches the client. A resumed server session
          // keeps what it applied, so the restore sends the watch set the
          // session holds either way. The case then writes both documents
          // from a second client and reads the update back, which holds only
          // the documents the server watches for the session.

          const { before, after } = restartedServers(`lost-${how}`);
          const server = reopen ? after : before;
          const host = outageTransport(before);
          const client = await connect({ transport: host.transport });
          const writerClient = await connect({ transport: loopback(server) });
          try {
            const session = await client.mount(
              SPACE,
              {},
              testSessionOpenAuthFactory,
            );
            session.setConcurrentWatchRefresh(concurrentWatchRefresh);
            await session.watchAddSync([graphWatch("before")]);

            host.losesResponse = (message) => addsWatch(message, "lost");
            const dropped = Promise.withResolvers<void>();
            host.onSend = (message) => {
              if (addsWatch(message, "lost")) {
                host.onSend = () => {};
                dropped.resolve(host.goDown());
              }
            };
            const lost = session.watchAddSync([graphWatch("lost")]).catch((
              e,
            ) => e);
            await dropped.promise;
            host.losesResponse = () => false;
            expect(isUnacknowledgedError(await lost)).toBe(true);
            host.comeBack(server);
            host.sent.length = 0;
            host.watchSets.length = 0;

            await client.restoreConnection();
            expect(host.watchSets).toEqual([["before"]]);
            expect(host.sent).not.toContain("session.watch.add");
            expect(
              await idsInNextUpdateAfterWrite(
                session,
                writerClient,
                SPACE,
                ["before", "lost"],
              ),
            ).toEqual(["of:before"]);
          } finally {
            await client.close();
            await writerClient.close();
            await before.close();
            await after.close();
          }
        });
      }

      it("rejects a watch request with the refusal that arrived before the drop, and restores the watch set held without it", async () => {
        // The acquisition names a watch id the session already holds for
        // another document, which the server refuses. The refusal reaches the
        // client, and the connection drops right after.

        const { before, after } = restartedServers("refused");
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

          let refusedRequestId: string | undefined;
          const dropped = Promise.withResolvers<void>();
          host.onSend = (message) => {
            if (addsWatch(message, "before")) {
              host.onSend = () => {};
              refusedRequestId = message.requestId;
            }
          };
          host.onDeliver = (requestId) => {
            if (requestId === refusedRequestId) {
              host.onDeliver = () => {};
              dropped.resolve(host.goDown());
            }
          };
          const refused = session.watchAddSync([{
            ...graphWatch("other"),
            id: "before",
          }]).catch((e) => e);
          await dropped.promise;
          const error = await refused;
          expect(connectionDeliveryOf(error)).toBeUndefined();
          expect(error.message).toContain(
            "session.watch.add may not replace an existing watch id",
          );
          host.comeBack(after);
          host.sent.length = 0;
          host.watchSets.length = 0;

          await client.restoreConnection();
          expect(host.watchSets).toEqual([["before"]]);
          expect(host.sent).not.toContain("session.watch.add");
          expect(demandedIds(after)).toEqual(["of:before"]);
        } finally {
          await client.close();
          await before.close();
          await after.close();
        }
      });

      if (concurrentWatchRefresh) {
        for (const reopen of [false, true]) {
          const how = reopen ? "re-opened" : "resumed";

          it(`keeps a watch whose answer arrived behind an unanswered watch set, and restores the watch set without that set's change, when the session is ${how}`, async () => {
            // Both requests are on the wire together. The watch set's answer
            // is lost, and the acquisition's arrives before the drop, so it
            // waits to be applied behind the set. The set fails with the
            // connection, the acquisition then applies, and the restore
            // re-establishes the watch set the session holds after both,
            // replacing whatever the server applied of the set.

            const { before, after } = restartedServers(`behind-lost-${how}`);
            const server = reopen ? after : before;
            const host = outageTransport(before);
            const client = await connect({ transport: host.transport });
            try {
              const session = await client.mount(
                SPACE,
                {},
                testSessionOpenAuthFactory,
              );
              session.setConcurrentWatchRefresh(true);
              await session.watchAddSync([graphWatch("before")]);

              host.losesResponse = (message) =>
                message.type === "session.watch.set" &&
                (message.watches ?? []).some((watch) => watch.id === "lost");
              let answeredRequestId: string | undefined;
              const answered = Promise.withResolvers<void>();
              host.onSend = (message) => {
                if (addsWatch(message, "answered")) {
                  answeredRequestId = message.requestId;
                }
              };
              host.onDeliver = (requestId) => {
                if (requestId === answeredRequestId) answered.resolve();
              };
              const lost = session.watchSetSync([
                graphWatch("before"),
                graphWatch("lost"),
              ]).catch((e) => e);
              const behind = session.watchAddSync([graphWatch("answered")]);
              // Awaited below; observed here so that a rejection before then
              // fails the case rather than surfacing as unhandled.
              behind.catch(() => {});
              await answered.promise;
              await host.goDown();
              host.losesResponse = () => false;
              expect(isUnacknowledgedError(await lost)).toBe(true);
              await behind;
              host.comeBack(server);
              host.watchSets.length = 0;

              await client.restoreConnection();
              expect(host.watchSets).toEqual([["before", "answered"]]);
              expect(demandedIds(server)).toEqual([
                "of:answered",
                "of:before",
              ]);
            } finally {
              await client.close();
              await before.close();
              await after.close();
            }
          });
        }
      }

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

      it("fails a watch change wherever the drop lands as it takes its turn, as unacknowledged once handed over, and restores the watch set held before it", async () => {
        // The drop is placed each of the first several microtasks after the
        // mutation is made, so it lands between any two steps of the
        // mutation's turn: its check that the session may send, and the send.
        // Whichever way the change fails, the server was handed it only if
        // it fails as unacknowledged.

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
            host.sent.length = 0;

            const mutation = session.watchAddSync([graphWatch("queued")])
              .catch((e) => e);
            for (let tick = 0; tick < delay; tick++) await Promise.resolve();
            await host.goDown();
            const error = await mutation;
            const handedOver = host.sent.includes("session.watch.add");
            expect(connectionDeliveryOf(error)).toBeDefined();
            if (handedOver) expect(isUnacknowledgedError(error)).toBe(true);
            host.comeBack(after);
            host.sent.length = 0;

            await client.restoreConnection();
            expect(client.connectionState).toBe("connected");
            expect(host.sent).toContain("session.watch.set");
            expect(host.sent).not.toContain("session.watch.add");
            expect(demandedIds(after)).toEqual(["of:before"]);
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
