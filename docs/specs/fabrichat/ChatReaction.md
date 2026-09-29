# ChatReaction

Status: proposed design (see [`README.md`](README.md)).

One person's reaction to one message, with one emoji. A
[`ChatMessage`](ChatMessage.md) holds its reactions, in no particular order, as
`reactions`.

```ts
// Shown for illustration only.
interface ChatReaction {
  /** The profile the reactor reacted under. */
  reactorProfile: Cell<ChatProfile>;

  /** A single emoji. */
  emoji: string;

  /** When the room recorded the reaction. Unique in the room. */
  sentAt: FabricEpochNsec;
}
```

A reaction is stored as `AuthoredByCurrentUser<TrustedActionWrite<ChatReaction,
…>>`, admitted only through the room's `sendReaction` stream, as a trusted
gesture on `ChatReactSurface`, and removed only through its `deleteReaction`
stream, on the same surface (see [`ChatRoomOutput`](ChatRoomOutput.md#streams)).

## Fields

- **`reactorProfile`** links the reactor's profile
  ([`ChatProfile.md`](ChatProfile.md)), which a client reads when it draws, as
  it does for a message's author.
- **`emoji`** is any single emoji: exactly one emoji sequence that [Unicode
  Technical Standard #51](https://www.unicode.org/reports/tr51/) recommends for
  general interchange (`RGI_Emoji`), with its modifiers and joiners included.
  The room refuses anything else, including text, and two emoji written as one.
  A room has no fixed list. The four cat faces in today's `FABRICHAT_REACJI` are
  a demo placeholder, not part of this design. Which emoji a client puts within
  easy reach is the client's choice.
- **`sentAt`** is the handler clock when the room recorded the reaction, at
  whatever resolution the system provides. Like every time a room records, it is
  unique in the room (see [unique times](ChatMessage.md#unique-times)). A
  reaction removed and added again is a new reaction, with a new `sentAt`.

## Uniqueness

A message holds at most one reaction per reactor and emoji. Adding or removing
one never changes anyone else's, and two people reacting at once both land.
Adding a reaction that's already there, or removing one that isn't, changes
nothing, so either can be sent again safely. A reaction is part of its message,
but a separately authorized part: only its reactor writes it (see
[`ChatMessage`](ChatMessage.md#who-wrote-what)).
