/// <reference path="./clock.d.ts" />
// The fake-clock harness fires every zero-delay timer from one `kick()`, in
// registration order, in a single real task. Two properties of that batch are
// load-bearing for code that takes a turn of the event loop without waiting on
// a timer — the memory transport's frame pump and the memory server's
// subscription refresh both do, through `armTurn`, because waking Deno's loop
// for a timer costs milliseconds.
//
// A `setImmediate` has to be one of the batch. Left to the real event loop it
// would run ahead of every turn the harness was holding, and no `settle()` or
// `tick()` could hold it back.
//
// And clearing has to work inside the batch. `armTurn` arms both a timer and
// an immediate for one turn and cancels the loser from the winner's callback,
// so a batch that fired a cleared callback anyway would run the handler twice.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

// The harness installs its replacements around each test, so these read the
// global when they are called rather than when this module loads.
const host = globalThis as unknown as {
  setImmediate: (handler: () => void) => unknown;
  clearImmediate: (handle: unknown) => void;
};
const setImmediate = (handler: () => void): unknown =>
  host.setImmediate(handler);
const clearImmediate = (handle: unknown): void => host.clearImmediate(handle);

describe("fake-clock zero-delay batch", () => {
  it("runs a setImmediate in registration order among the zero-delay timers", async () => {
    const order: string[] = [];
    setTimeout(() => order.push("timer-before"), 0);
    setImmediate(() => order.push("immediate"));
    setTimeout(() => order.push("timer-after"), 0);

    await clock.settle();

    expect(order).toEqual(["timer-before", "immediate", "timer-after"]);
  });

  it("does not run a zero-delay timer cleared by an earlier one in the batch", async () => {
    const fired: string[] = [];
    // The first timer is armed first so it fires first; the one it clears is
    // still ahead of it in the same batch.
    const armed: { handle?: ReturnType<typeof setTimeout> } = {};
    setTimeout(() => {
      fired.push("first");
      clearTimeout(armed.handle);
    }, 0);
    armed.handle = setTimeout(() => fired.push("second"), 0);

    await clock.settle();

    expect(fired).toEqual(["first"]);
  });

  it("does not run a setImmediate cleared by an earlier timer in the batch", async () => {
    const fired: string[] = [];
    // The timer is armed first so it fires first; the immediate it clears is
    // still ahead of it in the same batch.
    const armed: { handle?: unknown } = {};
    setTimeout(() => {
      fired.push("timer");
      clearImmediate(armed.handle);
    }, 0);
    armed.handle = setImmediate(() => fired.push("immediate"));

    await clock.settle();

    expect(fired).toEqual(["timer"]);
  });
});
