/**
 * Memory-client guarantees for `concurrentWatchRefresh` (set by the runner from
 * the `experimentalConcurrentWatchRefresh` storage setting):
 *
 *  1. Wire order across the whole watch-mutation family is preserved — an eager
 *     `watch.add` never overtakes an earlier `watch.set` (the bug the ordered
 *     issue phase fixes).
 *  2. Overlapping watch.adds through the REAL server all resolve, and later
 *     mutations on every watched root are delivered.
 *  3. A removal's replacement set sees every earlier acquisition applied, and
 *     later acquisitions stay behind it on the wire. Covered in
 *     `test/v2/SpaceSession.test.ts`, which holds a response open to force
 *     the interleaving.
 *
 * Event-driven (no wall-clock sleeps): a deterministic microtask drain settles
 * the loopback pipeline.
 */

import { assertEquals } from "@std/assert";
import { connect, loopback, type Transport } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import type { EntitySnapshot, WatchSpec } from "../v2.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

async function drainMicrotasks(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** loopback transport that records the type of each client->server message. */
function recordingLoopback(server: Server, wire: string[]): Transport {
  const inner = loopback(server);
  return {
    send(payload: string) {
      if (payload.includes('"session.watch.set"')) wire.push("watch.set");
      else if (payload.includes('"session.watch.add"')) wire.push("watch.add");
      return inner.send(payload);
    },
    close: () => inner.close(),
    setReceiver: (r) => inner.setReceiver(r),
    setCloseReceiver: (r) => inner.setCloseReceiver?.(r),
  };
}

const rootSpec = (id: string): WatchSpec => ({
  id,
  kind: "graph",
  query: { roots: [{ id, selector: { path: [], schema: false } }] },
});

Deno.test("concurrent refresh preserves wire order: watch.add never overtakes watch.set", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://concurrent-refresh-order"),
    subscriptionRefreshDelayMs: 0,
  });
  const wire: string[] = [];
  const client = await connect({ transport: recordingLoopback(server, wire) });
  const space = "did:key:z6Mk-concurrent-refresh-order";
  const session = await client.mount(space, {}, testSessionOpenAuthFactory);
  session.setConcurrentWatchRefresh(true);
  try {
    // set then add issued in the SAME turn. Under the old eager-add spike the
    // add reached the wire first; the ordered issue phase must keep [set, add].
    const set = session.watchSetSync([]);
    const add = session.watchAddSync([]);
    await Promise.all([set, add]);
    assertEquals(wire, ["watch.set", "watch.add"], "wire order preserved");
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("concurrent refresh: overlapping watch.adds resolve and later mutations deliver", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://concurrent-refresh-loopback"),
    subscriptionRefreshDelayMs: 0,
  });
  const writerClient = await connect({ transport: loopback(server) });
  const watcherClient = await connect({ transport: loopback(server) });
  const space = "did:key:z6Mk-concurrent-refresh-loopback";
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
  watcher.setConcurrentWatchRefresh(true);

  const ids = Array.from({ length: 5 }, (_, i) => `of:loop-${i}`);
  try {
    let seq = 0;
    for (const id of ids) {
      await writer.transact({
        localSeq: ++seq,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id, value: { value: { n: 0 } } }],
      });
    }

    // Overlapping watch.adds through the real server (issued without awaiting
    // between calls). All must resolve.
    const results = await Promise.all(
      ids.map((id) => watcher.watchAddSync([rootSpec(id)])),
    );
    assertEquals(results.length, ids.length);
    const view = results[results.length - 1].view;
    const nOf = (id: string) =>
      (view.entities.find((e: EntitySnapshot) => e.id === id)?.document as
        | { value?: { n?: number } }
        | undefined)?.value?.n;
    for (const id of ids) assertEquals(nOf(id), 0, `initial value for ${id}`);

    // Later mutations on EVERY watched root are delivered after the concurrent
    // acquisition — so a watch set that accidentally retained only one
    // acquisition cannot pass. Effects are pushed asynchronously through the
    // loopback; consume the subscription until all roots reach n=1.
    const updates = view.subscribe();
    const pending = new Set(ids);
    for (const id of ids) {
      await writer.transact({
        localSeq: ++seq,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id, value: { value: { n: 1 } } }],
      });
    }
    while (pending.size > 0) {
      const next = await updates.next();
      assertEquals(next.done, false, "subscription must keep delivering");
      for (const e of next.value.entities as EntitySnapshot[]) {
        const n = (e.document as { value?: { n?: number } } | undefined)
          ?.value?.n;
        if (n === 1) pending.delete(e.id);
      }
    }
    // Reaching here means every watched root's update was delivered.
    await drainMicrotasks();
  } finally {
    await writerClient.close();
    await watcherClient.close();
    await server.close();
  }
});
