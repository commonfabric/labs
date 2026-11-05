import {
  factoryStateOf,
  isAdmittedFabricFactory,
} from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  getLoggerCountsBreakdown,
  getTimingStatsBreakdown,
  resetAllLoggerCounts,
  resetAllTimingStats,
} from "@commonfabric/logger";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import type { Cell, PatternFactory } from "../src/builder/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  areNormalizedLinksSame,
  getMetaLink,
  parseLink,
} from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("bound list factory cold resume");
const space = signer.did();

const CALLBACK_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ values: number[]; factor: number }>(({ values, factor }) => ({",
      "  mapped: values.map((element, index, array) => element * factor + index + array.length),",
      "}));",
    ].join("\n"),
  }],
};

const OUTER_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern, PatternFactory } from 'commonfabric';",
      "type Argument = { element: number; index: number; array: number[] };",
      "type Input = { values: number[]; op: PatternFactory<Argument, number> };",
      "export default pattern<Input>(({ values, op }) => ({",
      "  mapped: (values as any).mapWithPattern(op),",
      "}));",
    ].join("\n"),
  }],
};

class SharedServerStorageManager extends EmulatedStorageManager {
  static override connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager.sharedServer = server;
    return manager;
  }

  private sharedServer!: MemoryV2Server.Server;

  protected override server(): MemoryV2Server.Server {
    return this.sharedServer;
  }
}

function createSharedServer(): MemoryV2Server.Server {
  return new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });
}

function owningResultCell(runtime: Runtime, projected: Cell<unknown>) {
  const ownerLink = getMetaLink(projected, "result");
  if (ownerLink === undefined) return projected;
  const { overwrite: _, ...ownerTarget } = ownerLink;
  return runtime.getCellFromLink(ownerTarget);
}

type CurryView<T, R> = PatternFactory<T, R> & {
  curry(params: unknown): PatternFactory<T, R>;
};

function curry<T, R>(
  factory: PatternFactory<T, R>,
  params: unknown,
): PatternFactory<T, R> {
  return (factory as CurryView<T, R>).curry(params);
}

async function expectMapped(
  runtime: Runtime,
  root: Cell<unknown>,
  expected: number[],
): Promise<void> {
  const actual = await waitForCellValue<number[]>(
    runtime,
    root.key("mapped"),
    (value) => JSON.stringify(value) === JSON.stringify(expected),
  );
  expect(actual).toEqual(expected);
}

describe("bound PatternFactory list operation cold resume", () => {
  it("preserves identities and follows its hidden linked params", async () => {
    const server = createSharedServer();
    let storage: SharedServerStorageManager | undefined;
    let runtime: Runtime | undefined;

    try {
      storage = SharedServerStorageManager.connectTo(server, { as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });

      // Compile the callback producer separately from the parent. This writes
      // the callback's content-addressed artifact, while ensuring that loading
      // the parent in session 2 cannot incidentally warm the callback artifact.
      const callbackProducer = await runtime.patternManager.compilePattern(
        CALLBACK_PROGRAM,
        { space },
      );
      const callbackNode = callbackProducer.nodes.find((node) => {
        const inputs = node.inputs as Record<string, unknown>;
        return Object.hasOwn(inputs, "list") && Object.hasOwn(inputs, "op");
      });
      expect(callbackNode).toBeDefined();
      expect(Object.hasOwn(callbackNode!.inputs as object, "params")).toBe(
        false,
      );
      const op = (callbackNode!.inputs as Record<string, unknown>).op;
      expect(isAdmittedFabricFactory(op)).toBe(true);
      if (!isAdmittedFabricFactory(op)) throw new Error("expected bound op");
      const state = factoryStateOf(op);
      expect(state.kind).toBe("pattern");
      if (state.kind !== "pattern") throw new Error("expected pattern state");
      const baseRef = state.ref;
      expect(baseRef).toBeDefined();
      if (baseRef === undefined) throw new Error("expected durable op ref");
      expect(state.params).toMatchObject({
        factor: { $alias: { cell: "argument", path: ["factor"] } },
      });

      const base = runtime.patternManager.artifactFromIdentitySync(
        baseRef.identity,
        baseRef.symbol,
      );
      expect(base).toBeDefined();
      if (base === undefined) throw new Error("expected warm callback base");

      const seedTx = runtime.edit();
      const factor = runtime.getCell<number>(
        space,
        "bound list factory linked factor",
        { type: "number" },
        seedTx,
      );
      factor.set(10);
      const selector = runtime.getCell<unknown>(
        space,
        "bound list factory persisted selector",
        undefined,
        seedTx,
      );
      selector.set(curry(base as PatternFactory<unknown, unknown>, { factor }));
      runtime.prepareTxForCommit(seedTx);
      expect((await seedTx.commit().settled).error).toBeUndefined();
      const factorLink = factor.getAsNormalizedFullLink();

      const compiled = await runtime.patternManager.compilePattern(
        OUTER_PROGRAM,
        { space },
      );
      const listNode = compiled.nodes.find((node) => {
        const inputs = node.inputs as Record<string, unknown>;
        return Object.hasOwn(inputs, "list") && Object.hasOwn(inputs, "op");
      });
      expect(listNode).toBeDefined();
      expect(Object.hasOwn(listNode!.inputs as object, "params")).toBe(false);

      const tx = runtime.edit();
      const root = runtime.getCell<Record<string, unknown>>(
        space,
        "bound list factory cold resume result",
        compiled.resultSchema,
        tx,
      );
      const result = runtime.run(
        tx,
        compiled,
        { values: [2, 4], op: selector },
        root,
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await expectMapped(runtime, result, [22, 43]);

      const rootLink = result.getAsNormalizedFullLink();
      const aggregateLink = result.key("mapped").resolveAsCell()
        .getAsNormalizedFullLink();
      const row = owningResultCell(
        runtime,
        result.key("mapped").key(0).resolveAsCell() as Cell<unknown>,
      );
      const rowLink = row.getAsNormalizedFullLink();
      const paramsLink = getMetaLink(row, "params")!;
      const params = runtime.getCellFromLink(paramsLink);
      const captureLink = parseLink(
        (params.getRaw() as { factor: unknown }).factor,
        params,
      );
      expect(captureLink).toMatchObject({
        space: factorLink.space,
        id: factorLink.id,
        path: factorLink.path,
        scope: factorLink.scope,
      });

      await runtime.patternManager.flushCompileCacheWrites();
      await storage.synced();
      runtime.runner.stop(result);
      await runtime.dispose();
      runtime = undefined;
      await storage.close();
      storage = undefined;

      storage = SharedServerStorageManager.connectTo(server, { as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      expect(
        runtime.patternManager.artifactFromIdentitySync(
          baseRef.identity,
          baseRef.symbol,
        ),
      ).toBeUndefined();

      const resumedRoot = runtime.getCellFromLink(rootLink);
      await resumedRoot.sync();
      const rowReadiness = Promise.withResolvers<void>();
      const retryStarted = Promise.withResolvers<void>();
      const syncRow = runtime.runner.syncCellsForPatternResume.bind(
        runtime.runner,
      );
      let syncAttempts = 0;
      runtime.runner.syncCellsForPatternResume = async (...args) => {
        syncAttempts++;
        if (syncAttempts === 1) {
          throw new Error("injected transient resumed-row sync failure");
        }
        if (syncAttempts === 3) retryStarted.resolve();
        const synced = await syncRow(...args);
        await rowReadiness.promise;
        return synced;
      };
      resetAllLoggerCounts();
      resetAllTimingStats();
      expect(await runtime.start(resumedRoot)).toBe(true);
      const resumedMappedCell = resumedRoot.key("mapped") as Cell<number[]>;
      const resumedMapped = waitForCellValue<number[]>(
        runtime,
        resumedMappedCell,
        (value) => JSON.stringify(value) === JSON.stringify([22, 43]),
      );
      const mapRuns = () =>
        runtime!.scheduler.getGraphSnapshot().nodes.find((node) =>
          node.id.startsWith("raw:map:")
        )?.stats?.runCount ?? 0;
      await retryStarted.promise;
      const parkedRuns = mapRuns();
      await runtime.idle();
      let pullSettled = false;
      const pulledMapped = resumedMappedCell.pull().then(
        (value) => {
          pullSettled = true;
          return value;
        },
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(pullSettled).toBe(false);
      const argument = runtime.getCellFromLink(
        getMetaLink(resumedRoot, "argument")!,
      );
      for (const values of [[2], [2, 4, 6], [2, 4]]) {
        expect(
          (await runtime.editWithRetry((updateTx) => {
            argument.withTx(updateTx).key("values").set(values);
          })).error,
        ).toBeUndefined();
        await runtime.idle();
      }
      expect(mapRuns()).toBeLessThanOrEqual(parkedRuns + 1);
      resetAllLoggerCounts();
      resetAllTimingStats();
      rowReadiness.resolve();
      expect(await pulledMapped).toEqual([22, 43]);
      expect(await resumedMapped).toEqual([22, 43]);
      expect(
        getLoggerCountsBreakdown()["storage.v2"]?.["commit-conflict"]
          ?.total ?? 0,
      ).toBe(0);
      expect(
        getTimingStatsBreakdown()["storage.v2"]?.[
          "commitNative/commitOperations"
        ]?.count ?? 0,
      ).toBe(0);
      expect(
        runtime.patternManager.artifactFromIdentitySync(
          baseRef.identity,
          baseRef.symbol,
        ),
      ).toBeDefined();
      expect(runtime.patternManager.getCompileCacheStats().byIdentityHits)
        .toBeGreaterThanOrEqual(2);

      expect(areNormalizedLinksSame(
        resumedRoot.key("mapped").resolveAsCell().getAsNormalizedFullLink(),
        aggregateLink,
      )).toBe(true);
      const resumedRow = owningResultCell(
        runtime,
        resumedRoot.key("mapped").key(0).resolveAsCell() as Cell<unknown>,
      );
      expect(areNormalizedLinksSame(
        resumedRow.getAsNormalizedFullLink(),
        rowLink,
      )).toBe(true);
      expect(areNormalizedLinksSame(
        getMetaLink(resumedRow, "params")!,
        paramsLink,
      )).toBe(true);

      const update = await runtime.editWithRetry((updateTx) => {
        runtime!.getCellFromLink(factorLink, undefined, updateTx).set(3);
      });
      expect(update.error).toBeUndefined();
      await expectMapped(runtime, resumedRoot, [8, 15]);

      expect(areNormalizedLinksSame(
        resumedRoot.key("mapped").resolveAsCell().getAsNormalizedFullLink(),
        aggregateLink,
      )).toBe(true);
      expect(areNormalizedLinksSame(
        owningResultCell(
          runtime,
          resumedRoot.key("mapped").key(0).resolveAsCell() as Cell<unknown>,
        ).getAsNormalizedFullLink(),
        rowLink,
      )).toBe(true);
    } finally {
      await runtime?.dispose();
      await storage?.close();
      await server.close();
    }
  });
});
