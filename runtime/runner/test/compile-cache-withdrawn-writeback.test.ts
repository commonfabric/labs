// A serving runtime's compile-cache write-back commits when its wave accepts
// it, and the wave can still withdraw it at the wave commit
// (serving-loop.md §3d). These pin what the pattern manager makes of that: a
// withdrawn write is a failed one, which the next load of the program in the
// space writes back (module-loading.md, cross-space closure replication).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { selectDocHead } from "@commonfabric/memory/v2/engine";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import type { WaveCommitSink } from "../src/executor/wave.ts";
import { resolveEntryIdentity } from "../src/index.ts";
import { sourceDocKey } from "../src/compilation-cache/cell-cache.ts";
import { ArrivalLog } from "./support/serving-waits.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const homeSigner = await Identity.fromPassphrase("withdrawn writeback home");
const homeSpace = homeSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "withdrawn writeback service",
);
const aliceSigner = await Identity.fromPassphrase("withdrawn writeback alice");

const PROGRAM = {
  main: "/withdrawn.tsx",
  files: [{
    name: "/withdrawn.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "export default pattern<{ n: number }, { out: number }>(",
      "  ({ n }) => ({ out: computed(() => n + 3) }),",
      ");",
    ].join("\n"),
  }],
};

const ENTRY_IDENTITY = await resolveEntryIdentity(
  PROGRAM.main,
  (name) =>
    Promise.resolve(
      PROGRAM.files.find((file) => file.name === name)!.contents,
    ),
);

describe("compile-cache-withdrawn-writeback", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost;
  let clientManager: EmulatedStorageManager;
  let clientRuntime: Runtime;
  let servingRuntime: Runtime | undefined;
  let activations: ArrivalLog<{ space: string; outcome: string }>;
  let cancelDemand: () => void;

  /** The id of the program's entry source document in the home space. */
  let entryDocId: string | undefined;

  /** Whether the next wave commit writing the entry document is refused. */
  let refuseEntryWrite: boolean;

  /** The wave commits that wrote the entry document, refused ones included. */
  let entryWrites: ArrivalLog<{ refused: boolean }>;

  beforeEach(async () => {
    server = newSharedServer({
      subscriptionRefreshDelayMs: 0,
      delegatingDids: [serviceSigner.did()],
    });
    servingRuntime = undefined;
    entryDocId = undefined;
    refuseEntryWrite = false;
    entryWrites = new ArrivalLog();
    activations = new ArrivalLog();
    host = new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      decorateWaveCommitSink: (sink: WaveCommitSink): WaveCommitSink => ({
        reportsCommits: sink.reportsCommits,
        currentHeads: sink.currentHeads.bind(sink),
        concurrentWritePaths: sink.concurrentWritePaths.bind(sink),
        intrusionSince: sink.intrusionSince?.bind(sink),
        staleReads: sink.staleReads?.bind(sink),
        sessionOverwritePathsSince: sink.sessionOverwritePathsSince?.bind(sink),
        commitSpaceAccessChange: sink.commitSpaceAccessChange?.bind(sink),
        commitWave: (batch) => {
          if (
            !batch.operations.some((op) => "id" in op && op.id === entryDocId)
          ) {
            return sink.commitWave(batch);
          }
          const refused = refuseEntryWrite;
          refuseEntryWrite = false;
          entryWrites.record({ refused });
          return refused
            ? Promise.resolve({
              error: {
                name: "WaveCommitRejected",
                message: "the test refuses the wave writing the entry",
              },
            })
            : sink.commitWave(batch);
        },
      }),
      createRuntime: (space) => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
          servingHomeSpace: space,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        servingRuntime = runtime;
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      onActivationSettled: (space, outcome) =>
        activations.record({ space, outcome }),
    });

    // A client's demand activates the home space's serving tenure.
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
    cancelDemand = clientRuntime.getCell<{ ping: number }>(
      homeSpace,
      "withdrawn-writeback-demand",
      undefined,
    ).sink(() => {});
    await activations.matching((entry) =>
      entry.space === homeSpace && entry.outcome === "active"
    );
    entryDocId =
      servingRuntime!.getCell(homeSpace, sourceDocKey(ENTRY_IDENTITY))
        .getAsNormalizedFullLink().id;
  });

  afterEach(async () => {
    cancelDemand();
    await host.close();
    await clientRuntime.dispose();
    await clientManager.close();
    await server.close();
  });

  /** The serving runtime's compile of the program into the home space, once
   * the waves holding its write-back have committed or withdrawn it. */
  const compileIntoHome = async (serving: Runtime) => {
    const compiled = await serving.patternManager.compilePattern(PROGRAM, {
      space: homeSpace,
    });
    await serving.sealsCommitted!();
    await serving.patternManager.flushCompileCacheWrites();
    return serving.patternManager.getArtifactEntryRef(compiled)!;
  };

  /** Loads the program in the home space, which the compile serves from
   * memory, and waits until what the load wrote has committed. */
  const loadInHome = async (serving: Runtime, symbol: string) => {
    await serving.patternManager.loadPatternByIdentity(
      ENTRY_IDENTITY,
      symbol,
      homeSpace,
    );
    await serving.patternManager.flushCompileCacheWrites();
    await serving.sealsCommitted!();
  };

  /** The head of the entry source document in the home space's store. */
  const storedEntryHead = async () =>
    selectDocHead(await server.engineForSpace(homeSpace), {
      id: entryDocId!,
      scopeKey: "space",
    });

  it("writes the closure back on the next load in the space after the wave withdrew its write", async () => {
    const serving = servingRuntime!;
    refuseEntryWrite = true;
    const entry = await compileIntoHome(serving);
    expect(entry.identity).toBe(ENTRY_IDENTITY);
    expect(entryWrites.entries).toEqual([{ refused: true }]);
    expect(await storedEntryHead()).toBe(0);

    await loadInHome(serving, entry.symbol);

    expect(entryWrites.entries).toEqual([
      { refused: true },
      { refused: false },
    ]);
    expect(await storedEntryHead()).toBeGreaterThan(0);
  });

  it("writes nothing back on a load in the space after the wave committed its write", async () => {
    const serving = servingRuntime!;
    const entry = await compileIntoHome(serving);
    expect(entryWrites.entries).toEqual([{ refused: false }]);
    expect(await storedEntryHead()).toBeGreaterThan(0);

    await loadInHome(serving, entry.symbol);

    expect(entryWrites.entries).toEqual([{ refused: false }]);
  });

  it("leaves the space out of the closure's recorded holders after the wave withdrew its write there", async () => {
    // What a replication takes as a fallback origin, and what a load served
    // from memory takes as a space needing no copy.

    const serving = servingRuntime!;
    refuseEntryWrite = true;
    await compileIntoHome(serving);

    expect(
      serving.patternManager.accessForTestingOnly.persistedClosureSpaces
        .get(ENTRY_IDENTITY)?.has(homeSpace) ?? false,
    ).toBe(false);
  });

  it("records the space among the closure's holders after the wave committed its write there", async () => {
    const serving = servingRuntime!;
    await compileIntoHome(serving);

    expect(
      serving.patternManager.accessForTestingOnly.persistedClosureSpaces
        .get(ENTRY_IDENTITY)?.has(homeSpace),
    ).toBe(true);
  });
});
