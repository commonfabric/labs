import { NAME } from "@commonfabric/runner/shared";

export interface Mentionable {
  [NAME]: string;

  /**
   * The piece a mention of this entry names, held as a cell reference.
   *
   * Optional, and its absence changes what an entry IS. Without one, the
   * entry is the piece itself, listed directly. With one, the entry is a
   * derived row standing for `piece` — the editor lists and matches on the
   * row's own name and resolves `piece` when a completion is picked, so
   * what a mention stores is the piece and never the row.
   *
   * The VALUE at this position never carries a usable handle: an `asCell`
   * position crosses the client boundary as an empty object. A reader
   * detects a row by this key's presence and reaches the piece by ADDRESS
   * — `entry.key("piece").resolveAsCell()` — never through the value.
   */
  piece?: unknown;

  /**
   * The name the collection that owns this member calls it by — `42` for a
   * member of a board that numbers its members.
   *
   * On a universe row it is a COPY the collection publishes, and the editor
   * reads that copy at both ends of a mention: a `#42` query matches it, and
   * a mention's pill shows it for the destination the row stands for, so
   * neither costs a read of the member behind the row. A piece may publish
   * one for itself as well. The editor does not read that one, neither off a
   * destination nor off an entry that is the piece itself: it is the name the
   * piece's creating collection gave it, and both ends show only what the
   * universe the editor completes mentions from calls the member. So a
   * universe listing pieces rather than rows offers nothing to a `#42` query
   * and gives no pill a name.
   *
   * Optional, and absent wherever no collection has named the member, which
   * is what keeps such an entry out of every short-name query rather than
   * matching them all.
   */
  shortName?: string;

  [key: string]: unknown;
}

export type MentionableArray = readonly Mentionable[];

export {
  MentionableArraySchema,
  MentionableSchema,
} from "@commonfabric/runner/component-read-contract";
