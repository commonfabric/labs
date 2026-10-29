import { assertEquals, assertNotEquals } from "@std/assert";
import { Server } from "../v2/server.ts";
import type { DemandChangeReason } from "../v2/server.ts";
import { connect, loopback } from "../v2/client.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

Deno.test("memory v2 demandChanged carries the session principal (watch + push-growth) so the host can drop the service session", async () => {
  // W1 (d′) review MINOR-4: the push-growth / watch `demandChanged` notify
  // carries the CHANGED SESSION's principal, so the ExecutorHost can drop the
  // serving runtime's own loopback (service-principal) session — its
  // tracked-set growth is the serving graph's own reads, not client demand, and
  // must neither wake the loop nor count in `pushGrowthWakes`. Mutation (drop
  // `session.principal` from the notify calls) → principal undefined → the host
  // can no longer distinguish the service session → RED here.
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://memory-v2-demand-principal"),
    subscriptionRefreshDelayMs: 0,
  });
  const captured: Array<{ reason?: DemandChangeReason; principal?: string }> =
    [];
  server.setServerExecutionObserver({
    demandChanged: (_space, reason, principal) => {
      captured.push({ reason, principal });
    },
  });
  const writerClient = await connect({ transport: loopback(server) });
  const watcherClient = await connect({ transport: loopback(server) });
  const space = "did:key:z6Mk-memory-v2-demand-principal";
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
    // Seed a doc that links to a second doc; the watcher follows the link
    // by schema, so writing the LINK grows its tracked set on push.
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:leaf",
        value: { value: { leaf: "v1" } },
      }],
    });
    await writer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:root",
        value: { value: { child: null } },
      }],
    });
    const view = await watcher.watchSet([{
      id: "root",
      kind: "graph",
      query: {
        roots: [{
          id: "of:root",
          selector: { path: [], schema: true },
        }],
      },
    }]);
    // The WATCH-set install itself is a demand change; it must carry the
    // watcher's principal (not undefined).
    const watchNotes = captured.filter((c) => c.reason === "watch");
    assertNotEquals(watchNotes.length, 0);
    for (const note of watchNotes) {
      assertEquals(note.principal, TEST_SESSION_OPEN_PRINCIPAL);
    }
    // GROW the watched set: link of:root.child -> of:leaf. On the push the
    // watcher's tracked set gains of:leaf → a push-growth notify fires,
    // carrying the watcher's principal.
    const updates = view.subscribe();
    const pending = updates.next();
    await writer.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:root",
        value: {
          value: { child: { "/": { "link@1": { id: "of:leaf", path: [] } } } },
        },
      }],
    });
    await pending;
    const growthNotes = captured.filter((c) => c.reason === "push-growth");
    // Every notify — whichever site fired — carries a defined principal
    // equal to the mounted session's; none is anonymous/undefined.
    for (const note of captured) {
      assertEquals(note.principal, TEST_SESSION_OPEN_PRINCIPAL);
    }
    // The growth site did fire (the tracked set grew through the new link).
    assertNotEquals(growthNotes.length, 0);
  } finally {
    await writerClient.close?.();
    await watcherClient.close?.();
  }
});
