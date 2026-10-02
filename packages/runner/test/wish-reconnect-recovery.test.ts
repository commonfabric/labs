import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { defer } from "@commonfabric/utils/defer";

import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import {
  SingleSessionFactory,
  TEST_MEMORY_SERVER_AUTH,
  testSessionOpenAuthFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("wish reconnect recovery");
const space = signer.did();

/**
 * Drops the first request naming `dropId`, closes the connection so the load
 * fails, and holds the next connection until `reconnect` is released.
 */
class DroppingTransport implements MemoryV2Client.Transport {
  dropId?: string;
  dropped = false;
  readonly reconnect = defer<void>();
  #held = false;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<MemoryV2Server.Server["connect"]> | null = null;
  #muted = false;

  constructor(readonly server: MemoryV2Server.Server) {}

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  async send(payload: string): Promise<void> {
    if (this.#connection === null && this.#held) await this.reconnect.promise;
    const message = decodeMemoryBoundary(payload) as { type?: string };
    if (
      !this.dropped && this.dropId !== undefined &&
      message.type !== "transact" && payload.includes(this.dropId)
    ) {
      this.dropped = true;
      this.#held = true;
      this.#muted = true;
      try {
        await this.#open().receive(payload);
      } finally {
        this.#muted = false;
        this.#close();
      }
      return;
    }
    await this.#open().receive(payload);
  }

  close(): Promise<void> {
    this.#close();
    return Promise.resolve();
  }

  #close(): void {
    this.#connection?.close();
    this.#connection = null;
    this.#closeReceiver(new Error("disconnect"));
  }

  #open(): ReturnType<MemoryV2Server.Server["connect"]> {
    this.#connection ??= this.server.connect((message) => {
      if (!this.#muted) this.#receiver(encodeMemoryBoundary(message));
    });
    return this.#connection;
  }
}

/** Advances logical time until `done` holds, failing after a fixed budget. */
async function advanceUntil(
  runtime: Runtime,
  done: () => boolean,
  what: string,
): Promise<void> {
  for (let step = 0; step < 200 && !done(); step++) {
    await clock.tick(100);
    await runtime.idle();
  }
  if (!done()) throw new Error(`Timed out waiting for ${what}`);
}

describe("wish-reconnect-recovery", () => {
  it("restores a favorite whose load failed on a dropped connection", async () => {
    const server = new MemoryV2Server.Server({
      ...TEST_MEMORY_SERVER_AUTH,
      store: new URL(`memory://wish-reconnect-${crypto.randomUUID()}`),
    });
    const transport = new DroppingTransport(server);
    const storageManager = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://wish-reconnect"),
    }, new SingleSessionFactory(transport));
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const writerClient = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(server),
    });
    const cancels: (() => void)[] = [];
    try {
      // The dropped provider exists on the server but not in this replica.
      const dropped = runtime.getCell(space, "dropped provider");
      const droppedId = dropped.getAsNormalizedFullLink().id;
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
          id: droppedId,
          value: { value: { name: "Dropped provider" } },
        }],
      });

      const setup = runtime.edit();
      const readable = runtime.getCell(
        space,
        "readable provider",
        undefined,
        setup,
      );
      readable.set({ name: "Readable provider" });
      runtime.getHomeSpaceCell(setup).key("defaultPattern").set({
        favorites: [
          { cell: dropped, tags: ["resources"] },
          { cell: readable, tags: ["resources"] },
        ],
      });
      expect((await setup.commit()).error).toBeUndefined();
      await storageManager.synced();
      transport.dropId = droppedId;

      const { commonfabric } = createTrustedBuilder(runtime);
      const pattern = commonfabric.pattern(() => ({
        found: commonfabric.wish({
          query: "#resources",
          scope: ["~"],
          headless: true,
        }),
      }));
      const run = runtime.edit();
      const result = runtime.run(
        run,
        pattern,
        {},
        runtime.getCell(space, "reconnect consumer", undefined, run),
      );
      expect((await run.commit()).error).toBeUndefined();
      const found = result.key("found").resolveAsCell();
      cancels.push(found.sink(() => {}));
      const candidates = () =>
        (found.key("candidates").get() as Cell<unknown>[] | undefined)
          ?.length;
      const selected = found.key("result").asSchema<{ name: string }>({
        type: "object",
        properties: { name: { type: "string" } },
      });

      await advanceUntil(runtime, () => candidates() !== undefined, "a result");
      expect(transport.dropped).toBe(true);
      expect(found.key("error").get()).toBeUndefined();
      expect(candidates()).toBe(1);
      expect(selected.key("name").get()).toBe("Readable provider");

      transport.reconnect.resolve();
      await advanceUntil(runtime, () => candidates() === 2, "recovery");
      expect(selected.key("name").get()).toBe("Dropped provider");
    } finally {
      transport.reconnect.resolve();
      cancels.forEach((cancel) => cancel());
      await runtime.dispose({ closeStorage: false });
      await writerClient.close();
      await storageManager.close();
      await server.close();
    }
  });
});
