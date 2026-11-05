import { assertEquals } from "@std/assert";
import { Server } from "../v2/server.ts";
import {
  connect,
  loopback,
  type SpaceSession,
  type Transport,
  WatchView,
} from "../v2/client.ts";
import type { EntitySnapshot } from "../v2.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

Deno.test("memory v2 watch view keeps same id snapshots in different scopes", () => {
  const view = WatchView.fromSync({
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [
      {
        branch: "",
        id: "of:scoped-watch-view",
        seq: 1,
        doc: { value: { scope: "space" } },
      },
      {
        branch: "",
        id: "of:scoped-watch-view",
        scope: "user",
        seq: 1,
        doc: { value: { scope: "user" } },
      },
    ],
    removes: [],
  });

  assertEquals(
    view.entities.map(({ id, scope, document }) => ({
      id,
      scope,
      document,
    })),
    [
      {
        id: "of:scoped-watch-view",
        scope: undefined,
        document: { value: { scope: "space" } },
      },
      {
        id: "of:scoped-watch-view",
        scope: "user",
        document: { value: { scope: "user" } },
      },
    ],
  );
});

Deno.test("memory v2 watch view keys KEYED entries by instance: two instances of one (branch, id, scope) stay apart, a keyed remove drops exactly the named one, and an unkeyed frame keys by scope name as before (fan-out stage A's wire leg; mutation: key ignores scopeKey → red)", () => {
  const aliceKey = "user:did%3Akey%3Aalice";
  const bobKey = "user:did%3Akey%3Abob";
  const view = WatchView.fromSync({
    type: "sync",
    fromSeq: 0,
    toSeq: 2,
    upserts: [
      {
        branch: "",
        id: "of:keyed-watch-view",
        scope: "user",
        scopeKey: aliceKey as never,
        seq: 1,
        doc: { value: { who: "alice" } },
      },
      {
        branch: "",
        id: "of:keyed-watch-view",
        scope: "user",
        scopeKey: bobKey as never,
        seq: 2,
        doc: { value: { who: "bob" } },
      },
    ],
    removes: [],
  });
  const snapshotOf = () =>
    view.entities.map(({ id, scope, scopeKey, document }) => ({
      id,
      scope,
      scopeKey,
      document,
    }));
  assertEquals(snapshotOf(), [
    {
      id: "of:keyed-watch-view",
      scope: "user",
      scopeKey: aliceKey,
      document: { value: { who: "alice" } },
    },
    {
      id: "of:keyed-watch-view",
      scope: "user",
      scopeKey: bobKey,
      document: { value: { who: "bob" } },
    },
  ]);
  // A keyed remove of Alice's instance leaves Bob's.
  view.applySync({
    type: "sync",
    fromSeq: 2,
    toSeq: 3,
    upserts: [],
    removes: [{
      branch: "",
      id: "of:keyed-watch-view",
      scope: "user",
      scopeKey: aliceKey as never,
    }],
  }, false);
  assertEquals(snapshotOf(), [
    {
      id: "of:keyed-watch-view",
      scope: "user",
      scopeKey: bobKey,
      document: { value: { who: "bob" } },
    },
  ]);
  // An unkeyed upsert of the same (branch, id, scope) is a DIFFERENT
  // entry (keyed by the scope name), and an unkeyed remove drops only it.
  view.applySync({
    type: "sync",
    fromSeq: 3,
    toSeq: 4,
    upserts: [{
      branch: "",
      id: "of:keyed-watch-view",
      scope: "user",
      seq: 4,
      doc: { value: { who: "own" } },
    }],
    removes: [],
  }, false);
  assertEquals(snapshotOf().length, 2);
  view.applySync({
    type: "sync",
    fromSeq: 4,
    toSeq: 5,
    upserts: [],
    removes: [{ branch: "", id: "of:keyed-watch-view", scope: "user" }],
  }, false);
  assertEquals(snapshotOf(), [
    {
      id: "of:keyed-watch-view",
      scope: "user",
      scopeKey: bobKey,
      document: { value: { who: "bob" } },
    },
  ]);
});

Deno.test("memory v2 client installs a watch set and receives live updates", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://memory-v2-client-watch"),
    subscriptionRefreshDelayMs: 0,
  });
  const writerClient = await connect({
    transport: loopback(server),
  });
  const watcherClient = await connect({
    transport: loopback(server),
  });
  const space = "did:key:z6Mk-memory-v2-client-watch";
  const writer = await writerClient.mount(
    space,
    {},
    testSessionOpenAuthFactory,
  );
  const watcher = await watcherClient.mount(
    space,
    {},
    testSessionOpenAuthFactory,
  );

  try {
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:1",
        value: {
          value: {
            hello: "world",
          },
        },
      }],
    });

    const view = await watcher.watchSet([{
      id: "root",
      kind: "graph",
      query: {
        roots: [{
          id: "of:doc:1",
          selector: {
            path: [],
            schema: false,
          },
        }],
      },
    }]);

    assertEquals(
      view.entities.map((entity: EntitySnapshot) => ({
        branch: entity.branch,
        id: entity.id,
        seq: entity.seq,
        document: entity.document,
      })),
      [{
        branch: "",
        id: "of:doc:1",
        seq: 1,
        document: {
          value: {
            hello: "world",
          },
        },
      }],
    );

    const updates = view.subscribe();
    const pending = updates.next();
    await writer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:1",
        value: {
          value: {
            hello: "again",
          },
        },
      }],
    });

    const next = await pending;
    assertEquals(next.done, false);
    assertEquals(
      next.value.entities.map((entity: EntitySnapshot) => ({
        branch: entity.branch,
        id: entity.id,
        seq: entity.seq,
        document: entity.document,
      })),
      [{
        branch: "",
        id: "of:doc:1",
        seq: 2,
        document: {
          value: {
            hello: "again",
          },
        },
      }],
    );
  } finally {
    await writerClient.close();
    await watcherClient.close();
    await server.close();
  }
});

/**
 * `runWatchMutation()` checks that the session is open when the call is made
 * and then awaits the response, so the `apply` step that acks that response
 * can run after the session has closed. A closed session must arm no new
 * work: `close()` drains the background tasks it knows about and returns, so
 * anything queued afterwards is work that nothing awaits.
 *
 * The armed timer is the observation, because the wire cannot tell the two
 * cases apart. `flushScheduledAcks()` independently declines to speak for a
 * closed session, so no `session.ack` frame is sent either way, and a test
 * that watched the wire would pass whether or not the session still schedules
 * the ack.
 */
Deno.test("memory v2 session closed mid-watch-set arms no ack timer", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://watch-set-close-before-apply"),
    subscriptionRefreshDelayMs: 0,
  });
  const inner = loopback(server);

  let setRequestId: string | null = null;
  let closing: Promise<void> | null = null;
  let session: SpaceSession | null = null;
  let countTimers = false;
  let timersArmed = 0;

  const transport: Transport = {
    send(payload: string) {
      // Frames carry the `fvj1:` `FabricValue` encoding, not bare JSON, so
      // this reads the payload as text.
      if (payload.includes('"session.watch.set"')) {
        setRequestId = /"requestId":"([^"]+)"/.exec(payload)?.[1] ?? null;
      }
      // The response to the close's own `session.close` would arm the
      // loopback's delivery turn, which is a timer and not the one under
      // observation, so that request stops here.
      if (payload.includes('"session.close"')) return Promise.resolve();
      return inner.send(payload);
    },
    close: () => inner.close(),
    setReceiver(receiver: (payload: string) => void) {
      inner.setReceiver((payload: string) => {
        if ((setRequestId !== null) && payload.includes(setRequestId)) {
          setRequestId = null;
          // The close lands between the response frame and the `apply` that
          // frame resolves, so the session is already closed when `apply`
          // reaches its ack.
          closing = session?.close() ?? null;
          countTimers = true;
        }
        receiver(payload);
      });
    },
    setCloseReceiver: (r) => inner.setCloseReceiver?.(r),
  };

  const client = await connect({ transport });
  const space = "did:key:z6Mk-watch-set-close-before-apply";
  session = await client.mount(space, {}, testSessionOpenAuthFactory);

  // Counted rather than faked: the timer is armed for real, and only the
  // count is observed. Saved and restored rather than assumed native, since a
  // package preload may already own this property.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    if (countTimers) timersArmed++;
    return realSetTimeout(...args);
  }) as typeof setTimeout;

  try {
    await session.watchSetSync([]);
    // `apply` has run by now: the mutation resolves on its return value.
    countTimers = false;
    assertEquals(closing !== null, true, "the close raced the apply");
    await closing;
    assertEquals(timersArmed, 0, "a closed session arms no ack timer");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    await client.close();
    await server.close();
  }
});
