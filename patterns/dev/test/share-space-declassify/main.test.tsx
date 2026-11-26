// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * The share-space experiment (README): can the owner's pattern publish the
 * last five minutes of the owner's secret location into a second space, so
 * that whoever can read that space sees them?
 *
 * The owner's fixes live in the test's space. Each share is placed in a new
 * space that grants everyone READ, and publishes into a store that admits
 * only unlabeled values. A share placed in the owner's own space is the
 * baseline, separating what the second space changes from what CFC decides.
 *
 * The shares are created by an action: `inSpace()` called in a pattern body
 * places the piece in the body's own space (README, findings).
 */
import {
  action,
  assert,
  pattern,
  spaceOf,
  TESTS,
  Writable,
} from "commonfabric";
import { type Fix, type OwnerLocation, type OwnerOnly } from "./policy.tsx";
import Share, { type ShareOutput } from "./share.tsx";
import ShareLive, { type ShareLiveOutput } from "./share-live.tsx";

const NOW = 1_800_000_000_000;
const MINUTE = 60 * 1000;

/** Two fixes inside the window, one before it. */
const FIXES: Fix[] = [
  { lat: 37.0, lon: -122.0, at: NOW - 20 * MINUTE },
  { lat: 37.1, lon: -122.1, at: NOW - 4 * MINUTE },
  { lat: 37.2, lon: -122.2, at: NOW - 1 * MINUTE },
];

const lats = (fixes: readonly Fix[] | undefined): number[] =>
  (fixes ?? []).map((fix) => fix?.lat);

const isRecent = (fixes: readonly Fix[] | undefined): boolean => {
  const got = lats(fixes);
  return got.length === 2 && got[0] === 37.1 && got[1] === 37.2;
};

const EVERYONE_READS = { grants: { "*": "READ" as const } };

/** The shares the test creates, held so later steps can reach them. */
interface Shares {
  /** Owner's policy, share in a second space. */
  policy?: ShareOutput;
  /** Owner's policy, share in the owner's own space (baseline). */
  here?: ShareOutput;
  /** The connector's `User{owner}` label, share in a second space. */
  connector?: ShareOutput;
  /** Owner's policy, second space, published by a function no rule names. */
  plain?: ShareOutput;
  /** The connector's label, reclassified by the owner's live share. */
  live?: ShareLiveOutput;
}

export default pattern(() => {
  // The sources start empty and are filled by a step of their own, so that
  // no commit both writes a secret and creates a share store.
  const policyFixes = new Writable<OwnerLocation<Fix[]>>().for("policyFixes");
  const connectorFixes = new Writable<OwnerOnly<Fix[]>>().for(
    "connectorFixes",
  );
  const shares = new Writable<Shares>({}).for("shares");

  const create = action(() =>
    shares.set({
      policy: Share.inSpace(undefined, EVERYONE_READS)({
        fixes: policyFixes,
        now: NOW,
      }),
      here: Share({ fixes: policyFixes, now: NOW }),
      connector: Share.inSpace(undefined, EVERYONE_READS)({
        fixes: connectorFixes,
        now: NOW,
      }),
      plain: Share.inSpace(undefined, EVERYONE_READS)({
        fixes: policyFixes,
        now: NOW,
      }),
      live: ShareLive.inSpace(undefined, EVERYONE_READS)({
        fixes: connectorFixes,
        now: NOW,
      }),
    })
  );

  return {
    [TESTS]: [
      { action: create },
      { action: action(() => policyFixes.set(FIXES as OwnerLocation<Fix[]>)) },
      { action: action(() => connectorFixes.set(FIXES as OwnerOnly<Fix[]>)) },
      {
        // The three shares are in spaces of their own; the baseline is not.
        assertion: assert(() => {
          const owner = spaceOf(policyFixes);
          const s = shares.get();
          const spaces = [s.policy?.space, s.connector?.space, s.plain?.space];
          return owner !== undefined &&
            s.here?.space === owner &&
            spaces.every((space) => space !== undefined && space !== owner) &&
            new Set(spaces).size === 3;
        }),
      },
      { action: action(() => shares.get().here?.publish.send()) },
      {
        // Baseline: the blessed window is released in the owner's space.
        assertion: assert(() => isRecent(shares.get().here?.shared)),
      },
      { action: action(() => shares.get().policy?.publish.send()) },
      {
        // Level 1: the blessed window is released into the share space.
        assertion: assert(() => isRecent(shares.get().policy?.shared)),
      },
      { action: action(() => shares.get().plain?.publishPlain.send()) },
      {
        // A function the policy does not name releases nothing.
        assertion: assert(() => lats(shares.get().plain?.shared).length === 0),
      },
      { action: action(() => shares.get().connector?.publish.send()) },
      {
        // The connector's label: no rule the owner can write releases it.
        assertion: assert(() =>
          lats(shares.get().connector?.shared).length === 0
        ),
      },
      { action: action(() => shares.get().live?.publish.send()) },
      {
        // The live share's store admits the owner or the share space's
        // readers. With `EXPERIMENTAL_PIECE_CREATOR_RECORD` and
        // `EXPERIMENTAL_CFC_PATTERN_RECLASSIFICATION` set, the window is
        // reclassified for the share space's readers and lands whole;
        // without them it stays the owner's alone and the store refuses it.
        // A run has one set of flags, and a pattern cannot read them, so the
        // step admits exactly those two outcomes (README, finding 7).
        assertion: assert(() => {
          const shared = shares.get().live?.shared;
          return lats(shared).length === 0 || isRecent(shared);
        }),
      },
    ],
    // Each refused publish logs the CFC refusal; the refusals are findings.
    allowConsoleWarnings: true,
    shares,
  };
});
