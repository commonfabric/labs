/**
 * A serving runtime's resume pre-sync over a read that crosses into another
 * space, against a provider that reports the crossings its server's walk
 * stopped at and against one that does not.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getDerivedInternalCell } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { trustExecutable } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-cov-c resume cross space");
const space = signer.did();
const farSpace =
  (await Identity.fromPassphrase("runner-cov-c resume far space")).did();

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

  /**
   * The authored parent, run once and stored, whose lift reads two documents
   * deep, the second in `farSpace`, and the id of that far document.
   */
  async function authoredParent(): Promise<{
    link: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>;
    leafId: string;
  }> {
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
    return {
      link: authored.getAsNormalizedFullLink(),
      leafId: leaf.getAsNormalizedFullLink().id,
    };
  }

  /** Every key the serving manager was asked to await a load of. */
  function recordSettles(): { keys: string[]; [Symbol.dispose](): void } {
    const keys: string[] = [];
    const settle = servingManager.loadsSettled.bind(servingManager);
    const stubbed = stub(servingManager, "loadsSettled", (asked) => {
      for (const key of asked) keys.push(key);
      return settle(asked);
    });
    return { keys, [Symbol.dispose]: () => stubbed.restore() };
  }

  /** Resumes the authored parent on the serving runtime, and its label. */
  async function resume(
    link: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>,
    identity?: { principal: string },
  ): Promise<unknown> {
    const resumed = serving.getCellFromLink<{ label?: string }>(link);
    await resumed.sync();
    const startTx = serving.readTx();
    if (identity !== undefined) startTx.tx.scopeKeyIdentity = identity;
    expect(await serving.start(resumed.withTx(startTx))).toBe(true);
    await serving.idle();
    await serving.storageManager.synced();
    const label = resumed.key("label");
    await label.pull();
    return label.get();
  }

  it("awaits no crossing load whose scope the family's identity cannot resolve", async () => {
    const { link, leafId } = await authoredParent();
    const unresolvable = {
      space: farSpace,
      id: "of:runner-cov-c-unresolvable" as const,
      scope: "session" as const,
    };
    const leaf = {
      space: farSpace,
      id: leafId as `of:${string}`,
      scope: "space" as const,
    };
    using _reported = stub(servingManager, "followsCrossings", () => true);
    using _crossings = stub(
      servingManager,
      "pendingCrossingLoadAddresses",
      () => [unresolvable, leaf],
    );
    using settles = recordSettles();

    // The family runs for a principal outside any session.
    expect(await resume(link, { principal: signer.did() })).toBe("n:Ada");
    expect(settles.keys.some((key) => key.includes(unresolvable.id))).toBe(
      false,
    );
    expect(settles.keys.some((key) => key.endsWith(`/${leafId}`))).toBe(true);
  });

  it("awaits the loads a plan's read kicks where the server reports no crossings", async () => {
    const { link, leafId } = await authoredParent();
    using _unreported = stub(servingManager, "followsCrossings", () => false);
    using settles = recordSettles();

    expect(await resume(link)).toBe("n:Ada");
    expect(settles.keys.some((key) => key.endsWith(`/${leafId}`))).toBe(true);
  });

  it("reads no inputs of a passthrough node, which copies them whole", async () => {
    const farTx = author.edit();
    const leaf = author.getCell<{ name?: string }>(
      farSpace,
      "copied far leaf",
      undefined,
      farTx,
    );
    leaf.withTx(farTx).set({ name: "Ada" });
    expect((await farTx.commit().settled).error).toBeUndefined();
    const copying = trustExecutable(author, {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "object" } },
      },
      resultSchema: {},
      result: { $alias: { partialCause: "output", path: [] } },
      nodes: [{
        module: { type: "passthrough" },
        inputs: { value: { $alias: { cell: "argument", path: ["input"] } } },
        outputs: { value: { $alias: { partialCause: "output", path: [] } } },
      }],
    } as Pattern);
    const ref = { identity: "of:fid1:runner-cov-c-copying", symbol: "default" };
    author.patternManager.associatePatternIdentity(copying, ref);
    serving.patternManager.associatePatternIdentity(copying, ref);
    const tx = author.edit();
    const authored = author.getCell<unknown>(space, "copying", undefined, tx);
    const running = author.run(tx, copying, { input: leaf } as never, authored);
    expect((await tx.commit().settled).error).toBeUndefined();
    await running.pull();
    await author.idle();
    await author.storageManager.synced();
    using _unreported = stub(servingManager, "followsCrossings", () => false);
    using settles = recordSettles();

    const resumed = serving.getCellFromLink(authored.getAsNormalizedFullLink());
    await resumed.sync();
    expect(await serving.start(resumed)).toBe(true);
    await serving.idle();

    const leafId = leaf.getAsNormalizedFullLink().id;
    expect(settles.keys.some((key) => key.endsWith(`/${leafId}`))).toBe(false);
    // What the node copied leads to the far document, which the copy did
    // not read.
    const output = getDerivedInternalCell(resumed, { partialCause: "output" });
    expect(output.resolveAsCell().getAsNormalizedFullLink().id).toBe(leafId);
  });
});
