/**
 * Holds lazy materialization to the properties the Topics board's mention
 * scaling rests on: a mention edit re-runs `backlinksOf` for the topics whose
 * pivot row changed, and for no other, whether a topic finds its row in the
 * board's index or scans the pivot; a numbered topic's lookup reads as much on
 * a large board as on a small one; and filing a topic re-runs only the lookups
 * whose rows it changed. The cases run the headless Topics fixture in
 * this process, with no browser and no server.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it } from "@std/testing/bdd";

import {
  type CaseMeasurement,
  caseNamed,
  measureCasePhases,
  type MeasuredPhaseRecord,
} from "./topics-cost-cases.ts";
import {
  buildTopicsFixture,
  measureTopicsFixture,
  topicIndicesOf,
} from "./topics-headless-fixture.ts";

/**
 * The cases, at a size where a lookup that re-runs per topic is unmistakable
 * against one that re-runs per changed row: every topic's lookup demanded,
 * once with each topic wired to its board's index and once with each topic
 * handed the pivot alone, as a topic filed before its board published an
 * index is until it is bound.
 */
const CASES = {
  keyed: caseNamed("pivot/high-degree/mentions-4/topics-32/all-backlinks"),
  unbound: caseNamed(
    "pivot/high-degree/mentions-4/topics-32/unbound/all-backlinks",
  ),
};

describe("topics-lazy-lookup-reruns", () => {
  // A scan, which an unbound topic's lookup makes, reads the pivot's rows only
  // as far as it touches them, so its registered reads are its own row and the
  // identity of every other. A mention edit rewrites the rows of the topics it
  // moved between, and only those lookups run again. An eager read of the
  // table registers every row whole, and then every unbound lookup runs on any
  // edit, which is the cost lazy materialization exists to remove. A keyed
  // lookup reads only the positions filed under its number, so it re-runs
  // only for its own row in either mode, and its case holds that. The read
  // budget bounds counts from above and does not see an eager read: a lazy
  // read turned eager makes fewer proxy accesses, not more.

  for (const [wiring, probeCase] of Object.entries(CASES)) {
    describe(`with every topic ${wiring}`, () => {
      let measurement: CaseMeasurement;
      beforeAll(async () => {
        measurement = await measureCasePhases(probeCase, {
          mode: "lazy-materialization-on",
        });
      });

      const phaseNamed = (name: string): MeasuredPhaseRecord => {
        const phase = measurement.phases.find((record) =>
          record.phase === name
        );
        if (phase === undefined || !phase.measured) {
          throw new Error(`The case did not measure the phase "${name}".`);
        }
        return phase;
      };

      it("runs under lazy materialization", () => {
        expect(measurement.mode).toBe("lazy-materialization-on");
      });

      it("runs every topic's lookup once at initialization", () => {
        expect(
          phaseNamed("initialization").bodies.consumer.backlinksOf.runs,
        ).toBe(probeCase.options.topicCount);
      });

      for (const phase of ["mention removal", "mention insertion"]) {
        it(`re-runs only the focus topic's lookup on ${phase}`, () => {
          expect(phaseNamed(phase).bodies.consumer.backlinksOf.runs).toBe(1);
        });
      }

      it("re-runs only the lookups of the two topics a retarget moves between", () => {
        // The focus topic loses a mentioner either way; the new target gains
        // one unless the source already mentioned it, which the edit records.
        const phase = phaseNamed("same-count retarget");
        const { targetGainsSource } = phase.edit as {
          targetGainsSource: boolean;
        };
        expect(phase.bodies.consumer.backlinksOf.runs).toBe(
          targetGainsSource ? 2 : 1,
        );
      });
    });
  }

  describe("a numbered topic's lookup", () => {
    // A numbered topic wired to its board's index reads the positions filed
    // under its number and the row it finds there, and no other row. So what
    // one run registers does not grow with the board, where a scan registers
    // the identity of every row.

    /**
     * The reads of the open topic's lookup over `topicCount` topics, each
     * mentioning the two after it.
     */
    const lookupReads = async (topicCount: number) => {
      await using measured = await measureTopicsFixture(
        buildTopicsFixture({
          topicCount,
          mentions: { shape: "low-degree", perSource: 2 },
        }),
        `topics-lazy-lookup-reruns keyed ${topicCount}`,
        { workload: "topic-open", topic: 0 },
        { mode: "lazy-materialization-on" },
      );
      expect(measured.errors).toEqual([]);
      const { runs, proxyAccesses, linkResolutions } =
        measured.reads.bodies.backlinksOf;
      return { runs, proxyAccesses, linkResolutions };
    };

    it("registers the same reads at 4 and at 32 topics", async () => {
      const small = await lookupReads(4);
      expect(small.runs).toBe(1);
      expect(await lookupReads(32)).toEqual(small);
    });

    it("re-runs, when a topic is filed, only the new topic's lookup and those of the topics it mentions", async () => {
      const TOPICS = 16;
      const fixture = buildTopicsFixture({
        topicCount: TOPICS,
        mentions: { shape: "low-degree", perSource: 2 },
      });
      const filed = TOPICS - 1;
      await using measured = await measureTopicsFixture(
        { ...fixture, board: fixture.board.filter((at) => at !== filed) },
        "topics-lazy-lookup-reruns filing",
        { workload: "all-backlinks" },
        { mode: "lazy-materialization-on" },
      );
      const { seeded } = measured;
      const appended = await measured.update((tx) => {
        seeded.board.withTx(tx).push(seeded.topics[filed]);
      });
      expect(measured.errors).toEqual([]);
      // The filed topic mentions the first two, which now have one more
      // mentioner each.
      const mentioned = fixture.topics[filed].mentions;
      expect(mentioned).toEqual([0, 1]);
      for (const target of mentioned) {
        expect(
          topicIndicesOf(seeded, measured.outputs.backlinks.get(target)!),
        ).toContain(filed);
      }
      expect(appended.reads.bodies.backlinksOf.actions.size).toBe(
        1 + mentioned.length,
      );
    });
  });
});
