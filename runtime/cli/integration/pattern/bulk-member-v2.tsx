/**
 * The "next generation" of `bulk-member.tsx`, for the bulk-operations drill:
 * the `--retarget` source whose computed identity the survey stamps onto
 * member rows, and which the retarget then moves them to. The only difference
 * from generation one is the field a retarget would change.
 *
 * It exports the same pattern twice. A module's identity is its closure's, so
 * `Member` and `MemberAlias` share one identity and differ only in symbol —
 * which is what lets the drill move a piece to a reference whose identity
 * half matches a plan row's target while its symbol half does not, and hold
 * the classification to comparing both.
 */

import { NAME, pattern, type PatternFactory } from "commonfabric";

export interface MemberInput {
  title: string;
}

export interface MemberOutput {
  [NAME]: string;
  title: string;

  /** Which generation of this fixture the member runs. */
  generation: string;
}

export const Member: PatternFactory<MemberInput, MemberOutput> = pattern<
  MemberInput,
  MemberOutput
>(({ title }) => ({
  [NAME]: title,
  title,
  generation: "two",
}));

/** The same member under a second symbol; see the module comment. */
export const MemberAlias: PatternFactory<MemberInput, MemberOutput> = pattern<
  MemberInput,
  MemberOutput
>(({ title }) => ({
  [NAME]: title,
  title,
  generation: "two",
}));
