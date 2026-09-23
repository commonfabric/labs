import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  eventBadges,
  filterEvents,
  formatIndexTime,
  matchRatio,
  patternsByScore,
  searchRequestOf,
  truncateId,
} from "../../console/index-inspector.ts";
import type {
  PatternIndexEvent,
  PatternIndexListedPattern,
  PatternIndexSearchResult,
} from "../../src/pattern-index/client.ts";

const pattern = (
  patternId: string,
  score: number,
  events: Record<string, number> = {},
): PatternIndexListedPattern => ({
  patternId,
  description: `pattern ${patternId}`,
  hashtags: [],
  keywords: [],
  ownerDid: "did:key:zOwner",
  createdAt: "2026-08-01T00:00:00.000Z",
  events,
  score,
});

const event = (
  overrides: Partial<PatternIndexEvent> = {},
): PatternIndexEvent => ({
  patternId: "pat-1",
  did: "did:key:zOwner",
  eventType: "run_succeeded",
  ts: "2026-08-02T09:04:11.000Z",
  ...overrides,
});

describe("console/index-inspector", () => {
  describe("patternsByScore", () => {
    it("puts the highest score first", () => {
      const sorted = patternsByScore([
        pattern("pat-a", 1),
        pattern("pat-b", 7),
        pattern("pat-c", 3),
      ]);

      expect(sorted.map((entry) => entry.patternId)).toEqual([
        "pat-b",
        "pat-c",
        "pat-a",
      ]);
    });

    it("orders patterns of one score by identity", () => {
      const sorted = patternsByScore([
        pattern("pat-c", 2),
        pattern("pat-a", 2),
        pattern("pat-b", 2),
      ]);

      expect(sorted.map((entry) => entry.patternId)).toEqual([
        "pat-a",
        "pat-b",
        "pat-c",
      ]);
    });

    it("orders a negative score below one of zero", () => {
      const sorted = patternsByScore([
        pattern("pat-a", -2),
        pattern("pat-b", 0),
      ]);

      expect(sorted.map((entry) => entry.patternId)).toEqual([
        "pat-b",
        "pat-a",
      ]);
    });

    it("leaves the listing it was given alone", () => {
      const listing = [pattern("pat-a", 1), pattern("pat-b", 7)];

      patternsByScore(listing);

      expect(listing.map((entry) => entry.patternId)).toEqual([
        "pat-a",
        "pat-b",
      ]);
    });
  });

  describe("eventBadges", () => {
    it("keeps two authors of the same verdict separate", () => {
      expect(eventBadges({ thumbs_up: 3, thumbs_down: 1 }, {
        thumbs_up: { "did:key:zRun": 2, "did:key:zConsole": 1 },
        thumbs_down: { "did:key:zRun": 1 },
      })).toEqual([
        { eventType: "thumbs_down", count: 1, did: "did:key:zRun" },
        { eventType: "thumbs_up", count: 1, did: "did:key:zConsole" },
        { eventType: "thumbs_up", count: 2, did: "did:key:zRun" },
      ]);
    });

    it("keeps the unattributed remainder separate from a known author", () => {
      expect(eventBadges({ thumbs_up: 4 }, {
        thumbs_up: { "did:key:zRun": 2 },
      })).toEqual([
        { eventType: "thumbs_up", count: 2, did: "did:key:zRun" },
        { eventType: "thumbs_up", count: 2 },
      ]);
    });

    it("returns an unattributed total when author counts exceed it", () => {
      expect(eventBadges({ thumbs_up: 1 }, {
        thumbs_up: { "did:key:zRun": 2 },
      })).toEqual([{ eventType: "thumbs_up", count: 1 }]);
    });

    it("answers one badge per counted event type, by type", () => {
      expect(eventBadges({ thumbs_up: 2, instantiated: 5 })).toEqual([
        { eventType: "instantiated", count: 5 },
        { eventType: "thumbs_up", count: 2 },
      ]);
    });

    it("leaves out an event type counted zero times", () => {
      expect(eventBadges({ run_failed: 0, run_succeeded: 1 })).toEqual([
        { eventType: "run_succeeded", count: 1 },
      ]);
    });

    it("answers no badges for a pattern with no counts", () => {
      expect(eventBadges(undefined)).toEqual([]);
      expect(eventBadges({})).toEqual([]);
    });
  });

  describe("filterEvents", () => {
    const events = [
      event({ eventType: "run_succeeded", note: "ran in the harness" }),
      event({ patternId: "pat-2", eventType: "thumbs_down" }),
    ];

    it("keeps every event for an empty filter", () => {
      expect(filterEvents(events, "   ")).toHaveLength(2);
    });

    it("keeps the events whose note carries the filter", () => {
      expect(filterEvents(events, "harness")).toEqual([events[0]]);
    });

    it("matches a pattern identifier as readily as an event type", () => {
      expect(filterEvents(events, "pat-2")).toEqual([events[1]]);
      expect(filterEvents(events, "thumbs")).toEqual([events[1]]);
    });

    it("matches without regard to case", () => {
      expect(filterEvents(events, "HARNESS")).toEqual([events[0]]);
    });

    it("keeps no event a filter matches nothing of", () => {
      expect(filterEvents(events, "nothing here")).toEqual([]);
    });

    it("matches an event carrying no note", () => {
      expect(filterEvents([event({ note: undefined })], "run_succeeded"))
        .toHaveLength(1);
    });
  });

  describe("matchRatio", () => {
    const result = (
      overrides: Partial<PatternIndexSearchResult>,
    ): PatternIndexSearchResult => ({
      patternId: "pat-1",
      description: "Totals an expense list",
      hashtags: [],
      ownerDid: "did:key:zOwner",
      createdAt: "2026-08-01T00:00:00.000Z",
      dependencies: [],
      kind: "part",
      quality: "proven",
      ...overrides,
    });

    it("reads as matched over asked", () => {
      expect(matchRatio(result({ matchedTerms: 2, queryTerms: 3 })))
        .toBe("2/3");
    });

    it("reads a hit that matched no term as zero of the terms asked", () => {
      expect(matchRatio(result({ queryTerms: 3 }))).toBe("0/3");
    });

    it("answers nothing for a search that asked no text", () => {
      expect(matchRatio(result({}))).toBeUndefined();
      expect(matchRatio(result({ queryTerms: 0 }))).toBeUndefined();
    });
  });

  describe("truncateId", () => {
    it("shortens an identifier longer than the width asked", () => {
      expect(truncateId("abcdefghijklmno", 10)).toBe("abcdefghij…");
    });

    it("leaves an identifier the width holds whole", () => {
      expect(truncateId("abcdefghij", 10)).toBe("abcdefghij");
    });
  });

  describe("formatIndexTime", () => {
    it("reads a recorded instant to the second, as the index wrote it", () => {
      expect(formatIndexTime("2026-08-02T09:04:11.000Z")).toBe(
        "2026-08-02 09:04:11",
      );
    });

    it("answers a dash for an instant the index does not hold", () => {
      expect(formatIndexTime(null)).toBe("—");
      expect(formatIndexTime(undefined)).toBe("—");
      expect(formatIndexTime("")).toBe("—");
    });
  });

  describe("searchRequestOf", () => {
    it("composes the fields the boxes were filled with", () => {
      expect(searchRequestOf(" expenses, todo ", " totals ", "5")).toEqual({
        tags: ["expenses", "todo"],
        text: "totals",
        limit: 5,
      });
    });

    it("leaves out every box left empty", () => {
      expect(searchRequestOf("", "  ", "")).toEqual({});
    });

    it("leaves out a limit that is not a whole count", () => {
      expect(searchRequestOf("", "totals", "0")).toEqual({ text: "totals" });
      expect(searchRequestOf("", "totals", "-3")).toEqual({ text: "totals" });
      expect(searchRequestOf("", "totals", "many")).toEqual({ text: "totals" });
    });

    it("drops an empty tag left by a trailing comma", () => {
      expect(searchRequestOf("expenses,,", "", "")).toEqual({
        tags: ["expenses"],
      });
    });
  });
});
