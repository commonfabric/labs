/** The Loom's participant roster and the one handler that writes it. */
import {
  type Cell,
  type Default,
  handler,
  type ReadonlyCell,
  type Stream,
  type Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

/**
 * A participant's Fabric profile, held as the live cell in its own space.
 * The profile's label names its principal, so the roster records no DID and
 * no name: readers take both from the profile.
 */
export type ParticipantProfile = Cell<{ name?: string; avatar?: string }>;

/**
 * `items` changes only through `addParticipant`; a write from any other
 * action, or from another pattern holding this cell, is refused by the
 * runtime.
 */
export type ParticipantList = WriteAuthorizedBy<
  ParticipantProfile[],
  typeof addParticipant
>;

/**
 * Object-wrapped so each entry stays a live profile cell. `items` is absent
 * until the first participant is added: a default inside the write contract
 * would be a write no handler made.
 */
export interface ParticipantRoster {
  items?: ParticipantList;
}

/** The shared roster cell; a Loom with no participants yet holds `{}`. */
export type ParticipantRosterCell = Writable<
  ParticipantRoster | Default<Record<PropertyKey, never>>
>;

/**
 * The roster's profiles, in the order they were added. The value type admits
 * `undefined` for a roster cell nothing has written yet; a
 * `ParticipantRosterCell` passes, because a `ReadonlyCell` accepts a cell
 * whose value type is assignable to its own.
 */
export const rosterProfiles = (
  roster: ReadonlyCell<ParticipantRoster | undefined>,
): ParticipantProfile[] => Array.from(roster.get()?.items ?? []);

/**
 * Adds a profile to the roster once. Any participant may add any profile: a
 * reader keeps only entries whose profile names a principal that currently
 * holds access to the Loom, so an entry for anyone else is never shown.
 */
export const addParticipant = handler<
  { profile: ParticipantProfile },
  { roster: ParticipantRosterCell }
>(({ profile }, { roster }) => {
  // `addUnique` is a mergeable set-add: participants adding at once all
  // land, and a profile already listed is not added again. The terminal cell
  // is pinned so the entry names this profile, not whatever an alias later
  // resolves to.
  roster.key("items").addUnique(profile.resolveAsCell());
});

/**
 * Lists the viewer in the Loom: bound to the root's `addParticipant` and the
 * viewer's `#profile`, it adds the viewer's own profile to the roster. The
 * event carries no profile: the one it lists is always the sender's own. A
 * host that admits its user to the Loom sends it, on joining and on each
 * open; the roster adds a profile once, so a repeat changes nothing. A send
 * that arrives before the viewer's profile resolves lists nothing, and the
 * next send lists them.
 *
 * `void`, not an empty object: a host's send and a rendered click arrive with
 * fields a closed empty object would refuse.
 */
export const joinAsViewer = handler<
  void,
  {
    join: Stream<{ profile: ParticipantProfile }>;
    profile: ParticipantProfile | undefined;
  }
>((_, { join, profile }) => {
  // An unresolved profile arrives as an empty cell, and linking it would
  // record no profile at all.
  const target = profile?.resolveAsCell();
  if (target === undefined || target.get() === undefined) return;
  join.send({ profile: target });
});
