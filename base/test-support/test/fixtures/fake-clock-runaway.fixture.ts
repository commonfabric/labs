// Run by `../fake-clock.test.ts` as a test file of its own: production timers
// that re-arm themselves forever, which the clock stops.

import { join, toFileUrl } from "@std/path";
import { installFakeClock } from "../../src/fake-clock.ts";
import { test } from "../../src/testing.ts";

installFakeClock({ mode: "auto-advance" });

// Armed from outside every test directory, so each is a production timer.
const helperDir = await Deno.makeTempDir({ prefix: "fake-clock-runaway-" });
await Deno.writeTextFile(
  join(helperDir, "rearm.js"),
  "export const rearm = () => setTimeout(rearm, 1);\n",
);
const { rearm }: { rearm(): void } = await import(
  toFileUrl(join(helperDir, "rearm.js")).href
);
Deno.removeSync(helperDir, { recursive: true });

test("re-arms a production timer forever", async () => {
  rearm();
  await new Promise(() => {});
});
