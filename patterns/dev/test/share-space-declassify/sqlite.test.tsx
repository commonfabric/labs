// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * Step 2 of top/3599 comment 7: the share pattern of `main.test.tsx`, fed
 * from SQLite rows labeled by a row rule instead of from a labeled cell
 * (`sqlite-source.tsx`). Each share runs in a new space that grants everyone
 * READ and publishes into a store that admits only unlabeled values.
 */
import {
  action,
  assert,
  pattern,
  spaceOf,
  TESTS,
  Writable,
} from "commonfabric";
import { type Fix } from "./policy.tsx";
import Share, { type ShareOutput } from "./share.tsx";
import SqliteSource from "./sqlite-source.tsx";

const NOW = 1_800_000_000_000;
const MINUTE = 60 * 1000;

const FIXES: Fix[] = [
  { lat: 37.0, lon: -122.0, at: NOW - 20 * MINUTE },
  { lat: 37.1, lon: -122.1, at: NOW - 4 * MINUTE },
  { lat: 37.2, lon: -122.2, at: NOW - 1 * MINUTE },
];

const lats = (fixes: readonly Fix[] | undefined): number[] =>
  (fixes ?? []).map((fix) => fix?.lat);

// Expected of the custody share once row labels resolve `PolicyOf`.
// deno-lint-ignore no-unused-vars
const isRecent = (fixes: readonly Fix[] | undefined): boolean => {
  const got = lats(fixes);
  return got.length === 2 && got[0] === 37.1 && got[1] === 37.2;
};

const EVERYONE_READS = { grants: { "*": "READ" as const } };

interface Shares {
  custody?: ShareOutput;
  sharedOwner?: ShareOutput;
  ownerOnly?: ShareOutput;
  custodyPlain?: ShareOutput;
}

export default pattern(() => {
  const source = SqliteSource({});
  const shares = new Writable<Shares>({}).for("shares");

  const create = action(() =>
    shares.set({
      custody: Share.inSpace(undefined, EVERYONE_READS)({
        fixes: source.custody as Fix[],
        now: NOW,
      }),
      sharedOwner: Share.inSpace(undefined, EVERYONE_READS)({
        fixes: source.sharedOwner as Fix[],
        now: NOW,
      }),
      ownerOnly: Share.inSpace(undefined, EVERYONE_READS)({
        fixes: source.ownerOnly as Fix[],
        now: NOW,
      }),
      custodyPlain: Share.inSpace(undefined, EVERYONE_READS)({
        fixes: source.custody as Fix[],
        now: NOW,
      }),
    })
  );

  return {
    [TESTS]: [
      {
        // The policy atom came out of the compiled schema.
        assertion: assert(() => {
          const atom = source.policyAtom;
          return atom?.policyRefKind === "module";
        }),
      },
      { action: create },
      { action: action(() => source.seed.send(FIXES)) },
      { settle: true },
      {
        // The owner reads every table's rows.
        assertion: assert(() =>
          lats(source.custody).length === 3 &&
          lats(source.sharedOwner).length === 3 &&
          lats(source.ownerOnly).length === 3
        ),
      },
      {
        assertion: assert(() => {
          const owner = spaceOf(shares);
          const s = shares.get();
          const spaces = [
            s.custody?.space,
            s.sharedOwner?.space,
            s.ownerOnly?.space,
            s.custodyPlain?.space,
          ];
          return spaces.every((space) =>
            space !== undefined && space !== owner
          );
        }),
      },
      { action: action(() => shares.get().custody?.publish.send()) },
      {
        // FINDING: a row whose rule names the policy alone is NOT released,
        // although a cell under the same label is (`main.test.tsx`). The
        // compiled `PolicyOf` atom carries `subject: {__ctOwningSpace: true}`,
        // which only the schema write path resolves and installs a manifest
        // for (`resolvePolicyOfValue`, runtime/runner/src/cfc/prepare.ts).
        // A row rule's `constant()` atom passes through the row-label
        // evaluator untouched, so no rule of the policy applies. Expect
        // `isRecent` here once row labels resolve `PolicyOf`.
        assertion: assert(() =>
          lats(shares.get().custody?.shared).length === 0
        ),
      },
      { action: action(() => shares.get().custodyPlain?.publishPlain.send()) },
      {
        // A function the policy does not name releases nothing.
        assertion: assert(() =>
          lats(shares.get().custodyPlain?.shared).length === 0
        ),
      },
      { action: action(() => shares.get().sharedOwner?.publish.send()) },
      {
        // `anyOf(owner, PolicyOf)` under a `dropClause` rule narrows back to
        // the owner (§4.4.5), so nothing is released.
        assertion: assert(() =>
          lats(shares.get().sharedOwner?.shared).length === 0
        ),
      },
      { action: action(() => shares.get().ownerOnly?.publish.send()) },
      {
        // Today's connector rule: nothing is released.
        assertion: assert(() =>
          lats(shares.get().ownerOnly?.shared).length === 0
        ),
      },
    ],
    allowConsoleWarnings: true,
    shares,
  };
});
