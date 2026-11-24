/**
 * A computation whose run reads an input before the input has arrived is
 * refused, and runs again once the input arrives. While the input is in
 * transit, a document this replica has not loaded yet, the refused run writes
 * nothing over a result the node already holds, so a client starting a piece
 * cold, whose first runs read inputs in spaces it has not loaded yet, never
 * replaces a stored result, for itself or for any other client, with one read
 * from data that had not arrived. A confirmed refusal replaces the stale
 * value with a diagnostic describing the failure.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { isUnavailable } from "@commonfabric/data-model/availability";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const owner = await Identity.fromPassphrase("refused-run-keeps-result owner");
const inputSigner = await Identity.fromPassphrase(
  "refused-run-keeps-result input space",
);
const space = owner.did() as MemorySpace;
const inputSpace = inputSigner.did() as MemorySpace;

/** A piece whose one computation reads a document in another space. */
const COMPUTED_PATTERN = [
  "import { computed, pattern, Writable } from 'commonfabric';",
  "type Ref = Writable<{ name: string }>;",
  "export default pattern<{ ref: Ref }, { out: string }>(({ ref }) => {",
  "  const out = computed(() => 'out:' + ref.get().name);",
  "  return { out };",
  "});",
].join("\n");

/**
 * The same piece, its computation a lift taking the document as its whole
 * argument, so that an input not yet arrived leaves the argument undefined
 * where the runtime reads arguments eagerly.
 */
const LIFT_PATTERN = [
  "import { lift, pattern, Writable } from 'commonfabric';",
  "type Ref = Writable<{ name: string }>;",
  "const label = lift((input: { name: string }) => 'out:' + input.name);",
  "export default pattern<{ ref: Ref }, { out: string }>(({ ref }) => {",
  "  const out = label(ref);",
  "  return { out };",
  "});",
].join("\n");

/**
 * The first piece, its computation reading a number in the piece's own space
 * too, so that a change made there runs it while its input is in transit.
 */
const TICKED_PATTERN = [
  "import { computed, pattern, Writable } from 'commonfabric';",
  "type Ref = Writable<{ name: string }>;",
  "export default pattern<{ ref: Ref; tick: Writable<number> }, { out: string }>(",
  "  ({ ref, tick }) => {",
  "    const out = computed(() => 'out:' + ref.get().name + ':' + tick.get());",
  "    return { out };",
  "  },",
  ");",
].join("\n");

/** How a case's runtimes read and what the piece is. */
interface Shape {
  pattern: string;
  lazyMaterialization?: false;
}

describe("refused-run-keeps-result", () => {
  let server: MemoryV2Server.Server;
  let sessions: MemoryV2Server.SessionRegistry;
  let opened: { runtime: Runtime; storage: EmulatedStorageManager }[];
  let inputSpaceHeld: PromiseWithResolvers<void> | undefined;
  let shape: Shape;

  /** A runtime of its own over the shared server, acting as `owner`. */
  const open = (): Runtime => {
    const storage = EmulatedStorageManager.connectTo(server, { as: owner });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      ...(shape.lazyMaterialization === false
        ? { experimental: { lazyMaterialization: false } }
        : {}),
    });
    runtime.scheduler.setActionRunTraceEnabled(true);
    opened.push({ runtime, storage });
    return runtime;
  };

  beforeEach(() => {
    opened = [];
    inputSpaceHeld = undefined;
    shape = { pattern: COMPUTED_PATTERN };
    sessions = new MemoryV2Server.SessionRegistry();
    server = newSharedServer({ subscriptionRefreshDelayMs: 0, sessions });
    // A session on the input space opens only once the test lets it, so a
    // cold runtime's first run reads its input before the input arrives.
    const openSession = server.openSession.bind(server);
    server.openSession = async (message, connection) => {
      if (message.space === inputSpace) await inputSpaceHeld?.promise;
      return openSession(message, connection);
    };
  });

  afterEach(async () => {
    inputSpaceHeld?.resolve();
    for (const { runtime, storage } of opened.splice(0)) {
      await runtime.dispose();
      await storage.close();
    }
    await server.close();
  });

  /**
   * Runs the piece on a warm runtime against an input named `name`, and, when
   * `stored` is set, has it compute and store the piece's `out`. Returns the
   * runtime, the input, the piece's result, and the id of the document `out`
   * is stored in.
   */
  const standUp = async (name: string, stored: boolean) => {
    const warm = open();
    const compiled = await warm.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: shape.pattern }],
    }, { space });
    const ref = warm.getCell<{ name: string }>(inputSpace, "input");
    {
      const tx = warm.edit();
      ref.withTx(tx).set({ name });
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    const result = warm.getCell<Record<string, unknown>>(
      space,
      "result",
      compiled.resultSchema,
    );
    {
      const tx = warm.edit();
      warm.run(tx, compiled, { ref }, result);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    if (stored) expect(await result.key("out").pull()).toBe(`out:${name}`);
    await warm.idle();
    await warm.storageManager.synced();
    const outId = result.key("out").resolveAsCell().getAsNormalizedFullLink()
      .id;
    return { warm, compiled, ref, result, outId };
  };

  /** Sets the input's name from `runtime`, without demanding `out`. */
  const rename = async (
    runtime: Runtime,
    ref: Cell<{ name: string }>,
    name: string,
  ): Promise<void> => {
    const tx = runtime.edit();
    ref.withTx(tx).set({ name });
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await runtime.storageManager.synced();
  };

  /** Each value the store has held for the document `id`, in order. */
  const storedValues = async (id: string): Promise<string[]> => {
    const engine = await server.engineForSpace(space);
    return (engine.database.prepare(
      `SELECT data FROM revision WHERE id = :id ORDER BY seq, op_index`,
    ).all({ id }) as Array<{ data: string }>).map((row) => row.data)
      .filter((data) => data.includes("value"));
  };

  /** How many times `runtime` has run `out`'s computation. */
  const outRuns = (runtime: Runtime): number =>
    runtime.scheduler.getActionRunTrace().filter((entry) =>
      entry.actionType === "computation"
    ).length;

  /**
   * Starts the piece on a cold runtime with its input space held, subscribes
   * to `out`, and waits for the runtime to settle with the input still out of
   * reach. `prepare`, when given, is handed the runtime's storage before the
   * piece starts. Returns the runtime, its result cell, and what its
   * subscription has seen.
   */
  const startCold = async (
    compiled: { resultSchema?: unknown },
    prepare?: (storage: EmulatedStorageManager, runtime: Runtime) => void,
  ) => {
    inputSpaceHeld = Promise.withResolvers<void>();
    const cold = open();
    prepare?.(opened.at(-1)!.storage, cold);
    const coldResult = cold.getCell<Record<string, unknown>>(
      space,
      "result",
      compiled.resultSchema as never,
    );
    await coldResult.sync();
    expect(await cold.start(coldResult)).toBe(true);
    const seen: unknown[] = [];
    const cancel = coldResult.key("out").sink((value) => {
      seen.push(value);
    });
    await cold.idle();
    return { cold, coldResult, seen, cancel };
  };

  /** Lets the input space open, and waits for `runtime` to settle. */
  const releaseInput = async (runtime: Runtime): Promise<void> => {
    inputSpaceHeld!.resolve();
    await runtime.idle();
    await runtime.storageManager.synced();
    await runtime.idle();
  };

  /** Counts loads initiated to establish readiness, apart from link prefetches. */
  function watchReadinessLoads(
    storage: EmulatedStorageManager,
    runtime: Runtime,
    target: Cell<{ name: string }>,
    onLoad: () => void,
    failure?: Promise<never>,
  ): void {
    const targetId = target.getAsNormalizedFullLink().id;
    let checkingReadiness = false;
    const ensure = runtime.ensureLinkedDocLoaded.bind(runtime);
    runtime.ensureLinkedDocLoaded = (...args) => {
      checkingReadiness = true;
      try {
        return ensure(...args);
      } finally {
        checkingReadiness = false;
      }
    };
    const sync = storage.syncCell.bind(storage);
    storage.syncCell = (cell, options) => {
      const link = cell.getAsNormalizedFullLink();
      if (link.space === inputSpace && link.id === targetId) {
        if (checkingReadiness) onLoad();
        if (failure !== undefined) return failure;
      }
      return sync(cell, options);
    };
  }

  function verifyRefusals() {
    it("leaves a result it already holds in place while its input has not arrived, and writes the input's result once it has", async () => {
      // The stored `out` is stale: the input was renamed once the warm runtime
      // stopped the piece, so the cold start's run has a different result to
      // write once its input arrives. A third runtime watches `out` without
      // running the piece, as another client showing it does.

      const { warm, compiled, ref, result, outId } = await standUp("abc", true);
      warm.runner.stop(result);
      await rename(warm, ref, "def");
      const watcher = open();
      const watched = watcher.getCell<Record<string, unknown>>(
        space,
        "result",
        compiled.resultSchema as never,
      );
      await watched.sync();
      const watcherSeen: unknown[] = [];
      const watcherSawNew = Promise.withResolvers<void>();
      const cancelWatcher = watched.key("out").sink((value) => {
        watcherSeen.push(value);
        if ((value as unknown) === "out:def") watcherSawNew.resolve();
      });
      await watcher.idle();
      await watcher.storageManager.synced();
      expect(outRuns(watcher)).toBe(0);
      const before = await storedValues(outId);

      const { cold, coldResult, seen, cancel } = await startCold(compiled);
      expect(outRuns(cold)).toBe(1);
      expect(await storedValues(outId)).toEqual(before);
      expect(coldResult.key("out").get()).toBe("out:abc");

      await releaseInput(cold);
      await watcher.idle();
      await watcher.storageManager.synced();
      expect(outRuns(cold)).toBe(2);
      expect(coldResult.key("out").get()).toBe("out:def");
      const after = await storedValues(outId);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length)).toHaveLength(1);
      expect(after.some((data) => data.includes("Undefined"))).toBe(false);
      expect(seen).toEqual(["out:abc", "out:def"]);
      // The server pushes the new value to the watcher after the cold runtime
      // settles, so the case waits for the push to reach the watcher's
      // subscription.
      await watcherSawNew.promise;
      expect(watcherSeen).toEqual(["out:abc", "out:def"]);
      expect(outRuns(watcher)).toBe(0);
      cancel();
      cancelWatcher();
    });

    it("writes no result for a node that holds none while its input has not arrived, and writes the input's result once it has", async () => {
      const { compiled, outId } = await standUp("abc", false);
      const before = await storedValues(outId);
      expect(before).toEqual([]);

      const { cold, coldResult, cancel } = await startCold(compiled);
      expect(outRuns(cold)).toBe(1);
      expect(await storedValues(outId)).toEqual([]);
      expect(coldResult.key("out").get()).toBeUndefined();

      await releaseInput(cold);
      expect(outRuns(cold)).toBe(2);
      expect(coldResult.key("out").get()).toBe("out:abc");
      const after = await storedValues(outId);
      expect(after).toHaveLength(1);
      expect(after[0]).toContain("out:abc");
      cancel();
    });

    it("replaces a stale result with a schema error when the input has the wrong shape", async () => {
      const { warm, ref, result, outId } = await standUp("abc", true);
      const seen: unknown[] = [];
      const cancel = result.key("out").sink((value) => {
        seen.push(value);
      });
      await warm.idle();
      {
        const tx = warm.edit();
        ref.withTx(tx).setRaw({ name: 5 } as never);
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      await warm.idle();
      await warm.storageManager.synced();
      const error = result.key("out").get();
      expect(isUnavailable(error) && error.errorKind).toBe("schemaMismatch");
      const stored = await storedValues(outId);
      expect(stored.at(-1)).toContain("schemaMismatch");
      expect(seen.at(-1)).toEqual(error);
      cancel();
    });

    it("reports a schema error only after the store confirms the input is absent", async () => {
      // The piece's argument is pointed at a document nothing has written, in
      // the input space, while nothing demands `out`. The cold start keeps the
      // stored result while that space is out of reach.

      const { warm, compiled, result, outId } = await standUp("abc", true);
      warm.runner.stop(result);
      {
        const tx = warm.edit();
        result.withTx(tx).getArgumentCell<{ ref: unknown }>()!.key("ref").set(
          warm.getCell<{ name: string }>(inputSpace, "never-written") as never,
        );
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      await warm.idle();
      await warm.storageManager.synced();
      const before = await storedValues(outId);

      const { cold, coldResult, cancel } = await startCold(compiled);
      expect(await storedValues(outId)).toEqual(before);
      expect(coldResult.key("out").get()).toBe("out:abc");

      await releaseInput(cold);
      const error = coldResult.key("out").get();
      expect(isUnavailable(error) && error.errorKind).toBe("schemaMismatch");
      const after = await storedValues(outId);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length)).toHaveLength(1);
      expect(after.at(-1)).toContain("schemaMismatch");
      cancel();
    });

    it("reports the failed load once, with its cause, without asking for it again", async () => {
      // Every load of the input space's documents on the cold runtime fails
      // once the case lets it, while the space stays out of reach. A failed
      // load leaves the input unexamined, so a run that kept the result and
      // asked for the load again would do so after every failure. The case
      // counts storage requests made to establish readiness, separately from
      // best-effort prefetches made while resolving the piece's links.

      const { warm, compiled, ref, result, outId } = await standUp("abc", true);
      warm.runner.stop(result);
      await rename(warm, ref, "def");
      const before = await storedValues(outId);

      const failure = Promise.withResolvers<never>();
      failure.promise.catch(() => {});
      let inputLoads = 0;
      const secondLoad = Promise.withResolvers<"asked again">();
      const { cold, coldResult, cancel } = await startCold(
        compiled,
        (storage, runtime) => {
          watchReadinessLoads(storage, runtime, ref, () => {
            if (++inputLoads > 1) secondLoad.resolve("asked again");
          }, failure.promise);
        },
      );
      expect(outRuns(cold)).toBe(1);
      expect(inputLoads).toBe(1);
      expect(coldResult.key("out").get()).toBe("out:abc");
      const reported = Promise.withResolvers<"reported">();
      const cancelReported = coldResult.key("out").sink((value) => {
        if (isUnavailable(value) && value.errorKind === "sync") {
          reported.resolve("reported");
        }
      });

      failure.reject(new Error("Document load failed"));
      expect(await Promise.race([reported.promise, secondLoad.promise]))
        .toBe("reported");
      await cold.idle();
      expect(outRuns(cold)).toBe(2);
      expect(inputLoads).toBe(1);
      await cold.storageManager.synced();
      const after = await storedValues(outId);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length)).toHaveLength(1);
      expect(after.at(-1)).toContain("Document load failed");
      const error = coldResult.key("out").get();
      expect(isUnavailable(error) && error.message).toBe(
        "Document load failed",
      );
      cancelReported();
      cancel();
    });
    it("reports a terminal refusal once the input's space refuses the reader, without repeatedly requesting it", async () => {
      // The input space is deleted while the cold runtime waits on it, so the
      // space refuses the runtime's session and the input never arrives. A
      // refused space neither delivers the document nor reports it absent, so
      // a run that kept the result and asked for the load again would do so
      // for as long as the runtime ran. The case counts the loads the runner
      // asks for once the space is deleted, as the case above does, and races
      // a second one against the diagnostic, so a run that keeps asking
      // fails the case rather than holding it.

      const { warm, compiled, ref, result, outId } = await standUp("abc", true);
      warm.runner.stop(result);
      await rename(warm, ref, "def");
      const before = await storedValues(outId);

      let deleted = false;
      // The refusal the server gives every command to a deleted space.
      const refusal: NonNullable<
        Awaited<ReturnType<MemoryV2Server.Server["deletedSpaceRefusal"]>>
      > = {
        name: "AuthorizationError",
        message: `Space ${inputSpace} is deleted`,
        deleted: true,
        permanentEvidence: true,
        aclRevision: 1,
      };
      const deletedSpaceRefusal = server.deletedSpaceRefusal.bind(server);
      server.deletedSpaceRefusal = (asked) =>
        deleted && asked === inputSpace
          ? Promise.resolve(refusal)
          : deletedSpaceRefusal(asked);

      let loadsSinceDeletion = 0;
      const secondLoad = Promise.withResolvers<"asked again">();
      const { cold, coldResult, cancel } = await startCold(
        compiled,
        (storage, runtime) => {
          watchReadinessLoads(storage, runtime, ref, () => {
            if (deleted && ++loadsSinceDeletion > 1) {
              secondLoad.resolve("asked again");
            }
          });
        },
      );
      expect(outRuns(cold)).toBe(1);
      expect(coldResult.key("out").get()).toBe("out:abc");
      const reported = Promise.withResolvers<unknown>();
      const cancelReported = coldResult.key("out").sink((value) => {
        if (isUnavailable(value) && value.isError()) reported.resolve(value);
      });

      deleted = true;
      inputSpaceHeld!.resolve();
      const error = await Promise.race([reported.promise, secondLoad.promise]);
      expect(isUnavailable(error) && error.errorKind).toBe("schemaMismatch");
      await cold.idle();
      expect(loadsSinceDeletion).toBeLessThanOrEqual(1);
      await cold.storageManager.synced();
      const after = await storedValues(outId);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length)).toHaveLength(1);
      expect(after.at(-1)).toContain("schemaMismatch");
      cancelReported();
      cancel();
    });
  }

  describe("a computed with lazy inputs", verifyRefusals);

  it("keeps a result through a later transit of an input whose kept load delivered it", async () => {
    // The cold runtime keeps the stored result through its input's transit,
    // and the load it asks for delivers the input. Its input replica is then
    // replaced, and a change in the piece's own space runs the computation
    // while the replacement's load is held open, so the input is in transit
    // again. A load that delivered its document is not one that settled
    // without it, so the run keeps the result again, and the store receives
    // no clearing revision while the replacement loads.

    shape = { pattern: TICKED_PATTERN };
    const warm = open();
    const compiled = await warm.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: shape.pattern }],
    }, { space });
    const ref = warm.getCell<{ name: string }>(inputSpace, "input");
    const tick = warm.getCell<number>(space, "tick");
    // A transaction writes one space, so the input and the number are set
    // apart.
    for (const write of [() => ref, () => tick]) {
      const tx = warm.edit();
      const cell = write();
      if (cell === ref) ref.withTx(tx).set({ name: "abc" });
      else tick.withTx(tx).set(0);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    const result = warm.getCell<Record<string, unknown>>(
      space,
      "result",
      compiled.resultSchema,
    );
    {
      const tx = warm.edit();
      warm.run(tx, compiled, { ref, tick }, result);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    expect(await result.key("out").pull()).toBe("out:abc:0");
    await warm.idle();
    await warm.storageManager.synced();
    const outId = result.key("out").resolveAsCell().getAsNormalizedFullLink()
      .id;
    warm.runner.stop(result);
    await rename(warm, ref, "def");

    const { cold, coldResult, cancel } = await startCold(compiled);
    expect(coldResult.key("out").get()).toBe("out:abc:0");
    await releaseInput(cold);
    expect(coldResult.key("out").get()).toBe("out:def:0");
    const before = await storedValues(outId);

    inputSpaceHeld = Promise.withResolvers<void>();
    const provider = opened.at(-1)!.storage.open(inputSpace) as unknown as {
      replaceProvisionalReplica(): Promise<void>;
    };
    const replaced = provider.replaceProvisionalReplica();
    {
      const tx = cold.edit();
      cold.getCell<number>(space, "tick").withTx(tx).set(1);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await cold.idle();
    expect(coldResult.key("out").get()).toBe("out:def:0");
    expect(await storedValues(outId)).toEqual(before);

    // A new route has no session from the previous route. The loopback
    // server serves both, so remove only that route's detached session.
    sessions.remove(inputSpace, cold.storageManager.id);
    inputSpaceHeld.resolve();
    await replaced;
    await cold.idle();
    await cold.storageManager.synced();
    await cold.idle();
    expect(coldResult.key("out").get()).toBe("out:def:1");
    const after = await storedValues(outId);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toHaveLength(1);
    expect(after.at(-1)).toContain("out:def:1");
    cancel();
  });

  describe("a lift whose argument is read eagerly", () => {
    // Read eagerly, an argument whose document has not arrived reads as
    // undefined rather than refusing, and the lift's body is not run.

    beforeEach(() => {
      shape = { pattern: LIFT_PATTERN, lazyMaterialization: false };
    });

    verifyRefusals();
  });
});
