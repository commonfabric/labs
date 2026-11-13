import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import {
  acceptedExample,
  buildClassificationPrompt,
  buildRuleGenerationPrompt,
  calculateF1,
  calculatePrecisionRecall,
  calculateTier,
  type ClassifiableInput,
  classificationFailure,
  type ClassificationRule,
  compileRuleRegex,
  correctedExample,
  deriveClassification,
  getTierColor,
  getTierLabel,
  isRegexSafe,
  isValidRuleSuggestion,
  type LabeledExample,
  matchRulesAgainstInput,
  newRule,
  previewFields,
  type RuleSuggestion,
  scoreRules,
  scoringOf,
  selectVisibleSuggestions,
  type Tier,
  viewVerdict,
} from "./classifier-logic.ts";

const rule = (overrides: Partial<ClassificationRule>): ClassificationRule => ({
  id: "r",
  name: "rule",
  targetField: "subject",
  pattern: "invoice",
  caseInsensitive: true,
  predicts: true,
  precision: 0.5,
  recall: 0.5,
  tier: 0,
  evaluationCount: 0,
  truePositives: 0,
  falsePositives: 0,
  trueNegatives: 0,
  falseNegatives: 0,
  createdAt: 0,
  isShared: false,
  ...overrides,
});

const input = (fields: Record<string, string>, id = "item-1") => ({
  id,
  receivedAt: 7,
  fields,
});

const example = (
  fields: Record<string, string>,
  overrides: Partial<LabeledExample> = {},
): LabeledExample => ({
  input: input(fields),
  label: true,
  decidedBy: "user",
  reasoning: "",
  confidence: 1,
  labeledAt: 0,
  wasCorrection: false,
  isInteresting: false,
  ...overrides,
});

const suggestion: RuleSuggestion = {
  name: "Invoices",
  targetField: "subject",
  pattern: "invoice",
  predicts: true,
  reasoning: "Bills say invoice",
};

describe("classifier-logic", () => {
  let warnings: unknown[][];
  let errors: unknown[][];
  let warnStub: { restore(): void };
  let errorStub: { restore(): void };

  beforeEach(() => {
    warnings = [];
    errors = [];
    warnStub = stub(console, "warn", (...args) => void warnings.push(args));
    errorStub = stub(console, "error", (...args) => void errors.push(args));
  });

  afterEach(() => {
    warnStub.restore();
    errorStub.restore();
  });

  describe("isRegexSafe()", () => {
    it("returns true for a plain alternation", () => {
      expect(isRegexSafe("invoice|statement")).toBe(true);
    });

    it("returns false for a pattern over 500 characters", () => {
      expect(isRegexSafe("a".repeat(501))).toBe(false);
    });

    it("returns false for nested quantifiers", () => {
      expect(isRegexSafe("(a+)+")).toBe(false);
    });
  });

  describe("compileRuleRegex()", () => {
    it("returns a case-insensitive regex when asked for one", () => {
      expect(compileRuleRegex("bill", true)?.test("BILL")).toBe(true);
      expect(compileRuleRegex("bill", false)?.test("BILL")).toBe(false);
    });

    it("returns null and warns for a dangerous pattern", () => {
      expect(compileRuleRegex("(.*)+", true)).toBeNull();
      expect(String(warnings[0][0])).toContain("dangerous regex");
    });

    it("returns null and warns for an invalid pattern", () => {
      expect(compileRuleRegex("[unclosed", true)).toBeNull();
      expect(String(warnings[0][0])).toContain(
        'Invalid regex pattern "[unclosed"',
      );
    });
  });

  describe("newRule()", () => {
    it("returns a tier-0 case-insensitive rule from the suggestion", () => {
      const created = newRule(suggestion);
      expect(created).toMatchObject({
        name: "Invoices",
        targetField: "subject",
        pattern: "invoice",
        predicts: true,
        caseInsensitive: true,
        tier: 0,
        precision: 0.5,
        recall: 0.5,
        evaluationCount: 0,
        isShared: false,
      });
      expect(created?.id).toMatch(/^[0-9a-z]+$/);
    });

    it("returns null and warns once for an invalid pattern", () => {
      expect(newRule({ ...suggestion, pattern: "(" })).toBeNull();
      expect(warnings.length).toBe(1);
      expect(String(warnings[0][0])).toContain('Invalid regex pattern "("');
      expect(errors).toEqual([]);
    });

    it("returns null and warns once for an unsafe pattern", () => {
      expect(newRule({ ...suggestion, pattern: "(.*)+" })).toBeNull();
      expect(warnings.length).toBe(1);
      expect(String(warnings[0][0])).toContain("dangerous regex");
      expect(errors).toEqual([]);
    });
  });

  describe("isValidRuleSuggestion()", () => {
    it("returns true for a complete suggestion", () => {
      expect(isValidRuleSuggestion(suggestion)).toBe(true);
    });

    it("returns false for a non-object", () => {
      expect(isValidRuleSuggestion(null)).toBe(false);
      expect(isValidRuleSuggestion("rule")).toBe(false);
    });

    it("returns false for a blank name", () => {
      expect(isValidRuleSuggestion({ ...suggestion, name: " " })).toBe(false);
    });

    it("returns false for a non-boolean prediction", () => {
      expect(isValidRuleSuggestion({ ...suggestion, predicts: "yes" })).toBe(
        false,
      );
    });
  });

  describe("calculateF1()", () => {
    it("returns the harmonic mean of precision and recall", () => {
      expect(calculateF1({ precision: 1, recall: 0.5 })).toBeCloseTo(2 / 3);
    });

    it("returns 0 for no rule and for zero precision and recall", () => {
      expect(calculateF1(undefined)).toBe(0);
      expect(calculateF1({ precision: 0, recall: 0 })).toBe(0);
    });
  });

  describe("calculatePrecisionRecall()", () => {
    it("returns ratios of the confusion matrix", () => {
      expect(
        calculatePrecisionRecall({
          truePositives: 3,
          falsePositives: 1,
          falseNegatives: 3,
        }),
      ).toEqual({ precision: 0.75, recall: 0.5 });
    });

    it("returns 0.5 for each ratio with nothing to divide by", () => {
      expect(
        calculatePrecisionRecall({
          truePositives: 0,
          falsePositives: 0,
          falseNegatives: 0,
        }),
      ).toEqual({ precision: 0.5, recall: 0.5 });
    });
  });

  describe("calculateTier()", () => {
    const at = (evaluationCount: number, f1: number) =>
      calculateTier({ precision: f1, recall: f1, evaluationCount });

    it("returns the highest tier whose evaluation count and F1 the rule meets", () => {
      expect(at(20, 0.95)).toBe(4);
      expect(at(19, 0.95)).toBe(3);
      expect(at(10, 0.85)).toBe(3);
      expect(at(5, 0.7)).toBe(2);
      expect(at(3, 0.5)).toBe(1);
      expect(at(100, 0.49)).toBe(0);
      expect(at(2, 1)).toBe(0);
    });
  });

  describe("getTierLabel()", () => {
    it("returns the label for each tier, and Silent for none", () => {
      const tiers: Tier[] = [0, 1, 2, 3, 4];
      expect(tiers.map(getTierLabel)).toEqual([
        "Silent",
        "Suggest",
        "Default",
        "Auto+Undo",
        "Automatic",
      ]);
      expect(getTierLabel(undefined)).toBe("Silent");
    });
  });

  describe("getTierColor()", () => {
    it("returns the color for each tier, and gray for none", () => {
      expect(getTierColor(4)).toBe("var(--cf-theme-color-error)");
      expect(getTierColor(1)).toBe("var(--cf-colors-info)");
      expect(getTierColor(undefined)).toBe("var(--cf-colors-gray-400)");
    });
  });

  describe("scoreRules()", () => {
    const yes = rule({ id: "yes", name: "yes", predicts: true });
    const no = rule({ id: "no", name: "no", predicts: false });
    const hit = (id: string) => ({ ruleIds: [id], matchedRuleIds: [id] });
    const miss = (id: string) => ({ ruleIds: [id], matchedRuleIds: [] });

    it("records a true positive for a matched rule that predicted the outcome", () => {
      const [scored] = scoreRules([yes], hit("yes"), true, 1);
      expect(scored).toMatchObject({
        truePositives: 1,
        evaluationCount: 1,
        precision: 1,
        recall: 1,
      });
    });

    it("records a false positive for a matched rule that predicted otherwise", () => {
      const [scored] = scoreRules([no], hit("no"), true, 1);
      expect(scored).toMatchObject({ falsePositives: 1, precision: 0 });
    });

    it("records a false negative for an unmatched rule that would have been right", () => {
      const [scored] = scoreRules([yes], miss("yes"), true, 1);
      expect(scored).toMatchObject({ falseNegatives: 1, recall: 0 });
    });

    it("records a true negative for an unmatched rule that would have been wrong", () => {
      const [scored] = scoreRules([no], miss("no"), true, 1);
      expect(scored).toMatchObject({ trueNegatives: 1, evaluationCount: 1 });
    });

    it("takes back an outcome with a step of -1, not counting below zero", () => {
      const seasoned = rule({
        id: "yes",
        name: "yes",
        truePositives: 20,
        evaluationCount: 20,
        precision: 1,
        recall: 1,
        tier: 4,
      });
      const [undone] = scoreRules([seasoned], hit("yes"), true, -1);
      expect(undone).toMatchObject({
        truePositives: 19,
        evaluationCount: 19,
        tier: 3,
      });
      const [floored] = scoreRules([yes], hit("yes"), false, -1);
      expect(floored).toMatchObject({ falsePositives: 0, evaluationCount: 0 });
    });

    it("promotes a rule whose metrics reach a higher tier", () => {
      const nearly = rule({
        id: "yes",
        name: "yes",
        truePositives: 19,
        evaluationCount: 19,
        tier: 3,
      });
      expect(scoreRules([nearly], hit("yes"), true, 1)[0].tier).toBe(4);
    });

    it("returns a rule the scoring does not name unchanged", () => {
      const [scored, untouched] = scoreRules([yes, no], hit("yes"), true, 1);
      expect(scored.evaluationCount).toBe(1);
      expect(untouched).toBe(no);
    });

    it("tells rules apart by ID, not by name", () => {
      const twin = rule({ id: "twin", name: "yes", predicts: true });
      const [scored, other] = scoreRules(
        [yes, twin],
        { ruleIds: ["yes", "twin"], matchedRuleIds: ["yes"] },
        true,
        1,
      );
      expect(scored.truePositives).toBe(1);
      expect(other).toMatchObject({ truePositives: 0, falseNegatives: 1 });
    });
  });

  describe("scoringOf()", () => {
    const rules = [
      rule({ id: "a", name: "Alpha" }),
      rule({ id: "b", name: "Beta" }),
    ];

    it("returns the scoring the item recorded", () => {
      const scoring = { ruleIds: ["a"], matchedRuleIds: [] };
      expect(scoringOf({ matchedRules: ["Alpha"], scoring }, rules)).toBe(
        scoring,
      );
    });

    it("returns every rule, matching by name, for an item stored without a scoring", () => {
      expect(scoringOf({ matchedRules: ["Beta"] }, rules)).toEqual({
        ruleIds: ["a", "b"],
        matchedRuleIds: ["b"],
      });
    });
  });

  describe("matchRulesAgainstInput()", () => {
    it("returns no prediction when no rule matches", () => {
      const result = matchRulesAgainstInput(
        input({ subject: "hello" }),
        [rule({})],
        0.85,
      );
      expect(result).toMatchObject({
        matchedRules: [],
        prediction: null,
        confidence: 0,
        highestTier: 0,
        shouldAutoClassify: false,
      });
    });

    it("skips a rule whose field the input lacks or whose regex is invalid", () => {
      const result = matchRulesAgainstInput(
        input({ subject: "invoice" }),
        [rule({ targetField: "body" }), rule({ pattern: "[" })],
        0.85,
      );
      expect(result.matchedRules).toEqual([]);
    });

    it("returns the precision-weighted majority and auto-classifies at tier 3", () => {
      const result = matchRulesAgainstInput(
        input({ subject: "Invoice due" }),
        [
          rule({ id: "a", name: "a", precision: 0.9, tier: 3 }),
          rule({ id: "c", name: "c", pattern: "absent" }),
          rule({
            id: "b",
            name: "b",
            pattern: "due",
            predicts: false,
            precision: 0.1,
          }),
        ],
        0.85,
      );
      expect(result.matchedRules).toEqual(["a", "b"]);
      expect(result.scoring).toEqual({
        ruleIds: ["a", "c", "b"],
        matchedRuleIds: ["a", "b"],
      });
      expect(result.prediction).toBe(true);
      expect(result.confidence).toBeCloseTo(0.9);
      expect(result.highestTier).toBe(3);
      expect(result.shouldAutoClassify).toBe(true);
    });

    it("returns a NO prediction when the NO votes outweigh the YES votes", () => {
      const result = matchRulesAgainstInput(
        input({ subject: "invoice" }),
        [rule({ predicts: false, precision: 0.8, tier: 2 })],
        0.85,
      );
      expect(result.prediction).toBe(false);
      expect(result.confidence).toBe(1);
      expect(result.shouldAutoClassify).toBe(false);
    });

    it("breaks a tie with the higher-tier rule's prediction at 0.5 confidence", () => {
      const result = matchRulesAgainstInput(
        input({ subject: "invoice" }),
        [
          rule({ name: "low", predicts: true, precision: 0.6, tier: 1 }),
          rule({ name: "high", predicts: false, precision: 0.6, tier: 4 }),
        ],
        0.4,
      );
      expect(result.prediction).toBe(false);
      expect(result.confidence).toBe(0.5);
      expect(result.shouldAutoClassify).toBe(true);
    });
  });

  describe("buildClassificationPrompt()", () => {
    it("returns the item, the question, and no context without examples", () => {
      const prompt = buildClassificationPrompt(
        input({ subject: "Hi" }, "abc"),
        "",
        [],
      );
      expect(prompt).toContain("Item ID: abc");
      expect(prompt).toContain("Question: Is this a positive example?");
      expect(prompt).toContain('"subject": "Hi"');
      expect(prompt).not.toContain("Examples for context");
    });

    it("returns the three most recent examples of each label", () => {
      const examples = [1, 2, 3, 4].map((n) =>
        example({ subject: `yes ${n}` }, { label: true })
      ).concat([example({ subject: "no 1" }, { label: false })]);
      const prompt = buildClassificationPrompt(
        input({ subject: "Hi" }),
        "Is it a bill?",
        examples,
      );
      expect(prompt).toContain("Question: Is it a bill?");
      expect(prompt).toContain("Positive examples (answer is YES)");
      expect(prompt).not.toContain("yes 1");
      expect(prompt).toContain("yes 4");
      expect(prompt).toContain("Negative examples (answer is NO)");
      expect(prompt).toContain("no 1");
    });

    it("returns only the label that has examples", () => {
      const prompt = buildClassificationPrompt(input({ subject: "Hi" }), "q", [
        example({ subject: "nope" }, { label: false }),
      ]);
      expect(prompt).not.toContain("Positive examples");
      expect(prompt).toContain("nope");
    });
  });

  describe("classificationFailure()", () => {
    const item: ClassifiableInput = input({ subject: "Invoice" }, "item-1");

    /** The failure for `llm`, given what `deriveClassification` made of it. */
    const failureOf = (
      llm: Parameters<typeof deriveClassification>[0],
    ) =>
      classificationFailure(
        llm,
        item.id,
        deriveClassification(llm, item, [], 0.85),
      );

    it("returns null while the call is pending or has not started", () => {
      expect(failureOf({ pending: true })).toBeNull();
      expect(failureOf({ pending: false })).toBeNull();
    });

    it("returns null for a valid answer for this item", () => {
      expect(
        failureOf({
          pending: false,
          result: {
            itemId: "item-1",
            classification: true,
            confidence: 0.9,
            reasoning: "x",
          },
        }),
      ).toBeNull();
    });

    it("returns null for the previous item's result", () => {
      expect(failureOf({ pending: false, result: { itemId: "item-0" } }))
        .toBeNull();
    });

    it("returns the call's error", () => {
      expect(failureOf({ pending: false, error: "boom" })).toBe("boom");
    });

    it("returns a rejection for a rejected answer for this item or for no item", () => {
      for (const result of [{ itemId: "item-1" }, { classification: true }]) {
        expect(failureOf({ pending: false, result })).toBe(
          "the model's answer could not be used",
        );
      }
    });
  });

  describe("deriveClassification()", () => {
    const item: ClassifiableInput = input({ subject: "Invoice" }, "item-1");
    const answer = {
      itemId: "item-1",
      classification: false,
      confidence: 0.6,
      reasoning: "Looks personal",
    };
    const done = (result?: Record<string, unknown>) =>
      result === undefined ? { pending: false } : { pending: false, result };

    it("returns null while the model is pending or failed", () => {
      expect(deriveClassification({ pending: true }, item, [], 0.85))
        .toBeNull();
      expect(
        deriveClassification({ pending: false, error: "x" }, item, [], 0.85),
      ).toBeNull();
      expect(deriveClassification(done(), item, [], 0.85)).toBeNull();
    });

    it("returns the model's answer when no rule decides", () => {
      expect(deriveClassification(done(answer), item, [], 0.85)).toEqual({
        inputId: "item-1",
        classification: false,
        confidence: 0.6,
        reasoning: "Looks personal",
        decidedBy: "llm",
        matchedRules: [],
      });
    });

    it("returns the rules' prediction when they match with enough confidence", () => {
      const result = deriveClassification(
        done(answer),
        item,
        [rule({ name: "bills", precision: 0.9 })],
        0.85,
      );
      expect(result).toEqual({
        inputId: "item-1",
        classification: true,
        confidence: 1,
        reasoning: "Rules matched: bills",
        decidedBy: "rules",
        matchedRules: ["bills"],
      });
    });

    it("returns the rules' prediction at any confidence for a threshold of 0", () => {
      const split = [
        rule({ id: "y", name: "yes", precision: 0.6 }),
        rule({ id: "n", name: "no", predicts: false, precision: 0.4 }),
      ];
      expect(deriveClassification(done(answer), item, split, 0)).toMatchObject(
        { decidedBy: "rules", classification: true, confidence: 0.6 },
      );
      expect(deriveClassification(done(answer), item, split, 0.85))
        .toMatchObject({ decidedBy: "llm", classification: false });
    });

    it("returns null and warns for an answer about another item", () => {
      expect(
        deriveClassification(done({ ...answer, itemId: "other" }), item, [], 1),
      ).toBeNull();
      expect(String(warnings[0][0])).toContain(
        "Item ID mismatch: expected item-1, got other",
      );
    });

    it("returns null and warns for a malformed answer", () => {
      for (
        const bad of [
          { classification: "no" },
          { confidence: 2 },
          { confidence: "high" },
          { reasoning: " " },
        ]
      ) {
        expect(
          deriveClassification(done({ ...answer, ...bad }), item, [], 1),
        ).toBeNull();
      }
      expect(warnings.map((w) => String(w[0]))).toEqual([
        "[Classifier] Invalid classification type: expected boolean, got string",
        "[Classifier] Invalid confidence: expected number between 0 and 1, got 2",
        "[Classifier] Invalid confidence: expected number between 0 and 1, got high",
        "[Classifier] Invalid reasoning: expected non-empty string",
      ]);
    });
  });

  describe("buildRuleGenerationPrompt()", () => {
    const config = { question: "Is it a bill?", minExamplesForRules: 3 };
    const corrected = example({ subject: "Lunch?" }, {
      label: false,
      wasCorrection: true,
      originalPrediction: true,
    });

    it("returns an empty prompt with too few examples", () => {
      expect(buildRuleGenerationPrompt([corrected, corrected], config)).toBe(
        "",
      );
    });

    it("returns an empty prompt with no corrections and under two interesting examples", () => {
      const plain = [1, 2, 3].map((n) => example({ subject: `s${n}` }));
      expect(buildRuleGenerationPrompt(plain, config)).toBe("");
    });

    it("returns the fields, examples of each label, and the corrections", () => {
      const prompt = buildRuleGenerationPrompt([
        example({ subject: "Invoice", body: "Pay" }),
        example({ subject: "Bill" }),
        corrected,
      ], config);
      expect(prompt).toContain('Question being classified: "Is it a bill?"');
      expect(prompt).toContain("Available fields: subject, body");
      expect(prompt).toContain('{"subject":"Invoice","body":"Pay"}');
      expect(prompt).toContain(
        '- {"subject":"Lunch?"} → was YES, correct: NO',
      );
      expect(prompt).toContain("Generate 1-3 regex patterns");
    });

    it("returns a prompt without corrections when interesting examples suffice", () => {
      const interesting = [1, 2, 3, 4, 5].map((n) =>
        example({ subject: `s${n}` }, { isInteresting: true })
      );
      const prompt = buildRuleGenerationPrompt(interesting, {
        question: "",
        minExamplesForRules: 0,
      });
      expect(prompt).toContain(
        'Question being classified: "Is this a positive example?"',
      );
      expect(prompt).not.toContain("Recent corrections");
    });
  });

  describe("selectVisibleSuggestions()", () => {
    const second = { ...suggestion, name: "Statements" };

    it("returns nothing while the model is pending, failed, or empty-handed", () => {
      expect(selectVisibleSuggestions({ pending: true }, [])).toEqual([]);
      expect(selectVisibleSuggestions({ pending: false, error: "x" }, []))
        .toEqual([]);
      expect(selectVisibleSuggestions({ pending: false }, [])).toEqual([]);
    });

    it("returns the valid undismissed suggestions with their indices", () => {
      const result = selectVisibleSuggestions({
        pending: false,
        result: {
          suggestions: [suggestion, { ...suggestion, pattern: "" }, second],
        },
      }, [0]);
      expect(result).toEqual([{ suggestion: second, originalIndex: 2 }]);
      expect(String(warnings[0][0])).toContain("Invalid rule suggestion");
    });
  });

  describe("acceptedExample()", () => {
    it("returns an accepted example marked interesting below 0.7 confidence", () => {
      const source = input({ subject: "Hi" });
      const accepted = acceptedExample(source, {
        classification: true,
        confidence: 0.6,
        reasoning: "maybe",
      });
      expect(accepted).toMatchObject({
        input: source,
        label: true,
        decidedBy: "suggestion-accepted",
        reasoning: "maybe",
        confidence: 0.6,
        wasCorrection: false,
        isInteresting: true,
        interestingReason: "Low confidence, user confirmed",
      });
      expect(accepted.input.fields).not.toBe(source.fields);
    });

    it("returns an uninteresting example at 0.7 confidence or above", () => {
      const accepted = acceptedExample(input({}), {
        classification: false,
        confidence: 0.9,
        reasoning: "sure",
      });
      expect(accepted.isInteresting).toBe(false);
      expect(accepted).not.toHaveProperty("interestingReason");
    });
  });

  describe("correctedExample()", () => {
    it("returns a certain user correction recording the original prediction", () => {
      expect(correctedExample(input({ a: "b" }), true, false, "nope"))
        .toMatchObject({
          label: false,
          decidedBy: "user",
          reasoning: "nope",
          confidence: 1,
          wasCorrection: true,
          originalPrediction: true,
          isInteresting: true,
          interestingReason: "User corrected classification",
        });
    });
  });

  describe("viewVerdict()", () => {
    it("returns a YES verdict with its confidence, source, and reasoning", () => {
      expect(viewVerdict({
        classification: true,
        confidence: 0.876,
        decidedBy: "llm",
        reasoning: "Mentions a total",
      })).toEqual({
        answer: "YES",
        opposite: "NO",
        color: "var(--cf-theme-color-success)",
        confidencePercent: "88",
        decidedBy: "llm",
        reasoning: "Mentions a total",
      });
    });

    it("returns a blank NO verdict for no result", () => {
      expect(viewVerdict(null)).toEqual({
        answer: "NO",
        opposite: "YES",
        color: "var(--cf-theme-color-error)",
        confidencePercent: "0",
        decidedBy: "",
        reasoning: "",
      });
    });
  });

  describe("previewFields()", () => {
    it("returns the first field truncated to 30 characters", () => {
      expect(previewFields({ subject: "x".repeat(40), body: "b" })).toBe(
        `subject: ${"x".repeat(30)}...`,
      );
    });

    it("returns (empty) for no fields", () => {
      expect(previewFields({})).toBe("(empty)");
    });
  });
});
