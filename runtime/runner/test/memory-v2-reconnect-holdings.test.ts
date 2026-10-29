/**
 * The replica's statement of what it holds, end to end: a document the
 * runner synced is declared on the reconnect's `session.open` at the seq
 * of the last frame the replica ABSORBED for it — never at a seq a local
 * promotion advanced it to — so the server re-delivers only what the
 * replica lacks and never elides an authoritative snapshot behind an
 * extrapolated one (04-protocol.md §4.1.2; `SpaceReplica.holdings`;
 * 09-invariants.md INV-14).
 */

import { assert } from "@std/assert";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { defer, type Deferred } from "@commonfabric/utils/defer";
import type { URI } from "@commonfabric/memory/interface";
import {
  decodeMemoryBoundary,
  DEFAULT_BRANCH,
  encodeMemoryBoundary,
  type EntityDocument,
  type SessionHolding,
  type SessionSyncUpsert,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { IStorageProvider } from "../src/storage/interface.ts";
import {
  SingleSessionFactory,
  TEST_MEMORY_SERVER_AUTH,
  testSessionOpenAuthFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-reconnect-holdings");
const space = signer.did();

type Sent = {
  type?: string;
  requestId?: string;
  space?: string;
  holdings?: SessionHolding[];
};

/** The provider surface this test drives: the runner's storage provider
 * narrowed to the document read, write, and sync entry points. */
type TestProvider = IStorageProvider & {
  get(uri: URI): EntityDocument | undefined;
  send(
    batch: { uri: URI; value: EntityDocument | undefined }[],
  ): Promise<
    {
      ok?: Record<PropertyKey, never>;
      error?: { name?: string; message?: string };
    }
  >;
  sync(uri: URI): Promise<unknown>;
};

/** A loopback transport over a real server that can drop its connection,
 * handing each reconnect's declared holdings to whoever is waiting. With
 * `dropEffects` set, server-push `session/effect` frames are discarded —
 * the shape of a verdict that arrives on its transact response while the
 * covering fan-out frame is lost to the connection. */
class DroppableTransport implements MemoryV2Client.Transport {
  dropEffects = false;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<MemoryV2Server.Server["connect"]> | null = null;
  #waiting: Deferred<SessionHolding[]> | null = null;
  #verdictWaiting: Deferred<void> | null = null;
  #transactRequestId: string | null = null;
  #space: string | null = null;
  #sessionId: string | null = null;
  #serverSeq = 0;

  readonly #server: MemoryV2Server.Server;

  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }

  /** Hands the client a crafted fan-out frame, as though the server had
   * pushed it: the way a test reaches frame shapes — a foreign branch, an
   * explicit instance key, a tombstone — that the runner's own watches
   * never request. */
  inject(upserts: SessionSyncUpsert[]): void {
    if (this.#space === null || this.#sessionId === null) {
      throw new Error("inject before a session opened");
    }
    const toSeq = this.#serverSeq + 1;
    this.#receiver(encodeMemoryBoundary({
      type: "session/effect",
      space: this.#space,
      sessionId: this.#sessionId,
      effect: {
        type: "sync",
        fromSeq: this.#serverSeq,
        toSeq,
        upserts,
        removes: [],
      },
    } as never));
    this.#serverSeq = toSeq;
  }

  /** Resolves once the next `transact` request is answered, correlated by
   * requestId so no other response — a reconnect's `session.open` among
   * them — can stand in for the verdict. */
  nextTransactVerdict(): Promise<void> {
    const waiting = defer<void>();
    this.#verdictWaiting = waiting;
    this.#transactRequestId = null;
    return waiting.promise;
  }

  async send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as Sent;
    if (message.type === "session.open") {
      this.#space = message.space ?? this.#space;
      if (message.holdings !== undefined) {
        this.#waiting?.resolve(message.holdings);
        this.#waiting = null;
      }
    }
    if (message.type === "transact" && this.#verdictWaiting !== null) {
      this.#transactRequestId = message.requestId ?? null;
    }
    await this.#openConnection().receive(payload);
  }

  close(): Promise<void> {
    this.#drop();
    return Promise.resolve();
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  /** Drops the connection and resolves with the reconnect's declaration.
   * The replacement connection is healthy: frame dropping ends with the
   * connection that was dropping them. */
  reconnectDeclaring(): Promise<SessionHolding[]> {
    const waiting = defer<SessionHolding[]>();
    this.#waiting = waiting;
    this.dropEffects = false;
    this.#drop();
    return waiting.promise;
  }

  #drop(): void {
    this.#connection?.close();
    this.#connection = null;
    queueMicrotask(() => this.#closeReceiver(new Error("disconnect")));
  }

  #openConnection(): ReturnType<MemoryV2Server.Server["connect"]> {
    if (this.#connection === null) {
      this.#connection = this.#server.connect((message) => {
        const framed = message as {
          type?: string;
          requestId?: string;
          ok?: { sessionId?: string; serverSeq?: number };
          effect?: { toSeq?: number };
        };
        if (this.dropEffects && framed.type === "session/effect") {
          return;
        }
        if (framed.type === "response") {
          if (framed.ok?.sessionId !== undefined) {
            this.#sessionId = framed.ok.sessionId;
          }
          if (framed.ok?.serverSeq !== undefined) {
            this.#serverSeq = Math.max(this.#serverSeq, framed.ok.serverSeq);
          }
          if (
            framed.requestId !== undefined &&
            framed.requestId === this.#transactRequestId
          ) {
            this.#transactRequestId = null;
            this.#verdictWaiting?.resolve();
            this.#verdictWaiting = null;
          }
        } else if (framed.effect?.toSeq !== undefined) {
          this.#serverSeq = Math.max(this.#serverSeq, framed.effect.toSeq);
        }
        this.#receiver(encodeMemoryBoundary(message));
      });
    }
    return this.#connection;
  }
}

describe("memory-v2 reconnect holdings", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("declares a synced document at its delivered seq, and not an own promotion", async () => {
    const server = new MemoryV2Server.Server({
      ...TEST_MEMORY_SERVER_AUTH,
      store: new URL(`memory://runner-v2-holdings-${crypto.randomUUID()}`),
    });
    const transport = new DroppableTransport(server);
    const storageManager = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://runner-v2-holdings"),
    }, new SingleSessionFactory(transport));
    const writerClient = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(server),
    });
    const writer = await writerClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    cleanups.push(
      () => storageManager.close(),
      () => writerClient.close(),
      () => server.close(),
    );
    const held = `of:memory-v2-held-${crypto.randomUUID()}` as URI;
    const never = `of:memory-v2-never-${crypto.randomUUID()}` as URI;
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: held, value: { value: { held: 1 } } }],
    });
    const provider = storageManager.open(space) as TestProvider;
    // One document the server has delivered to this replica, one it has
    // only ever found absent: the first is a holding, the second is not.
    await provider.sync(held);
    await provider.sync(never);
    await storageManager.synced();

    const declared = await transport.reconnectDeclaring();
    const first = declared.find((holding) => holding.id === held);
    assert(first !== undefined, "the synced document is declared");
    expect(first.seq).toBeGreaterThan(0);
    expect(first.deleted).toBeUndefined();
    expect(declared.some((holding) => holding.id === never)).toBe(false);
    // The declaration resolves at request-issue time, mid-restore. A fresh
    // document's sync is a full round trip, and the restore's remaining
    // steps are bare microtasks with nothing to replay — so once it
    // resolves, the restore is over and the write below goes out on a
    // settled connection rather than racing into the replay window.
    await provider.sync(`of:memory-v2-barrier-${crypto.randomUUID()}` as URI);

    // The replica's own write is accepted — the verdict rides the transact
    // response — while the covering `session/effect` frame is lost. The
    // confirmed layer can advance to the accepted seq by local promotion,
    // but no frame past `first.seq` was ever absorbed, and the promotion
    // extrapolates over the pending base a value the server never sent.
    // The declaration must keep naming the delivered seq: a claim at the
    // promoted seq is the one input that would make the server elide the
    // authoritative snapshot the dropped frame carried (INV-14's
    // over-declare direction).
    transport.dropEffects = true;
    const verdictArrived = transport.nextTransactVerdict();
    const sent = provider.send([{
      uri: held,
      value: { value: { held: 2 } },
    }]);
    await verdictArrived;

    const afterOwnWrite = await transport.reconnectDeclaring();
    const second = afterOwnWrite.find((holding) => holding.id === held);
    assert(second !== undefined, "the document is still declared");
    expect(second.seq).toBe(first.seq);

    // And because it did, the reconnect's catch-up re-delivers what the
    // dropped frame carried: the write lands, and the replica converges.
    expect(await sent).toEqual({ ok: {} });
    await storageManager.synced();
    expect((provider.get(held) as { value?: { held?: number } })?.value?.held)
      .toBe(2);
  });

  it("declares a tombstone as deleted and a foreign branch by name, and leaves a keyed instance unstated", async () => {
    const server = new MemoryV2Server.Server({
      ...TEST_MEMORY_SERVER_AUTH,
      store: new URL(`memory://runner-v2-holdings-${crypto.randomUUID()}`),
    });
    const transport = new DroppableTransport(server);
    const storageManager = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://runner-v2-holdings"),
    }, new SingleSessionFactory(transport));
    cleanups.push(() => storageManager.close(), () => server.close());
    const held = `of:memory-v2-held-${crypto.randomUUID()}` as URI;
    const branched = `of:memory-v2-branched-${crypto.randomUUID()}` as URI;
    const keyed = `of:memory-v2-keyed-${crypto.randomUUID()}` as URI;
    const tomb = `of:memory-v2-tomb-${crypto.randomUUID()}` as URI;
    const provider = storageManager.open(space) as TestProvider;
    await provider.sync(held);
    await storageManager.synced();

    // Frame shapes the runner's own watches never request, delivered as
    // the server would push them: a document on another branch, one under
    // an explicit foreign instance key (a lease-holder frame), and a
    // tombstone. The declaration must name the branch and the deletion,
    // and must leave the keyed instance unstated — the wire declares
    // instances by scope name, so claiming it would claim the session's
    // own instance instead.
    transport.inject([
      { branch: "b", id: branched, seq: 1, doc: { value: { b: 1 } } },
      {
        branch: DEFAULT_BRANCH,
        id: keyed,
        scope: "user",
        scopeKey: "user:foreign",
        seq: 1,
        doc: { value: { k: 1 } },
      },
      { branch: DEFAULT_BRANCH, id: tomb, seq: 1, deleted: true },
    ] as SessionSyncUpsert[]);

    const declared = await transport.reconnectDeclaring();
    const branchHolding = declared.find((holding) => holding.id === branched);
    assert(branchHolding !== undefined, "the branched document is declared");
    expect(branchHolding.branch).toBe("b");
    const tombHolding = declared.find((holding) => holding.id === tomb);
    assert(tombHolding !== undefined, "the tombstone is declared");
    expect(tombHolding.deleted).toBe(true);
    expect(declared.some((holding) => holding.id === keyed)).toBe(false);
  });
});
