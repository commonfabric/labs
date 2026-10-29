import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  crossrefTargets,
  DEFAULT_CITING_TOPICS,
  topicTitle,
} from "./topic-board-fixture.ts";

// The board these describe is built by the four-hourly benchmark workflow, so
// a break here would otherwise surface a scheduled run later, on a chart rather
// than in a test.
describe("topic-board-fixture", () => {
  describe("topicTitle", () => {
    it("returns a title carrying the index, zero-padded to four digits", () => {
      // The benchmark waits for this exact string to appear on the page, so
      // the format is part of the contract rather than a presentation choice.
      expect(topicTitle(7)).toBe("Topic 0007 handoff");
      expect(topicTitle(1234)).toBe("Topic 1234 kernel");
    });

    it("returns a distinct title for each of the first thousand indices", () => {
      const titles = new Set<string>();
      for (let index = 0; index < 1000; index++) titles.add(topicTitle(index));
      expect(titles.size).toBe(1000);
    });

    it("orders titles by index under a plain string sort", () => {
      const titles = [3, 11, 2, 100].map(topicTitle);
      expect([...titles].sort()).toEqual([2, 3, 11, 100].map(topicTitle));
    });
  });

  describe("crossrefTargets", () => {
    it("returns nothing for a topic older than the citing window", () => {
      expect(crossrefTargets(0, { topicCount: 30 })).toEqual([]);
      expect(
        crossrefTargets(30 - DEFAULT_CITING_TOPICS - 1, { topicCount: 30 }),
      ).toEqual([]);
    });

    it("returns citations for every topic inside the citing window", () => {
      for (let back = 1; back <= DEFAULT_CITING_TOPICS; back++) {
        expect(crossrefTargets(30 - back, { topicCount: 30 }).length)
          .toBeGreaterThan(0);
      }
    });

    it("returns citations for the newest topic, which the board lists first", () => {
      // The navigation benchmark opens the first card and follows its first
      // citation, so the newest topic having one is what makes that step run.
      expect(crossrefTargets(29, { topicCount: 30 })[0]).toBe(28);
    });

    it("returns only earlier topics", () => {
      for (let index = 0; index < 30; index++) {
        for (const target of crossrefTargets(index, { topicCount: 30 })) {
          expect(target).toBeLessThan(index);
          expect(target).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it("returns distinct targets", () => {
      const targets = crossrefTargets(29, {
        topicCount: 30,
        crossrefsPerTopic: 5,
      });
      expect(new Set(targets).size).toBe(targets.length);
    });

    it("returns as many citations as were asked for", () => {
      // No fixed ceiling: a density the board can satisfy is satisfied, so a
      // fixture never quietly carries a lighter citation load than requested.
      for (const crossrefsPerTopic of [1, 5, 8, 20, 99]) {
        const targets = crossrefTargets(100, {
          topicCount: 101,
          crossrefsPerTopic,
          citingTopics: 1,
        });
        expect(targets.length).toBe(crossrefsPerTopic);
        expect(new Set(targets).size).toBe(crossrefsPerTopic);
      }
    });

    it("returns every earlier topic when asked for more than exist", () => {
      expect(
        crossrefTargets(3, {
          topicCount: 4,
          crossrefsPerTopic: 10,
          citingTopics: 1,
        }).toSorted((a, b) => a - b),
      ).toEqual([0, 1, 2]);
    });

    it("spreads citations across everything earlier", () => {
      // Adjacent targets would leave the far end of the board uncited, and the
      // crossref join scanning one contiguous run instead of the whole corpus.
      const targets = crossrefTargets(100, {
        topicCount: 101,
        crossrefsPerTopic: 5,
        citingTopics: 1,
      });
      expect(targets).toEqual([99, 79, 59, 39, 19]);
    });

    it("returns nothing when no topic is asked to cite", () => {
      expect(crossrefTargets(29, { topicCount: 30, citingTopics: 0 }))
        .toEqual([]);
    });

    it("returns nothing for the first topic, which has nothing to cite", () => {
      expect(crossrefTargets(0, {
        topicCount: 2,
        crossrefsPerTopic: 5,
        citingTopics: 2,
      })).toEqual([]);
    });
  });
});
