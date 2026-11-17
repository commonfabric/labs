/**
 * The released function run over inputs other code chose is not released.
 * A probe copies the pool's contributions, repeats each under made-up
 * pseudonyms, seals the copies with a secret of its own, and hands them to
 * `releaseConsensus`. The function computes the victim's rule as released,
 * but the policy's input witness sees contributions `submitContribution` did
 * not write, so a public store refuses the result.
 *
 * Links do no better. A list of links to the pool's own entries, one entry
 * linked five times, releases nothing: a pseudonym counts once. A list
 * holding a link to the victim's real entry beside forged copies of it,
 * enough to pass any threshold the pool's seal allows, is refused by a public
 * store, as the forgery alone is.
 *
 * And `submitContribution`, bound by other code to a list of its own with a
 * threshold of one, refuses to seal it: the floor is the module's
 * (`MIN_SEALED_THRESHOLD`), not the binding's.
 *
 * Pattern under test: ./inductor-pool.tsx. The honest release reaching a
 * public store is in ./inductor-pool-multi-user.test.tsx.
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
  type OpenPublic,
  type Untouched,
} from "./inductor-pool-test-fixture.ts";
import InductorPool, {
  type Contribution,
  type ContributionEvent,
  releaseConsensus,
  type ReleasedRule,
  type StoredContribution,
  submitContribution,
} from "./inductor-pool.tsx";

/** Copies rules into `to`, as a release into a public store would. */
const publishRules = handler<
  void,
  { from: ReleasedRule[]; to: Writable<ReleasedRule[]> }
>((_, { from, to }) => {
  to.set(
    (from ?? []).map((rule) => ({
      field: rule.field,
      pattern: rule.pattern,
      predicts: rule.predicts,
      key: rule.key,
      count: rule.count,
    })),
  );
});

interface ProbeInput {
  contributions: StoredContribution[];
  leaked: Writable<Default<OpenPublic, Untouched>>;
}

interface ProbeOutput {
  [NAME]: string;
  [UI]: VNode;
  released: ReleasedRule[];
  leaked: OpenPublic;
  publish: Stream<void>;
}

const ReplayProbe = pattern<ProbeInput, ProbeOutput>(
  ({ contributions, leaked }) => {
    // Each contribution as many times as the lowest threshold a seal may
    // have, under made-up pseudonyms, sealed with that threshold and the
    // probe's own secret.
    const forged = computed((): Contribution[] =>
      (contributions ?? []).flatMap((contribution) =>
        Array.from(
          { length: MIN_SEALED_THRESHOLD },
          (_, i) => ({
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
      publish: publishRules({ from: released, to: leaked }),
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
 * pseudonyms, carrying its seal: together, as many as its seal's highest
 * threshold, so the function releases its rules whatever their offsets.
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
  leakedRepeated: Writable<Default<OpenPublic, Untouched>>;
  leakedMixed: Writable<Default<OpenPublic, Untouched>>;
}

interface LinkProbeOutput {
  [NAME]: string;
  [UI]: VNode;
  releasedRepeated: ReleasedRule[];
  releasedMixed: ReleasedRule[];
  leakedRepeated: OpenPublic;
  leakedMixed: OpenPublic;
  buildRepeated: Stream<void>;
  buildMixed: Stream<void>;
  publishRepeated: Stream<void>;
  publishMixed: Stream<void>;
}

/** Hands `releaseConsensus` lists of links to the pool's real entries. */
const LinkProbe = pattern<LinkProbeInput, LinkProbeOutput>(
  ({ contributions, repeated, mixed, leakedRepeated, leakedMixed }) => {
    const releasedRepeated = releaseConsensus(repeated);
    const releasedMixed = releaseConsensus(mixed);
    return {
      [NAME]: "Link probe",
      [UI]: <div />,
      releasedRepeated,
      releasedMixed,
      leakedRepeated,
      leakedMixed,
      buildRepeated: linkRepeated({ contributions, to: repeated }),
      buildMixed: linkBesideForgeries({ contributions, to: mixed }),
      publishRepeated: publishRules({
        from: releasedRepeated,
        to: leakedRepeated,
      }),
      publishMixed: publishRules({ from: releasedMixed, to: leakedMixed }),
    };
  },
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
  return {
    [TESTS]: [
      {
        action: pool.submit,
        event: { pseudonym: "victim", rules: [INVOICE] },
      },
      { assertion: assert(() => pool.releasedCount === 0) },
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
      {
        assertion: assert(() =>
          probe.leaked.length === 1 && probe.leaked[0]?.key === "untouched"
        ),
      },
      // One real entry linked five times is one pseudonym: nothing to release,
      // and a public store holds nothing.
      { action: links.buildRepeated },
      { action: links.publishRepeated },
      {
        assertion: assert(() =>
          links.releasedRepeated.length === 0 &&
          !links.leakedRepeated.some((rule) => rule?.pattern === "invoice")
        ),
      },
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
      {
        assertion: assert(() =>
          links.leakedMixed.length === 1 &&
          links.leakedMixed[0]?.key === "untouched"
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
    // The refused publish logs the CFC refusal; the refusal is the point.
    allowConsoleWarnings: true,
    expectRuntimeErrors: [`at least ${MIN_SEALED_THRESHOLD}`],
    pool,
    probe,
    own,
    links,
  };
});
