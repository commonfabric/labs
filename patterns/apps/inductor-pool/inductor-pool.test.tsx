/**
 * One contributor's view of the pool: a rule set below threshold is stored
 * but nothing is released, a resubmission replaces the set, a second
 * pseudonym and an out-of-grammar rule are refused, and the public store
 * refuses both a computation the policy does not name and a raw contribution.
 *
 * Pattern under test: ./inductor-pool.tsx. Release itself takes two
 * contributors, so it is in ./inductor-pool-multi-user.test.tsx.
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
  Writable,
} from "commonfabric";
import {
  BILL,
  INVOICE,
  LUNCH,
  type OpenPublic,
  type Untouched,
} from "./inductor-pool-test-fixture.ts";
import InductorPool, {
  publishRelease,
  type ReleasedRule,
  type StoredContribution,
  tallyEveryRule,
} from "./inductor-pool.tsx";

/** Copies the first contribution's rules, as if released, into `to`. */
const publishRawContribution = handler<
  void,
  { contributions: StoredContribution[]; to: Writable<ReleasedRule[]> }
>((_, { contributions, to }) => {
  to.set(
    (contributions[0]?.rules ?? []).map((rule) => ({ ...rule, count: 1 })),
  );
});

interface ProbeInput {
  contributions: StoredContribution[];
  // Public stores with no write binding, so only their label can refuse.
  leakedTally: Writable<Default<OpenPublic, Untouched>>;
  leakedRaw: Writable<Default<OpenPublic, Untouched>>;
}

interface ProbeOutput {
  [NAME]: string;
  [UI]: VNode;
  tally: ReleasedRule[];
  leakedTally: OpenPublic;
  leakedRaw: OpenPublic;
  publishTally: Stream<void>;
  publishRaw: Stream<void>;
}

/**
 * Tries to move contributions into public stores two ways: through a function
 * of the pool's module that no rule names, and copied out raw.
 */
const LeakProbe = pattern<ProbeInput, ProbeOutput>(
  ({ contributions, leakedTally, leakedRaw }) => {
    const tally = tallyEveryRule(contributions);
    return {
      [NAME]: "Leak probe",
      [UI]: <div />,
      tally,
      leakedTally,
      leakedRaw,
      publishTally: publishRelease({ from: tally, to: leakedTally }),
      publishRaw: publishRawContribution({ contributions, to: leakedRaw }),
    };
  },
);

export default pattern(() => {
  const pool = InductorPool(
    {
      goal: "Is this email a bill?",
      thresholdCenter: 2,
      jitter: 0,
    } as Parameters<typeof InductorPool>[0],
  );
  const probe = LeakProbe(
    {
      contributions: pool.contributions,
    } as Parameters<typeof LeakProbe>[0],
  );
  // The pool's own release, pointed at the unthresholded tally.
  const publishTallyToPool = publishRelease({
    from: probe.tally,
    to: pool.released,
  });

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
      // One contributor is below every threshold: nothing is released.
      { assertion: assert(() => pool.releasedCount === 0) },
      { assertion: assert(() => pool.released.length === 0) },

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

      // A second pseudonym for the same contributor is refused.
      {
        action: pool.submit,
        event: { pseudonym: "me-again", rules: [INVOICE] },
      },
      // So is a rule out of grammar.
      {
        action: pool.submit,
        event: {
          pseudonym: "me-for-bills",
          rules: [{ ...INVOICE, pattern: "(a)\\1" }],
        },
      },
      {
        assertion: assert(() =>
          pool.contributions.length === 1 &&
          pool.contributions[0]?.pseudonym === "me-for-bills" &&
          pool.contributions[0]?.rules[0]?.pattern === "lunch"
        ),
      },

      // The unthresholded tally is computed and holds the private rule...
      {
        assertion: assert(() =>
          probe.tally.length === 1 && probe.tally[0]?.count === 1
        ),
      },
      // ...but no rule names its function, so a public store refuses it,
      { action: probe.publishTally },
      {
        assertion: assert(() =>
          probe.leakedTally.length === 1 &&
          probe.leakedTally[0]?.key === "untouched"
        ),
      },
      // and so does the pool's own public store (on today's runtime this
      // store refuses any array of objects once a contribution exists, so
      // the probe store above is the sharper check; README.md, "CFC snags"),
      { action: publishTallyToPool },
      { assertion: assert(() => pool.released.length === 0) },
      // and a public store refuses a contribution copied out raw.
      { action: probe.publishRaw },
      {
        assertion: assert(() =>
          probe.leakedRaw.length === 1 &&
          probe.leakedRaw[0]?.key === "untouched"
        ),
      },
      { assertion: assert(() => pool.releasedCount === 0) },
    ],
    // Each refused publish logs the CFC refusal; the refusals are the point.
    allowConsoleWarnings: true,
    expectRuntimeErrors: [
      "under another pseudonym",
      "Refused a rule",
    ],
    pool,
    probe,
  };
});
