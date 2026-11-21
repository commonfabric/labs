import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { EntityDocument } from "@commonfabric/memory/v2";
import { stub } from "@std/testing/mock";
import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "../src/storage/cache.deno.ts";
import type { IStorageProvider } from "../src/storage/interface.ts";

type TestProvider = IStorageProvider & {
  sync(uri: string): Promise<unknown>;
  send(
    batch: { uri: string; value: EntityDocument | undefined }[],
  ): Promise<{ ok?: Record<PropertyKey, never>; error?: unknown }>;
};

const signer = await Identity.fromPassphrase("memory-v2-server-seq");
const space = signer.did();

describe("memory-v2 server seq", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let provider: TestProvider;

  /** Commits a new value of a document of its own through the provider. */
  const write = async (value: number) => {
    const result = await provider.send([{
      uri: `of:memory-v2-server-seq-${crypto.randomUUID()}`,
      value: { value },
    }]);
    expect(result).toEqual({ ok: {} });
  };

  /** The seq of the newest step of the space's history. */
  const newestSeq = async () => (await provider.listHistory!())[0].seq;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    provider = storageManager.open(space) as TestProvider;
  });

  afterEach(async () => {
    await storageManager.close();
  });

  describe("subscribeServerSeq()", () => {
    it("reports the seq of a commit the provider makes", async () => {
      const seen: number[] = [];
      provider.subscribeServerSeq!((seq) => seen.push(seq));

      await write(1);

      expect(seen.at(-1)).toBe(await newestSeq());
    });

    it("reports each seq to every observer", async () => {
      const first: number[] = [];
      const second: number[] = [];
      provider.subscribeServerSeq!((seq) => first.push(seq));
      provider.subscribeServerSeq!((seq) => second.push(seq));

      await write(1);

      expect(first.length).toBeGreaterThan(0);
      expect(second).toEqual(first);
    });

    it("returns a function that stops the reports", async () => {
      const seen: number[] = [];
      const stop = provider.subscribeServerSeq!((seq) => seen.push(seq));
      await write(1);
      const before = [...seen];

      stop();
      await write(2);

      expect(before.length).toBeGreaterThan(0);
      expect(seen).toEqual(before);
    });

    it("reports nothing once the provider is destroyed", async () => {
      const seen: number[] = [];
      provider.subscribeServerSeq!((seq) => seen.push(seq));
      await write(1);
      const before = [...seen];

      await provider.destroy();
      const result = await provider.send([{
        uri: `of:memory-v2-server-seq-${crypto.randomUUID()}`,
        value: { value: 2 },
      }]);

      expect(result.error).toBeDefined();
      expect(seen).toEqual(before);
    });

    it("reports nothing once the storage manager closes without waiting", async () => {
      const seen: number[] = [];
      provider.subscribeServerSeq!((seq) => seen.push(seq));
      await write(1);
      const before = [...seen];

      await storageManager.closeNow();
      storageManager = StorageManager.emulate({ as: signer });
      provider = storageManager.open(space) as TestProvider;
      await write(2);

      expect(seen).toEqual(before);
    });

    it("reports to the other observers when one throws, and logs the throw", async () => {
      const failure = new Error("observer failure");
      using reported = stub(console, "error");
      provider.subscribeServerSeq!(() => {
        throw failure;
      });
      const seen: number[] = [];
      provider.subscribeServerSeq!((seq) => seen.push(seq));

      await write(1);

      expect(seen.at(-1)).toBe(await newestSeq());
      expect(reported.calls.map((call) => call.args)).toContainEqual([
        "server-seq subscriber threw:",
        failure,
      ]);
    });

    it("reports the seq a session opened on a space with history starts at", async () => {
      const server = newLoopbackServer();
      const writer = EmulatedStorageManager.connectTo(server, { as: signer });
      const reader = EmulatedStorageManager.connectTo(server, { as: signer });
      try {
        const written = writer.open(space) as TestProvider;
        expect(
          await written.send([{
            uri: `of:memory-v2-server-seq-${crypto.randomUUID()}`,
            value: { value: 1 },
          }]),
        ).toEqual({ ok: {} });
        const newest = (await written.listHistory!())[0].seq;

        const opened = reader.open(space) as TestProvider;
        const seen: number[] = [];
        opened.subscribeServerSeq!((seq) => seen.push(seq));
        await opened.sync(`of:memory-v2-server-seq-${crypto.randomUUID()}`);

        expect(seen[0]).toBe(newest);
      } finally {
        await reader.close();
        await writer.close();
        await server.close();
      }
    });
  });
});
