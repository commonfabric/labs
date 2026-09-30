import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  PatternIndexListedPattern,
  PatternIndexPattern,
  PatternIndexSearchResult,
} from "../../src/pattern-index/client.ts";
import { resolvePatternIndexSuccessors } from "../../src/pattern-index/successors.ts";

const pattern = (
  patternId: string,
  priorPatternId?: string,
): PatternIndexPattern => ({
  patternId,
  description: `${patternId} description`,
  ownerDid: "did:key:publisher",
  createdAt: "2026-09-17T00:00:00Z",
  hashtags: ["donuts"],
  dependencies: [],
  ...(priorPatternId === undefined ? {} : { priorPatternId }),
});

const hit = (patternId: string): PatternIndexSearchResult => ({
  ...pattern(patternId),
  kind: "part",
  quality: "proven",
  signals: { uses: 9, score: 6.5 },
  matchedTerms: 7,
  queryTerms: 7,
});

const row = (patternId: string): PatternIndexListedPattern => ({
  ...pattern(patternId),
  keywords: [],
  events: { created: 1, instantiated: 1 },
  score: 0.5,
  quality: "unproven",
});

describe("resolvePatternIndexSuccessors()", () => {
  it("preserves the index's combined signals and attributed predecessor evidence", () => {
    const signals = {
      uses: 11,
      score: 6.5,
      inherited: {
        priorPatternId: "old",
        asOf: "2026-09-17T00:00:00Z",
        events: { instantiated: 5, run_succeeded: 4 },
        score: 6.5,
      },
    };
    const result = resolvePatternIndexSuccessors(
      { results: [hit("old")] },
      [row("old"), {
        ...row("fresh"),
        events: { created: 2 },
        score: 6.5,
        signals,
      }],
      [pattern("old"), pattern("fresh", "old")],
    );
    expect(result.results[0].signals).toEqual(signals);
  });

  it("replaces an old hit with a successor outside the ranked results", () => {
    const replacement = {
      ...pattern("fresh", "old"),
      argumentSchema: { type: "object" } as const,
      dependencies: ["flour"],
    };
    const response = resolvePatternIndexSuccessors(
      { results: [hit("other"), hit("old"), hit("last")] },
      [row("other"), row("old"), row("fresh"), row("last")],
      [pattern("other"), pattern("old"), replacement, pattern("last")],
    );
    expect(response.results.map((result) => result.patternId)).toEqual([
      "other",
      "fresh",
      "last",
    ]);
    expect(response.results[1]).toEqual({
      patternId: "fresh",
      description: "fresh description",
      ownerDid: "did:key:publisher",
      createdAt: "2026-09-17T00:00:00Z",
      hashtags: ["donuts"],
      dependencies: ["flour"],
      signals: { uses: 2, score: 0.5 },
      quality: "unproven",
      kind: "part",
    });
  });

  it("collapses a chain once at its earliest matching position", () => {
    const result = resolvePatternIndexSuccessors(
      { results: [hit("old"), hit("other"), hit("middle"), hit("fresh")] },
      [row("old"), row("middle"), row("fresh"), row("other")],
      [
        pattern("old"),
        pattern("middle", "old"),
        pattern("fresh", "middle"),
        pattern("other"),
      ],
    );
    expect(result.results.map((entry) => entry.patternId)).toEqual([
      "fresh",
      "other",
    ]);
    expect(result.results[0].kind).toBe("app");
  });

  it("does not revive an old hit when its successor is penalized", () => {
    const result = resolvePatternIndexSuccessors(
      { results: [hit("old"), hit("other")] },
      [
        row("old"),
        { ...row("fresh"), quality: "penalized", score: -2 },
        row("other"),
      ],
      [pattern("old"), pattern("fresh", "old"), pattern("other")],
    );
    expect(result.results).toEqual([hit("other")]);
  });

  it("withholds an unchanged hit when search or the refreshed catalog penalizes it", () => {
    for (const source of ["search", "catalog"] as const) {
      const result = resolvePatternIndexSuccessors(
        {
          results: [{
            ...hit("old"),
            quality: source === "search" ? "penalized" : "proven",
          }],
        },
        [{
          ...row("old"),
          quality: source === "catalog" ? "penalized" : "proven",
        }],
        [pattern("old")],
      );
      expect(result.results).toEqual([]);
    }
  });

  it("ignores a different owner's claim to replace a pattern", () => {
    const result = resolvePatternIndexSuccessors(
      { results: [hit("old")] },
      [row("old"), row("fresh")],
      [pattern("old"), {
        ...pattern("fresh", "old"),
        ownerDid: "did:key:someone-else",
      }],
    );
    expect(result.results).toEqual([hit("old")]);
  });

  it("keeps hidden successors outside discovery", () => {
    const result = resolvePatternIndexSuccessors(
      { results: [hit("old")] },
      [row("old")],
      [pattern("old"), pattern("hidden", "old")],
    );
    expect(result.results).toEqual([hit("old")]);
  });

  it("refuses ambiguous, cyclic, and unclassified replacements", () => {
    const cases = [
      [pattern("old"), pattern("a", "old"), pattern("b", "old")],
      [pattern("old", "fresh"), pattern("fresh", "old")],
      [pattern("old"), pattern("old", "old")],
    ];
    for (const patterns of cases) {
      expect(() =>
        resolvePatternIndexSuccessors(
          { results: [hit("old")] },
          patterns.map((entry) => row(entry.patternId)),
          patterns,
        )
      ).toThrow("ambiguous or cyclic");
    }
    expect(() =>
      resolvePatternIndexSuccessors(
        { results: [hit("old")] },
        [row("old"), { ...row("fresh"), quality: undefined }],
        [pattern("old"), pattern("fresh", "old")],
      )
    ).toThrow("no quality classification");
  });
});
