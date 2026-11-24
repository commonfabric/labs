/**
 * One contributor's view of the pool: a rule set below threshold is stored
 * but nothing is released, a resubmission replaces the set, under a new
 * pseudonym too, an out-of-grammar rule is refused, and withdrawing takes the
 * contribution out.
 *
 * A probe publishes the unthresholded tally, a function of the pool's module
 * that no rule names, into public scalar stores. A handler that types the
 * store with its ceiling is refused, and a literal lands beside it. A handler
 * that types the same store plainly lets the tally in (top/3219).
 *
 * Pattern under test: ./inductor-pool.tsx. Release itself takes five
 * contributors, so it, and the other refusal probes, are in
 * ./inductor-pool-multi-user.test.tsx and ./inductor-pool-replay.test.tsx.
 */
import {
  assert,
  type Default,
  handler,
  NAME,
  pattern,
  type Stream,
  TESTS,
  UI,
  type VNode,
  type Writable,
} from "commonfabric";
import {
  BILL,
  INVOICE,
  LUNCH,
  type PublicText,
  publishLiteral,
  publishPatterns,
  UNTOUCHED,
} from "./inductor-pool-test-fixture.ts";
import InductorPool, { type ReleasedRule } from "./inductor-pool.tsx";
import { type StoredContribution, tallyEveryRule } from "./pool-policy.tsx";

/**
 * `publishPatterns` with the destination typed without its ceiling. The
 * runtime checks a store's ceiling only against the writing handler's own
 * type for it (top/3219), so this lets a confidential value in.
 */
const publishPatternsPlain = handler<
  void,
  { from: ReleasedRule[]; to: Writable<string> }
>((_, { from, to }) => {
  to.set((from ?? []).map((rule) => rule?.pattern ?? "").join(","));
});

type Text = Writable<Default<PublicText, typeof UNTOUCHED>>;

interface ProbeInput {
  contributions: StoredContribution[];
  // Public stores with no write binding, so only their ceiling can refuse.
  tallied: Text;
  talliedPlain: Text;
  literal: Text;
}

interface ProbeOutput {
  [NAME]: string;
  [UI]: VNode;
  tally: ReleasedRule[];
  tallied: PublicText;
  talliedPlain: PublicText;
  literal: PublicText;
  publishTallied: Stream<void>;
  publishTalliedPlain: Stream<void>;
  publishLiteral: Stream<void>;
}

/** Tries to move the unthresholded tally into public stores. */
const LeakProbe = pattern<ProbeInput, ProbeOutput>(
  ({ contributions, tallied, talliedPlain, literal }) => {
    const tally = tallyEveryRule(contributions);
    return {
      [NAME]: "Leak probe",
      [UI]: <div />,
      tally,
      tallied,
      talliedPlain,
      literal,
      publishTallied: publishPatterns({ from: tally, to: tallied }),
      publishTalliedPlain: publishPatternsPlain({
        from: tally,
        to: talliedPlain,
      }),
      publishLiteral: publishLiteral({ to: literal }),
    };
  },
);

export default pattern(() => {
  const pool = InductorPool(
    {
      goal: "Is this email a bill?",
      thresholdCenter: 5,
      jitter: 0,
    } as Parameters<typeof InductorPool>[0],
  );
  const probe = LeakProbe(
    {
      contributions: pool.contributions,
    } as Parameters<typeof LeakProbe>[0],
  );
  return {
    [TESTS]: [
      { assertion: assert(() => pool.releasedCount === 0) },
      {
        action: pool.submit,
        event: { pseudonym: "me-for-bills", rules: [INVOICE, BILL, INVOICE] },
      },
      {
        assertion: assert(() =>
          pool.contributions.length === 1 &&
          pool.contributions[0]?.pseudonym === "me-for-bills" &&
          pool.contributions[0]?.rules.length === 2
        ),
      },
      // One contributor is below every threshold: the pool's public result
      // is empty.
      {
        assertion: assert(() =>
          pool.consensus.length === 0 && pool.releasedCount === 0
        ),
      },

      // A resubmission replaces the set rather than adding to it.
      {
        action: pool.submit,
        event: { pseudonym: "me-for-bills", rules: [LUNCH] },
      },
      {
        assertion: assert(() =>
          pool.contributions.length === 1 &&
          pool.contributions[0]?.rules.length === 1 &&
          pool.contributions[0]?.rules[0]?.pattern === "lunch"
        ),
      },

      // A new pseudonym from the same contributor replaces their entry: the
      // principal is the binding, so they are still counted once.
      {
        action: pool.submit,
        event: { pseudonym: "me-again", rules: [LUNCH] },
      },
      {
        assertion: assert(() =>
          pool.contributions.length === 1 &&
          pool.contributions[0]?.pseudonym === "me-again" &&
          pool.contributions[0]?.rules[0]?.pattern === "lunch"
        ),
      },
      // A rule out of grammar refuses the whole set.
      {
        action: pool.submit,
        event: {
          pseudonym: "me-again",
          rules: [{ ...INVOICE, pattern: "(a)\\1" }],
        },
      },
      {
        assertion: assert(() =>
          pool.contributions.length === 1 &&
          pool.contributions[0]?.pseudonym === "me-again" &&
          pool.contributions[0]?.rules[0]?.pattern === "lunch"
        ),
      },

      // The unthresholded tally is computed and holds the private rule...
      {
        assertion: assert(() =>
          probe.tally.length === 1 && probe.tally[0]?.pattern === "lunch" &&
          probe.tally[0]?.count === 1
        ),
      },
      // ...a literal lands in a public store beside it...
      { action: probe.publishLiteral },
      { assertion: assert(() => probe.literal === "literal") },
      // ...but no rule names the tally's function, so a store whose ceiling
      // the writing handler repeats refuses it.
      { action: probe.publishTallied },
      { assertion: assert(() => probe.tallied === UNTOUCHED) },
      // top/3219: a handler that types the same kind of store without the
      // ceiling writes the tally in. This asserts the leak as it stands, so
      // the fix shows up here: flip this assertion when the runtime enforces
      // the store's own ceiling.
      { action: probe.publishTalliedPlain },
      { assertion: assert(() => probe.talliedPlain === "lunch") },
      {
        assertion: assert(() =>
          pool.consensus.length === 0 && pool.releasedCount === 0
        ),
      },
      // Withdrawing takes the contributor's entry out.
      { action: pool.withdraw },
      { assertion: assert(() => pool.contributions.length === 0) },
    ],
    // The refused publish logs the CFC refusal; the refusal is the point.
    allowConsoleWarnings: true,
    // The out-of-grammar submission throws.
    expectRuntimeErrors: ["Refused a rule"],
    pool,
    probe,
  };
});
