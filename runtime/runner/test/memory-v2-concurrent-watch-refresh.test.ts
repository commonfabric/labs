/**
 * `experimentalConcurrentWatchRefresh` at the RUNNER storage layer: watch-
 * refresh round trips may overlap up to a bounded window instead of the default
 * strict single-flight. (The memory-client ordering guarantees — wire order
 * across the set/add family and ordered delivery through the real server — are
 * covered in runtime/memory/test/v2-concurrent-watch-refresh.test.ts, where
 * the in-package server/loopback helpers are available.)
 *
 * Everything here is event-driven (no wall-clock sleeps): progress is awaited
 * on transport signals, and the "nothing more happens" assertions use a
 * deterministic microtask drain, not a timer.
 */

import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import {
  type EntityDocument,
  type SessionSync,
  type SessionSyncUpsert,
} from "@commonfabric/memory/v2";
import type { IStorageProvider } from "../src/storage/interface.ts";
import {
  ScriptedSessionTransport,
  type ScriptedTransportMessage,
  SingleSessionFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-concurrent-refresh");
const space = signer.did();

// CONCURRENT_WATCH_REFRESH_WINDOW in storage/v2.ts. Kept in sync by assertion:
// the concurrency test proves the observed max equals this.
const WINDOW = 8;

type TestProvider = IStorageProvider & {
  get(uri: URI): EntityDocument | undefined;
  sync(
    uri: URI,
    selector?: { path: string[]; schema: unknown },
  ): Promise<unknown>;
};

const doc = (
  id: URI,
  seq: number,
  value: SessionSyncUpsert["doc"],
): SessionSyncUpsert => ({ branch: "", id, seq, doc: value });

const fullSync = (
  toSeq: number,
  upserts: SessionSyncUpsert[],
): SessionSync => ({
  type: "sync",
  fromSeq: 0,
  toSeq,
  upserts,
  removes: [],
});

/** Flush pending microtasks deterministically (no timers). */
async function drainMicrotasks(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/**
 * Holds every watch.add response open. Records how many are in flight at once
 * (the whole point), signals on the Nth request, and releases held responses
 * on demand. Event-driven: `receivedAtLeast(n)` resolves exactly when the Nth
 * request lands.
 */
class HoldingTransport extends ScriptedSessionTransport {
  watchAddCount = 0;
  inFlight = 0;
  maxConcurrent = 0;
  #held: Array<() => void> = [];
  #receivedWaiters = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<void>>
  >();

  constructor() {
    super({
      name: "concurrent-refresh",
      sessionId: "session:concurrent-refresh",
      space,
    });
  }

  receivedAtLeast(n: number): Promise<void> {
    if (this.watchAddCount >= n) return Promise.resolve();
    let d = this.#receivedWaiters.get(n);
    if (!d) {
      d = Promise.withResolvers<void>();
      this.#receivedWaiters.set(n, d);
    }
    return d.promise;
  }

  releaseAll(): void {
    const held = this.#held;
    this.#held = [];
    for (const respond of held) respond();
  }

  protected override ackServerSeq(): number {
    return 100;
  }

  protected override handle(message: ScriptedTransportMessage): void {
    if (message.type !== "session.watch.add") {
      throw new Error(`Unhandled scripted message: ${message.type}`);
    }
    this.watchAddCount += 1;
    this.inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    const roots =
      message.watches?.flatMap((w) =>
        w.query?.roots?.map((r) => r.id as URI) ?? []
      ) ?? [];

    for (const [n, waiter] of this.#receivedWaiters) {
      if (this.watchAddCount >= n) {
        waiter.resolve();
        this.#receivedWaiters.delete(n);
      }
    }

    this.#held.push(() => {
      this.inFlight -= 1;
      this.respond({
        type: "response",
        requestId: message.requestId!,
        ok: {
          serverSeq: roots.length,
          sync: fullSync(
            roots.length,
            roots.map((id, i) => doc(id, i + 1, { value: { label: id } })),
          ),
        },
      });
    });
  }
}

function makeProvider(concurrent: boolean) {
  const transport = new HoldingTransport();
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL(`memory://concurrent-refresh-${concurrent}`),
    settings: {
      experimentalConcurrentWatchRefresh: concurrent,
    },
  }, new SingleSessionFactory(transport));
  return {
    transport,
    storageManager,
    provider: storageManager.open(space) as TestProvider,
  };
}

const uri = (tag: string) =>
  `of:${tag}-${crypto.randomUUID()}` as unknown as URI;

/** Release held responses until every pull settles. Signal-driven: after each
 * release, wait for either all pulls to settle or the next batch to be sent
 * (a freed slot flushing more work) — never a fixed iteration/time budget. */
async function drainAllPulls(
  transport: HoldingTransport,
  pulls: Promise<unknown>[],
): Promise<void> {
  const all = Promise.all(pulls);
  let done = false;
  void all.then(() => (done = true));
  while (!done) {
    const nextSent = transport.receivedAtLeast(transport.watchAddCount + 1);
    transport.releaseAll();
    // Releasing frees window slots, which may flush the next coalesced batch
    // (its watch.add arrives) — or all pulls settle. Await whichever happens.
    await Promise.race([all, nextSent]);
  }
  await all;
}

Deno.test("single-flight by default: watch refreshes never overlap", async () => {
  const { transport, storageManager, provider } = makeProvider(false);
  try {
    const pulls: Promise<unknown>[] = [];
    // First pull's refresh is sent and held.
    pulls.push(provider.sync(uri("sf-a"), { path: [], schema: false }));
    await transport.receivedAtLeast(1);
    // A second pull discovered a wave later (after the first was sent) must NOT
    // be sent while the first is still in flight — that is single-flight.
    pulls.push(provider.sync(uri("sf-b"), { path: [], schema: false }));
    await drainMicrotasks();
    assertEquals(transport.watchAddCount, 1, "second refresh is not sent yet");
    assertEquals(transport.maxConcurrent, 1, "never more than 1 in flight");

    await drainAllPulls(transport, pulls);
    assertEquals(
      transport.maxConcurrent,
      1,
      "still never more than 1 in flight",
    );
    assertEquals(transport.watchAddCount, 2, "both refreshes eventually sent");
  } finally {
    await storageManager.close();
  }
});

Deno.test("concurrent refresh overlaps up to the bounded window", async () => {
  const { transport, storageManager, provider } = makeProvider(true);
  try {
    const pulls: Promise<unknown>[] = [];
    // Issue pulls one wave apart (each after the prior was SENT) so each is its
    // own frame. The first WINDOW stay in flight together.
    for (let i = 1; i <= WINDOW; i++) {
      pulls.push(provider.sync(uri(`win-${i}`), { path: [], schema: false }));
      await transport.receivedAtLeast(i);
    }
    assertEquals(
      transport.maxConcurrent,
      WINDOW,
      "concurrency reaches exactly the window",
    );
    assertEquals(transport.watchAddCount, WINDOW, "window is full");

    // One more while the window is full: issued but held back (not sent).
    pulls.push(provider.sync(uri("win-extra"), { path: [], schema: false }));
    await drainMicrotasks();
    assertEquals(
      transport.watchAddCount,
      WINDOW,
      "the over-window pull is not sent until a slot frees",
    );

    await drainAllPulls(transport, pulls);
    assert(
      transport.maxConcurrent === WINDOW,
      `bounded at the window, saw ${transport.maxConcurrent}`,
    );
  } finally {
    await storageManager.close();
  }
});
