/**
 * Runs a fixture on today's runtime with several events queued before
 * the scheduler takes any, and reads the result when the run has
 * settled: what the comparison of a batch of events takes as today's
 * side (`scheduler-and-serving-loop.md` §5.4, "Derivations settle once
 * behind the batch").
 */
import { Identity } from "@commonfabric/identity";

import { type Cell, sendEvent } from "../../../runtime/runner/src/cell.ts";
import { Runtime } from "../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../runtime/runner/src/storage/cache.deno.ts";

/** One event of a batch: the member of the result that holds the stream. */
export type BatchEvent = { stream: string; event: unknown };

/**
 * The result of `fixture` on today's runtime after the events of `batch`
 * were all queued and the run settled. With `servingPosture`, the
 * scheduler runs the handlers of the queued events back to back and
 * settles the derivations once behind them
 * (`Scheduler#processExecuteEventPhases` in
 * `runtime/runner/src/scheduler/facade.ts`); without it, it settles
 * behind each event.
 */
export const batchOnRuntime = async (
  fixture: string,
  argument: Record<string, unknown>,
  batch: BatchEvent[],
  servingPosture: boolean,
): Promise<Record<string, unknown>> => {
  const signer = await Identity.fromPassphrase("pattern-compiler-batch");
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    servingPosture,
  });
  try {
    const contents = await Deno.readTextFile(
      new URL(`./fixtures/${fixture}.tsx`, import.meta.url),
    );
    const compiled = await runtime.patternManager.compilePattern(
      { main: "/main.tsx", files: [{ name: "/main.tsx", contents }] },
      { space },
    );
    const start = runtime.edit();
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      `batch ${fixture} ${servingPosture}`,
      compiled.resultSchema,
      start,
    );
    runtime.run(start, compiled, argument, result);
    runtime.prepareTxForCommit(start);
    const { error } = await start.commit().settled;
    if (error !== undefined) throw error;
    await result.pull();
    await runtime.settled();
    for (const { stream, event } of batch) {
      sendEvent(result.key(stream) as Cell<unknown>, event as never);
    }
    await runtime.settled();
    await result.pull();
    await runtime.settled();
    const read = runtime.edit();
    try {
      return JSON.parse(
        JSON.stringify(result.withTx(read).get()),
      ) as Record<string, unknown>;
    } finally {
      read.abort();
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};
