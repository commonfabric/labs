import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("scheduler cold replica");
const space = signer.did();

const SOURCE_ID = "scheduler-cold-replica-source";
const RESULT_ID = "scheduler-cold-replica-result";

const sourceSchema = {
  type: "object",
  properties: { value: { type: "string" } },
} as const;

const resultSchema = {
  type: "object",
  properties: { observed: { type: "string" } },
} as const;

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern, computed } from 'commonfabric';",
      "export default pattern<{ value?: string }>((input) => {",
      "  const observed = computed(() => input.value ?? 'missing');",
      "  return { observed };",
      "});",
    ].join("\n"),
  }],
};

const newSharedServer = () =>
  new MemoryV2Server.Server(TEST_MEMORY_SERVER_AUTH);

const newRuntime = (storageManager: EmulatedStorageManager) =>
  new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

describe("scheduler cold-replica startup", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let readerStorage: EmulatedStorageManager;

  beforeEach(() => {
    server = newSharedServer();
    writerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
  });

  afterEach(async () => {
    await writerStorage?.close();
    await readerStorage?.close();
    await server?.close();
  });

  it("converges when a cold input update arrives after start()", async () => {
    const writer = newRuntime(writerStorage);
    const reader = newRuntime(readerStorage);

    try {
      const setupTx = writer.edit();
      const compiled = await writer.patternManager.compilePattern(PROGRAM, {
        space,
        tx: setupTx,
      });
      const sourceCell = writer.getCell<{ value?: string }>(
        space,
        SOURCE_ID,
        sourceSchema,
        setupTx,
      );
      // The reader has no local source replica at start. The empty server-side
      // document lets startup prefetch establish the watch before the writer
      // fills the value through the second client connection.
      sourceCell.set({});
      const writerResultCell = writer.getCell<{ observed: string }>(
        space,
        RESULT_ID,
        resultSchema,
        setupTx,
      );
      await writer.setup(
        setupTx,
        compiled,
        { value: sourceCell.key("value").getAsWriteRedirectLink() },
        writerResultCell,
      );
      await setupTx.commit().settled;
      await writer.patternManager.flushCompileCacheWrites();
      await writer.storageManager.synced();

      const resultCell = reader.getCell<{ observed: string }>(
        space,
        RESULT_ID,
        resultSchema,
      );
      const seen: unknown[] = [];
      const cancelSink = resultCell.sink((value) => {
        seen.push(value);
      });

      const started = await reader.start(resultCell);
      expect(started).toBe(true);
      await reader.idle();
      expect(resultCell.getAsQueryResult()).not.toEqual({
        observed: "arrived",
      });

      const writerTx = writer.edit();
      writer.getCell<{ value: string }>(
        space,
        SOURCE_ID,
        sourceSchema,
        writerTx,
      ).set({ value: "arrived" });
      await writerTx.commit().settled;
      await writer.storageManager.synced();

      const projected = await waitForCellValue<{ observed: string }>(
        reader,
        resultCell,
        (value) => value?.observed === "arrived",
      );
      expect(projected).toEqual({ observed: "arrived" });
      cancelSink();
      expect(seen.at(-1)).toEqual({ observed: "arrived" });
    } finally {
      await writer.dispose();
      await reader.dispose();
    }
  });
});
