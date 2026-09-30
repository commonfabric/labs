/** Commits test fixture writes through the served instance's wave protocol. */

import { expect } from "@std/expect";
import type * as Engine from "@commonfabric/memory/v2/engine";
import { serverSeq } from "@commonfabric/memory/v2/engine";
import type { ExecutionLeaseCycle } from "@commonfabric/memory/v2/execution-lease";
import { EngineWaveCommitSink } from "../../src/executor/engine-wave-sink.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  waveRunContextOf,
  waveSettlementOf,
} from "../../src/executor/wave.ts";
import type { Runtime } from "../../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../../src/storage/interface.ts";

/** Commits each served transaction in its own wave under the run's instance. */
export function servedCommitDestination(
  runtime: Runtime,
  space: MemorySpace,
  engine: Engine.Engine,
  lease: ExecutionLeaseCycle,
) {
  const sink = new EngineWaveCommitSink({
    engineFor: () => engine,
    sessionId: lease.holder,
  });
  return {
    seal: async (tx: IExtendedStorageTransaction) => {
      if (waveRunContextOf(tx) === undefined) {
        stampWaveRunContext(tx, {
          actionId: "served-fixture-completion",
          kind: "bookkeeping",
          scopeKeyIdentity: tx.tx.scopeKeyIdentity,
        });
      }
      const wave = new WaveAccumulator({
        space,
        basisSeq: serverSeq(engine),
        scopeKeyIdentity: runtime.scopeKeyIdentity,
        replicaFor: (target) => runtime.storageManager.open(target).replica,
        lease,
      });
      const sealed = await wave.seal(tx);
      if (sealed.error !== undefined) return sealed;
      const outcome = await wave.commitWave(sink);
      await wave.settled();
      expect(outcome.aborted).toBeUndefined();
      return (await waveSettlementOf(tx)) ?? sealed;
    },
  };
}
