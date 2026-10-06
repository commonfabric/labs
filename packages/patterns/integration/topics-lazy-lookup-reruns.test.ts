/**
 * Holds lazy materialization to the property the Topics board's mention
 * scaling rests on: a mention edit re-runs `backlinksOf` for the topics whose
 * pivot row changed, and for no other. The case runs the headless Topics
 * fixture in this process, with no browser and no server.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it } from "@std/testing/bdd";

import {
  type CaseMeasurement,
  caseNamed,
  measureCasePhases,
  type MeasuredPhaseRecord,
} from "./topics-cost-cases.ts";

/** The case: every topic's lookup demanded, at a size where a lookup that
 * re-runs per topic is unmistakable against one that re-runs per changed row. */
const CASE = caseNamed("pivot/high-degree/mentions-4/topics-32/all-backlinks");

describe("topics-lazy-lookup-reruns", () => {
  // Each topic's `backlinksOf` reads the pivot's rows only as far as its own
  // lookup touches them, so its registered reads are its own row and the
  // identity of every other. A mention edit rewrites the rows of the topics
  // it moved between, and only those lookups run again. An eager read of the
  // table registers every row whole, and then every lookup runs on any edit,
  // which is the cost lazy materialization exists to remove. The read budget
  // bounds counts from above and does not see this: a lazy read turned eager
  // makes fewer proxy accesses, not more.

  let measurement: CaseMeasurement;
  beforeAll(async () => {
    measurement = await measureCasePhases(CASE, {
      mode: "lazy-materialization-on",
    });
  });

  const phaseNamed = (name: string): MeasuredPhaseRecord => {
    const phase = measurement.phases.find((record) => record.phase === name);
    if (phase === undefined || !phase.measured) {
      throw new Error(`The case did not measure the phase "${name}".`);
    }
    return phase;
  };

  it("runs under lazy materialization", () => {
    expect(measurement.mode).toBe("lazy-materialization-on");
  });

  it("runs every topic's lookup once at initialization", () => {
    expect(phaseNamed("initialization").bodies.consumer.backlinksOf.runs).toBe(
      CASE.options.topicCount,
    );
  });

  for (const phase of ["mention removal", "mention insertion"]) {
    it(`re-runs only the focus topic's lookup on ${phase}`, () => {
      expect(phaseNamed(phase).bodies.consumer.backlinksOf.runs).toBe(1);
    });
  }

  it("re-runs only the lookups of the two topics a retarget moves between", () => {
    // The focus topic loses a mentioner either way; the new target gains one
    // unless the source already mentioned it, which the edit records.
    const phase = phaseNamed("same-count retarget");
    const { targetGainsSource } = phase.edit as { targetGainsSource: boolean };
    expect(phase.bodies.consumer.backlinksOf.runs).toBe(
      targetGainsSource ? 2 : 1,
    );
  });
});
