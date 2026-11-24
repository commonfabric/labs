# Joining a Loom lists you in it

**Status:** stopgap plan, narrowed after review. Stage 1 is in progress.

## Why

A Loom's members are the principals its access list admits, each with the
profiles on its root's participant roster whose owner is that principal
(`spaceMembersAt()`, `joinSpaceMembers()`). The roster is how members learn
each other's names and faces: a principal the access list admits but the
roster does not list is drawn as a short DID.

Getting onto the roster is left to each host. The loom daemon lists its own
user in every Loom it owns or has accepted, by sending that user's profile to
the root's `addParticipant`. Web Weaver lists nobody: a guest who opens an
invitation link there creates a profile, is told that the Loom's members will
see it, and joins. Every member then sees them as `did:key:…` rather than the
name they gave.

This plan gets Web Weaver's guests named soon. It is a stopgap. The longer-term
shape of joining is part of making looms and chat-only spaces behave the same,
and this plan does not try to settle it.

## Plan

### 0. Web Weaver lists its guest through `addParticipant`

Every Loom root already exports `addParticipant`, so this needs no Labs
release, host deploy or root roll-forward. Web Weaver sends its user's own
profile, the one its join page showed, when the guest joins and whenever it
opens a Loom. It sends only to a root whose stored export has the stream: a
stream schema over a missing key still reads as a stream, and a send to it
would write the event into the root. The roster adds a profile once, so the
send on each open is harmless for a listed member, and it lists a guest who
joined before this existed.

The bar is that the owner sees the guest's name without the guest reloading,
and a browser test now holds Web Weaver to it. A first send could be lost if the
serving runtime has not yet loaded the guest's home; the test shows it landing
on a fresh join, so Web Weaver sends again only on the guest's next visit. If a
lost first send shows up, Web Weaver re-sends when `participants` changes and
still lacks the guest, not on a timer.

### 1. The Loom root exports `joinAsViewer`

`joinAsViewer: Stream<void>` on the Loom root adds the sender's resolved
`#profile` to the roster through the root's own `addParticipant`, and does
nothing while that profile has not resolved. The root already holds the
viewer's `#profile` wish (`duplicateAsViewer` uses it). Under server execution
an empty event resolves `#profile` for the event's sender.

Once hosts are on roots that export it, Web Weaver can send this empty event
instead of its profile, with the same presence check and re-send.

## Accepted limits

- **READ link guests stay unnamed.** `addParticipant` needs write access, so a
  member admitted by a READ link cannot list themselves. To decide later.
- **A person with several profiles** is listed by their home's order when
  `joinAsViewer` resolves `#profile`. That is fine while only Web Weaver sends
  it. A later host would follow `duplicateAsViewer`'s rule: the session's
  acting profile, then `#profile`.
- **Rooms are out.** Chat-room roots and FabriChat's `joinRooms` are
  unchanged.
- **Older roots.** A root runs the pattern version it was created with until a
  runtime that follows its `system:` origin opens it. Until then it exports no
  `joinAsViewer`, and stage 0 covers it.

## What it does not change

- Membership is still the access list. A roster entry is a claim: it counts
  toward a member only while its profile's owner holds access
  (`joinSpaceMembers()`), and it stays stored after access is revoked.
- The name others see is the one on the member's own profile. `joinAsViewer`
  takes no profile; it lists the sender's own.
- Home's shared-space catalog, invitation redemption, the default app and the
  pattern docs are untouched.

## Held for later

- A paragraph in the pattern docs telling hosts to send `joinAsViewer`. It
  waits until the shape settles, so other hosts do not build on a stopgap.
- Moving the loom daemon onto the empty event. The daemon passes an explicit
  profile today, and a host's preferred profile does not reach a served
  handler.
- One join for every social space, Looms and chat-only spaces alike.

## Stages

1. Web Weaver sends its guest's profile to `addParticipant` (stage 0 above),
   with a browser test in which the owner reads the guest's name.
2. The Loom root exports `joinAsViewer`, with pattern tests.
3. Once hosts are on roots that export it, Web Weaver sends `joinAsViewer`
   instead.
4. Archive this plan.
