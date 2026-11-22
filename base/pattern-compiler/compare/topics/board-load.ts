/**
 * Loads a Topics board out of a snapshot of its space in today's runtime and
 * reports the heap it keeps, as a comparison for `scale.ts --seed`, whose
 * topics are documents of the board's demanded fields alone.
 *
 * `deno run -A --no-check --v8-flags=--expose-gc board-load.ts <snapshot> <board> pull|start`
 *
 * `<snapshot>` and `<board>` are as for `board-seed.ts`, and the snapshot is
 * read through a copy. `pull` reads the board's result under the result
 * schema of `patterns/apps/topics/main.tsx`, which loads every document a
 * reader of the board's result needs. `start` starts the stored board piece
 * (`Runtime.start`) and waits until its computations have settled, in the
 * client posture a bare `Runtime` resolves to. Each prints one line of JSON
 * with `Deno.memoryUsage()` after a full collection before the load and
 * after it.
 */
import { Identity } from "@commonfabric/identity";
import { basename, fromFileUrl, join, toFileUrl } from "@std/path";

import { resolveLocalProgram } from "../../../../runtime/runner/src/harness/local-program.deno.ts";
import { Runtime } from "../../../../runtime/runner/src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../../../runtime/runner/src/storage/v2-emulate.ts";

const repository = fromFileUrl(new URL("../../../../", import.meta.url));

/**
 * The process's memory after a full collection. With `BOARD_LOAD_HOLD` set,
 * the run then waits for `SIGUSR2` before it goes on, so that a heap snapshot
 * can be taken through the inspector (`--inspect` and
 * `skills/perf-investigation/scripts/heap-snapshot.ts`), which writes a heap
 * of any size; `node:v8`'s `writeHeapSnapshot()` did not finish on a heap of
 * this size.
 */
const memoryAt = async (point: string): Promise<Deno.MemoryUsage> => {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (collect === undefined) {
    throw new Error("run with --v8-flags=--expose-gc");
  }
  collect();
  const usage = Deno.memoryUsage();
  if (Deno.env.get("BOARD_LOAD_HOLD") !== undefined) {
    const { promise, resolve } = Promise.withResolvers<void>();
    const go = () => resolve();
    Deno.addSignalListener("SIGUSR2", go);
    console.error(`board-load: holding at ${point}, pid ${Deno.pid}`);
    await promise;
    Deno.removeSignalListener("SIGUSR2", go);
  }
  return usage;
};

/** A copy of `snapshot` in a store directory a memory server reads. */
const storeCopy = async (snapshot: string): Promise<string> => {
  const store = await Deno.makeTempDir({ prefix: "topics-board-load-" });
  const engine = join(store, "engine-v3");
  await Deno.mkdir(engine);
  const target = join(engine, basename(snapshot));
  const cloned = Deno.build.os === "darwin" &&
    (await new Deno.Command("cp", { args: ["-c", snapshot, target] }).output())
      .success;
  if (!cloned) await Deno.copyFile(snapshot, target);
  return store;
};

const load = async (snapshot: string, board: string, mode: string) => {
  const space = basename(snapshot).replace(/\.sqlite$/, "") as `did:${string}`;
  const store = await storeCopy(snapshot);
  const server = newLoopbackServer({ store: toFileUrl(`${store}/`) });
  const signer = await Identity.fromPassphrase("topics board load");
  const storageManager = EmulatedStorageManager.connectTo(server, {
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      { main: `${repository}patterns/apps/topics/main.tsx`, root: repository },
    );
    const compiled = await runtime.patternManager.compilePattern(program, {
      space,
    });
    const link = {
      id: board as `${string}:${string}`,
      space,
      path: [],
    };
    const before = await memoryAt("before");
    const began = performance.now();
    // deno-lint-ignore no-explicit-any
    const result: any = runtime.getCellFromLink(link, compiled.resultSchema);
    if (mode === "start") await runtime.start(result);
    await result.pull();
    await runtime.settled();
    const settled = performance.now();
    const topics = (result.key("topics").get() as unknown[] | undefined)
      ?.length;
    const after = await memoryAt("after");
    console.log(JSON.stringify({
      mode,
      topics,
      seconds: Math.round(settled - began) / 1000,
      before,
      after,
    }));
  } finally {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
    await Deno.remove(store, { recursive: true });
  }
};

if (import.meta.main) {
  const [snapshot, board, mode] = Deno.args;
  if (
    snapshot === undefined || board === undefined ||
    (mode !== "pull" && mode !== "start")
  ) {
    console.error("usage: board-load.ts <snapshot> <board> pull|start");
    Deno.exit(2);
  }
  await load(snapshot, board, mode);
}
