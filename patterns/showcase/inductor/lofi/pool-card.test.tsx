/**
 * The pool card on its own: it lists what became of each rule the pool
 * offered, says what the last publish did when no pool took it, and its
 * three buttons each send their own verb and no other.
 *
 * Pattern under test: ./pool-card.tsx.
 */
import {
  action,
  assert,
  handler,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  findNode,
  fireClick,
  hasText,
  isElement,
} from "../../../tools/test-support/vnode-helpers.ts";
import type { CanonicalRule } from "../shared/rule-grammar.ts";
import type { PoolOffer, Published } from "./induction.ts";
import PoolCard from "./pool-card.tsx";

const GOAL = "Is this email a bill?";

const INVOICE: CanonicalRule = {
  field: "subject",
  pattern: "invoice",
  predicts: true,
  key: "invoice",
};
const LUNCH: CanonicalRule = {
  field: "subject",
  pattern: "lunch",
  predicts: false,
  key: "lunch",
};

const OFFER: PoolOffer = {
  key: "offer",
  judgement: {
    accepted: true,
    reason: "F1 rises",
    rules: [INVOICE],
    refusals: ["pattern is too costly"],
    currentF1: 0.5,
    proposedF1: 0.8,
    heldOut: 6,
  },
  unexercised: [LUNCH],
};

const published = (rules: CanonicalRule[], pooled: boolean): Published => ({
  goal: GOAL,
  rules,
  publishedAt: 0,
  pooled,
  withheld: 2,
});

const count = handler<void, { sent: Writable<number> }>((_, { sent }) => {
  sent.set(sent.get() + 1);
});

export default pattern(() => {
  const settled = new Writable(0);
  const publishes = new Writable(0);
  const unpublishes = new Writable(0);
  const verbs = {
    settlePoolOffer: count({ sent: settled }),
    publish: count({ sent: publishes }),
    unpublish: count({ sent: unpublishes }),
  };

  const offered = PoolCard({
    offer: OFFER,
    published: null,
    rules: [INVOICE],
    sendable: 1,
    connected: true,
    ...verbs,
  });
  const sentNothing = PoolCard({
    offer: null,
    published: published([], false),
    rules: [INVOICE],
    ...verbs,
  });
  const foundNoPool = PoolCard({
    offer: null,
    published: published([INVOICE], false),
    rules: [INVOICE],
    ...verbs,
  });
  const pooled = PoolCard({
    offer: null,
    published: published([INVOICE], true),
    rules: [INVOICE],
    connected: true,
    ...verbs,
  });

  // Each released rule is listed with what became of it.
  const assert_offer_lines = assert(() =>
    hasText(offered[UI], "offered: subject: /invoice/i → YES") &&
    hasText(offered[UI], "refused: pattern is too costly") &&
    hasText(
      offered[UI],
      "left out, no held-out item matches it: subject: /lunch/i → NO",
    ) &&
    !hasText(sentNothing[UI], "refused:")
  );

  // A publish no pool took says whether anything was sent at all.
  const assert_sent_nothing = assert(() =>
    hasText(
      sentNothing[UI],
      "Nothing was sent. Held back 2 that look personal",
    ) &&
    !hasText(sentNothing[UI], `No pool for “${GOAL}”`) &&
    hasText(
      foundNoPool[UI],
      `No pool for “${GOAL}” found; nothing was sent. Held back 2`,
    ) &&
    !hasText(foundNoPool[UI], "Nothing was sent.") &&
    !hasText(pooled[UI], "nothing was sent")
  );

  const assert_nothing_sent_yet = assert(() =>
    settled.get() === 0 && publishes.get() === 0 &&
    unpublishes.get() === 0
  );

  const action_settle = action(() => {
    fireClick(
      findNode(
        offered[UI],
        (node) =>
          isElement(node, "cf-button") &&
          hasText(node, "Adopt the pool's rules (F1 50% → 80%)"),
      ),
      "the adopt button",
    );
  });
  const assert_settled = assert(() =>
    settled.get() === 1 && publishes.get() === 0 &&
    unpublishes.get() === 0
  );

  const action_publish = action(() => {
    clickButton(offered[UI], "Publish rules");
  });
  const assert_published = assert(() =>
    settled.get() === 1 && publishes.get() === 1 &&
    unpublishes.get() === 0
  );

  const action_unpublish = action(() => {
    clickButton(pooled[UI], "Unpublish");
  });
  const assert_unpublished = assert(() =>
    settled.get() === 1 && publishes.get() === 1 &&
    unpublishes.get() === 1
  );

  return {
    [TESTS]: [
      { assertion: assert_offer_lines },
      { assertion: assert_sent_nothing },
      { assertion: assert_nothing_sent_yet },
      { action: action_settle },
      { assertion: assert_settled },
      { action: action_publish },
      { assertion: assert_published },
      { action: action_unpublish },
      { assertion: assert_unpublished },
    ],
  };
});
