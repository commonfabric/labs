import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { getLoggerFlagsBreakdown } from "@commonfabric/utils/logger";
import { sendEvent } from "../src/cell.ts";
import type { RuntimeTelemetryEvent } from "../src/telemetry.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type SchedulerTestRuntime,
  space,
} from "./scheduler-test-utils.ts";

/**
 * A handler whose `$ctx` requires a plain-number `gate` the argument document
 * does not hold until the test writes it, so its dispatch finds the argument
 * unresolved (`isValidArgument === false`) until then.
 */
const GATED_BUMP_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const bump = handler<unknown, { value: Writable<number>; gate: number }>(",
  "  (_ev, { value, gate }) => {",
  "    value.set((value.get() ?? 0) + 1 + gate * 0);",
  "  },",
  ");",
  "export default pattern<",
  "  { value: Writable<number>; gate: Writable<number> },",
  "  { value: number; bump: Stream<unknown> }",
  ">(({ value, gate }) => ({ value, bump: bump({ value, gate }) }));",
].join("\n");

describe("stream handler whose argument does not resolve", () => {
  let env: SchedulerTestRuntime;

  beforeEach(() => {
    env = createSchedulerTestRuntime(import.meta.url);
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime(env);
  });

  it("re-runs the dispatch until the argument resolves, flags the skipped run with its schema and raw binding, and fires the commit callback once, on the run that wrote", async () => {
    const { runtime, tx } = env;
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: GATED_BUMP_PATTERN }],
    }, { space, tx });
    const argument = runtime.getCell<{ value: number; gate?: number }>(
      space,
      "unresolved-argument",
      undefined,
      tx,
    );
    argument.set({ value: 0 });
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "unresolved-result",
      compiled.resultSchema,
      tx,
    );
    runtime.run(tx, compiled, argument, result);
    await tx.commit().settled;
    env.tx = runtime.edit();
    await runtime.idle();

    // The pass that dispatches the event skips the run (no `gate` yet) and
    // requeues it. Its settle marker is the first one after the dispatch's
    // invocation marker, so listen from before the send.
    let dispatches = 0;
    const firstPassSettled = Promise.withResolvers<void>();
    const onTelemetry = (event: Event) => {
      const { marker } = (event as RuntimeTelemetryEvent).detail;
      if (marker.type === "scheduler.invocation") dispatches++;
      if (marker.type === "scheduler.settle" && dispatches > 0) {
        firstPassSettled.resolve();
      }
    };
    runtime.telemetry.addEventListener("telemetry", onTelemetry);

    const callbackStatuses: string[] = [];
    sendEvent(result.key("bump"), {}, (commitTx) => {
      callbackStatuses.push(commitTx.status().status);
    });
    await firstPassSettled.promise;
    expect(dispatches).toBeGreaterThanOrEqual(1);
    expect(callbackStatuses).toEqual([]);

    // The skipped run's flag carries what the argument was validated against
    // and the binding it was validated from, and nothing read through it.
    const flagged = Object.values(
      getLoggerFlagsBreakdown().runner?.["action invalid input"] ?? {},
    );
    expect(flagged).toHaveLength(1);
    expect(Object.keys(flagged[0] ?? {}).sort()).toEqual(["raw", "schema"]);

    {
      const write = runtime.edit();
      argument.key("gate").withTx(write).set(1);
      expect((await write.commit().settled).error).toBeUndefined();
    }
    await runtime.idle();
    await runtime.scheduler.idleWithPendingCommits();
    runtime.telemetry.removeEventListener("telemetry", onTelemetry);

    expect(dispatches).toBeGreaterThanOrEqual(2);
    expect(argument.get().value).toBe(1);
    expect(callbackStatuses).toEqual(["done"]);
    expect(
      getLoggerFlagsBreakdown().runner?.["action invalid input"] ?? {},
    ).toEqual({});
  });
});
