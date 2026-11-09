/**
 * The sleep watch, on clocks the tests move by hand and a check they run by
 * hand, so nothing here waits on a timer.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  SLEEP_CHECK_EVERY_MS,
  SLEEP_GAP_MS,
  watchMachineSleep,
} from "../../src/model/machine-sleep.ts";

/** Two clocks the test moves, and the watch's check, which it runs. */
const clocks = () => {
  const state = {
    wall: 1_000_000,
    monotonic: 5_000,
    check: undefined as (() => void) | undefined,
    everyMs: undefined as number | undefined,
    stops: 0,
  };
  return {
    state,
    options: {
      wallNowMs: () => state.wall,
      monotonicNowMs: () => state.monotonic,
      repeat: (check: () => void, everyMs: number) => {
        state.check = check;
        state.everyMs = everyMs;
        return () => {
          state.stops += 1;
        };
      },
    },
    /** The clocks moving together, as they do while the machine is awake. */
    awake(ms: number) {
      state.wall += ms;
      state.monotonic += ms;
      state.check?.();
    },
    /** The wall clock moving on alone, as it does while the machine sleeps. */
    asleep(ms: number) {
      state.wall += ms;
      state.check?.();
    },
  };
};

describe("machine-sleep", () => {
  describe("watchMachineSleep()", () => {
    it("checks the clocks at its cadence", () => {
      const { state, options } = clocks();
      watchMachineSleep(() => {}, options);

      expect(state.everyMs).toBe(SLEEP_CHECK_EVERY_MS);
    });

    it("reports nothing while the clocks move together", () => {
      const { options, awake } = clocks();
      const slept: number[] = [];
      watchMachineSleep((ms) => slept.push(ms), options);

      for (let check = 0; check < 5; check += 1) awake(SLEEP_CHECK_EVERY_MS);

      expect(slept).toEqual([]);
    });

    it("reports nothing for a gap short of a sleep", () => {
      const { options, asleep } = clocks();
      const slept: number[] = [];
      watchMachineSleep((ms) => slept.push(ms), options);

      asleep(SLEEP_GAP_MS - 1);

      expect(slept).toEqual([]);
    });

    it("reports how long the machine slept, once, and stops checking", () => {
      const { state, options, awake, asleep } = clocks();
      const slept: number[] = [];
      watchMachineSleep((ms) => slept.push(ms), options);

      awake(3_000);
      asleep(600_000);
      asleep(600_000);
      awake(3_000);

      expect(slept).toEqual([600_000]);
      expect(state.stops).toBe(1);
    });

    it("counts only the gap since the last check", () => {
      const { options, awake, asleep } = clocks();
      const slept: number[] = [];
      watchMachineSleep((ms) => slept.push(ms), options);

      // drift under the gap at each check never adds up to a sleep
      for (let check = 0; check < 5; check += 1) asleep(SLEEP_GAP_MS / 2);
      awake(1_000);

      expect(slept).toEqual([]);
    });

    it("reports nothing once stopped, and stops its check once", () => {
      const { state, options, asleep } = clocks();
      const slept: number[] = [];
      const stop = watchMachineSleep((ms) => slept.push(ms), options);

      stop();
      stop();
      asleep(600_000);

      expect(slept).toEqual([]);
      expect(state.stops).toBe(1);
    });
  });
});
