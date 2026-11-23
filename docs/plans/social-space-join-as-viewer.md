# Joining a social space lists you in it

**Status:** proposal, for review before any code. Nothing here is built.

## Why

A social space's members are the principals its access list admits, each
with the profiles on its root's participant roster whose owner is that
principal (`spaceMembersAt()`, `joinSpaceMembers()`). The roster is how
members learn each other's names and faces: a principal the access list
admits but the roster does not list is drawn as a short DID.

Getting onto the roster is left to each host, and each does it differently:

- The loom daemon lists its own user in every Loom it owns or has accepted,
  by sending that user's profile to the root's `addParticipant`.
- FabriChat's manager lists its user in a room it creates, accepts or joins
  (`joinRooms` in `patterns/system/fabrichat/manager.tsx`).
- The default app draws a "Join this space" button whose handler,
  `joinAsViewer`, sends the viewer's `#profile` to its own `addParticipant`.
  It is bound only to that button; the root exports no stream for it.
- Web Weaver lists nobody. A guest who opens an invitation link there
  creates a profile, is told that the Loom's members will see it, and joins;
  every member then sees them as `did:key:…` rather than the name they gave.

Every new host, and every new kind of social space, repeats this miss. Links
for every social space (Looms and chat-room spaces alike) make it more
common, not less: each link join is a join with no host-side code written for
that space kind.

Labs already says what joining should do. "Build the roster by join" in
[multi-user patterns](../common/patterns/multi-user-patterns.md) and
[shared-profile rosters](../specs/shared-profile-rosters.md): each viewer
contributes their own `#profile` cell when they join, through the space's own
join handler. The reference demo
(`patterns/examples/profile-roster-live-demo/`) exports that handler as a
`join` stream bound to the viewer's `#profile` wish. What is missing is that
the system social-space roots export it, under one name, so that a host's
join is one event with no profile passed around.

## Proposal

### 1. One join stream on every social-space root

The Loom root and the default app export `joinAsViewer: Stream<void>`. It
adds the viewer's resolved `#profile` to the roster through the root's own
`addParticipant`, and does nothing while the profile has not resolved. A
room root does the same once chat-room spaces share the Loom's membership.

The body lives once, beside the roster's writer in
`patterns/system/loom/participants.tsx`, and every current copy calls it:
the default app's button, the new streams, and FabriChat's `joinRooms`. The
four lines each copy repeats today (resolve the profile, skip an unresolved
one, send `{ profile }` to `addParticipant`) become one function.

```ts
// Shown for illustration only.
/** Adds `profile`, once it resolves, to the roster `join` writes. */
export function listProfile(
  join: Stream<{ profile: ParticipantProfile }>,
  profile: ParticipantProfile | undefined,
): void;

/** Binds `listProfile` to a root's roster and the viewer's `#profile`. */
export const joinAsViewer = handler<
  void,
  { join: Stream<{ profile: ParticipantProfile }>; profile: ParticipantProfile | undefined }
>(…);
```

The event carries nothing, so no host chooses whose profile is listed: the
pattern takes the viewer's own, as the access check for `addParticipant`
(write access to the space) already requires the sender to be a member.

### 2. A host's join is one event

After a host admits its user to a social space (redeeming an invitation,
accepting an offer, or opening a space it already belongs to), it sends an
empty event to the root's `joinAsViewer`. Sending on every open lists a member
who joined before this existed, and is harmless otherwise: the roster adds a
profile once.

- **Web Weaver** sends it after a guest joins and whenever it opens a space
  root that exports it. This is the case that motivates the plan.
- **The loom daemon** can later replace its own profile send with this event.
- **FabriChat's manager** keeps `joinRooms` for now, calling the shared
  function, because it also lists other members' profiles when it offers
  them a room, which a viewer's own join cannot cover.

### 3. What the spec says

One paragraph in [multi-user patterns](../common/patterns/multi-user-patterns.md),
"Build the roster by join": a social-space root exports `joinAsViewer`, and a
host that admits its user to a social space sends it, rather than writing the
roster itself.

## What it does not change

- Membership is still the access list. A roster entry is a claim, kept only
  while its profile's owner holds access (`joinSpaceMembers()`).
- The name others see is the one on the member's own profile. Nobody can list
  a name for someone else's principal.
- Home's shared-space catalog is untouched. It records which spaces the person
  belongs to and the profile acting in each, and does not reach into those
  spaces.
- Invitation redemption is untouched. It grants access and knows nothing of
  profiles.

## Open questions

1. **Existing roots.** A root runs the pattern version it was created with
   until a runtime that follows its `system:` origin opens it (the serving
   loop does at the start of each tenure; `ensureDefaultPattern` does for a
   default app). A Loom whose root has not moved yet exports no
   `joinAsViewer`. Should a host fall back to sending its user's profile to
   `addParticipant` directly for such a root, or treat it as outdated and
   wait?
2. **READ members.** `addParticipant` needs write access, so a member admitted
   by a READ link cannot list themselves and stays a short DID to everyone.
   Is the right answer a roster write that READ admits, a narrower "list
   yourself only" capability, or that READ guests stay unnamed?
3. **Which profile.** With one principal per profile (top/1178's direction),
   the viewer's `#profile` in a space is the profile acting there. Until then,
   a person with several profiles is listed under whichever the wish resolves
   to. Should `joinAsViewer` prefer the profile Home records as acting in the
   space when there is one?
4. **Rooms.** Should a FabriChat room root export `joinAsViewer` in this
   change, or once its membership moves onto the access list?

## Stages

1. Extract the shared function, export `joinAsViewer` from the Loom root and
   the default app, and point the default app's button and `joinRooms` at the
   shared function. Pattern tests: a viewer's join lists their profile once,
   an unresolved profile lists nothing, a READ member's join is refused.
2. Web Weaver sends `joinAsViewer` on join and on open, with a browser test
   in which a guest joins and the owner reads the guest's name off the roster.
3. The loom daemon moves its own listing onto the event.
4. Archive this plan.
