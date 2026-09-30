/**
 * A collection's mention universe: the rows an editor autocompletes over, and
 * the one derivation that builds them from the collection's members. Nothing
 * here knows what kind of piece a member is either — a member is read for three
 * display strings and carried onward as a reference.
 *
 * The universe is one document of COPIES, and that is what separates it from a
 * survey index whose rows ARE the members. A survey reads its members anyway;
 * the universe is read by EVERY member's editor, so wiring it to the members
 * would multiply the collection by itself, and one document of copies is what
 * bounds that product.
 *
 * `shortName` is copied off the member's own — the property `naming.ts` gives
 * it — so a member's number is derived once and reads the same wherever the
 * collection shows it. `docs/common/conventions/mentionable.md` is the contract
 * both editors consume this through.
 */

import { Default, lift, NAME, type ReadonlyCell } from "commonfabric";

/**
 * One row of a collection's mention universe: the display name the editor's
 * autocomplete lists and matches on, the title, the collection's name for the
 * member as `shortName`, and the member itself as a reference.
 *
 * `piece` is the member, written as a reference and never read through here:
 * the editor resolves it when a completion is picked, so what a mention stores
 * is the member and never this row (`Mentionable.piece` in
 * `packages/ui/src/v2/core/mentionable.ts` is the consuming contract). It is
 * deliberately not part of the demand a member declares for its own universe
 * input: a property that demand does not select is invisible to the walks that
 * warm and watch a member's argument, and that invisibility is what keeps one
 * member from reaching every sibling through its mention universe.
 */
export interface MentionableRow {
  [NAME]: string;
  title: string | Default<"">;
  shortName: string | Default<"">;
  piece: unknown;
}

/**
 * Each member's universe row, read once per member. A member whose own
 * `shortName` has produced no value carries the empty name, which is a row no
 * `#42` query matches.
 *
 * Declared structurally, and that is what makes the mid-sync guard a
 * compile-checked read: `get()` on a `ReadonlyCell` is declared to return a
 * value rather than `T | undefined`, so against a cell type omitting the guard
 * type-checks exactly as well as including it. A member with nothing behind it
 * yet — one appended a moment ago, still mid-sync — reads as `undefined` here
 * and gets no row rather than a junk one; the row appears on the next run.
 */
export function mentionableRowsOf(
  members: readonly (
    | {
      get():
        | { [NAME]?: string; title?: string; shortName?: string }
        | undefined;
    }
    | undefined
  )[],
): MentionableRow[] {
  const rows: MentionableRow[] = [];
  for (const member of members) {
    const value = member?.get();
    if (!value) continue;
    rows.push({
      // The display-name chain a reader would otherwise walk the member for: a
      // cold member has not produced its derived `[NAME]` yet, and its
      // persisted title is authoritative until it does.
      [NAME]: value[NAME] || value.title || "",
      title: value.title ?? "",
      shortName: value.shortName ?? "",
      piece: member,
    });
  }
  return rows;
}

/**
 * A collection's mention universe, derived once for the whole collection:
 * every member's editor autocompletes over this one document of copies rather
 * than over the members themselves, so a universe read is one document however
 * many members the collection holds.
 *
 * The parameter is an array of CELLS for two reasons: the cell is the identity
 * each row's `piece` records, and a cell always writes as a link, so an
 * unchanged collection recomputes to the same rows and writes nothing. What it
 * declares is the ceiling on the walk — three display strings per member — so
 * the derivation expands no member's prose, thread, verbs, or rendered view.
 *
 * `shortName` is declared OPTIONAL rather than defaulted, which is a fact
 * about the compatibility proof: a default below an array constraint is one
 * the proof cannot show stable under default insertion, while an optional
 * property carries no default to move. That is the bound on what the spelling
 * buys, and it is about the READ: `cf piece setsrc` refuses a member demand
 * that gains any property at all — optional included — over a collection
 * whose stored members do not publish it, because the schema recorded on the
 * retained link is unconstrained at that path. Finding 1 of
 * `docs/history/plans/collection-naming-s6-backfill-rehearsal-2026-09-05.md`
 * measured that refusal against an optional string and an optional `unknown`
 * alike. A member that publishes none contributes a row carrying the empty
 * string, which `mentionableRowsOf` coalesces.
 */
export const mentionableIndex = lift(
  (
    { members }: {
      members:
        | ReadonlyCell<{
          [NAME]?: string | Default<"">;
          title: string | Default<"">;
          shortName?: string;
        }>[]
        | Default<[]>;
    },
  ): MentionableRow[] =>
    // A plain array, read once per member: an element read through the
    // reactive array costs a link resolution per access.
    mentionableRowsOf(Array.from(members)),
);
