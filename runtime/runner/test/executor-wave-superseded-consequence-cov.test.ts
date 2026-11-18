import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { PatchOp } from "@commonfabric/memory/v2";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import { EngineWaveCommitSink } from "../src/executor/engine-wave-sink.ts";
import { stampWaveRunContext, WaveAccumulator } from "../src/executor/wave.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("wave superseded consequence");
const space = signer.did() as MemorySpace;

type Draft = { name: string; bio: string };

describe("WaveAccumulator", () => {
  // The session that fired an event writes over the one document the event's
  // consequence writes, before the wave opens, so the wave drops the whole of
  // the consequence's home writes.

  let server: MemoryV2Server.Server;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;
  let engine: Engine.Engine;

  const firing = { user: "did:key:alice", session: "sess-fire" };
  const typed: Draft = { name: "Grace", bio: "Admiral" };

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

  /**
   * Seeds the draft, has the firing session overwrite it straight in the
   * store when `overwrite` is set, and commits a wave under the space's lease
   * holding the handler run of the event `e-edit`, which writes the draft,
   * and a derivation that writes another document. Returns the wave's
   * outcome and the draft as the store then holds it.
   */
  const commitOverwrittenRun = async (overwrite: boolean) => {
    const draft = runtime.getCell<Draft>(space, "wave-draft", undefined);
    const other = runtime.getCell<number>(space, "wave-other", undefined);
    const seed = runtime.edit();
    draft.withTx(seed).set({ name: "", bio: "" });
    other.withTx(seed).set(0);
    expect((await seed.commit().settled).error).toBeUndefined();
    const eventSeq = Engine.serverSeq(engine);
    if (overwrite) {
      Engine.applyCommit(engine, {
        sessionId: firing.session,
        principal: firing.user,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: draft.getAsNormalizedFullLink().id,
            patches: [{ op: "replace", path: "/value", value: typed }],
          }],
        },
      });
    }
    await server.flushSessions([space]);
    await storageManager.open(space).pullToServerHead?.();
    await draft.sync();

    const holder = executionLeaseHolder(`service:${space}`);
    const lease = new ExecutionLeaseCycle({
      leases: engine.executionLeases,
      space,
      holder,
    });
    expect(await lease.acquire()).toBe(true);
    try {
      const wave = new WaveAccumulator({
        space,
        basisSeq: Engine.serverSeq(engine),
        scopeKeyIdentity: {
          principal: signer.did(),
          sessionId: "wave-test-session",
        },
        replicaFor: (s) => storageManager.open(s).replica,
        lease,
      });
      runtime.installSealDestination(wave);
      const handler = runtime.edit();
      stampWaveRunContext(handler, {
        actionId: "start-editing",
        kind: "event-handler",
        eventId: "e-edit",
        acting: firing,
        streamEntry: { sidecarId: "stream-edit", index: 0, seq: eventSeq },
      });
      draft.withTx(handler).set({ name: "Ada", bio: "Countess" });
      expect((await handler.commit().settled).error).toBeUndefined();
      const derivation = runtime.edit();
      stampWaveRunContext(derivation, {
        actionId: "derive",
        kind: "derivation",
      });
      other.withTx(derivation).set(1);
      expect((await derivation.commit().settled).error).toBeUndefined();
      runtime.clearSealDestination();
      const outcome = await wave.commitWave(
        new EngineWaveCommitSink({
          engineFor: () => engine,
          sessionId: holder,
        }),
      );
      await wave.settled();
      const stored = Engine.readState(engine, {
        id: draft.getAsNormalizedFullLink().id,
      })?.document;
      return { outcome, stored };
    } finally {
      await lease.release();
    }
  };

  /**
   * Seeds a list, has the firing session apply `splice` to it straight in
   * the store, and commits a wave under the space's lease holding the handler
   * run of the event `e-list`, which writes the list's first element, and a
   * derivation that writes another document. Returns the wave's outcome and
   * the list as the store then holds it.
   */
  const commitSplicedRun = async (splice: PatchOp) => {
    const list = runtime.getCell<string[]>(space, "wave-list", undefined);
    const other = runtime.getCell<number>(space, "wave-list-other", undefined);
    const seed = runtime.edit();
    list.withTx(seed).set(["a", "b", "c", "d"]);
    other.withTx(seed).set(0);
    expect((await seed.commit().settled).error).toBeUndefined();
    const eventSeq = Engine.serverSeq(engine);
    Engine.applyCommit(engine, {
      sessionId: firing.session,
      principal: firing.user,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: list.getAsNormalizedFullLink().id,
          patches: [splice],
        }],
      },
    });
    await server.flushSessions([space]);
    await storageManager.open(space).pullToServerHead?.();
    await list.sync();

    const holder = executionLeaseHolder(`service:${space}`);
    const lease = new ExecutionLeaseCycle({
      leases: engine.executionLeases,
      space,
      holder,
    });
    expect(await lease.acquire()).toBe(true);
    try {
      const wave = new WaveAccumulator({
        space,
        basisSeq: Engine.serverSeq(engine),
        scopeKeyIdentity: {
          principal: signer.did(),
          sessionId: "wave-test-session",
        },
        replicaFor: (s) => storageManager.open(s).replica,
        lease,
      });
      runtime.installSealDestination(wave);
      const handler = runtime.edit();
      stampWaveRunContext(handler, {
        actionId: "pick-first",
        kind: "event-handler",
        eventId: "e-list",
        acting: firing,
        streamEntry: { sidecarId: "stream-list", index: 0, seq: eventSeq },
      });
      list.withTx(handler).key(0).set("handler");
      expect((await handler.commit().settled).error).toBeUndefined();
      const derivation = runtime.edit();
      stampWaveRunContext(derivation, {
        actionId: "derive",
        kind: "derivation",
      });
      other.withTx(derivation).set(1);
      expect((await derivation.commit().settled).error).toBeUndefined();
      runtime.clearSealDestination();
      const outcome = await wave.commitWave(
        new EngineWaveCommitSink({
          engineFor: () => engine,
          sessionId: holder,
        }),
      );
      await wave.settled();
      const stored = Engine.readState(engine, {
        id: list.getAsNormalizedFullLink().id,
      })?.document;
      return { outcome, stored };
    } finally {
      await lease.release();
    }
  };

  describe("commitWave()", () => {
    it("drops an event consequence whose every home write the firing session overwrote, and names its event committed", async () => {
      const { outcome, stored } = await commitOverwrittenRun(true);

      expect(stored).toEqual({ value: typed });
      expect(outcome.dispositions).toEqual([
        { kind: "dropped" },
        { kind: "committed" },
      ]);
      expect(outcome.committedEventIds).toEqual(["e-edit"]);
      expect(outcome.requeuedEventIds).toEqual([]);
    });

    it("drops an event consequence at an element the firing session's later splice moved", async () => {
      const { outcome, stored } = await commitSplicedRun({
        op: "splice",
        path: "/value",
        index: 0,
        remove: 1,
        add: ["typed", "x"],
      });

      expect(stored).toEqual({ value: ["typed", "x", "b", "c", "d"] });
      expect(outcome.dispositions).toEqual([
        { kind: "dropped" },
        { kind: "committed" },
      ]);
      expect(outcome.committedEventIds).toEqual(["e-list"]);
    });

    it("keeps an event consequence at an element before the firing session's later splice", async () => {
      const { outcome, stored } = await commitSplicedRun({
        op: "splice",
        path: "/value",
        index: 2,
        remove: 0,
        add: ["x"],
      });

      expect(stored).toEqual({ value: ["handler", "b", "x", "c", "d"] });
      expect(outcome.dispositions).toEqual([
        { kind: "committed" },
        { kind: "committed" },
      ]);
    });

    it("commits the same consequence where nothing overwrote its write", async () => {
      const { outcome, stored } = await commitOverwrittenRun(false);

      expect(stored).toEqual({ value: { name: "Ada", bio: "Countess" } });
      expect(outcome.dispositions).toEqual([
        { kind: "committed" },
        { kind: "committed" },
      ]);
      expect(outcome.committedEventIds).toEqual(["e-edit"]);
    });
  });
});
