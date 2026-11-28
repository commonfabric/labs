/**
 * The lo-fi inductor's verbs, as an agent drives them: `addItems` adds a
 * batch and skips ids already held; `removeItem` takes out the item it is
 * handed, by reference, and no other, even after the list has moved (for
 * an item added through `addItem`; see below for one seeded inline);
 * `removeRule` takes out one rule and its adopted mark; `resetRules` empties
 * the set and keeps the history; the setters write their setting; each verb
 * refuses malformed input by throwing rather than doing nothing; and the
 * header's goal box sets a new goal when filled and nothing when blank.
 *
 * Pattern under test: ./lofi-inductor.tsx
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  findNodeByProp,
  propValue,
  setBound,
  typeInto,
} from "../../../tools/test-support/vnode-helpers.ts";
import { HIFI_MOCKS, rule } from "./lofi-inductor-test-fixture.ts";
import LofiInductor, { type Item } from "./lofi-inductor.tsx";

const GOAL = "Is this email a bill?";
const LUNCH_GOAL = "Is this email about lunch?";
const GOAL_BOX = "A new yes-or-no question, such as “Is this email a bill?”";

/** What the goal box in the header of `view` holds. */
const goalBox = (view: unknown): unknown =>
  propValue(findNodeByProp(view, "placeholder", GOAL_BOX), "$value");

export const llmMocks = HIFI_MOCKS;

/** The message each refused event throws, one per refusal below. */
const REFUSALS = [
  "An item needs at least one field.",
  // The event's schema drops a field that is not a string before the action
  // sees it, so an item whose only field is a number has none.
  "An item needs at least one field.",
  // The schema turns an event that is not an item, here a bare string and
  // an object without `fields`, into nothing.
  "An item is an object with `fields`.",
  "An item is an object with `fields`.",
  "`items` is a list of items.",
  "`item` is an item read from `items`.",
  "`rule` is a rule read from `rules`.",
  "`goal` is a yes-or-no question, not blank.",
  "`count` is a whole number, at least 1.",
  "`percent` is a number above 0 and below 100.",
  '`model` is a model name, or "" for the default.',
];

export default pattern(() => {
  const INVOICE = rule("subject", "invoice");
  const BILL = rule("subject", "\\bbill\\b");
  const LUNCH = rule("subject", "lunch", false);
  const subject = LofiInductor({
    goal: GOAL,
    items: [],
    rules: [INVOICE, BILL, LUNCH],
    history: [{
      round: 1,
      accepted: true,
      reason: "it scored better",
      proposed: [INVOICE],
      refusals: [],
      currentF1: 0,
      proposedF1: 1,
      heldOut: 5,
      answered: [],
      decidedAt: 0,
    }],
    published: null,
    adopted: [BILL.key, LUNCH.key],
    // No rewrite here: the verbs are under test, not the gate.
    rewriteAfter: 100,
    heldOutPercent: 30,
  });
  const held = new Writable<Item | null>(null);

  // Items seeded with the piece are stored inline, not as links; removing
  // one by reference works the same.
  const seeded = LofiInductor({
    goal: GOAL,
    items: [
      { id: "mail-12", fields: { subject: "Lunch?" } },
      { id: "mail-6", fields: { subject: "Invoice 42" } },
      { id: "mail-7", fields: { subject: "Your bill is ready" } },
    ],
    rules: [],
  });

  const action_add_batch = action(() => {
    subject.addItems.send({
      items: [
        { id: "mail-1", fields: { subject: "Bill for March" } },
        { id: "mail-3", fields: { subject: "Weekend plans" } },
        // Repeated within the batch: added once.
        { id: "mail-1", fields: { subject: "Bill for April" } },
        { fields: { subject: "Lunch?" } },
      ],
    });
  });
  const assert_batch_added = assert(() =>
    subject.items.length === 3 && subject.items[0]?.id === "mail-1" &&
    subject.items[0]?.fields.subject === "Bill for March" &&
    subject.items[1]?.id === "mail-3" &&
    /^item-[0-9a-z]+$/.test(subject.items[2]?.id ?? "")
  );

  // An id the list holds adds nothing; a new one is appended.
  const action_add_repeat = action(() => {
    subject.addItems.send({
      items: [
        { id: "mail-3", fields: { subject: "Something else" } },
        { id: "mail-2", fields: { subject: "Electricity bill" } },
      ],
    });
  });
  const assert_repeat_skipped = assert(() =>
    subject.items.length === 4 &&
    subject.items[1]?.fields.subject === "Weekend plans" &&
    subject.items[3]?.id === "mail-2"
  );

  // Held before the list moves: removing the first item shifts this one
  // down, and the reference still finds it.
  const action_stash = action(() => {
    const item = subject.items[2];
    if (item) held.set(item);
  });
  const action_remove_first = action(() => {
    const item = subject.items[0];
    if (item) subject.removeItem.send({ item });
  });
  const assert_first_removed = assert(() =>
    subject.items.length === 3 && subject.items[0]?.id === "mail-3" &&
    subject.rows.length === 3 && held.get()?.fields.subject === "Lunch?"
  );
  const action_remove_held = action(() => {
    const item = held.get();
    if (item) subject.removeItem.send({ item });
  });
  const assert_held_removed = assert(() =>
    subject.items.length === 2 && subject.items[0]?.id === "mail-3" &&
    subject.items[1]?.id === "mail-2"
  );
  // Sent again, the reference matches nothing the list holds.
  const assert_held_removed_once = assert_held_removed;

  // Held before the first is removed, so the list has moved by the time it
  // is sent. An inline element has no document of its own: the reference
  // names its slot, which after the move holds nothing, so the send removes
  // nothing, and in particular not the item that moved into another slot.
  // (README.md, "Known runtime issues".)
  const heldSeeded = new Writable<Item | null>(null);
  const action_remove_seeded = action(() => {
    const later = seeded.items[2];
    if (later) heldSeeded.set(later);
    const item = seeded.items[0];
    if (item) seeded.removeItem.send({ item });
  });
  const assert_seeded_removed = assert(() =>
    seeded.items.length === 2 && seeded.items[0]?.id === "mail-6" &&
    seeded.items[1]?.id === "mail-7"
  );
  const action_remove_held_seeded = action(() => {
    const item = heldSeeded.get();
    if (item) seeded.removeItem.send({ item });
  });
  const assert_held_seeded_kept = assert(() =>
    seeded.items.length === 2 && seeded.items[0]?.id === "mail-6" &&
    seeded.items[1]?.id === "mail-7"
  );

  const action_remove_bill_rule = action(() => {
    const target = subject.rules[1];
    if (target) subject.removeRule.send({ rule: target });
  });
  const assert_rule_removed = assert(() =>
    subject.rules.length === 2 && subject.rules[0]?.key === INVOICE.key &&
    subject.rules[1]?.key === LUNCH.key && subject.adopted.length === 1 &&
    subject.adopted[0] === LUNCH.key
  );

  const action_reset_rules = action(() => {
    subject.resetRules.send();
  });
  const assert_rules_reset = assert(() =>
    subject.rules.length === 0 && subject.adopted.length === 0 &&
    subject.items.length === 2 && subject.history.length === 1
  );

  const action_settings = action(() => {
    subject.setRewriteAfter.send({ count: 5 });
    subject.setHeldOutPercent.send({ percent: 50 });
    subject.setHifiModel.send({ model: "  gateway:stronger-model " });
  });
  const assert_settings = assert(() =>
    subject.rewriteAfter === 5 && subject.heldOutPercent === 50 &&
    subject.hifiModel === "gateway:stronger-model"
  );
  // The settings card: a filled draft is applied, a blank one is left alone,
  // and its button returns to the default model.
  const action_fill_settings = action(() => {
    setBound(
      findNodeByProp(subject[UI], "placeholder", "5"),
      "$value",
      "4",
      "the rewrite-after box",
    );
  });
  const assert_settings_applied = assert(() =>
    subject.rewriteAfter === 4 && subject.heldOutPercent === 50 &&
    subject.hifiModel === "gateway:stronger-model"
  );
  // A model typed but not applied is dropped by "Use the default model", so
  // a later Apply does not bring it back.
  const action_type_model = action(() => {
    setBound(
      findNodeByProp(subject[UI], "placeholder", "gateway:stronger-model"),
      "$value",
      "gateway:typed-model",
      "the model box",
    );
  });
  const assert_default_model = assert(() => subject.hifiModel === "");

  // Every refusal leaves what it would have changed as it was.
  const assert_unchanged_by_refusals = assert(() =>
    subject.items.length === 2 && subject.goal === GOAL &&
    subject.rewriteAfter === 4 && subject.heldOutPercent === 50 &&
    subject.hifiModel === ""
  );

  // The schema drops an id that is not a string, so the item is added under
  // a minted id rather than refused.
  const assert_numbered_added = assert(() =>
    seeded.items.length === 3 &&
    seeded.items[2]?.fields.subject === "Weekend plans" &&
    /^item-[0-9a-z]+$/.test(seeded.items[2]?.id ?? "")
  );

  // A blank goal box sets nothing; a filled one sets the new goal, which
  // clears what belonged to the old one, and empties the box.
  const asking = LofiInductor({
    goal: GOAL,
    items: [],
    rules: [INVOICE],
    history: [{
      round: 1,
      accepted: true,
      reason: "it scored better",
      proposed: [INVOICE],
      refusals: [],
      currentF1: 0,
      proposedF1: 1,
      heldOut: 5,
      answered: [],
      decidedAt: 0,
    }],
  });
  const action_type_blank_goal = action(() => {
    typeInto(asking[UI], GOAL_BOX, "   ");
  });
  const assert_goal_unchanged = assert(() =>
    asking.goal === GOAL && asking.rules.length === 1 &&
    asking.history.length === 1
  );
  const action_type_goal = action(() => {
    typeInto(asking[UI], GOAL_BOX, `  ${LUNCH_GOAL} `);
  });
  const assert_goal_set = assert(() =>
    asking.goal === LUNCH_GOAL && asking.rules.length === 0 &&
    asking.history.length === 0 && goalBox(asking[UI]) === ""
  );

  return {
    [TESTS]: [
      { action: action_add_batch },
      { assertion: assert_batch_added },
      { action: action_add_repeat },
      { assertion: assert_repeat_skipped },
      { action: action_stash },
      { action: action_remove_first },
      { assertion: assert_first_removed },
      { action: action_remove_held },
      { assertion: assert_held_removed },
      { action: action_remove_held },
      { assertion: assert_held_removed_once },
      { action: action_remove_seeded },
      { assertion: assert_seeded_removed },
      { action: action_remove_held_seeded },
      { assertion: assert_held_seeded_kept },
      { action: action_remove_bill_rule },
      { assertion: assert_rule_removed },
      { action: action_reset_rules },
      { assertion: assert_rules_reset },
      { action: action_settings },
      { assertion: assert_settings },
      { render: subject[UI] },
      { action: action_fill_settings },
      { press: subject[UI], control: "Apply" },
      { assertion: assert_settings_applied },
      { action: action_type_model },
      { press: subject[UI], control: "Use the default model" },
      { assertion: assert_default_model },
      { press: subject[UI], control: "Apply" },
      { assertion: assert_default_model },
      // The refusals, in the order of `REFUSALS`.
      { action: subject.addItem, event: { id: "mail-9", fields: {} } },
      {
        action: subject.addItem,
        event: { fields: { subject: 42 } },
      },
      { action: subject.addItem, event: "mail-9" },
      { action: subject.addItem, event: { id: "mail-9" } },
      { action: subject.addItems, event: { items: "mail-9" } },
      { action: subject.removeItem, event: {} },
      { action: subject.removeRule, event: {} },
      { action: subject.setGoal, event: { goal: "   " } },
      { action: subject.setRewriteAfter, event: { count: 0 } },
      { action: subject.setHeldOutPercent, event: { percent: 100 } },
      { action: subject.setHifiModel, event: { model: 7 } },
      { assertion: assert_unchanged_by_refusals },
      {
        action: seeded.addItem,
        event: { id: 9, fields: { subject: "Weekend plans" } },
      },
      { assertion: assert_numbered_added },
      { render: asking[UI] },
      { action: action_type_blank_goal },
      { press: asking[UI], control: "Set goal" },
      { assertion: assert_goal_unchanged },
      { action: action_type_goal },
      { press: asking[UI], control: "Set goal" },
      { assertion: assert_goal_set },
    ],
    expectRuntimeErrors: REFUSALS,
    subject,
    seeded,
    asking,
  };
});
