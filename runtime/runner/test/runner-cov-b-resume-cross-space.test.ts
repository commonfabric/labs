/**
 * A serving runtime's resume pre-sync over a read that crosses into another
 * space, when the load that read kicked does not land.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("runner-cov-b resume cross space");
const space = signer.did();
const farSpace =
  (await Identity.fromPassphrase("runner-cov-b resume far space")).did();

// The lift reads two documents deep, the second in another space.
const DEEP_READ_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "type Leaf = { name?: string };",
      "type Mid = { next?: Leaf };",
      "type Top = { next?: Mid };",
      "export default pattern<{ def: Top }, { label: string }>(",
      "  ({ def }) => {",
      "    const label = computed(() => `n:${def.next?.next?.name ?? 'none'}`);",
      "    return { label };",
      "  },",
      ");",
    ].join("\n"),
  }],
};

describe("runner resume cross-space pre-sync", () => {
  let server: MemoryV2Server.Server;
  let authorManager: EmulatedStorageManager;
  let servingManager: EmulatedStorageManager;
  let author: Runtime;
  let serving: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    authorManager = EmulatedStorageManager.connectTo(server, { as: signer });
    servingManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
      servingHomeSpace: space,
    });
    author = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: authorManager,
    });
    serving = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: servingManager,
      servingPosture: true,
    });
  });

  afterEach(async () => {
    await author.dispose();
    await serving.dispose();
    await authorManager.close();
    await servingManager.close();
    await server.close();
  });

  it("resumes, and logs the miss, when a load a cross-space read kicked does not land", async () => {
    const farTx = author.edit();
    const leaf = author.getCell<{ name?: string }>(
      farSpace,
      "far leaf",
      undefined,
      farTx,
    );
    leaf.withTx(farTx).set({ name: "Ada" });
    expect((await farTx.commit().settled).error).toBeUndefined();
    const tx = author.edit();
    const mid = author.getCell<unknown>(space, "mid", undefined, tx);
    mid.withTx(tx).set({ next: leaf });
    const top = author.getCell<unknown>(space, "top", undefined, tx);
    top.withTx(tx).set({ next: mid });
    const compiled = await author.patternManager.compilePattern(
      DEEP_READ_PROGRAM,
      { space, tx },
    );
    const authored = author.getCell<{ label?: string }>(
      space,
      "cross-space parent",
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const running = author.run(tx, compiled as any, { def: top }, authored);
    author.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await running.pull();
    await author.idle();
    await author.patternManager.flushCompileCacheWrites();
    await author.storageManager.synced();

    const leafId = leaf.getAsNormalizedFullLink().id;
    const settle = servingManager.loadsSettled.bind(servingManager);
    let refused = 0;
    using _refusing = stub(servingManager, "loadsSettled", (keys) => {
      if (keys.some((key) => key.endsWith(`/${leafId}`))) {
        refused++;
        return Promise.reject(new Error("synthetic load failure"));
      }
      return settle(keys);
    });
    const runnerLogger = getLogger("runner");
    const level = runnerLogger.level;
    const debug = console.debug;
    const debugLines: string[] = [];
    runnerLogger.level = "debug";
    console.debug = (...args: unknown[]) => {
      debugLines.push(args.map(String).join(" "));
    };
    let resumed;
    try {
      resumed = serving.getCellFromLink<{ label?: string }>(
        authored.getAsNormalizedFullLink(),
      );
      await resumed.sync();
      expect(await serving.start(resumed)).toBeTruthy();
    } finally {
      console.debug = debug;
      runnerLogger.level = level;
    }

    expect(refused).toBe(1);
    expect(
      debugLines.filter((line) =>
        line.includes("a load a cross-space read kicked did not land") &&
        line.includes("synthetic load failure")
      ).length,
    ).toBe(1);
    // The run reads past the absence, and reads the leaf once it arrives.
    await serving.idle();
    await serving.storageManager.synced();
    const label = resumed.key("label");
    await label.pull();
    expect(label.get()).toBe("n:Ada");
  });
});
