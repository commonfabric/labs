import type {
  PatternIndexListedPattern,
  PatternIndexSearchResult,
} from "@commonfabric/pattern-index/client";
import { describe, it } from "@commonfabric/test-support/test";
import { expect } from "@std/expect";
import {
  eventBadges,
  formatIndexTime,
  listingLabel,
  matchRatio,
  patternsByScore,
  searchRequestOf,
  truncateId,
} from "../../console/index-inspector.ts";

const pattern = (
  patternId: string,
  score: number,
  events: Record<string, number> = {},
): PatternIndexListedPattern => ({
  patternId,
  description: `pattern ${patternId}`,
  hashtags: [],
  keywords: [],
  handle: "p-owner00001",
  createdAt: "2026-08-01T00:00:00.000Z",
  events,
  score,
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

  describe("listingLabel", () => {
    it("joins the listing state, whether it is listed, the bucket and both flags in that order", () => {
      expect(listingLabel({
        listing: "passed",
        listed: true,
        bucket: "main",
        grandfathered: true,
        hidden: true,
      })).toBe("passed · listed · main · grandfathered · hidden");
    });

    it("says unlisted for a pattern the index does not list", () => {
      expect(listingLabel({ listing: "held", listed: false })).toBe(
        "held · unlisted",
      );
    });

    it("reads a listing state with no bucket on its own", () => {
      expect(listingLabel({ listing: "pending" })).toBe("pending");
    });

    it("answers nothing for an answer carrying no listing fields", () => {
      expect(listingLabel({})).toBeUndefined();
    });
  });

  describe("matchRatio", () => {
    const result = (
      overrides: Partial<PatternIndexSearchResult>,
    ): PatternIndexSearchResult => ({
      patternId: "pat-1",
      description: "Totals an expense list",
      hashtags: [],
      handle: "p-owner00001",
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
