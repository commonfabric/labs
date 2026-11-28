// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * The labels and the one blessed computation of the share-space experiment
 * (README). An owner's location fixes are secret to the owner; a share
 * pattern in a second space wants to publish the last five minutes of them
 * to whoever can read that space.
 *
 * Two source labels are modeled:
 *
 * - `OwnerOnly`, `User{owner}`: what loom's location connector puts on every
 *   row (`connectors/loom_context_location/labels.py`). No exchange rule
 *   names it, so nothing a pattern can write releases it.
 * - `OwnerLocation`, this module's policy: the owner's own policy, which
 *   releases the output of `recentFixes` alone.
 */
import { type Confidential, type CurrentPrincipal, lift } from "commonfabric";
import {
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
} from "commonfabric/cfc";

/** One location fix: where, and when in milliseconds since the epoch. */
export interface Fix {
  lat: number;
  lon: number;
  at: number;
}

/** What the share pattern reads: the owner's fixes and the instant now. */
export interface RecentInput {
  fixes: Fix[];
  now: number;
}

/** How far back the share reaches. */
export const WINDOW_MS = 5 * 60 * 1000;

/** The fixes in the last `WINDOW_MS` before `now`, oldest first. */
export const fixesWithin = (fixes: readonly Fix[], now: number): Fix[] =>
  fixes.filter((fix) => fix.at <= now && now - fix.at <= WINDOW_MS);

/** Releases what `recentFixes` alone computed, to any reader of its store. */
export const releaseRecentFixes = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [{
      type: "https://commonfabric.org/cfc/atom/TransformedBy",
      identity: {
        kind: "verified",
        moduleIdentity: THIS_POLICY.moduleIdentity,
        symbol: "recentFixes",
      },
    }],
  },
  post: { dropClause: true },
});

export const locationRules = exchangeRules([releaseRecentFixes]);

/** The owner's fixes under the owner's own policy. */
export type OwnerLocation<T> = Confidential<
  T,
  readonly [PolicyOf<typeof locationRules>]
>;

/** The owner's fixes as the location connector labels them. */
export type OwnerOnly<T> = Confidential<
  T,
  readonly [{
    type: "https://commonfabric.org/cfc/atom/User";
    subject: CurrentPrincipal;
  }]
>;

/** The released computation: the last five minutes of fixes. */
export const recentFixes = lift(({ fixes, now }: RecentInput): Fix[] =>
  fixesWithin(fixes ?? [], now ?? 0)
);
