/**
 * Seed data and view readers shared by the classifier's pattern tests.
 */
import {
  findElementByText,
  findNode,
  findNodeByProp,
  hasExactText,
  propValue,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import type {
  ClassificationRule,
  ClassifierConfig,
  LabeledExample,
  PendingClassification,
} from "./classifier-logic.ts";

/** The default configuration, asking no question yet. */
export const CONFIG: ClassifierConfig = {
  question: "",
  minExamplesForRules: 5,
  autoClassifyThreshold: 0.85,
  prefillThreshold: 0.7,
  suggestionThreshold: 0.5,
  harmAsymmetry: "equal",
  enableLLMFallback: true,
};

/** A tier-4 rule that auto-classifies any subject saying "invoice" as YES. */
export const INVOICE_RULE: ClassificationRule = {
  id: "rule-invoice",
  name: "Invoice word",
  targetField: "subject",
  pattern: "invoice",
  caseInsensitive: true,
  predicts: true,
  precision: 1,
  recall: 1,
  tier: 4,
  evaluationCount: 30,
  truePositives: 30,
  falsePositives: 0,
  trueNegatives: 0,
  falseNegatives: 0,
  createdAt: 0,
  isShared: false,
};

/** A classification the model made of a `subject`, awaiting the user. */
export const pendingItem = (
  id: string,
  subject: string,
  classification: boolean,
  confidence: number,
  reasoning: string,
): PendingClassification => ({
  input: { id, receivedAt: 0, fields: { subject } },
  result: {
    inputId: id,
    classification,
    confidence,
    reasoning,
    decidedBy: "llm",
    matchedRules: [],
  },
});

/** A YES example of a `subject` the user accepted, with `overrides`. */
export const labeledExample = (
  id: string,
  subject: string,
  overrides: Partial<LabeledExample> = {},
): LabeledExample => ({
  input: { id, receivedAt: 0, fields: { subject } },
  label: true,
  decidedBy: "suggestion-accepted",
  reasoning: "",
  confidence: 0.9,
  labeledAt: 0,
  wasCorrection: false,
  isInteresting: false,
  ...overrides,
});

/** The input IDs of a list of examples or pending classifications, sorted. */
export const sortedIds = (
  items: readonly { input: { id: string } }[],
): string => items.map((item) => item.input.id).sort().join();

/** Whether the view shows an element whose whole text is `text`. */
export const shows = (root: unknown, text: string): boolean =>
  findNode(root, (node) => hasExactText(node, text)) !== undefined;

/** Whether the view's text holds every one of `texts`, read in one walk. */
export const showsAll = (root: unknown, texts: readonly string[]): boolean => {
  const text = textContent(root);
  return texts.every((expected) => text.includes(expected));
};

/** Whether the view's text holds none of `texts`, read in one walk. */
export const showsNone = (root: unknown, texts: readonly string[]): boolean => {
  const text = textContent(root);
  return !texts.some((expected) => text.includes(expected));
};

/** The value of the input showing `placeholder`, or `undefined` when the view
 * has no such input. */
export const inputValue = (root: unknown, placeholder: string): unknown => {
  const input = findNodeByProp(root, "placeholder", placeholder);
  return input === undefined ? undefined : propValue(input, "value");
};

/** The text of the statistics row: each count followed by its label. */
export const statsText = (root: unknown): string =>
  textContent(findElementByText(root, "cf-hstack", "Examples"));
