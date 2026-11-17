/**
 * Three contributors, each in their own runtime and under their own
 * principal, share one pool whose threshold is exactly two. A rule two of
 * them hold is released with its count, and a public store takes it; a rule
 * only one holds never appears; no one can submit under another's
 * pseudonym; a contributor who resubmits, under a new pseudonym too,
 * replaces their own entry and is still counted once, even after another
 * contributor's replacement rewrote the list; and a contributor who
 * withdraws takes their count off every rule.
 *
 * Pattern under test: ./inductor-pool.tsx
 */
import {
  assert,
  type Default,
  handler,
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
  type OpenPublic,
  type Untouched,
} from "./inductor-pool-test-fixture.ts";
import InductorPool, {
  type InductorPoolOutput,
  type ReleasedRule,
} from "./inductor-pool.tsx";

interface Setup {
  pool: InductorPoolOutput;
}

export const setup = pattern<Record<string, never>, Setup>(() => ({
  pool: InductorPool(
    {
      goal: "Is this email a bill?",
      thresholdCenter: 2,
      jitter: 0,
    } as Parameters<typeof InductorPool>[0],
  ),
}));

/** Copies the pool's release into a public store, as a reader might. */
const publishRelease = handler<
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

interface ReaderInput {
  consensus: ReleasedRule[];
  // Public stores with no write binding, so only their label can refuse.
  first: Writable<Default<OpenPublic, Untouched>>;
  later: Writable<Default<OpenPublic, Untouched>>;
}

interface ReaderOutput {
  [NAME]: string;
  [UI]: VNode;
  first: OpenPublic;
  later: OpenPublic;
  publishFirst: Stream<void>;
  publishLater: Stream<void>;
}

/** Someone reading the pool's public result into public stores of their own. */
const Reader = pattern<ReaderInput, ReaderOutput>(
  ({ consensus, first, later }) => ({
    [NAME]: "Reader",
    [UI]: <div />,
    first,
    later,
    publishFirst: publishRelease({ from: consensus, to: first }),
    publishLater: publishRelease({ from: consensus, to: later }),
  }),
);

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

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const reader = Reader(
    { consensus: setup.pool.consensus } as Parameters<typeof Reader>[0],
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
      { await: "bob-submitted" },
      { await: "carol-submitted" },
      // Two hold `invoice`: released, with its count. `bill` (bob alone) and
      // `lunch` (alice alone) do not appear.
      { assertion: assert(() => releasedIs(setup.pool, [["invoice", 2]])) },
      // The release is public: the policy lets it into a public store.
      { action: reader.publishFirst },
      {
        assertion: assert(() =>
          reader.first.length === 1 &&
          reader.first[0]?.pattern === "invoice" &&
          reader.first[0]?.count === 2
        ),
      },
      // Alice replaces her set, which rewrites the list around Bob's entry.
      {
        action: setup.pool.submit,
        event: { pseudonym: "alice-bills", rules: [INVOICE, LUNCH, BILL] },
      },
      {
        assertion: assert(() =>
          releasedIs(setup.pool, [["bill", 2], ["invoice", 2]])
        ),
      },
      { label: "alice-replaced" },
      { await: "bob-renamed" },
      // Bob's new pseudonym replaced his entry: he holds only `lunch` now.
      { assertion: assert(() => releasedIs(setup.pool, [["lunch", 2]])) },
      // A replaced contribution is still the pool's own, so the release
      // after it is public too.
      { action: reader.publishLater },
      {
        assertion: assert(() =>
          reader.later.length === 1 && reader.later[0]?.pattern === "lunch"
        ),
      },
      // Withdrawing takes Alice's count off every rule.
      { action: setup.pool.withdraw },
      {
        assertion: assert(() =>
          releasedIs(setup.pool, []) &&
          setup.pool.contributions.length === 1 &&
          setup.pool.contributions[0]?.pseudonym === "bob-new"
        ),
      },
    ],
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
    { assertion: assert(() => releasedIs(setup.pool, [["invoice", 2]])) },
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
        setup.pool.contributions.length === 2 &&
        releasedIs(setup.pool, [["lunch", 2]])
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
    { assertion: assert(() => releasedIs(setup.pool, [["invoice", 2]])) },
    { label: "carol-submitted" },
  ],
  expectRuntimeErrors: ["belongs to another contributor"],
}));

export default multiUserTest({ setup, participants: { alice, bob, carol } });
