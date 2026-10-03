/**
 * Pins the main-thread↔worker IPC hop of the CellSet race: a CellUpdate
 * carrying a concurrent value ("blue") is in flight to the main thread when
 * the client blind-sets "green". The worker↔server hop of the same race (the
 * replica rebasing the pending write under the incoming sync) is pinned by
 * packages/runner/test/memory-v2-sync-under-pending.test.ts; here the worker
 * side runs in-process and the test controls IPC delivery order.
 *
 * What must hold on this hop:
 *  1. `set()` applies optimistically and fires the handle's callbacks before
 *     any IPC round trip.
 *  2. The in-flight stale CellUpdate(blue) is applied blindly when it arrives
 *     (there is deliberately no versioning/suppression on this hop) — the
 *     transient flash is accepted behavior.
 *  3. The worker's own commit of green re-fires the subscription sink — the
 *     "we don't echo back to the sender" suppression exists only on the
 *     server↔worker hop — so a CellUpdate(green) follows blue in channel
 *     order and the handle converges to green.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { Runtime } from "@commonfabric/runner";
import * as V2Storage from "@commonfabric/runner/storage/v2";
import { newLoopbackServer } from "@commonfabric/runner/storage/cache.deno";

import type { RuntimeProcessor } from "@/backends/runtime-processor.ts";
import { createCellRef } from "@/backends/utils.ts";
import { $conn, CellHandle, type RuntimeClient } from "@/mod.ts";
import { RuntimeConnection } from "@/client/connection.ts";
import { EventEmitter } from "@/client/emitter.ts";
import type {
  RuntimeTransport,
  RuntimeTransportEvents,
} from "@/client/transport.ts";
import {
  type InitializationData,
  type IPCClientMessage,
  type IPCClientNotification,
  type IPCRemoteMessage,
  RequestType,
} from "@/protocol/mod.ts";
import { buildProcessor } from "./build-processor.ts";

const signer = await Identity.fromPassphrase("cell-set-echo-race");
const space = signer.did();

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

class SharedV2SessionFactory implements V2Storage.SessionFactory {
  readonly #server: MemoryV2Server.Server;

  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }

  async create(sessionSpace: MemorySpace) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.#server),
    });
    const session = await client.mount(
      sessionSpace,
      {},
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: {
          principal: signer.did(),
        },
      }),
    );
    return { client, session };
  }
}

const createRuntime = () => {
  const server = newLoopbackServer();
  const storageManager = new (class extends V2Storage.StorageManager {
    constructor() {
      super(
        { as: signer, memoryHost: new URL("memory://") },
        new SharedV2SessionFactory(server),
      );
    }
  })();
  const runtime = new Runtime({
    apiUrl: new URL("http://localhost/"),
    storageManager,
  });
  return { runtime, storageManager };
};

/**
 * The IPC channel, in-process: client requests are handled by the (real)
 * RuntimeProcessor immediately, but everything the worker sends back —
 * responses AND notifications, sharing one FIFO like the real postMessage
 * channel — sits in `outbox` until the test pumps it. Not pumping is the
 * test's way of holding a message "in flight over IPC".
 */
class InProcessWorkerTransport extends EventEmitter<RuntimeTransportEvents>
  implements RuntimeTransport {
  readonly outbox: IPCRemoteMessage[] = [];

  readonly #processor: RuntimeProcessor;

  constructor(processor: RuntimeProcessor) {
    super();
    this.#processor = processor;
  }

  send(original: IPCClientMessage | IPCClientNotification): void {
    // Encoded, cloned and decoded, as the real transport delivers it: `send()`
    // encodes, `postMessage` clones, the worker entry decodes. The clone in
    // the middle is what makes the copy -- a bare encode-decode pair returns
    // the sender's own object where nothing needed encoding, and deep-freezes
    // it in place. The handler is entitled to its own: `BaseRequest` lets it
    // own what its request carries, and handing over the sender's object would
    // let a handler that cedes a payload reach back into the sender.
    const message = fabricFromRealmValue(
      structuredClone(realmFromFabricValue(original)),
    ) as IPCClientMessage | IPCClientNotification;
    if (!("msgId" in message)) {
      throw new Error("This test sends no one-way client notifications");
    }
    const { msgId, data } = message;
    // Initialize/Dispose are worker-entry concerns (backends/web-worker), not
    // RuntimeProcessor handlers; the harness acks them directly.
    if (
      data.type === RequestType.Initialize || data.type === RequestType.Dispose
    ) {
      this.outbox.push({ msgId } as IPCRemoteMessage);
      return;
    }
    void Promise.resolve()
      .then(() => this.#processor.handleRequest(data))
      .then(
        (response) =>
          this.outbox.push(
            (response !== undefined
              ? { msgId, data: response }
              : { msgId }) as IPCRemoteMessage,
          ),
        (error) =>
          this.outbox.push(
            {
              msgId,
              error: error instanceof Error ? error.message : String(error),
            } as IPCRemoteMessage,
          ),
      );
  }

  /** Deliver everything queued so far to the main thread, in channel order. */
  pump(): void {
    while (this.outbox.length > 0) {
      this.emit("message", this.outbox.shift()!);
    }
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

describe("CellSet / CellUpdate echo race over IPC", () => {
  it("echoes the worker commit after a stale in-flight update, converging the handle", async () => {
    const { runtime, storageManager } = createRuntime();

    // The worker sink posts via self.postMessage; route it into the channel.
    const hadPostMessage = "postMessage" in globalThis;
    const originalPostMessage =
      (globalThis as { postMessage?: unknown }).postMessage;

    const schema = {
      type: "object",
      properties: { color: { type: "string" } },
    } as const;

    try {
      // Seed the cell with red on the worker-side runtime.
      const cell = runtime.getCell<{ color: string }>(
        space,
        "cell-set-echo-race",
        schema,
      );
      const seed = runtime.edit();
      cell.withTx(seed).set({ color: "red" });
      runtime.prepareTxForCommit(seed);
      await seed.commit().settled;
      await runtime.idle();

      // A real `RuntimeProcessor` over that runtime.
      const processor = buildProcessor({ runtime });
      const transport = new InProcessWorkerTransport(processor);
      (globalThis as { postMessage?: unknown }).postMessage = (m: unknown) =>
        transport.outbox.push(
          fabricFromRealmValue(m as never) as IPCRemoteMessage,
        );

      const connectionPromise = new RuntimeConnection(transport).initialize(
        {} as InitializationData,
      );
      transport.pump();
      const connection = await connectionPromise;
      const client = { [$conn]: () => connection } as unknown as RuntimeClient;

      const handle = new CellHandle<{ color: string }>(
        client,
        createCellRef(cell, schema),
      );
      const seen: unknown[] = [];
      const cancel = handle.subscribe((value) => {
        seen.push(value === undefined ? undefined : { ...value });
      });
      await flush();
      transport.pump();
      expect(seen).toEqual([undefined, { color: "red" }]);

      // A concurrent write lands worker-side (stands in for a server-pushed
      // remote update — this hop doesn't care where the worker-local change
      // came from). Its CellUpdate(blue) is queued but NOT delivered: it is
      // in flight over IPC.
      const blueTx = runtime.edit();
      cell.withTx(blueTx).set({ color: "blue" });
      runtime.prepareTxForCommit(blueTx);
      await blueTx.commit().settled;
      await runtime.idle();
      await flush();
      expect(transport.outbox.length).toBeGreaterThan(0);

      // Main thread blind-sets green while blue is in flight. The optimistic
      // update fires before any IPC round trip.
      const setPromise = handle.set({ color: "green" });
      expect(handle.get()).toEqual({ color: "green" });
      expect(seen).toEqual([
        undefined,
        { color: "red" },
        { color: "green" },
      ]);

      // Let the worker process the CellSet: the real handleCellSet blind
      // write commits green over blue, and the subscription sink re-fires for
      // the worker's OWN commit — the echo — queued after blue.
      await flush();
      await runtime.idle();
      await flush();

      // Deliver the channel. Blue applies blindly (the transient flash — no
      // suppression on this hop), then the echo converges the handle.
      transport.pump();
      expect(seen).toEqual([
        undefined,
        { color: "red" },
        { color: "green" }, // optimistic
        { color: "blue" }, // stale in-flight update, applied blindly
        { color: "green" }, // the worker's echo of our own commit
      ]);
      expect(handle.get()).toEqual({ color: "green" });
      await setPromise;

      // Worker-side state agrees.
      expect(cell.get()).toEqual({ color: "green" });

      cancel();
      await flush();
      transport.pump(); // deliver the CellUnsubscribe ack
      const disposePromise = connection.dispose();
      transport.pump();
      await disposePromise;
    } finally {
      if (hadPostMessage) {
        (globalThis as { postMessage?: unknown }).postMessage =
          originalPostMessage;
      } else {
        delete (globalThis as { postMessage?: unknown }).postMessage;
      }
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
