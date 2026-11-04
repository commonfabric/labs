import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  COMPILE_INTERLEAVES_EVENT_LOOP,
  interleaveCompileYield,
} from "../src/harness/compile-interleave.ts";

describe("compile-interleave", () => {
  // The compile pipeline's yield points run through interleaveCompileYield. The
  // predicate default and both arms carry perf contracts the pattern unit
  // suites depend on (Deno batch compiles must add ZERO macrotask turns; the
  // browser worker must get REAL turns), so pin all three here.

  it("does not interleave under Deno (batch compiles run straight through)", () => {
    // cf test / toolshed / CLI: the sync compile driver, no yields.
    expect(COMPILE_INTERLEAVES_EVENT_LOOP).toBe(false);
  });

  it("adds no macrotask turn by default in Deno (sync-driver contract)", async () => {
    // A due timer is a queued macrotask; if the default call yielded one
    // event-loop turn, the timer would fire before the continuation.
    let timerRan = false;
    const timer = setTimeout(() => {
      timerRan = true;
    }, 0);
    try {
      await interleaveCompileYield();
      expect(timerRan).toBe(false);
    } finally {
      clearTimeout(timer);
    }
  });

  it("yields a real macrotask turn when interleaving is on", async () => {
    // Queue a posted-message task BEFORE the yield: the browser-worker
    // contract is that work already queued on the loop (IPC deliveries) runs
    // before the compile continues. Posted-message ordering is FIFO, so the
    // probe task must have run once the yield resolves.
    const { port1, port2 } = new MessageChannel();
    let queuedTaskRan = false;
    port1.onmessage = () => {
      queuedTaskRan = true;
    };
    port2.postMessage(null);
    try {
      await interleaveCompileYield(true);
      expect(queuedTaskRan).toBe(true);
    } finally {
      port1.close();
      port2.close();
    }
  });
});
