# ChatReaction

One person's reaction to one message, with one emoji. A
[`ChatMessage`](ChatMessage.md) holds its reactions, in the order they were
added, as `reactions`.

```ts
// Shown for illustration only.
interface ChatReaction {
  /** The profile the reactor reacted under. */
  reactorProfile: Cell<ChatProfile>;

  /** A single emoji. */
  emoji: string;

  /** The room's handler clock when it recorded the reaction. */
  sentAt: FabricEpochNsec;
}
```

A reaction is stored as
`AuthoredByCurrentUser<TrustedActionWrite<ChatReaction, …>>`: an object pushed
onto its message's reaction list, a document of its own, admitted only through
the room's `sendReaction` stream, as a trusted gesture on `ChatReactSurface`,
and removed only through its `deleteReaction` stream, on the same surface (see
[`ChatRoomOutput`](ChatRoomOutput.md#streams)). Its identity is its cell.

## Fields

- **`reactorProfile`** links the reactor's profile
  ([`ChatProfile.md`](ChatProfile.md)), which a client reads when it draws, as
  it does for a message's author.
- **`emoji`** is any single emoji: exactly one emoji sequence that [Unicode
  Technical Standard #51](https://www.unicode.org/reports/tr51/) recommends for
  general interchange (`RGI_Emoji`), with its modifiers and joiners included.
  The room refuses anything else, including text, and two emoji written as one.
  A room has no fixed list. Which emoji a client puts within easy reach is the
  client's choice.
- **`sentAt`** is the handler clock when the room recorded the reaction, at
  whatever resolution the system provides (see
  [times](ChatMessage.md#times)). A reaction removed and added again is a new
  reaction, with a new `sentAt`.

## Uniqueness

Reaction deduplication and tallying identify a reactor by profile.
This limits uniqueness to a profile and emoji: one authenticated actor using
different profiles can appear more than once.

FabriChat's reaction rows identify the viewer's reactions and offer removal
controls by comparing each reaction's `authored-by` attestation with the owner
of the viewer's profile, as `profileOwnerOf()` determines it. As with message
rights, switching between profiles owned by one principal retains the removal
control; a profile with no verified owner offers none. This display uses the
profile's owner, while the stream checks the authenticated actor. Selecting
another actor's profile can offer a removal that the stream refuses.

The room adds none where the sender's profile already has one with
that emoji, so adding a reaction that's already there, or removing one that
isn't, changes nothing, and either can be sent again safely. Adding or removing
one never changes anyone else's, and two people reacting at once both land.
Two sessions of one person reacting with one emoji at the same moment can each
add one; a client tallies by profile and emoji, so the pair shows once, and
removing takes the one the room finds. A reaction is part of its message, but a
separately authorized part: only its reactor writes it, and it goes only by its
reactor, or out of reach with its message when the message is deleted or
obliterated (see [`ChatMessage`](ChatMessage.md#who-wrote-what)).

The `deleteReaction` stream checks the authenticated actor against the reaction's
`authored-by` attestation. Selecting the same profile as another actor does not
grant the right to remove their reaction; its author can use this stream to
remove it after changing profiles.
