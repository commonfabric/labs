/**
 * The payoff of the pool: an inductor offers the pool's released rules for
 * its goal as a candidate set, judged on its own held-out items by the same
 * gate as a rewrite, and adopted or dismissed the same way. A better set is
 * adopted, without a released rule that none of the held-out items
 * exercises, and is not published back as the person's own; a worse one is
 * dismissed, and neither is offered again; a pool for another goal offers
 * nothing.
 *
 * Patterns under test: ./lofi-inductor.tsx, reading a pool's release. The
 * pool here is a stand-in that releases a given set; a real pool's release
 * takes several contributors (../pool/inductor-pool-multi-user
 * .test.tsx).
 */
import {
  action,
  assert,
  type Default,
  handler,
  NAME,
  pattern,
  type Stream,
  TESTS,
  UI,
  type VNode,
} from "commonfabric";
import { hasText } from "../../../tools/test-support/vnode-helpers.ts";
import {
  HELD_OUT_ITEMS,
  HIFI_MOCKS,
  INVOICE_ONLY,
  TRAINING_ITEMS,
} from "./lofi-inductor-test-fixture.ts";
import LofiInductor, {
  type PoolRule,
  type PoolSubmission,
} from "./lofi-inductor.tsx";

const GOAL = "Is this email a bill?";

export const llmMocks = HIFI_MOCKS;

const ignore = handler<PoolSubmission, Record<string, never>>(() => {});
const ignoreWithdraw = handler<void, Record<string, never>>(() => {});

interface StandInInput {
  goal: Default<string, "">;
  consensus: Default<PoolRule[], []>;
}

interface StandInOutput {
  [NAME]: string;
  [UI]: VNode;
  goal: string;
  consensus: PoolRule[];
  submit: Stream<PoolSubmission>;
  withdraw: Stream<void>;
}

/**
 * A pool that releases the set it is given and ignores submissions and
 * withdrawals.
 */
const StandInPool = pattern<StandInInput, StandInOutput>(
  ({ goal, consensus }) => ({
    [NAME]: "Stand-in pool",
    [UI]: <div />,
    goal,
    consensus,
    submit: ignore({}),
    withdraw: ignoreWithdraw({}),
  }),
);

const BETTER = {
  field: "subject",
  pattern: "invoice|\\bbill\\b",
  predicts: true,
};
const WORSE = { field: "subject", pattern: "lunch", predicts: true };
/** A NO exception no held-out item exercises, riding along with BETTER. */
const PLANTED = {
  field: "from",
  pattern: "billing@bank\\.example",
  predicts: false,
};

const ITEMS = [...HELD_OUT_ITEMS, ...TRAINING_ITEMS];

const inductor = (pool: StandInOutput) =>
  LofiInductor({
    goal: GOAL,
    items: [],
    rules: INVOICE_ONLY,
    history: [],
    published: null,
    // No rewrite here: only the pool's rules are proposed.
    rewriteAfter: 100,
    heldOutPercent: 30,
    pool,
  });

export default pattern(() => {
  const goodPool = StandInPool(
    {
      goal: ` ${GOAL.toLowerCase()}`,
      consensus: [BETTER, PLANTED],
    } as Parameters<
      typeof StandInPool
    >[0],
  );
  const badPool = StandInPool(
    { goal: GOAL, consensus: [WORSE] } as Parameters<typeof StandInPool>[0],
  );
  const otherPool = StandInPool(
    { goal: "Is this email a newsletter?", consensus: [BETTER] } as Parameters<
      typeof StandInPool
    >[0],
  );
  const adopter = inductor(goodPool);
  const dismisser = inductor(badPool);
  const elsewhere = inductor(otherPool);

  const action_submit_items = action(() => {
    ITEMS.forEach((item) => adopter.addItem.send(item));
    ITEMS.forEach((item) => dismisser.addItem.send(item));
    ITEMS.forEach((item) => elsewhere.addItem.send(item));
  });
  const action_settle = action(() => {
    adopter.settlePoolOffer.send();
    dismisser.settlePoolOffer.send();
    elsewhere.settlePoolOffer.send();
  });
  // Sent from an action rather than named as the step's stream: a step's
  // `adopter.publish` compiles to a computed that holds the stream, and with
  // server execution off nothing reads that computed before the send, so the
  // send would find no handler.
  const action_publish = action(() => adopter.publish.send());

  // Judged on the inductor's own held-out items, before anything changes.
  const assert_offered = assert(() =>
    adopter.poolOffer?.judgement.accepted === true &&
    adopter.poolOffer?.judgement.proposedF1 === 1 &&
    dismisser.poolOffer?.judgement.accepted === false &&
    elsewhere.poolOffer === null &&
    adopter.rules[0]?.pattern === "invoice" && adopter.history.length === 0
  );
  // The planted rule is left out of the offer, and the view says so
  const assert_planted_left_out = assert(() =>
    adopter.poolOffer?.judgement.rules.length === 1 &&
    adopter.poolOffer?.unexercised.length === 1 &&
    adopter.poolOffer?.unexercised[0]?.field === "from"
  );
  const assert_view_offers = assert(() =>
    hasText(adopter[UI], "Adopt the pool's rules (F1 67% → 100%)") &&
    hasText(adopter[UI], "left out, no held-out item matches it: from:") &&
    hasText(dismisser[UI], "Dismiss the pool's rules")
  );

  const assert_adopted = assert(() =>
    adopter.rules.length === 1 &&
    adopter.rules[0]?.pattern === "\\bbill\\b|invoice" &&
    adopter.history.length === 1 && adopter.history[0]?.accepted === true &&
    typeof adopter.history[0]?.poolOffer === "string" &&
    adopter.poolOffer === null
  );
  // A rule adopted from the pool is not this person's learning, so
  // publishing leaves it out rather than counting them for it.
  const assert_adopted_not_published = assert(() =>
    adopter.adopted.length === 1 &&
    adopter.adopted[0] === adopter.rules[0]?.key &&
    adopter.published?.rules.length === 0 &&
    adopter.published?.adopted === 1 &&
    adopter.published?.pooled === false
  );
  const assert_dismissed = assert(() =>
    dismisser.rules[0]?.pattern === "invoice" &&
    dismisser.history.length === 1 &&
    dismisser.history[0]?.accepted === false &&
    dismisser.poolOffer === null
  );
  const assert_elsewhere_untouched = assert(() =>
    elsewhere.history.length === 0 && elsewhere.rules[0]?.pattern === "invoice"
  );

  return {
    [TESTS]: [
      { action: action_submit_items },
      { settle: true },
      { assertion: assert_offered },
      { assertion: assert_planted_left_out },
      { render: adopter[UI] },
      { render: dismisser[UI] },
      { assertion: assert_view_offers },
      { action: action_settle },
      { assertion: assert_adopted },
      { action: action_publish },
      { assertion: assert_adopted_not_published },
      { assertion: assert_dismissed },
      { assertion: assert_elsewhere_untouched },
    ],
    adopter,
    dismisser,
    elsewhere,
  };
});
