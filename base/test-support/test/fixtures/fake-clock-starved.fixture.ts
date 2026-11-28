// Run by `../fake-clock.test.ts` as a test file of its own, in the mode
// `FAKE_CLOCK_MODE` names: a test awaiting a promise nothing resolves while
// zero-delay work re-arms itself forever, which the clock stops.

import { type FakeClockMode, installFakeClock } from "../../src/fake-clock.ts";
import { test } from "../../src/testing.ts";

const mode: FakeClockMode = Deno.env.get("FAKE_CLOCK_MODE") === "freeze-all"
  ? "freeze-all"
  : "auto-advance";
// A low turn limit lets the work that re-arms forever reach it quickly.
installFakeClock({ mode, turnLimit: 100 });

test("re-arms a zero-delay timer forever while awaiting a promise nothing resolves", async () => {
  const rearm = () => setTimeout(rearm, 0);
  await new Promise<void>(() => rearm());
});
