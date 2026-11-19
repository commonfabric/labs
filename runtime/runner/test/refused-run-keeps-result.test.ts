/**
 * A computation whose run reads an input before the input has arrived is
 * refused, and runs again once the input arrives. The refused run writes
 * nothing over a result the node already holds, so a client starting a piece
 * cold, whose first runs read inputs in spaces it has not loaded yet, never
 * replaces a stored result, for itself or for any other client, with one read
 * from data that had not arrived.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

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
const PATTERN = [
  "import { computed, pattern, Writable } from 'commonfabric';",
  "type Ref = Writable<{ name: string }>;",
  "export default pattern<{ ref: Ref }, { out: string }>(({ ref }) => {",
  "  const out = computed(() => 'out:' + ref.get().name);",
  "  return { out };",
  "});",
].join("\n");

describe("refused-run-keeps-result", () => {
  let server: MemoryV2Server.Server;
  let opened: { runtime: Runtime; storage: EmulatedStorageManager }[];
  let inputSpaceHeld: PromiseWithResolvers<void> | undefined;

  /** A runtime of its own over the shared server, acting as `owner`. */
  const open = (): Runtime => {
    const storage = EmulatedStorageManager.connectTo(server, { as: owner });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    runtime.scheduler.setActionRunTraceEnabled(true);
    opened.push({ runtime, storage });
    return runtime;
  };

  beforeEach(() => {
    opened = [];
    inputSpaceHeld = undefined;
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
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
      files: [{ name: "/main.tsx", contents: PATTERN }],
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
  const storedValues = async (id: string): Promise<unknown[]> => {
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
   * reach. Returns the runtime, its result cell, and what its subscription has
   * seen.
   */
  const startCold = async (compiled: { resultSchema?: unknown }) => {
    inputSpaceHeld = Promise.withResolvers<void>();
    const cold = open();
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
    const cancelWatcher = watched.key("out").sink((value) => {
      watcherSeen.push(value);
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
    // The watcher never sees `out` without a value. Whether its subscription
    // reports the new value as well is the subscription's business, so the
    // value is read afresh.
    expect(watcherSeen[0]).toBe("out:abc");
    expect(watcherSeen.every((value) => typeof value === "string")).toBe(true);
    expect(await watched.key("out").pull()).toBe("out:def");
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
});
