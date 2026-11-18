/**
 * What a wave accumulator keeps once its wave is over. A committed or
 * abandoned wave is still named: a node started in it holds the transaction
 * that sealed into it, and the serving loop reads its counts and awaits its
 * settlement after the commit. The sealed commits themselves, each holding
 * the documents a run wrote and read, are of no use after the outcome, so
 * the accumulator lets go of them.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { stampWaveRunContext, WaveAccumulator } from "../src/executor/wave.ts";
import { EngineWaveCommitSink } from "../src/executor/engine-wave-sink.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("wave sealed state test");
const space = signer.did() as MemorySpace;

describe("wave", () => {
  let server: MemoryV2Server.Server;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;
  let engine: Engine.Engine;

  beforeEach(async () => {
    server = newSharedServer();
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
    });
    engine = await server.engineForSpace(space);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  /** A wave under a live lease, as the serving loop's waves are. */
  const newWave = async (): Promise<WaveAccumulator> => {
    const lease = new ExecutionLeaseCycle({
      leases: engine.executionLeases,
      space,
      holder: executionLeaseHolder(`service:${space}`),
    });
    if (!await lease.acquire()) throw new Error("The lease was not acquired");
    return new WaveAccumulator({
      space,
      basisSeq: Engine.serverSeq(engine),
      scopeKeyIdentity: {
        principal: signer.did(),
        sessionId: "wave-sealed-state-session",
      },
      replicaFor: (s) => storageManager.open(s).replica,
      lease,
    });
  };

  const newSink = (): EngineWaveCommitSink =>
    new EngineWaveCommitSink({
      engineFor: () => engine,
      sessionId: executionLeaseHolder(`service:${space}`),
    });

  /** Seals two derivation runs into `wave`, each writing one document. */
  const sealTwoDerivations = async (wave: WaveAccumulator): Promise<void> => {
    runtime.installSealDestination(wave);
    try {
      for (const name of ["first", "second"]) {
        const cell = runtime.getCell<{ value: string }>(
          space,
          `wave-sealed-state-${name}`,
          undefined,
        );
        const tx = runtime.edit();
        stampWaveRunContext(tx, {
          actionId: `derive-${name}`,
          kind: "derivation",
        });
        cell.withTx(tx).set({ value: name });
        expect((await tx.commit().settled).error).toBeUndefined();
      }
    } finally {
      runtime.clearSealDestination();
    }
    expect(wave.accessForTestingOnly.heldSealedCommits).toBe(2);
  };

  describe("commitWave()", () => {
    it("holds no sealed commit once the wave has committed", async () => {
      const wave = await newWave();
      await sealTwoDerivations(wave);
      const seqBefore = Engine.serverSeq(engine);

      const outcome = await wave.commitWave(newSink());

      expect(outcome.seq).toBeGreaterThan(seqBefore);
      expect(wave.accessForTestingOnly.heldSealedCommits).toBe(0);
    });

    it("still counts its contributions after the commit", async () => {
      const wave = await newWave();
      await sealTwoDerivations(wave);

      await wave.commitWave(newSink());

      expect(wave.contributionCount).toBe(2);
      expect(wave.contentContributionCount).toBe(2);
      expect(wave.hasOutboundAppends).toBe(false);
      expect(wave.foreignSpaces).toEqual([]);
    });

    it("settles after the commit", async () => {
      const wave = await newWave();
      await sealTwoDerivations(wave);

      await wave.commitWave(newSink());

      await expect(wave.settled()).resolves.toBeUndefined();
    });
  });

  describe("abandon()", () => {
    it("holds no sealed commit once the wave is abandoned", async () => {
      const wave = await newWave();
      await sealTwoDerivations(wave);

      wave.abandon("the test is over");

      expect(wave.accessForTestingOnly.heldSealedCommits).toBe(0);
      expect(wave.contributionCount).toBe(2);
      await expect(wave.settled()).resolves.toBeUndefined();
    });
  });
});
