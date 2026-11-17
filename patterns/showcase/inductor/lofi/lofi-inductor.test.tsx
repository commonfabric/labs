/**
 * The lo-fi inductor watching the hi-fi model: an item both label alike is no
 * surprise, an item they label differently is one, a rewrite waits for enough
 * new surprises, `addItem` ignores a repeated id and an item without
 * fields, publishing records the current rules for the goal, with no pool to
 * send them to, setting a new goal clears what belonged to the old one, and
 * removing an item takes it out by id.
 *
 * Pattern under test: ./lofi-inductor.tsx
 */
import { action, assert, FS, pattern, TESTS, UI } from "commonfabric";
import {
  HIFI_MOCKS,
  INVOICE_ONLY,
  rewriteMock,
} from "./lofi-inductor-test-fixture.ts";
import LofiInductor from "./lofi-inductor.tsx";

const GOAL = "Is this email a bill?";
const LUNCH_GOAL = "Is this email about lunch?";

/** The hi-fi model's answer about `subject` for the lunch question. */
const lunchMock = (subject: string, label: boolean) => ({
  when: {
    systemContains: "careful labeller",
    lastMessageContains: `${LUNCH_GOAL}\n\nItem:\n{\n  "subject": "${subject}"`,
  },
  object: { label, reasoning: label ? "About lunch." : "Not lunch." },
  repeat: true,
});

// No rewrite should be asked for here; this answer would be refused if it
// were, and an unasked-for request would show up as rules changing. The
// lunch question's answers come first, so they win over the bill answers.
export const llmMocks = [
  lunchMock("Invoice 42", false),
  lunchMock("Lunch?", true),
  lunchMock("Bill for March", false),
  ...HIFI_MOCKS,
  rewriteMock(GOAL, [{ field: "subject", pattern: "lunch", predicts: true }]),
];

export default pattern(() => {
  const subject = LofiInductor({
    goal: GOAL,
    items: [],
    rules: INVOICE_ONLY,
    history: [],
    published: null,
    rewriteAfter: 2,
    heldOutPercent: 30,
  });

  const action_submit_agreeing = action(() => {
    subject.addItem.send({
      id: "mail-6",
      fields: { subject: "Invoice 42" },
    });
    subject.addItem.send({ id: "mail-12", fields: { subject: "Lunch?" } });
  });
  const action_submit_disagreeing = action(() => {
    subject.addItem.send({
      id: "mail-1",
      fields: { subject: "Bill for March" },
    });
  });
  const action_submit_repeat = action(() => {
    subject.addItem.send({
      id: "mail-1",
      fields: { subject: "Something else" },
    });
  });

  const assert_starts_empty = assert(() =>
    subject.summary.items === 0 && subject.summary.agreementRate === null &&
    subject.rewrite.status === "idle"
  );

  // Both labels agree on both items: no surprise
  const assert_agreement_is_no_surprise = assert(() =>
    subject.summary.labelled === 2 && subject.summary.surprises === 0 &&
    subject.summary.agreementRate === 1 &&
    subject.rows[0]?.hifi === true && subject.rows[0]?.lofi === true &&
    subject.rows[1]?.hifi === false && subject.rows[1]?.lofi === false
  );

  // The model says bill, the rules (invoice only) say no: one surprise, which
  // is fewer than the two a rewrite waits for
  const assert_disagreement_is_a_surprise = assert(() =>
    subject.summary.surprises === 1 && subject.rows[2]?.id === "mail-1" &&
    subject.rows[2]?.surprise === true && subject.rows[2]?.hifi === true &&
    subject.rows[2]?.lofi === false && subject.rewrite.status === "idle"
  );

  const assert_repeat_ignored = assert(() =>
    subject.items.length === 3 &&
    subject.items[2]?.fields.subject === "Bill for March"
  );

  const assert_rules_unchanged = assert(() =>
    subject.rules.length === 1 && subject.rules[0]?.pattern === "invoice" &&
    subject.history.length === 0
  );

  const assert_published = assert(() =>
    subject.published?.goal === GOAL &&
    subject.published?.rules.length === 1 &&
    subject.published?.rules[0]?.key === subject.rules[0]?.key &&
    // No pool is given or found, so nothing left the piece.
    subject.published?.pooled === false
  );

  // A new question clears what belonged to the old one and keeps the items,
  // which the hi-fi model labels for the new question.
  const assert_goal_reset = assert(() =>
    subject.goal === LUNCH_GOAL && subject.rules.length === 0 &&
    subject.history.length === 0 && subject.published === null &&
    subject.pseudonym === "" && subject.items.length === 3 &&
    subject.rows[0]?.hifi === false && subject.rows[1]?.hifi === true &&
    subject.rows[2]?.hifi === false
  );

  // The same question again, but for case and space, changes nothing.
  const action_set_same_goal = action(() => {
    subject.setGoal.send({ goal: `  ${LUNCH_GOAL.toUpperCase()} ` });
  });
  const action_set_lunch_goal = action(() => {
    subject.setGoal.send({ goal: LUNCH_GOAL });
  });
  const assert_goal_kept = assert(() =>
    subject.goal === LUNCH_GOAL && subject.items.length === 3
  );

  const assert_text_projection = assert(() =>
    subject[FS].type === "text/markdown" &&
    subject[FS].frontmatter.title === `Lo-fi inductor: ${GOAL}` &&
    subject[FS].content.includes("- `subject: /invoice/i → YES`") &&
    subject[FS].content.includes("3 items, 3 labelled by the hi-fi model")
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_empty },
      { action: action_submit_agreeing },
      // The hi-fi calls the new items start have landed
      { settle: true },
      { assertion: assert_agreement_is_no_surprise },
      { action: action_submit_disagreeing },
      { settle: true },
      { assertion: assert_disagreement_is_a_surprise },
      // The view renders over items, rules, and an empty history
      { render: subject[UI] },
      { action: action_submit_repeat },
      { assertion: assert_repeat_ignored },
      { assertion: assert_rules_unchanged },
      { press: subject[UI], control: "Publish rules" },
      { assertion: assert_published },
      { assertion: assert_text_projection },
      { action: action_set_lunch_goal },
      { settle: true },
      { assertion: assert_goal_reset },
      { action: action_set_same_goal },
      { assertion: assert_goal_kept },
    ],
    subject,
  };
});
