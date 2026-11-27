import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { SpaceServer } from "../src/executor/space-server.ts";
import { emptyServingLoopStats } from "../src/executor/stats.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { ArrivalLog } from "./support/serving-waits.ts";

const spaceSigner = await Identity.fromPassphrase("dispatched carriage space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "dispatched carriage service",
);

describe("SpaceServer", () => {
  let server: MemoryV2Server.Server;
  let spaceServer: SpaceServer;
  let servingRuntime: Runtime | undefined;

  beforeEach(async () => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    spaceServer = new SpaceServer({
      space,
      server,
      engine: await server.engineForSpace(space),
      serviceIdentity: serviceSigner.did(),
      createRuntime: () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
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
      localSeqRef: { value: 0 },
      stats: emptyServingLoopStats(),
      policy: { flushDeadlineMs: 2_000, idleParkMs: 600_000 },
    });
  });

  afterEach(async () => {
    await spaceServer.park("test-teardown");
    await server.close();
  });

  describe("activate()", () => {
    it("answers the serving runtime's dispatched-carriage question from its outbox while a request it sent runs", async () => {
      expect(await spaceServer.activate()).toBe(true);
      const runtime = servingRuntime!;
      const key = "fetchTest:dispatched-carriage";
      const sent = new ArrivalLog<void>();
      const answered = Promise.withResolvers<void>();
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "test/dispatched-carriage",
        kind: "derivation",
        acting: { user: "user:alice", session: "sess-1" },
      });
      tx.enqueuePostCommitEffect({
        id: key,
        kind: "fetchTest-start",
        flush: () => {
          runtime.asyncWorkObserver?.(answered.promise);
          sent.record();
        },
      });
      expect(runtime.hasDispatchedEffectCarriage(key)).toBe(false);
      expect((await tx.commit().settled).error).toBeUndefined();
      await sent.reached(1);

      expect(runtime.hasDispatchedEffectCarriage(key)).toBe(true);
      expect(runtime.hasDispatchedEffectCarriage("fetchTest:never-sent"))
        .toBe(false);
      answered.resolve();
    });

    it("leaves the serving runtime reporting no dispatched carriage once a park whose cleanup failed has closed the outbox", async () => {
      expect(await spaceServer.activate()).toBe(true);
      const runtime = servingRuntime!;
      const key = "fetchTest:parked-carriage";
      const sent = new ArrivalLog<void>();
      const answered = Promise.withResolvers<void>();
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "test/parked-carriage",
        kind: "derivation",
        acting: { user: "user:alice", session: "sess-1" },
      });
      tx.enqueuePostCommitEffect({
        id: key,
        kind: "fetchTest-start",
        flush: () => {
          runtime.asyncWorkObserver?.(answered.promise);
          sent.record();
        },
      });
      expect((await tx.commit().settled).error).toBeUndefined();
      await sent.reached(1);
      expect(runtime.hasDispatchedEffectCarriage(key)).toBe(true);

      // The park's observer cleanup opens the space's provider; failing that
      // once leaves the runtime's seal destination, and with it the carriage
      // question, installed after the outbox has gone.
      const manager = runtime.storageManager;
      const open = manager.open;
      manager.open = () => {
        manager.open = open;
        throw new Error("observer cleanup failed");
      };
      await spaceServer.park("cleanup-failed");

      expect(runtime.sealDestinationInstalled).toBe(true);
      expect(runtime.hasDispatchedEffectCarriage(key)).toBe(false);
      answered.resolve();
    });
  });
});
