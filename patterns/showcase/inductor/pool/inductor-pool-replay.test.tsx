/**
 * The released function run over inputs other code chose is not released.
 * A probe copies the pool's contributions, repeats each under made-up
 * contributors and pseudonyms, seals the copies with a secret of its own, and
 * hands them to `releaseConsensus`. The function computes the victim's rule
 * as released, but the policy's input witness sees contributions
 * `submitContribution` did not write, so a public store refuses the result.
 *
 * Links do no better. A list of links to the pool's own entries, one entry
 * linked five times, releases nothing: a contributor counts once. A list
 * holding a link to the victim's real entry beside forged copies of it,
 * enough to pass any threshold the pool's seal allows, is refused by a public
 * store, as the forgery alone is.
 *
 * Nor does replaying one principal's old entries. A contributor who submits
 * under five pseudonyms in turn, then withdraws, leaves five entries that
 * `submitContribution` wrote; handed links to all five, the release counts
 * them as one contributor, because it counts the principal the handler
 * stamped, not the pseudonym.
 *
 * And `submitContribution`, bound by other code to a list of its own with a
 * threshold of one, refuses to seal it: the floor is the module's
 * (`MIN_SEALED_THRESHOLD`), not the binding's.
 *
 * Each refusal writes a scalar through a handler that types its public store
 * with the ceiling, and a literal lands in a store of the same shape beside
 * it (inductor-pool-test-fixture.ts). The genuine release does not land in
 * such a store today (top/3226; ./inductor-pool-multi-user.test.tsx), so
 * these refusals alone do not show that the witness tells forged inputs from
 * honest ones. That they come from the witness is checked by dropping it
 * from the exchange rule, which lets both forgeries through.
 *
 * Pattern under test: ./inductor-pool.tsx.
 */
import {
  assert,
  computed,
  type Default,
  handler,
  linksOf,
  NAME,
  pattern,
  type Stream,
  TESTS,
  UI,
  type VNode,
  type Writable,
} from "commonfabric";
import { MIN_SEALED_THRESHOLD } from "./consensus.ts";
import {
  INVOICE,
  type PublicText,
  publishLiteral,
  publishPatterns,
  UNTOUCHED,
} from "./inductor-pool-test-fixture.ts";
import InductorPool, { type Contribution, type ReleasedRule } from "./main.tsx";
import {
  type ContributionEvent,
  releaseConsensus,
  type StoredContribution,
  submitContribution,
  tallyEveryRule,
} from "./pool-policy.tsx";

type Text = Writable<Default<PublicText, typeof UNTOUCHED>>;

interface ProbeInput {
  contributions: StoredContribution[];
  // Public stores with no write binding, so only their ceiling can refuse.
  leaked: Text;
  literal: Text;
}

interface ProbeOutput {
  [NAME]: string;
  [UI]: VNode;
  released: ReleasedRule[];
  leaked: PublicText;
  literal: PublicText;
  publish: Stream<void>;
  publishLiteral: Stream<void>;
}

const ReplayProbe = pattern<ProbeInput, ProbeOutput>(
  ({ contributions, leaked, literal }) => {
    // Each contribution as many times as the lowest threshold a seal may
    // have, under made-up contributors and pseudonyms, sealed with that
    // threshold and the probe's own secret.
    const forged = computed((): Contribution[] =>
      (contributions ?? []).flatMap((contribution) =>
        Array.from(
          { length: MIN_SEALED_THRESHOLD },
          (_, i) => ({
            contributor: `${contribution.contributor}-${i}`,
            pseudonym: `${contribution.pseudonym}-${i}`,
            rules: (contribution.rules ?? []).map((rule) => ({ ...rule })),
            seal: {
              secret: "chosen",
              thresholdCenter: MIN_SEALED_THRESHOLD,
              jitter: 0,
            },
          }),
        )
      )
    );
    const released = releaseConsensus(forged);
    return {
      [NAME]: "Replay probe",
      [UI]: <div />,
      released,
      leaked,
      literal,
      publish: publishPatterns({ from: released, to: leaked }),
      publishLiteral: publishLiteral({ to: literal }),
    };
  },
);

/** The first contribution, linked `MIN_SEALED_THRESHOLD` times. */
const linkRepeated = handler<
  void,
  {
    contributions: Writable<StoredContribution[]>;
    to: Writable<Contribution[]>;
  }
>((_, { contributions, to }) => {
  const [first] = linksOf(contributions) ?? [];
  if (first === undefined) return;
  to.set(
    Array.from(
      { length: MIN_SEALED_THRESHOLD },
      (): Contribution | typeof first => first,
    ) as Contribution[],
  );
});

/**
 * A link to the first contribution, beside forged copies of it under new
 * contributors and pseudonyms, carrying its seal: together, as many as its
 * seal's highest threshold, so the function releases its rules whatever
 * their offsets.
 */
const linkBesideForgeries = handler<
  void,
  {
    contributions: Writable<StoredContribution[]>;
    to: Writable<Contribution[]>;
  }
>((_, { contributions, to }) => {
  const [first] = linksOf(contributions) ?? [];
  const victim = contributions.get()[0];
  if (first === undefined || victim === undefined) return;
  const forgeries = Array.from(
    { length: victim.seal.thresholdCenter + victim.seal.jitter - 1 },
    (_, i) => ({
      contributor: `${victim.contributor}-${i}`,
      pseudonym: `${victim.pseudonym}-${i}`,
      rules: (victim.rules ?? []).map((rule) => ({ ...rule })),
      seal: { ...victim.seal },
    }),
  );
  to.set([first, ...forgeries] as Contribution[]);
});

interface LinkProbeInput {
  contributions: Writable<StoredContribution[]>;
  repeated: Writable<Default<Contribution[], []>>;
  mixed: Writable<Default<Contribution[], []>>;
  leakedMixed: Text;
}

interface LinkProbeOutput {
  [NAME]: string;
  [UI]: VNode;
  releasedRepeated: ReleasedRule[];
  releasedMixed: ReleasedRule[];
  leakedMixed: PublicText;
  buildRepeated: Stream<void>;
  buildMixed: Stream<void>;
  publishMixed: Stream<void>;
}

/** Hands `releaseConsensus` lists of links to the pool's real entries. */
const LinkProbe = pattern<LinkProbeInput, LinkProbeOutput>(
  ({ contributions, repeated, mixed, leakedMixed }) => {
    const releasedMixed = releaseConsensus(mixed);
    return {
      [NAME]: "Link probe",
      [UI]: <div />,
      releasedRepeated: releaseConsensus(repeated),
      releasedMixed,
      leakedMixed,
      buildRepeated: linkRepeated({ contributions, to: repeated }),
      buildMixed: linkBesideForgeries({ contributions, to: mixed }),
      publishMixed: publishPatterns({ from: releasedMixed, to: leakedMixed }),
    };
  },
);

/** Appends a link to the last stored contribution to `to`. */
const hoardLast = handler<
  void,
  {
    contributions: Writable<StoredContribution[]>;
    to: Writable<Contribution[]>;
  }
>((_, { contributions, to }) => {
  const stored = linksOf(contributions) ?? [];
  const last = stored[stored.length - 1];
  if (last === undefined) return;
  const kept = linksOf(to) ?? [];
  const next: (Contribution | (typeof kept)[number] | typeof last)[] = [
    ...kept,
    last,
  ];
  to.set(next as Contribution[]);
});

interface HoardInput {
  contributions: Writable<StoredContribution[]>;
  hoard: Writable<Default<Contribution[], []>>;
}

interface HoardOutput {
  [NAME]: string;
  [UI]: VNode;
  hoard: Contribution[];
  tallied: ReleasedRule[];
  released: ReleasedRule[];
  keep: Stream<void>;
}

/**
 * Keeps a link to each entry a contributor stores, through every
 * replacement and their withdrawal, and hands the old entries to the
 * released function and to the unthresholded tally.
 */
const HoardProbe = pattern<HoardInput, HoardOutput>(
  ({ contributions, hoard }) => ({
    [NAME]: "Hoard probe",
    [UI]: <div />,
    hoard,
    tallied: tallyEveryRule(hoard),
    released: releaseConsensus(hoard),
    keep: hoardLast({ contributions, to: hoard }),
  }),
);

interface OwnListInput {
  contributions: Writable<Default<StoredContribution[], []>>;
}

interface OwnListOutput {
  [NAME]: string;
  [UI]: VNode;
  contributions: StoredContribution[];
  released: ReleasedRule[];
  submit: Stream<ContributionEvent>;
}

/**
 * The pool's exported submit handler, bound by other code to a list of its
 * own and configured with the lowest threshold there is.
 */
const OwnList = pattern<OwnListInput, OwnListOutput>(({ contributions }) => ({
  [NAME]: "Own list",
  [UI]: <div />,
  contributions,
  released: releaseConsensus(contributions),
  submit: submitContribution({ contributions, thresholdCenter: 1, jitter: 0 }),
}));

/** The pseudonyms one contributor submits under, in turn. */
const TURNS = Array.from(
  { length: MIN_SEALED_THRESHOLD },
  (_, i) => `turn-${i}`,
);

export default pattern(() => {
  const pool = InductorPool(
    {
      goal: "Is this email a bill?",
      thresholdCenter: 15,
      jitter: 5,
    } as Parameters<typeof InductorPool>[0],
  );
  const probe = ReplayProbe(
    { contributions: pool.contributions } as Parameters<typeof ReplayProbe>[0],
  );
  const own = OwnList({} as Parameters<typeof OwnList>[0]);
  const links = LinkProbe(
    { contributions: pool.contributions } as Parameters<typeof LinkProbe>[0],
  );
  // A pool at the lowest threshold, so the release over the hoard would
  // release `invoice` if it counted each old entry.
  const lowest = InductorPool(
    {
      goal: "Is this email a bill?",
      thresholdCenter: MIN_SEALED_THRESHOLD,
      jitter: 0,
    } as Parameters<typeof InductorPool>[0],
  );
  const hoarder = HoardProbe(
    { contributions: lowest.contributions } as Parameters<
      typeof HoardProbe
    >[0],
  );
  return {
    [TESTS]: [
      {
        action: pool.submit,
        event: { pseudonym: "victim", rules: [INVOICE] },
      },
      { assertion: assert(() => pool.releasedCount === 0) },
      // The control: a literal lands in a public store of the same shape.
      { action: probe.publishLiteral },
      { assertion: assert(() => probe.literal === "literal") },
      // The released function, fed the forgery, computes the victim's rule
      // as released...
      {
        assertion: assert(() =>
          probe.released.length === 1 &&
          probe.released[0]?.pattern === "invoice" &&
          probe.released[0]?.count === MIN_SEALED_THRESHOLD
        ),
      },
      // ...but its inputs are not the pool's own contributions, so a public
      // store refuses it.
      { action: probe.publish },
      { assertion: assert(() => probe.leaked === UNTOUCHED) },
      // One real entry linked five times is one contributor: nothing to
      // release.
      { action: links.buildRepeated },
      { assertion: assert(() => links.releasedRepeated.length === 0) },
      // A real entry beside forged copies of it: the function counts twenty,
      // the pool's highest threshold, but the forgeries are not the pool's
      // own, so a public store refuses.
      { action: links.buildMixed },
      {
        assertion: assert(() =>
          links.releasedMixed.length === 1 &&
          links.releasedMixed[0]?.count === 20
        ),
      },
      { action: links.publishMixed },
      { assertion: assert(() => links.leakedMixed === UNTOUCHED) },

      // One contributor submits under five pseudonyms in turn, each
      // replacing the last, and the probe keeps a link to every entry...
      ...TURNS.flatMap((pseudonym) => [
        { action: lowest.submit, event: { pseudonym, rules: [INVOICE] } },
        { action: hoarder.keep },
      ]),
      // ...then withdraws, so all five are old entries.
      { action: lowest.withdraw },
      {
        assertion: assert(() =>
          lowest.contributions.length === 0 &&
          hoarder.hoard.map((entry) => entry?.pseudonym).join() ===
            TURNS.join()
        ),
      },
      // The functions read all five, and count them as one contributor: the
      // tally counts `invoice` once, and the release, at a threshold of
      // five, releases nothing.
      {
        assertion: assert(() =>
          hoarder.tallied.length === 1 &&
          hoarder.tallied[0]?.pattern === "invoice" &&
          hoarder.tallied[0]?.count === 1 &&
          hoarder.released.length === 0
        ),
      },

      // The submit handler, bound to a list configured with a threshold of
      // one, refuses to seal it, so the list holds nothing to release.
      {
        action: own.submit,
        event: { pseudonym: "accomplice", rules: [INVOICE] },
      },
      {
        assertion: assert(() =>
          own.contributions.length === 0 && own.released.length === 0
        ),
      },
    ],
    // Each refused publish logs the CFC refusal; the refusals are the point.
    allowConsoleWarnings: true,
    expectRuntimeErrors: [`at least ${MIN_SEALED_THRESHOLD}`],
    pool,
    probe,
    own,
    links,
    lowest,
    hoarder,
  };
});
