/**
 * Items, rules, and model answers shared by the lo-fi inductor's pattern
 * tests. The hi-fi model is mocked to call an email a bill exactly when its
 * subject is one; the current rules know only "invoice", so a bill without
 * that word surprises them.
 */

import { type CanonicalRule, checkRule } from "../shared/rule-grammar.ts";

/** A rule in canonical form; throws on a rule outside the grammar. */
export function rule(
  field: string,
  pattern: string,
  predicts = true,
): CanonicalRule {
  const check = checkRule({ field, pattern, predicts });
  if (!check.ok) throw new Error(check.reason);
  return check.rule;
}

/** The rule set every test starts from. */
export const INVOICE_ONLY = [rule("subject", "invoice")];

/** What the hi-fi model says about each subject, and why. */
const HIFI_ANSWERS: Array<[string, boolean]> = [
  ["Invoice 42", true],
  ["Your bill is ready", true],
  ["Lunch?", false],
  ["Billing team offsite", false],
  ["Bill for March", true],
  ["Electricity bill", true],
  ["Weekend plans", false],
  ["Team lunch Friday", false],
];

/** One answer per subject, wherever and however often it is asked. */
export const HIFI_MOCKS = HIFI_ANSWERS.map(([subject, label]) => ({
  when: {
    systemContains: "careful labeller",
    lastMessageContains: `"subject": "${subject}"`,
  },
  object: { label, reasoning: label ? "It asks for payment." : "No bill." },
  repeat: true,
}));

/**
 * Items whose ids split 30% held out (pinned by `induction.test.ts`):
 * mail-6, mail-7, mail-12, mail-13, and mail-17 are held out, the rest
 * train. Five is the fewest a proposal is scored on (`MIN_HELD_OUT`).
 */
export const HELD_OUT_ITEMS = [
  { id: "mail-6", fields: { subject: "Invoice 42" } },
  { id: "mail-7", fields: { subject: "Your bill is ready" } },
  { id: "mail-12", fields: { subject: "Lunch?" } },
  { id: "mail-13", fields: { subject: "Billing team offsite" } },
  { id: "mail-17", fields: { subject: "Team lunch Friday" } },
];

/** Training items, two of them bills the current rules miss. */
export const TRAINING_ITEMS = [
  { id: "mail-1", fields: { subject: "Bill for March" } },
  { id: "mail-2", fields: { subject: "Electricity bill" } },
  { id: "mail-3", fields: { subject: "Weekend plans" } },
];

/** A rewrite answer, for the goal `goal` only. */
export function rewriteMock(
  goal: string,
  rules: Array<{ field: string; pattern: string; predicts: boolean }>,
) {
  return {
    when: {
      systemContains: "You write lo-fi rules",
      lastMessageContains: `Question: ${goal}\n`,
    },
    object: { rules, reasoning: "Bills say bill or invoice." },
    repeat: true,
  };
}
