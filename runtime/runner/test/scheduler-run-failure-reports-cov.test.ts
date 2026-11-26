/**
 * What a reactive run reports when the scheduler's own bookkeeping around it
 * throws: finalizing the run, and deciding whether a run a wave dropped is
 * owed again.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { getLogger, setLoggerCountObserver } from "@commonfabric/logger";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { EngineWaveCommitSink } from "../src/executor/engine-wave-sink.ts";
import { stampWaveRunContext, WaveAccumulator } from "../src/executor/wave.ts";
import { createSigilLinkFromParsedLink } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action, ErrorWithContext } from "../src/scheduler.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("scheduler run failure reports");
const space = signer.did() as MemorySpace;

const REARM_FAILED = "wave-withdrawal-rearm-failed";

/** How many re-arm failures the scheduler's logger has logged. */
const rearmFailures = (): number =>
  getLogger("scheduler").countsByKey[REARM_FAILED]?.error ?? 0;

describe("scheduler run failure reports", () => {
  let server: ReturnType<typeof newSharedServer>;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;
  let actions: Action[];

  beforeEach(() => {
    server = newSharedServer();
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
    });
    actions = [];
  });

  afterEach(async () => {
    for (const action of actions) runtime.scheduler.unsubscribe(action);
    runtime.clearSealDestination();
    await storageManager.synced();
    await runtime.dispose();
    await server.close();
  });

  describe("a run whose finalization throws", () => {
    for (const throws of [true, false]) {
      it(`${throws ? "reports the throw as the run's error, and still commits the run" : "reports nothing for a run whose finalization completes"}`, async () => {
        const output = runtime.getCell<string>(space, `finalize-${throws}`);
        const errors: ErrorWithContext[] = [];
        runtime.scheduler.onError((error) => errors.push(error));
        const submit = runtime.telemetry.submit.bind(runtime.telemetry);
        let thrown = 0;
        using _submit = stub(
          runtime.telemetry,
          "submit",
          (marker: Parameters<typeof submit>[0]) => {
            if (
              throws && thrown === 0 && marker.type === "scheduler.run.complete"
            ) {
              thrown++;
              throw new Error("telemetry refused the marker");
            }
            submit(marker);
          },
        );
        const write: Action = (tx) => {
          tx.writeValueOrThrow(output.getAsNormalizedFullLink(), "written");
        };
        actions.push(write);
        runtime.scheduler.subscribe(write, {
          reads: [],
          shallowReads: [],
          writes: [],
        }, { isEffect: true });
        await runtime.scheduler.idleWithPendingCommits();

        expect(errors.map((error) => error.message)).toEqual(
          throws ? ["telemetry refused the marker"] : [],
        );
        expect(output.get()).toBe("written");
      });
    }
  });

  describe("a dropped run whose owed check throws", () => {
    // A client's piece start leaves a computed document holding structure and
    // no value, which drops a served run's write to it; such a run is owed
    // again once the replica shows the document holds no value. A check that
    // throws is reported, and the run is not re-armed on its account.

    let engine: Engine.Engine;
    let lease: ExecutionLeaseCycle;
    let waves: WaveAccumulator[];

    beforeEach(async () => {
      waves = [];
      engine = await server.engineForSpace(space);
      lease = new ExecutionLeaseCycle({
        leases: engine.executionLeases,
        space,
        holder: executionLeaseHolder(`service:${space}`),
      });
      expect(await lease.acquire()).toBe(true);
    });

    afterEach(async () => {
      setLoggerCountObserver(undefined);
      runtime.clearSealDestination();
      for (const wave of waves) wave.abandon("test cleanup");
      await Promise.all(waves.map((wave) => wave.settled()));
      await lease.release();
    });

    const newWave = () => {
      const wave = new WaveAccumulator({
        space,
        basisSeq: Engine.serverSeq(engine),
        lease,
        foreignWrites: "accept",
        foreignWriteGrant: () => true,
        scopeKeyIdentity: { principal: signer.did(), sessionId: "wave-test" },
        replicaFor: (target) => storageManager.open(target).replica,
      });
      waves.push(wave);
      return wave;
    };

    for (const throws of [true, false]) {
      it(`${throws ? "logs the failure and does not run it again" : "runs it again"} when the check ${throws ? "throws" : "completes"}`, async () => {
        const failuresBefore = rearmFailures();
        // The re-arm runs off the wave's settlement, outside anything the
        // scheduler's idle waits on, so the case waits on its report.
        const reported = Promise.withResolvers<void>();
        setLoggerCountObserver((module, key) => {
          if (module === "scheduler" && key === REARM_FAILED) {
            reported.resolve();
          }
        });
        const output = runtime.getCell<string>(space, `owed-output-${throws}`);
        const outputLink = output.getAsNormalizedFullLink();
        const resultLink = createSigilLinkFromParsedLink(
          runtime.getCell(space, `owed-result-${throws}`)
            .getAsNormalizedFullLink(),
        );
        // The wave's basis predates the authored commit, which the run's
        // write then loses to.
        const wave = newWave();
        const authored = runtime.edit();
        output.withTx(authored).setMetaRaw(
          "result",
          resultLink,
          rawMetaWriteAuthorization,
        );
        expect((await authored.commit().settled).error).toBeUndefined();

        let flushing = false;
        let recoveryWave: WaveAccumulator | undefined;
        runtime.installSealDestination({
          seal: (tx) => (flushing ? recoveryWave ??= newWave() : wave).seal(tx),
        }, {
          runStamper: (tx, info) =>
            stampWaveRunContext(tx, {
              actionId: info.actionId,
              kind: info.kind,
            }),
        });
        let runs = 0;
        const rerun = Promise.withResolvers<void>();
        const derive: Action = (tx) => {
          if (++runs === 2) rerun.resolve();
          tx.writeValueOrThrow(outputLink, "derived");
        };
        actions.push(derive);
        runtime.scheduler.subscribe(derive, {
          reads: [],
          shallowReads: [],
          writes: [],
        }, { isEffect: true });
        await runtime.scheduler.idleWithPendingCommits();
        expect(runs).toBe(1);

        const replica = storageManager.open(space).replica;
        const getDocument = replica.getDocument.bind(replica);
        let checking = false;
        using _getDocument = stub(
          replica,
          "getDocument",
          (...args: Parameters<typeof getDocument>) => {
            if (checking && throws && args[0] === outputLink.id) {
              throw new Error("the replica could not read the output");
            }
            return getDocument(...args);
          },
        );
        flushing = true;
        checking = true;
        const outcome = await wave.commitWave(
          new EngineWaveCommitSink({
            engineFor: () => engine,
            sessionId: executionLeaseHolder(`service:${space}`),
          }),
        );
        await wave.settled();
        expect(outcome.supersededWrites).toBe(1);
        await (throws ? reported.promise : rerun.promise);
        setLoggerCountObserver(undefined);
        await runtime.scheduler.idleWithPendingCommits();
        checking = false;

        expect(runs).toBe(throws ? 1 : 2);
        expect(rearmFailures() - failuresBefore).toBe(throws ? 1 : 0);
        if (throws) {
          expect(
            getLogger("scheduler").errorMessagesByKey[REARM_FAILED]?.some(
              (message) =>
                message.includes("Could not re-arm a withdrawn reactive run") &&
                message.includes("the replica could not read the output"),
            ),
          ).toBe(true);
        }
      });
    }
  });
});
