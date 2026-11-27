// Run by `../fake-clock.test.ts` as a test file of its own.

import {
  clock,
  installFakeClock,
  runningClock,
  useRealClock,
} from "../../src/fake-clock.ts";
import { test } from "../../src/testing.ts";

const log = (what: string) => console.log(`LOG ${what}`);

installFakeClock({ mode: "auto-advance" });

// This file needs the real clock to show what a file asking for it gets.
useRealClock();

test("reads the real clock", () => {
  log(`running ${runningClock() !== undefined}`);
  log(`date after 2020 ${Date.now() > Date.UTC(2020, 0, 1)}`);
  try {
    clock.reset();
  } catch (error) {
    log(`reset refused: ${(error as Error).message}`);
  }
});
