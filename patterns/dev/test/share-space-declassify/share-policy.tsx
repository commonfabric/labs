// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * The share space's own policy: a value under it is readable by whoever holds
 * READ on the space the label was created in, its policy subject. A store of
 * the share space typed with it is "readers of the share space", where an
 * unlabeled store is "anyone the value reaches". The rule is the one
 * `patterns/examples/cfc-exchange-rules/direct-release.tsx` copies.
 */
import { type Confidential } from "commonfabric";
import {
  cfcPattern,
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
  v,
} from "commonfabric/cfc";

export const releaseToSpaceReader = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [
      cfcPattern.hasRole(v("reader"), THIS_POLICY.subject, "reader"),
    ],
  },
  post: { addAlternatives: [cfcPattern.user(v("reader"))] },
});

export const shareSpaceRules = exchangeRules([releaseToSpaceReader]);

/** Readable by the readers of the space the value is labeled in. */
export type ShareSpaceReaders<T> = Confidential<
  T,
  readonly [PolicyOf<typeof shareSpaceRules>]
>;
