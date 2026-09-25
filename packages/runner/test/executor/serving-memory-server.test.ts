import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  listenServingMemoryServer,
  startServingMemoryServer,
} from "../../src/executor/serving-memory-server.deno.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/v2.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";

const alice = await Identity.fromPassphrase("serving memory server alice");

type Counter = { count: number };

/** A counter whose only writer is a handler, so a served event moves it. */
const COUNTER_SOURCE = `
import { handler, pattern, Writable } from "commonfabric";
const bump = handler<Record<string, never>, { count: Writable<number> }>(
  (_event, { count }) => count.set(count.get() + 1),
);
export default pattern(() => {
  const count = new Writable<number>(0).for("count");
  return { count, bump: bump({ count }) };
});
`;

/**
 * Starts the counter from `writer`, fires one bump, and waits until `reader`
 * reads the count the serving loop committed. Under ON the firing client
 * commits only the event, and may show its consequence speculatively; the
 * reader fired nothing, so the count it reads is the store's.
 */
async function expectServedBump(writer: Runtime, reader: Runtime) {
  const space = alice.did() as MemorySpace;
  const cancels: Array<() => void> = [];
  try {
    const pattern = await writer.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    }, { space });
    const result = writer.getCell<Counter>(
      space,
      "counter",
      pattern.resultSchema,
    );
    const start = writer.edit();
    writer.run(start, pattern, {}, result);
    expect((await start.commit()).error).toBeUndefined();
    cancels.push(result.sink(() => {}));
    await waitForCellValue<Counter>(writer, result, (v) => v?.count === 0);
    result.key("bump").send({});

    const read = reader.getCellFromLink<Counter>(
      result.getAsNormalizedFullLink(),
    );
    cancels.push(read.sink(() => {}));
    const value = await waitForCellValue<Counter>(
      reader,
      read,
      (v) => v?.count === 1,
    );
    expect(value.count).toBe(1);
  } finally {
    for (const cancel of cancels) cancel();
  }
}

describe("serving-memory-server", () => {
  describe("startServingMemoryServer()", () => {
    it("commits the consequence of an ON client's event, which a second client reads from the store", async () => {
      await using serving = await startServingMemoryServer({
        apiUrl: new URL(import.meta.url),
      });
      const runtimes = [0, 1].map(() =>
        new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: EmulatedStorageManager.connectTo(serving.server, {
            as: alice,
          }),
          experimental: { serverExecution: true },
        })
      );
      const [writer, reader] = runtimes;
      try {
        await expectServedBump(writer, reader);
      } finally {
        await serving.host.close();
        // Each runtime's dispose closes its own storage manager.
        for (const runtime of runtimes) await runtime.dispose();
      }
    });

    it("closes the serving loop and the server once, however often it is asked", async () => {
      const serving = await startServingMemoryServer({
        apiUrl: new URL(import.meta.url),
      });
      const first = serving.close();
      expect(serving.close()).toBe(first);
      await first;
      await serving[Symbol.asyncDispose]();
      expect(serving.host.stats().activeSpaces).toBe(0);
    });
  });

  describe("listenServingMemoryServer()", () => {
    it("serves the event of an ON client connected over its websocket", async () => {
      await using serving = await listenServingMemoryServer();
      const runtimes = [0, 1].map(() =>
        new Runtime({
          apiUrl: serving.url,
          storageManager: StorageManager.open({
            as: alice,
            memoryHost: serving.url,
          }),
          experimental: { serverExecution: true },
        })
      );
      const [writer, reader] = runtimes;
      try {
        await expectServedBump(writer, reader);
      } finally {
        await serving.host.close();
        for (const runtime of runtimes) await runtime.dispose();
      }
    });
  });
});
