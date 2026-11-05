/**
 * Guard for `--timing-measures-out`, whose whole value is that the file it
 * writes describes the run rather than a fragment of it.
 *
 * Each test file starts by clearing the performance timeline, so a capture read
 * once at the end of a multi-file run keeps only the last file and reports its
 * count as though it were the run's. That is invisible in a passing run — the
 * tests still pass, the file still exists, and only the numbers are wrong —
 * which is why it is pinned here rather than left to a reading of the code.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";
import {
  clearTimingMeasures,
  getTimingMeasuresState,
  setTimingMeasuresEnabled,
  TIMING_MEASURE_PREFIX,
} from "@commonfabric/logger";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/step-kinds");
const FIXTURE = resolve(FIXTURES, "marker-step.test.tsx");

interface Written {
  name: string;
  startTime: number;
  duration: number;
}

async function runCapturing(paths: string | string[]): Promise<Written[]> {
  const out = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await runTests(paths, { root: FIXTURES, timingMeasuresOut: out });
    return JSON.parse(await Deno.readTextFile(out)) as Written[];
  } finally {
    await Deno.remove(out);
  }
}

describe(
  "test-runner timing measures",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("writes the spans a run emitted, each carrying the logger's prefix", async () => {
      const written = await runCapturing(FIXTURE);

      expect(written.length).toBeGreaterThan(0);
      expect(
        written.every((entry) => entry.name.startsWith(TIMING_MEASURE_PREFIX)),
      ).toBe(true);
      // Intervals are the point of emitting these at all: without them the
      // statistics already say how long and how often.
      expect(written.every((entry) => entry.duration >= 0)).toBe(true);
    });

    it("keeps every file's spans when several are run", async () => {
      // Counting a phase that runs exactly once per file rather than comparing
      // totals: a warm compile cache makes a second run of the same file much
      // cheaper, so span counts across runs are not comparable — the phase
      // still runs, and still reports, whether or not it hits the cache.
      const compiles = (written: Written[]) =>
        written.filter((entry) =>
          entry.name.startsWith(
            `${TIMING_MEASURE_PREFIX}runTestPattern/compile#`,
          )
        ).length;

      expect(compiles(await runCapturing(FIXTURE))).toBe(1);
      // Reading the timeline once at the end instead of draining per file
      // would report one here, because each file clears what came before it.
      expect(compiles(await runCapturing([FIXTURE, FIXTURE]))).toBe(2);
    });

    it("leaves emission and the cap as it found them", async () => {
      const before = getTimingMeasuresState();
      await runCapturing(FIXTURE);
      const after = getTimingMeasuresState();
      // Emission is process-global; a run that borrows it owes it back, or
      // every later run in the process pays for a capture nobody reads.
      expect(after.enabled).toBe(before.enabled);
      // The ceiling is borrowed too — the run raises it because it drains per
      // file. Left behind, it removes the retention bound for the whole
      // process, which is the one thing the cap exists to provide.
      expect(after.cap).toBe(before.cap);
    });

    it("emits nothing when the option is absent", async () => {
      await runTests(FIXTURE, { root: FIXTURES });
      expect(
        performance.getEntriesByType("measure").some((entry) =>
          entry.name.startsWith(TIMING_MEASURE_PREFIX)
        ),
      ).toBe(false);
    });

    it("takes its cap from the environment when none is passed", () => {
      // This lives here rather than beside the other logger tests because
      // `base/logger` runs its suite with no permissions at all, and
      // reading an environment variable needs one. The library copes — every
      // env read there is wrapped — but a test that sets one cannot.
      const before = getTimingMeasuresState();
      Deno.env.set("CF_TIMING_MEASURES_CAP", "4242");
      try {
        setTimingMeasuresEnabled(true);
        expect(getTimingMeasuresState().cap).toBe(4242);

        // A value naming no positive integer is ignored rather than applied,
        // which would otherwise disable the guard from outside the process.
        Deno.env.set("CF_TIMING_MEASURES_CAP", "not-a-number");
        setTimingMeasuresEnabled(true);
        expect(getTimingMeasuresState().cap).toBe(4242);
      } finally {
        Deno.env.delete("CF_TIMING_MEASURES_CAP");
        setTimingMeasuresEnabled(before.enabled, { cap: before.cap });
        clearTimingMeasures();
      }
    });
  },
);
