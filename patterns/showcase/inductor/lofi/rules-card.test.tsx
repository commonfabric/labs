/**
 * The rules card's buttons, pressed as a person presses them: "Remove" sends
 * the rule in its own row and no other, "Clear rules" empties the set, a
 * failed rewrite says why and offers "Try again", and a ready one offers the
 * button that records it instead. Each press reaches only its own stream.
 *
 * Pattern under test: ./rules-card.tsx
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import { hasText } from "../../../tools/test-support/vnode-helpers.ts";
import { rule } from "./lofi-inductor-test-fixture.ts";
import type { RewriteStatus, Summary } from "./induction.ts";
import RulesCard, { type RuleRef } from "./rules-card.tsx";

const SUMMARY: Summary = {
  items: 8,
  labelled: 8,
  agreements: 6,
  surprises: 2,
  agreementRate: 0.75,
  heldOut: 5,
};

/** How often each of the card's streams has been sent, and what removal got. */
interface Pressed {
  resets: number;
  retries: number;
  settles: number;
  removed: string[];
}

function matches(actual: Pressed, expected: Pressed): boolean {
  return actual.resets === expected.resets &&
    actual.retries === expected.retries &&
    actual.settles === expected.settles &&
    actual.removed.join(",") === expected.removed.join(",");
}

export default pattern(() => {
  const INVOICE = rule("subject", "invoice");
  const LUNCH = rule("subject", "lunch", false);

  const pressed = new Writable<Pressed>({
    resets: 0,
    retries: 0,
    settles: 0,
    removed: [],
  });
  const rewrite = new Writable<RewriteStatus>({
    status: "failed",
    reason: "the model timed out",
  });

  const card = RulesCard({
    rules: [INVOICE, LUNCH],
    heldOutF1: 0.5,
    summary: SUMMARY,
    rewrite,
    settleRewrite: action(() => {
      const now = pressed.get();
      pressed.set({ ...now, settles: now.settles + 1 });
    }),
    retryRewrite: action(() => {
      const now = pressed.get();
      pressed.set({ ...now, retries: now.retries + 1 });
    }),
    removeRule: action((event: RuleRef) => {
      const now = pressed.get();
      pressed.set({ ...now, removed: [...now.removed, event.rule.key] });
    }),
    resetRules: action(() => {
      const now = pressed.get();
      pressed.set({ ...now, resets: now.resets + 1 });
    }),
  });

  const assert_failed_shown = assert(() =>
    hasText(
      card[UI],
      "Proposing failed (the model timed out); nothing was recorded.",
    ) &&
    hasText(card[UI], "Try again") &&
    !hasText(card[UI], "Apply new rules") &&
    matches(pressed.get(), { resets: 0, retries: 0, settles: 0, removed: [] })
  );
  const assert_retried = assert(() =>
    matches(pressed.get(), { resets: 0, retries: 1, settles: 0, removed: [] })
  );
  const assert_lunch_removed = assert(() =>
    matches(pressed.get(), {
      resets: 0,
      retries: 1,
      settles: 0,
      removed: [LUNCH.key],
    })
  );
  const assert_reset = assert(() =>
    matches(pressed.get(), {
      resets: 1,
      retries: 1,
      settles: 0,
      removed: [LUNCH.key],
    })
  );

  const action_ready = action(() =>
    rewrite.set({
      status: "ready",
      judgement: {
        accepted: true,
        reason: "it scored better",
        rules: [INVOICE],
        refusals: [],
        currentF1: 0.5,
        proposedF1: 1,
        heldOut: 5,
      },
      answered: [],
    })
  );
  const assert_ready_shown = assert(() =>
    hasText(card[UI], "Proposed: it scored better.") &&
    hasText(card[UI], "Apply new rules (F1 50% → 100%)") &&
    !hasText(card[UI], "Try again") && !hasText(card[UI], "Proposing failed")
  );
  const assert_settled = assert(() =>
    matches(pressed.get(), {
      resets: 1,
      retries: 1,
      settles: 1,
      removed: [LUNCH.key],
    })
  );

  return {
    [TESTS]: [
      { assertion: assert_failed_shown },
      { press: card[UI], control: "Try again" },
      { assertion: assert_retried },
      { press: card[UI], control: "Remove", within: "subject: /lunch/i → NO" },
      { assertion: assert_lunch_removed },
      { press: card[UI], control: "Clear rules" },
      { assertion: assert_reset },
      { action: action_ready },
      { assertion: assert_ready_shown },
      { press: card[UI], control: "Apply new rules (F1 50% → 100%)" },
      { assertion: assert_settled },
    ],
    card,
  };
});
