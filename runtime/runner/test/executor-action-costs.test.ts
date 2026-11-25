/**
 * The serving loop's action costs, read where an operator reads them: from the
 * host's counters, after a pattern has been served and a client has changed
 * its input. The table's own rules are pinned in
 * `test/executor/action-costs.test.ts`; this file pins that a served run
 * reaches the table with the piece, the authored site, and the cause of the
 * run.
 */

import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { ArrivalLog } from "./support/serving-waits.ts";

const spaceSigner = await Identity.fromPassphrase("action costs space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("action costs service");
const aliceSigner = await Identity.fromPassphrase("action costs alice");

const PATTERN = [
  "import { computed, pattern } from 'commonfabric';",
  "export default pattern<{ n: number }, { total: number }>(",
  "  ({ n }) => ({ total: computed(() => n * 7) }),",
  ");",
].join("\n");

describe("serving-loop action costs", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: EmulatedStorageManager | undefined;
  let clientRuntime: Runtime | undefined;
  let activations: ArrivalLog<{ space: string; outcome: string }>;
  let resultId: string | undefined;

  const newHost = (): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        const compiled = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: PATTERN }],
        }, { space });
        const argument = runtime.getCell<{ n: number }>(space, "arg");
        const result = runtime.getCell<{ total: number }>(
          space,
          "result",
          compiled.resultSchema,
        );
        await argument.sync();
        await result.sync();
        await runtime.storageManager.synced();
        resultId = result.getAsNormalizedFullLink().id;
        const tx = runtime.edit();
        runtime.run(tx, compiled, argument, result);
        const committed = await tx.commit().settled;
        if (committed.error !== undefined) {
          throw new Error(
            `serving pattern run failed: ${committed.error.message}`,
          );
        }
        await runtime.idle();
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      onActivationSettled: (activatedSpace, outcome) =>
        activations.record({ space: activatedSpace, outcome }),
    });

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    activations = new ArrivalLog();
    resultId = undefined;
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime?.dispose();
    clientRuntime = undefined;
    await clientManager?.close();
    clientManager = undefined;
    await server.close();
  });

  it("lists a served derivation with its piece and authored site, counting the runs its input changes caused", async () => {
    host = newHost();
    expect(host.stats().actions.entries).toEqual([]);
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const client = clientRuntime;
    const clientResult = client.getCell<{ total: number }>(space, "result");
    await clientResult.sync();
    const cancelDemand = clientResult.sink(() => {});
    await activations.matching((entry) =>
      entry.space === space && entry.outcome === "active"
    );
    const clientArg = client.getCell<{ n: number }>(space, "arg");
    await clientArg.sync();
    for (const n of [6, 9]) {
      const tx = client.edit();
      clientArg.withTx(tx).set({ n });
      expect((await tx.commit().settled).error).toBeUndefined();
      await waitForCellValue<number>(
        client,
        clientResult.key("total"),
        (total) => total === n * 7,
        { stuckLabel: `the client's total to reach ${n * 7}` },
      );
    }
    cancelDemand();

    const derivation = host.stats().actions.entries.find((entry) =>
      entry.src?.includes("/main.tsx") === true
    );
    expect(derivation).toBeDefined();
    expect(derivation!.space).toBe(space);
    expect(derivation!.piece).toBe(resultId);
    expect(derivation!.inputRuns).toBeGreaterThanOrEqual(2);
    expect(derivation!.runs).toBeGreaterThanOrEqual(derivation!.inputRuns);
    expect(derivation!.totalMs).toBeGreaterThanOrEqual(derivation!.longestMs);
    expect(derivation!.longestMs).toBeGreaterThanOrEqual(derivation!.lastMs);
  });
});
