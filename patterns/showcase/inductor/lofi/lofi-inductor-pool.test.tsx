/**
 * Publishing reaches a pool only when the pool is for the inductor's goal:
 * the matching pool stores one contribution under the pseudonym the first
 * publish mints, and replaces it when the inductor republishes, and a pool for another
 * goal receives nothing. The goal matches ignoring case and space, the view
 * says the rules were sent, a rule with an @ or a six-digit run is held back,
 * an inductor with no rules sends nothing, and a publish after the rules are
 * reset withdraws the earlier contribution.
 *
 * Patterns under test: ./lofi-inductor.tsx publishing into
 * ../pool/inductor-pool.tsx. Release across contributors is in
 * ./lofi-inductor-pool-multi-user.test.tsx.
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findElementByExactText,
  hasText,
  propValue,
} from "../../../tools/test-support/vnode-helpers.ts";
import InductorPool from "../pool/main.tsx";
import { INVOICE_ONLY, rule } from "./lofi-inductor-test-fixture.ts";
import LofiInductor from "./main.tsx";

const GOAL = "Is this email a bill?";
const OTHER_GOAL = "Is this email a newsletter?";

/** Whether the button labelled `label` in `view` is disabled. */
const disabled = (view: unknown, label: string): unknown =>
  propValue(findElementByExactText(view, "cf-button", label), "disabled");

export default pattern(() => {
  const billPool = InductorPool(
    {
      goal: GOAL,
      thresholdCenter: 5,
      jitter: 0,
    } as Parameters<typeof InductorPool>[0],
  );
  const newsletterPool = InductorPool(
    {
      goal: OTHER_GOAL,
      thresholdCenter: 5,
      jitter: 0,
    } as Parameters<typeof InductorPool>[0],
  );
  // The goal matches the pool's, but for case and space.
  const matching = LofiInductor({
    goal: `  ${GOAL.toUpperCase().replace(" ", "   ")} `,
    items: [],
    rules: INVOICE_ONLY,
    history: [],
    published: null,
    pool: billPool,
  });
  const mismatched = LofiInductor({
    goal: GOAL,
    items: [],
    rules: INVOICE_ONLY,
    history: [],
    published: null,
    pool: newsletterPool,
  });

  // Rules that look like they name someone stay in the piece.
  const personalPool = InductorPool(
    {
      goal: GOAL,
      thresholdCenter: 5,
      jitter: 0,
    } as Parameters<typeof InductorPool>[0],
  );
  const personal = LofiInductor({
    goal: GOAL,
    items: [],
    rules: [
      ...INVOICE_ONLY,
      rule("from", "billing@example\\.org"),
      rule("subject", "account 1234567"),
    ],
    history: [],
    published: null,
    pool: personalPool,
  });

  const removeInvoice = action(() => {
    const invoice = personal.rules[0];
    if (invoice) personal.removeRule.send({ rule: invoice });
  });

  // With no rules, there is nothing to publish.
  const empty = LofiInductor({
    goal: GOAL,
    items: [],
    rules: [],
    history: [],
    published: null,
    pool: billPool,
  });

  return {
    [TESTS]: [
      { assertion: assert(() => billPool.contributions.length === 0) },
      // Connected to a pool for its goal, with a rule to send, the inductor
      // can publish; with nothing published, it cannot unpublish. One with no
      // rules, or with a pool for another goal, cannot publish. Nothing has
      // been published yet (`published` is null), and the view says so.
      { render: matching[UI] },
      { render: empty[UI] },
      { render: mismatched[UI] },
      {
        assertion: assert(() =>
          hasText(matching[UI], "Not published yet.") &&
          hasText(empty[UI], "No rules to publish yet.") &&
          hasText(matching[UI], "A pool for this question is connected.") &&
          disabled(matching[UI], "Publish rules") === false &&
          disabled(matching[UI], "Unpublish") === true &&
          disabled(empty[UI], "Publish rules") === true &&
          hasText(mismatched[UI], "No pool for this question is connected") &&
          disabled(mismatched[UI], "Publish rules") === true
        ),
      },
      { action: matching.publish },
      // One contribution, under a pseudonym the publish minted, holding its
      // rules. One contributor is below threshold, so nothing is public.
      {
        assertion: assert(() =>
          matching.published?.pooled === true &&
          /^p-[0-9a-z]+$/.test(matching.pseudonym) &&
          billPool.contributions.length === 1 &&
          /^p-[0-9a-z]+$/.test(billPool.contributions[0]?.pseudonym ?? "") &&
          billPool.contributions[0]?.rules.length === 1 &&
          billPool.contributions[0]?.rules[0]?.pattern === "invoice" &&
          billPool.consensus.length === 0
        ),
      },
      // The view says the rules were sent: whether the pool took them is not
      // something the piece can see.
      { render: matching[UI] },
      {
        assertion: assert(() =>
          hasText(matching[UI], "Sent 1 rules to the pool for") &&
          disabled(matching[UI], "Unpublish") === false
        ),
      },
      // Republishing replaces the contribution, under the pseudonym the
      // piece kept. (A first publish runs twice under server execution, and
      // the run that did not commit can send a pseudonym of its own; the
      // pool binds the principal, so it replaces rather than adds either way.)
      { action: matching.publish },
      {
        assertion: assert(() =>
          billPool.contributions.length === 1 &&
          billPool.contributions[0]?.pseudonym === matching.pseudonym
        ),
      },

      // A pool for another goal receives nothing. The publish still mints
      // the inductor's pseudonym, for when a pool for its goal appears.
      { assertion: assert(() => mismatched.pseudonym === "") },
      { action: mismatched.publish },
      {
        assertion: assert(() =>
          mismatched.published?.goal === GOAL &&
          mismatched.published?.pooled === false &&
          /^p-[0-9a-z]+$/.test(mismatched.pseudonym) &&
          newsletterPool.contributions.length === 0 &&
          billPool.contributions.length === 1
        ),
      },

      // Only the rule with no @ and no six-digit run reaches the pool.
      { action: personal.publish },
      {
        assertion: assert(() =>
          personal.published?.pooled === true &&
          personal.published?.withheld === 2 &&
          personal.published?.rules.length === 1 &&
          personalPool.contributions.length === 1 &&
          personalPool.contributions[0]?.rules.length === 1 &&
          personalPool.contributions[0]?.rules[0]?.pattern === "invoice"
        ),
      },

      // With only personal rules left, a publish sends nothing, and takes back
      // what the earlier publish sent.
      { action: removeInvoice },
      { action: personal.publish },
      {
        assertion: assert(() =>
          personal.published?.pooled === false &&
          personal.published?.rules.length === 0 &&
          personal.published?.withheld === 2 &&
          personalPool.contributions.length === 0
        ),
      },

      // An inductor with no rules sends nothing, and mints nothing: the
      // publish only records that nothing was sent.
      { action: empty.publish },
      {
        assertion: assert(() =>
          empty.published?.pooled === false &&
          empty.published?.rules.length === 0 &&
          empty.pseudonym === "" &&
          billPool.contributions.length === 1
        ),
      },

      // Publishing after the rules are reset takes back what the earlier
      // publish sent, rather than leaving it in the pool.
      { action: matching.resetRules },
      { action: matching.publish },
      {
        assertion: assert(() =>
          matching.published?.pooled === false &&
          matching.published?.rules.length === 0 &&
          /^p-[0-9a-z]+$/.test(matching.pseudonym) &&
          billPool.contributions.length === 0
        ),
      },
    ],
    billPool,
    newsletterPool,
    empty,
    personal,
    personalPool,
    matching,
    mismatched,
  };
});
