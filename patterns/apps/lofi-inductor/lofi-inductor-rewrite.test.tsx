/**
 * The lo-fi inductor's rewrite gate. Four inductors see the same items and
 * the same surprises; each gets a different proposal. Only the one that is in
 * grammar, safe, and strictly better on the held-out items replaces the
 * current rules. A worse set, a set with one unsafe rule, and a set with one
 * rule outside the grammar are each recorded as rejected and change nothing.
 * Judging is derived: nothing changes until `settleRewrite` records it.
 *
 * Pattern under test: ./lofi-inductor.tsx
 */
import { action, assert, pattern, TESTS } from "commonfabric";
import {
  HELD_OUT_ITEMS,
  HIFI_MOCKS,
  INVOICE_ONLY,
  rewriteMock,
  TRAINING_ITEMS,
} from "./lofi-inductor-test-fixture.ts";
import LofiInductor from "./lofi-inductor.tsx";

const BETTER = "Is this email a bill?";
const WORSE = "Is this email a bill? (worse)";
const UNSAFE = "Is this email a bill? (unsafe)";
const OUT_OF_GRAMMAR = "Is this email a bill? (out of grammar)";

const GOOD_RULE = {
  field: "subject",
  pattern: "Invoice|\\bBill\\b",
  predicts: true,
};

export const llmMocks = [
  ...HIFI_MOCKS,
  rewriteMock(BETTER, [GOOD_RULE]),
  rewriteMock(WORSE, [{ field: "subject", pattern: "lunch", predicts: true }]),
  rewriteMock(UNSAFE, [GOOD_RULE, {
    field: "subject",
    pattern: "(bill|bills)+",
    predicts: true,
  }]),
  rewriteMock(OUT_OF_GRAMMAR, [GOOD_RULE, {
    field: "subject",
    pattern: "(?<=re: )bill",
    predicts: true,
  }]),
];

const ITEMS = [...HELD_OUT_ITEMS, ...TRAINING_ITEMS];

const inductor = (goal: string) =>
  LofiInductor({
    goal,
    items: [],
    rules: INVOICE_ONLY,
    history: [],
    published: null,
    rewriteAfter: 2,
    heldOutPercent: 30,
  });

export default pattern(() => {
  const better = inductor(BETTER);
  const worse = inductor(WORSE);
  const unsafe = inductor(UNSAFE);
  const outOfGrammar = inductor(OUT_OF_GRAMMAR);

  // Straight-line, one statement per inductor: a test's action is pattern
  // code, which keeps loops out of callbacks
  const action_submit_items = action(() => {
    ITEMS.forEach((item) => better.submitItem.send(item));
    ITEMS.forEach((item) => worse.submitItem.send(item));
    ITEMS.forEach((item) => unsafe.submitItem.send(item));
    ITEMS.forEach((item) => outOfGrammar.submitItem.send(item));
  });
  const action_settle = action(() => {
    better.settleRewrite.send();
    worse.settleRewrite.send();
    unsafe.settleRewrite.send();
    outOfGrammar.settleRewrite.send();
  });

  // "Your bill is ready", "Bill for March", and "Electricity bill" are bills
  // the invoice-only rules miss: three new surprises, past the two a rewrite
  // waits for
  const assert_surprised = assert(() =>
    better.summary.labelled === 7 && better.summary.surprises === 3 &&
    better.rewrite.status === "ready"
  );

  // Judged, but nothing recorded yet: a computed does not write
  const assert_judged_not_recorded = assert(() =>
    better.rewrite.status === "ready" &&
    better.rewrite.judgement.accepted === true &&
    better.rules.length === 1 && better.rules[0]?.pattern === "invoice" &&
    better.history.length === 0
  );

  const assert_better_accepted = assert(() =>
    better.history.length === 1 && better.history[0]?.accepted === true &&
    better.history[0]?.proposedF1 === 1 &&
    better.history[0]?.currentF1 < 1 &&
    better.rules.length === 1 &&
    better.rules[0]?.pattern === "\\bbill\\b|invoice"
  );

  // The new rules agree with every label, and the surprises they answered
  // do not start another round
  const assert_better_settled = assert(() =>
    better.summary.surprises === 0 && better.summary.agreementRate === 1 &&
    better.heldOutF1 === 1 && better.rewrite.status === "idle"
  );

  const assert_worse_rejected = assert(() =>
    worse.history.length === 1 && worse.history[0]?.accepted === false &&
    worse.history[0]?.proposedF1 < worse.history[0]?.currentF1 &&
    worse.rules.length === 1 && worse.rules[0]?.pattern === "invoice" &&
    worse.summary.surprises === 3
  );

  const assert_unsafe_rejected = assert(() =>
    unsafe.history.length === 1 && unsafe.history[0]?.accepted === false &&
    unsafe.history[0]?.refusals.length === 1 &&
    unsafe.history[0]?.refusals[0]?.includes("backtrack") === true &&
    unsafe.rules.length === 1 && unsafe.rules[0]?.pattern === "invoice"
  );

  const assert_out_of_grammar_rejected = assert(() =>
    outOfGrammar.history.length === 1 &&
    outOfGrammar.history[0]?.accepted === false &&
    outOfGrammar.history[0]?.refusals[0] ===
      "rule 2: lookaround is not allowed" &&
    outOfGrammar.rules.length === 1 &&
    outOfGrammar.rules[0]?.pattern === "invoice"
  );

  // A rejected round answered its surprises too: no new round until more
  // surprises arrive
  const assert_rejected_rounds_idle = assert(() =>
    worse.rewrite.status === "idle" && unsafe.rewrite.status === "idle" &&
    outOfGrammar.rewrite.status === "idle"
  );

  return {
    [TESTS]: [
      { action: action_submit_items },
      // The hi-fi calls, then the rewrite calls they open, have landed
      { settle: true },
      { assertion: assert_surprised },
      { assertion: assert_judged_not_recorded },
      { action: action_settle },
      { assertion: assert_better_accepted },
      { assertion: assert_better_settled },
      { assertion: assert_worse_rejected },
      { assertion: assert_unsafe_rejected },
      { assertion: assert_out_of_grammar_rejected },
      { assertion: assert_rejected_rounds_idle },
    ],
  };
});
