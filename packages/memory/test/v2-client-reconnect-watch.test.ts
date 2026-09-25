import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { connect, loopback, type Transport } from "../v2/client.ts";
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
 * been handed to the live server.
 */
function outageTransport(server: Server) {
  let active: Transport | null = loopback(server);
  let receiver = (_payload: string) => {};
  let disconnected = (_error?: Error) => {};
  const sent: string[] = [];
  let onSend = (_message: { type: string }) => {};
  const transport: Transport = {
    async send(payload) {
      if (active === null) throw new Error("connection refused");
      const message = decodeMemoryBoundary(payload) as { type: string };
      sent.push(message.type);
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

describe("v2-client-reconnect-watch", () => {
  // A watch mutation that finds its session disconnected or restoring waits
  // for the restore. `restore()` re-establishes the watch set through the same
  // watch-mutation chain, and only when the server that comes back no longer
  // knows the session — which is what a fresh `Server` here stands for — so
  // each case reconnects to a second server rather than the first. A case that
  // regresses into the wait it guards against leaves nothing scheduled, and
  // Deno fails it with "Promise resolution is still pending but the event loop
  // has already resolved".

  for (const concurrentWatchRefresh of [false, true]) {
    describe(`with concurrentWatchRefresh ${concurrentWatchRefresh}`, () => {
      it("completes the reconnect when a watch was added while the host was down", async () => {
        const before = new Server({
          ...testSessionOpenServerOptions,
          store: new URL("memory://reconnect-watch-outage-before"),
        });
        const after = new Server({
          ...testSessionOpenServerOptions,
          store: new URL("memory://reconnect-watch-outage-after"),
        });
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

        const before = new Server({
          ...testSessionOpenServerOptions,
          store: new URL("memory://reconnect-watch-queued-before"),
        });
        const after = new Server({
          ...testSessionOpenServerOptions,
          store: new URL("memory://reconnect-watch-queued-after"),
        });
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

        const before = new Server({
          ...testSessionOpenServerOptions,
          store: new URL("memory://reconnect-watch-reopen-before"),
          subscriptionRefreshDelayMs: 0,
        });
        const after = new Server({
          ...testSessionOpenServerOptions,
          store: new URL("memory://reconnect-watch-reopen-after"),
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

          const updates = (await session.watchAddSync([])).view.subscribe();
          const writer = await writerClient.mount(
            SPACE,
            {},
            testSessionOpenAuthFactory,
          );
          await writer.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:during",
              value: { value: { written: true } },
            }],
          });
          const next = await updates.next();
          expect(
            (next.value?.entities ?? []).map((entity: EntitySnapshot) =>
              entity.id
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

        const before = new Server({
          ...testSessionOpenServerOptions,
          store: new URL("memory://reconnect-watch-second-before"),
          subscriptionRefreshDelayMs: 0,
        });
        const after = new Server({
          ...testSessionOpenServerOptions,
          store: new URL("memory://reconnect-watch-second-after"),
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

          const updates = (await second.watchAddSync([])).view.subscribe();
          const writer = await writerClient.mount(
            SECOND_SPACE,
            {},
            testSessionOpenAuthFactory,
          );
          await writer.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:during",
              value: { value: { written: true } },
            }],
          });
          const next = await updates.next();
          expect(
            (next.value?.entities ?? []).map((entity: EntitySnapshot) =>
              entity.id
            ),
          ).toContain("of:during");
        } finally {
          await client.close();
          await writerClient.close();
          await before.close();
          await after.close();
        }
      });
    });
  }
});
