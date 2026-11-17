/**
 * The lo-fi inductor's rewrite gate. Four inductors see the same items and
 * the same surprises; each gets a different proposal. Only the one that is in
 * grammar, safe, and strictly better on the held-out items replaces the
 * current rules. A worse set, a set with one unsafe rule, and a set with one
 * rule outside the grammar are each recorded as rejected and change nothing.
 * Judging is derived: nothing changes until `settleRewrite` records it, and
 * the view says what recording does before it is done. A failed model call
 * records nothing and is retried.
 *
 * Pattern under test: ./lofi-inductor.tsx
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import { hasText } from "../../../tools/test-support/vnode-helpers.ts";
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
const FLAKY = "Is this email a bill? (flaky)";

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
  // The first call fails; the retry, which says it is one, succeeds.
  {
    when: {
      systemContains: "You write lo-fi rules",
      lastMessageContains: `Question: ${FLAKY}\n`,
    },
    error: "the model is down",
  },
  {
    when: {
      systemContains: "You write lo-fi rules",
      messagesContain: [`Question: ${FLAKY}\n`, "(Attempt 2.)"],
    },
    object: { rules: [GOOD_RULE], reasoning: "Bills say bill or invoice." },
    repeat: true,
  },
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
  const flaky = inductor(FLAKY);

  // Straight-line, one statement per inductor: a test's action is pattern
  // code, which keeps loops out of callbacks
  const action_submit_items = action(() => {
    ITEMS.forEach((item) => better.addItem.send(item));
    ITEMS.forEach((item) => worse.addItem.send(item));
    ITEMS.forEach((item) => unsafe.addItem.send(item));
    ITEMS.forEach((item) => outOfGrammar.addItem.send(item));
    ITEMS.forEach((item) => flaky.addItem.send(item));
  });
  const action_settle_better = action(() => better.settleRewrite.send());
  const action_settle_worse = action(() => worse.settleRewrite.send());
  const action_settle_unsafe = action(() => unsafe.settleRewrite.send());
  const action_settle_out_of_grammar = action(() =>
    outOfGrammar.settleRewrite.send()
  );

  // "Your bill is ready", "Bill for March", and "Electricity bill" are bills
  // the invoice-only rules miss: three new surprises, past the two a rewrite
  // waits for. Every inductor that is later settled is read here, because an
  // assertion is what asks for its model calls: without server execution, a
  // piece nothing reads makes no calls, and its `settleRewrite` would find
  // nothing ready.
  const assert_surprised = assert(() =>
    [better, worse, unsafe, outOfGrammar].every((piece) =>
      piece.summary.labelled === 8 && piece.summary.surprises === 3 &&
      piece.rewrite.status === "ready"
    )
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

  // Before recording, the view shows each proposal and says what recording
  // it does: apply an accepted set, with the F1 it brings, or dismiss one.
  const assert_view_offers_proposal = assert(() =>
    hasText(better[UI], "subject: /\\bbill\\b|invoice/i → YES") &&
    hasText(better[UI], "Apply new rules (F1 67% → 100%)") &&
    hasText(worse[UI], "Dismiss rejected proposal")
  );

  // A failed call is not a rejection: nothing is recorded, and the surprises
  // stay new for the retry.
  const assert_flaky_failed = assert(() =>
    flaky.rewrite.status === "failed" && flaky.history.length === 0 &&
    flaky.rules[0]?.pattern === "invoice"
  );
  const action_settle_flaky = action(() => {
    flaky.settleRewrite.send();
  });
  const action_retry_flaky = action(() => {
    flaky.retryRewrite.send();
  });
  const assert_flaky_retried = assert(() =>
    flaky.rewrite.status === "ready" &&
    flaky.rewrite.judgement.accepted === true && flaky.history.length === 0
  );
  // The round answers the two surprises its request was frozen on, which
  // is `rewriteAfter`, not every surprise there is.
  const assert_flaky_accepted = assert(() =>
    flaky.history.length === 1 && flaky.history[0]?.accepted === true &&
    flaky.history[0]?.answered.length === 2 &&
    flaky.rules[0]?.pattern === "\\bbill\\b|invoice"
  );

  const assert_view_shows_refusal = assert(() =>
    hasText(unsafe[UI], "Round 1: rejected") &&
    hasText(unsafe[UI], "could backtrack exponentially")
  );

  return {
    [TESTS]: [
      { action: action_submit_items },
      // The hi-fi calls, then the rewrite calls they open, have landed
      { settle: true },
      { assertion: assert_surprised },
      { assertion: assert_judged_not_recorded },
      { render: better[UI] },
      { render: worse[UI] },
      { assertion: assert_view_offers_proposal },
      { assertion: assert_flaky_failed },
      { action: action_settle_flaky },
      { assertion: assert_flaky_failed },
      { action: action_retry_flaky },
      { settle: true },
      { assertion: assert_flaky_retried },
      { action: action_settle_flaky },
      { assertion: assert_flaky_accepted },
      { action: action_settle_better },
      { action: action_settle_worse },
      { action: action_settle_unsafe },
      { action: action_settle_out_of_grammar },
      { assertion: assert_better_accepted },
      { assertion: assert_better_settled },
      { assertion: assert_worse_rejected },
      { assertion: assert_unsafe_rejected },
      { assertion: assert_out_of_grammar_rejected },
      { assertion: assert_rejected_rounds_idle },
      // The view lists the rejected round with the rule that sank it
      { render: unsafe[UI] },
      { assertion: assert_view_shows_refusal },
    ],
    // The flaky inductor's first rewrite call fails on purpose, and the model
    // client warns about it when it runs in this process.
    allowConsoleWarnings: true,
  };
});
