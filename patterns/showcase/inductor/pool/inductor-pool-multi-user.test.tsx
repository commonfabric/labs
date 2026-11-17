/**
 * Five contributors, each in their own runtime and under their own
 * principal, share one pool whose threshold is exactly five, the lowest a
 * pool may seal (`MIN_SEALED_THRESHOLD`). A rule five of them hold is
 * released with its count; a rule four hold never appears; no one can submit
 * under another's pseudonym; a contributor who resubmits, under a new
 * pseudonym too, replaces their own entry and is still counted once, even
 * after another contributor's replacement rewrote the list; and a contributor
 * who withdraws takes their own entry out, and their count off every rule,
 * leaving everyone else's, and withdrawing again with no entry takes nothing.
 * Carol, Dave, and Erin each hold all three rules, so Alice's and Bob's
 * choices decide which reach five.
 *
 * Alice also reads the pool into public scalar stores of her own: the
 * unthresholded tally, the release over forged copies of her entry, and a
 * contribution's leaves read raw are refused, and a literal lands beside
 * them. The genuine release should land too, and today does not (top/3226).
 *
 * Pattern under test: ./inductor-pool.tsx
 */
import {
  assert,
  computed,
  type Default,
  multiUserTest,
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
  type PublicCount,
  type PublicText,
  publishContributionCount,
  publishContributionLeaf,
  publishLiteral,
  publishPatterns,
  publishRuleCount,
  UNTOUCHED,
} from "./inductor-pool-test-fixture.ts";
import { MIN_SEALED_THRESHOLD } from "./consensus.ts";
import InductorPool, {
  type Contribution,
  type InductorPoolOutput,
  type ReleasedRule,
} from "./inductor-pool.tsx";
import {
  releaseConsensus,
  type StoredContribution,
  tallyEveryRule,
} from "./pool-policy.tsx";

interface Setup {
  pool: InductorPoolOutput;
}

export const setup = pattern<Record<string, never>, Setup>(() => ({
  pool: InductorPool(
    {
      goal: "Is this email a bill?",
      thresholdCenter: MIN_SEALED_THRESHOLD,
      jitter: 0,
    } as Parameters<typeof InductorPool>[0],
  ),
}));

type Text = Writable<Default<PublicText, typeof UNTOUCHED>>;
type Count = Writable<Default<PublicCount, -1>>;

interface ReaderInput {
  consensus: ReleasedRule[];
  contributions: StoredContribution[];
  // Public scalar stores with no write binding, so only their ceiling can
  // refuse. Each publish below writes one scalar through a handler that types
  // its store with the ceiling (inductor-pool-test-fixture.ts).
  released: Text;
  releasedCount: Count;
  literal: Text;
  tallied: Text;
  talliedCount: Count;
  forged: Text;
  rawPattern: Text;
  rawPseudonym: Text;
  rawSecret: Text;
  rawCount: Count;
}

interface ReaderOutput {
  [NAME]: string;
  [UI]: VNode;
  tally: ReleasedRule[];
  forgedRelease: ReleasedRule[];
  released: PublicText;
  releasedCount: PublicCount;
  literal: PublicText;
  tallied: PublicText;
  talliedCount: PublicCount;
  forged: PublicText;
  rawPattern: PublicText;
  rawPseudonym: PublicText;
  rawSecret: PublicText;
  rawCount: PublicCount;
  publishReleased: Stream<void>;
  publishReleasedCount: Stream<void>;
  publishLiteral: Stream<void>;
  publishTallied: Stream<void>;
  publishTalliedCount: Stream<void>;
  publishForged: Stream<void>;
  publishRawPattern: Stream<void>;
  publishRawPseudonym: Stream<void>;
  publishRawSecret: Stream<void>;
  publishRawCount: Stream<void>;
}

/**
 * Someone given the pool's public result and its stored contributions,
 * publishing scalars derived from each into public stores of their own. The
 * genuine release and a literal must land; everything else derived from the
 * contributions must not.
 */
const Reader = pattern<ReaderInput, ReaderOutput>((input) => {
  const { consensus, contributions } = input;
  // A function of the pool's module that no rule names.
  const tally = tallyEveryRule(contributions);
  // The released function over a list this pattern wrote: the first
  // contribution, carrying the pool's real seal, copied under made-up
  // contributors enough times to pass the sealed threshold.
  const forgedRelease = releaseConsensus(
    computed((): Contribution[] => {
      const first = (contributions ?? [])[0];
      if (first === undefined) return [];
      return Array.from({ length: MIN_SEALED_THRESHOLD }, (_, i) => ({
        contributor: `forged-${i}`,
        pseudonym: `forged-${i}`,
        rules: (first.rules ?? []).map((rule) => ({ ...rule })),
        seal: { ...first.seal },
      }));
    }),
  );
  return {
    [NAME]: "Reader",
    [UI]: <div />,
    tally,
    forgedRelease,
    released: input.released,
    releasedCount: input.releasedCount,
    literal: input.literal,
    tallied: input.tallied,
    talliedCount: input.talliedCount,
    forged: input.forged,
    rawPattern: input.rawPattern,
    rawPseudonym: input.rawPseudonym,
    rawSecret: input.rawSecret,
    rawCount: input.rawCount,
    publishReleased: publishPatterns({ from: consensus, to: input.released }),
    publishReleasedCount: publishRuleCount({
      from: consensus,
      to: input.releasedCount,
    }),
    publishLiteral: publishLiteral({ to: input.literal }),
    publishTallied: publishPatterns({ from: tally, to: input.tallied }),
    publishTalliedCount: publishRuleCount({
      from: tally,
      to: input.talliedCount,
    }),
    publishForged: publishPatterns({ from: forgedRelease, to: input.forged }),
    publishRawPattern: publishContributionLeaf({
      contributions,
      leaf: "pattern",
      to: input.rawPattern,
    }),
    publishRawPseudonym: publishContributionLeaf({
      contributions,
      leaf: "pseudonym",
      to: input.rawPseudonym,
    }),
    publishRawSecret: publishContributionLeaf({
      contributions,
      leaf: "secret",
      to: input.rawSecret,
    }),
    publishRawCount: publishContributionCount({
      contributions,
      to: input.rawCount,
    }),
  };
});

/**
 * Whether the pool's public result, `consensus`, is exactly these patterns
 * and counts, and `releasedCount` agrees.
 */
function releasedIs(
  pool: InductorPoolOutput,
  expected: readonly (readonly [string, number])[],
): boolean {
  const released = pool.consensus ?? [];
  return released.length === expected.length &&
    pool.releasedCount === expected.length &&
    expected.every(([pattern, count], i) =>
      released[i]?.pattern === pattern && released[i]?.count === count
    );
}

/** Whether the pool holds exactly the four entries other than Alice's. */
function othersRemain(pool: InductorPoolOutput): boolean {
  const pseudonyms = pool.contributions.map((c) => c?.pseudonym).sort();
  return pseudonyms.join() === "bob-new,carol-bills,dave-bills,erin-bills";
}

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const reader = Reader(
    {
      consensus: setup.pool.consensus,
      contributions: setup.pool.contributions,
    } as Parameters<typeof Reader>[0],
  );
  return {
    [TESTS]: [
      {
        action: setup.pool.submit,
        event: { pseudonym: "alice-bills", rules: [INVOICE, LUNCH] },
      },
      // Alone, nothing is released.
      { assertion: assert(() => releasedIs(setup.pool, [])) },
      { label: "alice-submitted" },
      { await: "erin-submitted" },
      // Five hold `invoice`: released, with its count. `bill` and `lunch`,
      // four each, do not appear.
      { assertion: assert(() => releasedIs(setup.pool, [["invoice", 5]])) },

      // The control: a literal lands in a public store of the same shape,
      // beside the same inputs, so a refusal below is the value's label and
      // not the store (top/3205).
      { action: reader.publishLiteral },
      { assertion: assert(() => reader.literal === "literal") },

      // The genuine release should land too: it is what the policy releases.
      // Today it is refused, because the release's input witness names
      // `submitContribution`, which writes what its event carried, and the
      // runtime does not match such a witness (top/3226). Until it lands, the
      // tally and forgery refusals below show only that those values are not
      // public, not that the policy tells them apart from the release.
      { action: reader.publishReleased },
      { action: reader.publishReleasedCount },
      {
        assertion: assert(() =>
          // top/3226: flip to "invoice" and 1 when the runtime matches the
          // input witness.
          reader.released === UNTOUCHED && reader.releasedCount === -1
        ),
      },

      // Every rule's count, threshold or not, is computed by a function of
      // the pool's module that no rule names...
      {
        assertion: assert(() =>
          reader.tally.map((rule) => `${rule?.pattern}:${rule?.count}`)
            .sort().join() === "bill:4,invoice:5,lunch:4"
        ),
      },
      // ...so neither its rules nor how many there are reach a public store.
      { action: reader.publishTallied },
      { action: reader.publishTalliedCount },
      {
        assertion: assert(() =>
          reader.tallied === UNTOUCHED && reader.talliedCount === -1
        ),
      },

      // The released function over Alice's entry copied under made-up
      // contributors computes `lunch`, which four real contributors hold, as
      // released...
      {
        assertion: assert(() =>
          reader.forgedRelease.map((rule) => rule?.pattern).sort().join() ===
            "invoice,lunch"
        ),
      },
      // ...but `submitContribution` did not write its inputs, so a public
      // store refuses it.
      { action: reader.publishForged },
      { assertion: assert(() => reader.forged === UNTOUCHED) },

      // A contribution read raw: its rule, its pseudonym, the pool's secret,
      // and how many contributions there are, each refused.
      { action: reader.publishRawPattern },
      { action: reader.publishRawPseudonym },
      { action: reader.publishRawSecret },
      { action: reader.publishRawCount },
      {
        assertion: assert(() =>
          reader.rawPattern === UNTOUCHED &&
          reader.rawPseudonym === UNTOUCHED &&
          reader.rawSecret === UNTOUCHED &&
          reader.rawCount === -1
        ),
      },

      // Alice replaces her set, which rewrites the list around the others'.
      {
        action: setup.pool.submit,
        event: { pseudonym: "alice-bills", rules: [INVOICE, LUNCH, BILL] },
      },
      {
        assertion: assert(() =>
          releasedIs(setup.pool, [["bill", 5], ["invoice", 5]])
        ),
      },
      { label: "alice-replaced" },
      { await: "bob-renamed" },
      // Bob's new pseudonym replaced his entry: he holds only `lunch` now.
      { assertion: assert(() => releasedIs(setup.pool, [["lunch", 5]])) },
      // Withdrawing takes Alice's entry out, and her count off every rule,
      // and leaves everyone else's entry where it was.
      { action: setup.pool.withdraw },
      {
        assertion: assert(() =>
          releasedIs(setup.pool, []) && othersRemain(setup.pool)
        ),
      },
      // Alice holds no entry now, so withdrawing again takes nothing out.
      { action: setup.pool.withdraw },
      { assertion: assert(() => othersRemain(setup.pool)) },
    ],
    // Each refused publish logs the CFC refusal.
    allowConsoleWarnings: true,
    reader,
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { await: "alice-submitted" },
    {
      action: setup.pool.submit,
      event: { pseudonym: "bob-bills", rules: [INVOICE, BILL] },
    },
    { assertion: assert(() => releasedIs(setup.pool, [])) },
    { label: "bob-submitted" },
    { await: "alice-replaced" },
    // A new pseudonym from Bob replaces his entry rather than adding one or
    // being refused: the principal, read after Alice's rewrite, is still his.
    {
      action: setup.pool.submit,
      event: { pseudonym: "bob-new", rules: [LUNCH] },
    },
    {
      assertion: assert(() =>
        setup.pool.contributions.length === 5 &&
        releasedIs(setup.pool, [["lunch", 5]])
      ),
    },
    { label: "bob-renamed" },
  ],
}));

export const carol = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { await: "bob-submitted" },
    // Carol cannot submit under Bob's pseudonym, so cannot add to his count
    // or replace his set.
    {
      action: setup.pool.submit,
      event: { pseudonym: "bob-bills", rules: [BILL] },
    },
    {
      assertion: assert(() =>
        setup.pool.contributions.length === 2 && releasedIs(setup.pool, [])
      ),
    },
    {
      action: setup.pool.submit,
      event: { pseudonym: "carol-bills", rules: [INVOICE, BILL, LUNCH] },
    },
    { label: "carol-submitted" },
  ],
  expectRuntimeErrors: ["belongs to another contributor"],
}));

export const dave = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { await: "carol-submitted" },
    {
      action: setup.pool.submit,
      event: { pseudonym: "dave-bills", rules: [INVOICE, BILL, LUNCH] },
    },
    // Four hold `invoice`: one short.
    { assertion: assert(() => releasedIs(setup.pool, [])) },
    { label: "dave-submitted" },
  ],
}));

export const erin = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { await: "dave-submitted" },
    {
      action: setup.pool.submit,
      event: { pseudonym: "erin-bills", rules: [INVOICE, BILL, LUNCH] },
    },
    { assertion: assert(() => releasedIs(setup.pool, [["invoice", 5]])) },
    { label: "erin-submitted" },
  ],
}));

export default multiUserTest({
  setup,
  participants: { alice, bob, carol, dave, erin },
});
