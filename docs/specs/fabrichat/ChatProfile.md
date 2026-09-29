# ChatProfile

Status: normative reference (see [`README.md`](README.md)).

The part of a person's profile that FabriChat reads. It is not a record
FabriChat keeps: it is a view of the person's shared profile, which lives in
that person's own profile space ([shared profile
space](../shared-profile-space.md)), reached through a link.

```ts
// Shown for illustration only.
interface ChatProfile {
  /** The person's display name, if they have set one. */
  name?: string;

  /** The person's avatar: a URL or a glyph, if they have set one. */
  avatar?: string;
}
```

## How FabriChat uses it

A room links profiles and never copies them. A message links its author's
profile ([`ChatMessage.md`](ChatMessage.md)), a reaction its reactor's
([`ChatReaction.md`](ChatReaction.md)), and a member-set entry the member's.

A client shows a person by reading the linked profile when it draws, and redraws
when the profile changes. A person who changes their name or avatar is shown
with the new one everywhere, including on everything they sent before the
change. FabriChat stores no name or avatar of its own, so a name someone has
stopped using isn't kept in any room's history.

A profile also says whose it is. Its value carries a `represents-principal`
label naming its owner, and that is what a client compares with a message's
`authored-by` label to show the message as verified (see
[`clients.md`](clients.md#showing-a-room)).

## When a profile can't be read

A linked profile can be unreadable to a viewer: its space may not admit them, or
it may be unreachable right now. A client then shows the person with a neutral
placeholder, and never with a name from anywhere else. The message itself, and
whether it is verified, don't depend on reading the profile.

## Prerequisite

Showing people from their profiles assumes that a room's members can read one
another's profiles. A profile space's access list decides that, and whether
profile spaces should be readable by collaborators by default is an open
question in [shared profile space](../shared-profile-space.md). FabriChat needs
the answer to be yes for anyone who shares a room.
