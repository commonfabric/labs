import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  contentWords,
  descriptionOverlap,
  DETAILED_RANK_CUTOFF,
  indiscriminateTerms,
  type LabelledCapability,
  type LabelledQuery,
  type NegativeQuery,
  scoreQuery,
  scoreRetrieval,
} from "../../src/pattern-index/retrieval-scoring.ts";

const capability = (
  overrides: Partial<LabelledCapability> = {},
): LabelledCapability => ({
  id: "checklist",
  need: "a list to tick off",
  answers: ["good-1", "good-2"],
  partial: ["mockup-1"],
  evidence: "read from source",
  ...overrides,
});

const query = (overrides: Partial<LabelledQuery> = {}): LabelledQuery => ({
  id: "checklist.keywords",
  capability: "checklist",
  register: "keywords",
  text: "list add tick off",
  ...overrides,
});

const NO_STOP_WORDS: ReadonlySet<string> = new Set();

describe("retrieval scoring", () => {
  it("puts the first answering entry's rank at its one-based position", () => {
    const score = scoreQuery(query(), capability(), [
      "other",
      "good-2",
      "good-1",
    ]);
    expect(score.firstAnswerRank).toBe(2);
    expect(score.answersInTop5).toBe(2);
  });

  it("reports no rank and one miss when nothing answering came back", () => {
    const score = scoreQuery(query(), capability(), ["other", "another"]);
    expect(score.firstAnswerRank).toBeUndefined();
    expect(score.failures.map((failure) => failure.kind)).toEqual(["miss"]);
  });

  it("calls an answer past the detailed cut-off buried rather than found", () => {
    const ranked = ["a", "b", "c", "d", "e", "good-1"];
    const score = scoreQuery(query(), capability(), ranked);
    expect(score.firstAnswerRank).toBe(DETAILED_RANK_CUTOFF + 1);
    expect(score.answersInTop5).toBe(0);
    expect(score.answersInTop10).toBe(1);
    expect(score.failures.map((failure) => failure.kind)).toEqual(["buried"]);
  });

  it("calls a partial ahead of every answer misleading", () => {
    const score = scoreQuery(query(), capability(), ["mockup-1", "good-1"]);
    expect(score.failures.map((failure) => failure.kind)).toEqual([
      "misleading",
    ]);
  });

  it("does not call a partial misleading when an answer outranks it", () => {
    const score = scoreQuery(query(), capability(), ["good-1", "mockup-1"]);
    expect(score.failures).toEqual([]);
    expect(score.partialsInTop5).toBe(1);
  });

  it("raises no miss for a capability nothing in the corpus answers", () => {
    const empty = capability({ id: "itinerary", answers: [], partial: ["m"] });
    const score = scoreQuery(
      query({ capability: "itinerary" }),
      empty,
      ["unrelated"],
    );
    expect(score.failures).toEqual([]);
    expect(score.relevantTotal).toBe(0);
  });

  it("scores a query the runner never issued as having returned nothing", () => {
    const report = scoreRetrieval([capability()], [query()], [], new Map());
    expect(report.overall.queries).toBe(1);
    expect(report.overall.hitAt5).toBe(0);
    expect(report.failures.map((failure) => failure.kind)).toEqual(["miss"]);
  });

  it("counts a negative query that returned anything as a false positive", () => {
    const negative: NegativeQuery = {
      id: "neg.stopwatch",
      kind: "absent",
      text: "elapsed seconds",
      why: "no clock in the corpus",
    };
    const report = scoreRetrieval(
      [capability()],
      [],
      [negative],
      new Map([["neg.stopwatch", ["anything"]]]),
    );
    expect(report.negativesClean).toBe(0);
    expect(report.failures.map((failure) => failure.kind)).toEqual([
      "false-positive",
    ]);
  });

  it("counts a negative query that returned nothing as clean", () => {
    const negative: NegativeQuery = {
      id: "neg.nonsense",
      kind: "control",
      text: "xylophone",
      why: "appears nowhere",
    };
    const report = scoreRetrieval([capability()], [], [negative], new Map());
    expect(report.negativesClean).toBe(1);
    expect(report.failures).toEqual([]);
  });

  // The gate this instrument exists to drive is "hit@5 across the set". These
  // two cases are the demonstration that it can register both verdicts: the
  // same query set scores 1 against a perfect index and 0 against one that
  // answers nothing. A gate only ever exercised against real data is a gate
  // nobody has watched fail.
  it("scores a perfect index at one and an answerless one at zero", () => {
    const queries = [
      query(),
      query({ id: "checklist.task", register: "task" }),
    ];
    const perfect = scoreRetrieval(
      [capability()],
      queries,
      [],
      new Map(queries.map((entry) => [entry.id, ["good-1"]])),
    );
    expect(perfect.overall.hitAt5 / perfect.overall.queries).toBe(1);
    expect(perfect.overall.meanReciprocalRank).toBe(1);

    const answerless = scoreRetrieval(
      [capability()],
      queries,
      [],
      new Map(queries.map((entry) => [entry.id, ["junk-1", "junk-2"]])),
    );
    expect(answerless.overall.hitAt5).toBe(0);
    expect(answerless.overall.meanReciprocalRank).toBe(0);
    expect(answerless.failures).toHaveLength(2);
  });

  it("refuses a query naming a capability the set does not define", () => {
    expect(() =>
      scoreRetrieval(
        [capability()],
        [query({ capability: "absent" })],
        [],
        new Map(),
      )
    ).toThrow("which the set does not define");
  });

  it("averages recall only over capabilities that have something to recall", () => {
    const capabilities = [
      capability(),
      capability({ id: "itinerary", answers: [], partial: [] }),
    ];
    const queries = [
      query(),
      query({ id: "itinerary.keywords", capability: "itinerary" }),
    ];
    const report = scoreRetrieval(
      capabilities,
      queries,
      [],
      new Map([["checklist.keywords", ["good-1", "good-2"]]]),
    );
    // Both answers found for the only capability that has any, so recall is
    // whole; the answerless capability neither helps nor hurts it.
    expect(report.overall.recallAt5).toBe(1);
  });

  describe("wording diagnostics", () => {
    it("reports the share of a query's content words the target already carries", () => {
      const overlap = descriptionOverlap(
        "sortable table columns",
        "Renders rows in a table and sorts them when a column header is clicked",
        NO_STOP_WORDS,
      );
      // Only "table" is carried. "sortable" is absent outright, and
      // "columns" does not match "column" — see the next case.
      expect(overlap).toBeCloseTo(1 / 3, 5);
    });

    it("matches a query term inside the target's word but not the reverse", () => {
      // The index tests `haystack.includes(term)`, so the direction decides
      // the answer: a query term shorter than the word it means matches, and
      // one longer than it does not. This is why a plural in a query can cost
      // a match that its singular would have made, and it is a property of
      // the index being measured rather than a choice of this scorer.
      expect(descriptionOverlap("column", "column headers", NO_STOP_WORDS))
        .toBe(1);
      expect(descriptionOverlap("columns", "column headers", NO_STOP_WORDS))
        .toBe(0);
    });

    it("returns zero overlap when the query has no content words", () => {
      expect(descriptionOverlap("a to", "any target", new Set(["a", "to"])))
        .toBe(0);
    });

    it("drops stop words and single characters from a query's content words", () => {
      expect(
        contentWords("I need a list to tick off", new Set(["i", "a", "to"])),
      )
        .toEqual(["need", "list", "tick", "off"]);
    });

    it("names the terms most of the corpus already contains", () => {
      const corpus = ["interactive counter", "interactive list", "plain table"];
      expect(indiscriminateTerms(["interactive", "counter"], corpus))
        .toEqual(["interactive"]);
    });

    it("names no term indiscriminate when the corpus is empty", () => {
      expect(indiscriminateTerms(["anything"], [])).toEqual([]);
    });
  });
});
