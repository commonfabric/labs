/** Measures replay-range selection with a fixed suffix and growing old history. */

import { expect } from "@std/expect";

import { reconstructOutcome, reconstructRevision } from "../reconstruct.ts";
import { replayRangeFixture } from "./reconstruct-range-fixture.ts";

for (const historyLength of [100, 1_000, 10_000]) {
  const fixture = replayRangeFixture(historyLength);
  globalThis.addEventListener("unload", () => fixture[Symbol.dispose]());
  Deno.bench({
    name: `${historyLength} old revisions, snapshot head`,
    group: "inspector replay range",
    fn(bench) {
      bench.start();
      const outcome = reconstructOutcome(fixture.space, {
        id: "of:range",
        atSeq: fixture.targetSeq,
      });
      bench.end();
      expect(outcome).toEqual({
        status: "present",
        document: { value: { items: ["base", "first", "second"] } },
      });
    },
  });
  Deno.bench({
    name: `${historyLength} old revisions, exact first operation`,
    group: "inspector replay range",
    fn(bench) {
      bench.start();
      const document = reconstructRevision(fixture.space, {
        id: "of:range",
        seq: fixture.targetSeq,
        opIndex: 0,
      });
      bench.end();
      expect(document).toEqual({ value: { items: ["base", "first"] } });
    },
  });
}
