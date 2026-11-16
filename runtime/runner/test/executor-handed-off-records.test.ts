/**
 * The preparation records of a transaction whose post-commit effects a
 * serving loop took over, checked against a real `SpaceServer`: a start of a
 * hand-built pattern on the serving runtime stages the piece's session pattern
 * pointer behind a runner-acceptance effect, which the loop's outbox flushes
 * after the wave commits.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import type { Pattern } from "../src/builder/types.ts";
import { SpaceServer } from "../src/executor/space-server.ts";
import { emptyServingLoopStats } from "../src/executor/stats.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { ArrivalLog, awaitEach } from "./support/serving-waits.ts";
import { trustExecutable } from "./support/trusted-builder.ts";

const spaceSigner = await Identity.fromPassphrase(
  "executor handed-off records space",
);
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "executor handed-off records service",
);

/** A hand-built pattern, which a start gives a session pointer only. */
const KEYLESS: Pattern = {
  argumentSchema: { type: "object", properties: {} },
  resultSchema: {},
  result: { marker: "started" },
  nodes: [],
};

describe("executor-handed-off-records", () => {
  let server: MemoryV2Server.Server;
  let engine: Engine.Engine;
  let spaceServer: SpaceServer;
  let runtime: Runtime | undefined;
  let retirements: ArrivalLog<void>;

  beforeEach(async () => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    engine = await server.engineForSpace(space);
    retirements = new ArrivalLog();
    runtime = undefined;
    spaceServer = new SpaceServer({
      space,
      server,
      engine,
      serviceIdentity: serviceSigner.did(),
      createRuntime: () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const created = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        runtime = created;
        return Promise.resolve({
          runtime: created,
          dispose: async () => {
            await created.dispose();
            await manager.close();
          },
        });
      },
      localSeqRef: { value: 0 },
      stats: emptyServingLoopStats(),
      onEffectRetired: retirements.record,
      policy: { flushDeadlineMs: 2_000, idleParkMs: 600_000 },
    });
    expect(await spaceServer.activate()).toBe(true);
  });

  afterEach(async () => {
    await spaceServer?.park("test-teardown");
    await server.close();
  });

  it("releases a start's records once it settles, and still publishes the pointer its acceptance carries", async () => {
    const serving = runtime!;
    const resultCell = serving.getCell(space, "handed-off records");
    await resultCell.sync();
    const seqBefore = Engine.serverSeq(engine);

    const tx = serving.edit();
    stampWaveRunContext(tx, {
      actionId: "test/keyless-start",
      kind: "derivation",
    });
    serving.run(tx, trustExecutable(serving, KEYLESS), {}, resultCell);
    serving.prepareTxForCommit(tx);
    expect(tx.getCfcState().writePolicyInputs.length).toBeGreaterThan(0);
    expect(tx.hasPendingPostCommitEffects()).toBe(true);

    expect((await tx.commit().settled).error).toBeUndefined();
    await tx.postCommitEffectsSettled();
    await awaitEach(
      retirements,
      () =>
        Engine.serverSeq(engine) > seqBefore &&
        serving.runner.sessionPatternPointerFor(resultCell) !== undefined,
    );

    const state = tx.getCfcState();
    expect(state.prepare.status).not.toBe("prepared");
    expect(state.writePolicyInputs).toEqual([]);
    expect(state.writePolicyInputIdentities.size).toBe(0);
    expect(state.dereferenceTraces).toEqual([]);
  });
});
