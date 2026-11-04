/**
 * Member fixture for the bulk-survey drill: the "current generation" of the
 * piece a board's collection holds. It lives in its own module so a member's
 * pattern identity differs from the board's — the shape the survey exists to
 * read — the way `topic.tsx` sits beside the topics board's `main.tsx`.
 * `bulk-member-v2.tsx` is the same pattern one generation later, used only as
 * a retarget source for the identity the plan stamps; nothing deploys it.
 * Nothing else deploys this file either: the drill owns its subject.
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
  generation: "one",
}));
