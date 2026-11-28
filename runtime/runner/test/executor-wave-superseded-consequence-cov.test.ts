import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { type PatchOp, toDocumentPath } from "@commonfabric/memory/v2";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
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
import type { Cell } from "../src/cell.ts";
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
    // The server advertises marked splices, so the served runs' array
    // changes are held to the rules a wave batch meets.
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
   * Seeds a list with `seeded`, has a peer session apply `peer` to it, then
   * the firing session apply `patches`, then the peer session apply
   * `peerAfter`, all straight in the store, and commits a wave under the
   * space's lease holding the handler run of the event `e-list`, which does
   * `write` to the list, and a derivation that writes another document. The
   * firing session's commit carries a recursive read of the list where it
   * marks a splice, as a marked splice must. Returns the wave's outcome and
   * the list as the store then holds it.
   */
  const commitListRun = async <T = string[]>(
    seeded: T,
    patches: PatchOp[],
    write: (list: Cell<T>) => void,
    peer: PatchOp[] = [],
    peerAfter: PatchOp[] = [],
  ) => {
    const list = runtime.getCell<T>(space, "wave-list", undefined);
    const other = runtime.getCell<number>(space, "wave-list-other", undefined);
    const seed = runtime.edit();
    list.withTx(seed).set(seeded);
    other.withTx(seed).set(0);
    expect((await seed.commit().settled).error).toBeUndefined();
    const eventSeq = Engine.serverSeq(engine);
    const listId = list.getAsNormalizedFullLink().id;
    let peerSeq = 0;
    const applyPeer = (peerPatches: PatchOp[]) => {
      if (peerPatches.length === 0) return;
      Engine.applyCommit(engine, {
        sessionId: "sess-peer",
        principal: "did:key:bob",
        commit: {
          localSeq: ++peerSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "patch", id: listId, patches: peerPatches }],
        },
      });
    };
    applyPeer(peer);
    const marks = patches.some((patch) =>
      patch.op === "splice" && patch.pinned === true
    );
    Engine.applyCommit(engine, {
      sessionId: firing.session,
      principal: firing.user,
      commit: {
        localSeq: 1,
        reads: {
          confirmed: marks
            ? [{
              id: listId,
              path: toDocumentPath(["value"]),
              seq: Engine.serverSeq(engine),
            }]
            : [],
          pending: [],
        },
        operations: [{ op: "patch", id: listId, patches }],
      },
    });
    applyPeer(peerAfter);
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
      write(list.withTx(handler));
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

    it("commits a served derivation's head insertion into a list", async () => {
      // A wave batch carries no read set the store checks, so a served run's
      // array change goes index by index: a marked splice in it would be
      // refused, and the wave with it.
      const list = runtime.getCell<string[]>(space, "wave-derived", undefined);
      const seed = runtime.edit();
      list.withTx(seed).set(["a", "b", "c"]);
      expect((await seed.commit().settled).error).toBeUndefined();
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
        const derivation = runtime.edit();
        stampWaveRunContext(derivation, {
          actionId: "derive-list",
          kind: "derivation",
        });
        const current = list.withTx(derivation).get() as string[];
        list.withTx(derivation).set(["x", ...current]);
        expect((await derivation.commit().settled).error).toBeUndefined();
        runtime.clearSealDestination();
        const outcome = await wave.commitWave(
          new EngineWaveCommitSink({
            engineFor: () => engine,
            sessionId: holder,
          }),
        );
        await wave.settled();

        expect(outcome.dispositions).toEqual([{ kind: "committed" }]);
        expect(
          Engine.readState(engine, { id: list.getAsNormalizedFullLink().id })
            ?.document,
        ).toEqual({ value: ["x", "a", "b", "c"] });
      } finally {
        await lease.release();
      }
    });

    it("drops an event consequence at an element the firing session's later splice moved", async () => {
      const { outcome, stored } = await commitListRun(
        ["a", "b", "c", "d"],
        [{
          op: "splice",
          path: "/value",
          index: 0,
          remove: 1,
          add: ["typed", "x"],
          pinned: true,
        }],
        (list) => list.key(0).set("handler"),
      );

      expect(stored).toEqual({ value: ["typed", "x", "b", "c", "d"] });
      expect(outcome.dispositions).toEqual([
        { kind: "dropped" },
        { kind: "committed" },
      ]);
      expect(outcome.committedEventIds).toEqual(["e-list"]);
    });

    it("keeps an event consequence at an element before the firing session's later splice", async () => {
      const { outcome, stored } = await commitListRun(
        ["a", "b", "c", "d"],
        [{
          op: "splice",
          path: "/value",
          index: 2,
          remove: 0,
          add: ["x"],
          pinned: true,
        }],
        (list) => list.key(0).set("handler"),
      );

      expect(stored).toEqual({ value: ["handler", "b", "x", "c", "d"] });
      expect(outcome.dispositions).toEqual([
        { kind: "committed" },
        { kind: "committed" },
      ]);
    });

    it("keeps an event consequence at an element the firing session's move left in place", async () => {
      // `c` moves to the head as an insertion and a removal; `e` ends where it
      // started.
      const { outcome, stored } = await commitListRun(
        ["a", "b", "c", "d", "e", "f"],
        [
          {
            op: "splice",
            path: "/value",
            index: 0,
            remove: 0,
            add: ["c"],
            pinned: true,
          },
          {
            op: "splice",
            path: "/value",
            index: 3,
            remove: 1,
            add: [],
            pinned: true,
          },
        ],
        (list) => list.key(4).set("handler"),
      );

      expect(stored).toEqual({
        value: ["c", "a", "b", "d", "handler", "f"],
      });
      expect(outcome.dispositions).toEqual([
        { kind: "committed" },
        { kind: "committed" },
      ]);
    });

    it("keeps an event consequence at an element a peer appended that the firing session's unmarked splice moved", async () => {
      // The firing session's tail append was diffed against `[a, b]`, and goes
      // unmarked; a peer's append landed first, so the splice inserts before
      // the peer's elements and moves them. An unmarked splice overwrites
      // nothing, so the handler's write to one of those elements stands.
      const { outcome, stored } = await commitListRun(
        ["a", "b"],
        [{ op: "splice", path: "/value", index: 2, remove: 0, add: ["mine"] }],
        (list) => list.key(4).set("handler"),
        [{ op: "append", path: "/value", values: ["p", "q", "r"] }],
      );

      expect(stored).toEqual({
        value: ["a", "b", "mine", "p", "handler", "r"],
      });
      expect(outcome.dispositions).toEqual([
        { kind: "committed" },
        { kind: "committed" },
      ]);
    });

    it("keeps an event consequence at a key of an object that replaced the array the firing session spliced", async () => {
      // The firing session's splice overwrote the list's element 0; a peer
      // then replaced the list with an object. The key "00" names no array
      // index, even though it reads as the number 0, so the splice did not
      // overwrite the handler's write to it.
      const { outcome, stored } = await commitListRun<
        string[] | Record<string, string>
      >(
        ["a", "b", "c"],
        [{
          op: "splice",
          path: "/value",
          index: 0,
          remove: 1,
          add: ["typed"],
          pinned: true,
        }],
        (list) => list.key("00").set("handler"),
        [],
        [{ op: "replace", path: "/value", value: { "00": "p", "0": "q" } }],
      );

      expect(stored).toEqual({ value: { "00": "handler", "0": "q" } });
      expect(outcome.dispositions).toEqual([
        { kind: "committed" },
        { kind: "committed" },
      ]);
    });

    it("drops an event consequence at an index key of an object that replaced the array the firing session spliced", async () => {
      const { outcome, stored } = await commitListRun<
        string[] | Record<string, string>
      >(
        ["a", "b", "c"],
        [{
          op: "splice",
          path: "/value",
          index: 0,
          remove: 1,
          add: ["typed"],
          pinned: true,
        }],
        (list) => list.key("0").set("handler"),
        [],
        [{ op: "replace", path: "/value", value: { "00": "p", "0": "q" } }],
      );

      expect(stored).toEqual({ value: { "00": "p", "0": "q" } });
      expect(outcome.dispositions).toEqual([
        { kind: "dropped" },
        { kind: "committed" },
      ]);
    });

    it("drops only the overwritten element of a consequence that replaces it and inserts beside it", async () => {
      // The handler's change would be one splice that replaces element 0 and
      // inserts after it. It goes index by index, so the wave can drop the
      // write to element 0 that the firing session overwrote, and keep the
      // rest.
      const { outcome, stored } = await commitListRun(
        ["a", "b", "c", "d"],
        [{ op: "replace", path: "/value/0", value: "typed" }],
        (list) => {
          const current = list.get() as string[];
          list.set(["handler", "x", ...current.slice(1)]);
        },
      );

      expect(stored).toEqual({ value: ["typed", "x", "b", "c", "d"] });
      expect(outcome.dispositions).toEqual([
        { kind: "partially-dropped", droppedOps: 1 },
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
