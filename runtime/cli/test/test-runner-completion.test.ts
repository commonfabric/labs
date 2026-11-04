import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { Runtime } from "@commonfabric/runner";
import { runTestPattern } from "../lib/test-runner.ts";

const fixtures = resolve(import.meta.dirname!, "fixtures");

const checkpoints = [
  {
    name: "action settlement",
    fixture: "settle/settle-step.test.tsx",
    phase: "step/action_1/settle/iter-0/idle",
  },
  {
    name: "render settlement",
    fixture: "render-step/render-step.test.tsx",
    phase: "step/render_1/settle/iter-0/idle",
  },
  {
    name: "full settlement",
    fixture: "settle/settle-step.test.tsx",
    phase: "step/settle_1/settled",
  },
  {
    name: "assertion async work",
    fixture: "async-read/delayed-read.test.tsx",
    phase: "step/assertion_1/asyncWork",
  },
  {
    name: "cleanup",
    fixture: "settle/settle-step.test.tsx",
    phase: "cleanup/runtimeDispose",
  },
];

describe("test-runner completion", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  for (const checkpoint of checkpoints) {
    it(`waits for ${checkpoint.name} after three minutes have elapsed`, async () => {
      // The phase marks select the wait, after real setup has completed. Hold
      // that operation pending and advance a fake clock before allowing it to
      // finish; the eventual assertion must still be read and pass.

      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      using resources = new DisposableStack();
      let time: FakeTime | undefined;
      let completed = false;

      /** Hold the named operation once, before its caller can arm a timer. */
      function hold(): Promise<void> | undefined {
        const mark = performance.getEntriesByType("mark").at(-1)?.name;
        if (
          time === undefined &&
          mark?.startsWith(`cf-test/runTestPattern/${checkpoint.phase}:start#`)
        ) {
          time = resources.use(new FakeTime());
          entered.resolve();
          return release.promise;
        }
      }

      const idle = Runtime.prototype.idle;
      using _idle = stub(Runtime.prototype, "idle", function (...args) {
        const waiting = hold();
        return waiting
          ? waiting.then(() => idle.apply(this, args))
          : idle.apply(this, args);
      });
      const settled = Runtime.prototype.settled;
      using _settled = stub(Runtime.prototype, "settled", function (...args) {
        const waiting = hold();
        return waiting
          ? waiting.then(() => settled.apply(this, args))
          : settled.apply(this, args);
      });
      const dispose = Runtime.prototype.dispose;
      using _dispose = stub(Runtime.prototype, "dispose", function (...args) {
        const waiting = hold();
        return waiting
          ? waiting.then(() => dispose.apply(this, args))
          : dispose.apply(this, args);
      });
      const path = resolve(fixtures, checkpoint.fixture);
      const running = runTestPattern(path).finally(() => completed = true);
      // Observe a rejection immediately, including one from cleanup, while
      // leaving the original promise's result for the assertion below.
      void running.catch(() => {});
      try {
        await Promise.race([
          entered.promise,
          running.then((result) => {
            throw new Error(
              `Run finished (${
                result.error ?? "passed"
              }) before holding ${checkpoint.phase}`,
            );
          }),
        ]);
        await time!.tickAsync(180_001);
        expect(completed).toBe(false);
      } finally {
        resources.dispose();
        release.resolve();
        await running.catch(() => {});
      }
      const result = await running;
      expect(result.error).toBeUndefined();
      expect(result.results.map(({ passed }) => passed)).toEqual([true]);
    });
  }
});
