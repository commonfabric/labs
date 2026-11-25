// Run by `../fake-clock.test.ts` as a test file of its own, under the clock
// in the mode `FAKE_CLOCK_MODE` names.

import {
  clock,
  type FakeClockMode,
  installFakeClock,
  runningClock,
} from "../../src/fake-clock.ts";
import { describe, it } from "../../src/testing.ts";

const log = (what: string) => console.log(`LOG ${what}`);

installFakeClock({ mode: Deno.env.get("FAKE_CLOCK_MODE") as FakeClockMode });

describe("clock", () => {
  it("reads the time", () => {
    log(`running ${runningClock() !== undefined}`);
    log(`date ${Date.now()}`);
  });

  it("fires a zero-delay timer on settle", async () => {
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 0);
    await clock.settle();
    log(`zero-delay fired ${fired}`);
  });

  it("fires a test timer on tick", async () => {
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 1_000);
    await clock.settle();
    log(`before tick ${fired}`);
    await clock.tick(1_000);
    log(`after tick ${fired}`);
  });
});
