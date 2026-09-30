/// <reference path="./clock.d.ts" />
// The fake-clock harness (auto-advance mode) sorts every positive-delay
// `setTimeout` into a `src/` timer, which auto-advances so the runtime's own
// throttle/backoff windows elapse instantly, or a `test/` timer, which freezes
// so a stray wall-clock sleep written in test code deadlocks and the async-op
// sanitizer catches it. It decides by reading the scheduling frame's file path.
//
// SES's `errorTaming: "safe"` (the runner's production lockdown) blanks
// `new Error().stack` for the rest of the process from the first lockdown on.
// Reading the frame through `new Error().stack` therefore saw nothing after
// lockdown, and every test-scheduled sleep was misfiled as a `src/` timer and
// auto-advanced — silently defeating the freeze-and-catch guarantee for the
// whole suite. The harness reads the frames through SES's `getStackString`
// hook, which keeps returning them after lockdown (the same hook the runtime's
// own error mapping uses). These tests pin the classification across the
// lockdown boundary and the SES contract it stands on.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { sleep } from "@commonfabric/utils/sleep";
import { ensureSESLockdown } from "../src/sandbox/ses-runtime.ts";

// One real macrotask turn. A zero-delay `setTimeout` fires on a real macrotask
// through the harness's kick. After this yield a frozen `test/` timer has not
// fired, and it never will on its own.
const macrotaskTurn = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("fake-clock caller classification survives SES lockdown", () => {
  it("SES blanks Error.stack yet exposes the frames through getStackString", () => {
    ensureSESLockdown();
    // The hazard: the tamed `stack` accessor reads back empty post-lockdown.
    expect(new Error().stack ?? "").toBe("");
    // The mechanism the harness stands on: the real frames, this file among them.
    const getStackString = (globalThis as {
      getStackString?: (error: Error) => string;
    }).getStackString;
    expect(typeof getStackString).toBe("function");
    const frames = getStackString!(new Error());
    expect(frames.length).toBeGreaterThan(0);
    expect(frames).toContain(".test.ts");
  });

  it("a test-scheduled positive-delay setTimeout freezes after lockdown", async () => {
    ensureSESLockdown();
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 500);
    await macrotaskTurn();
    // Frozen, not auto-advanced: the harness saw this file's `test/` frame.
    expect(fired).toBe(false);
    // Still a live timer — explicit time advancement fires it.
    await clock.tick(500);
    expect(fired).toBe(true);
  });

  it("a src/-scheduled positive-delay setTimeout still auto-advances after lockdown", async () => {
    ensureSESLockdown();
    // `sleep` arms the timer from `packages/utils/src`, a `src/` frame, so the
    // harness auto-advances it — the runtime's own throttle and backoff timers
    // are armed the same way and must keep elapsing on their own. The pump
    // fires it once the loop is idle, so the wait is on the sleep itself:
    // frozen, it would never return, and Deno would report the pending
    // promise once the loop emptied.
    const started = Date.now();
    await sleep(500);
    expect(Date.now() - started).toBe(500);
  });
});
