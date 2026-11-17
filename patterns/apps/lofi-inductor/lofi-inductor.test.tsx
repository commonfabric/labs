/**
 * The lo-fi inductor watching the hi-fi model: an item both label alike is no
 * surprise, an item they label differently is one, a rewrite waits for enough
 * new surprises, `submitItem` ignores a repeated id and an item without
 * fields, and publishing records the current rules for the goal.
 *
 * Pattern under test: ./lofi-inductor.tsx
 */
import { action, assert, FS, pattern, TESTS } from "commonfabric";
import {
  HIFI_MOCKS,
  INVOICE_ONLY,
  rewriteMock,
} from "./lofi-inductor-test-fixture.ts";
import LofiInductor from "./lofi-inductor.tsx";

const GOAL = "Is this email a bill?";

// No rewrite should be asked for here; this answer would be refused if it
// were, and an unasked-for request would show up as rules changing.
export const llmMocks = [
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
    subject.submitItem.send({
      id: "mail-6",
      fields: { subject: "Invoice 42" },
    });
    subject.submitItem.send({ id: "mail-12", fields: { subject: "Lunch?" } });
  });
  const action_submit_disagreeing = action(() => {
    subject.submitItem.send({
      id: "mail-1",
      fields: { subject: "Bill for March" },
    });
  });
  const action_submit_repeat_and_empty = action(() => {
    subject.submitItem.send({
      id: "mail-1",
      fields: { subject: "Something else" },
    });
    subject.submitItem.send({ id: "mail-99", fields: {} });
  });
  const action_publish = action(() => subject.publish.send());

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

  const assert_repeat_and_empty_ignored = assert(() =>
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
    subject.published?.rules[0]?.key === subject.rules[0]?.key
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
      { action: action_submit_repeat_and_empty },
      { assertion: assert_repeat_and_empty_ignored },
      { assertion: assert_rules_unchanged },
      { action: action_publish },
      { assertion: assert_published },
      { assertion: assert_text_projection },
    ],
    subject,
  };
});
