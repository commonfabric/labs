# ChatReaction

Status: proposed design (see [`README.md`](README.md)).

One person's reaction to one message, with one emoji. A room
([`ChatRoomOutput`](ChatRoomOutput.md)) offers its reactions, in no particular
order, as `reactions`.

```ts
// Shown for illustration only.
interface ChatReaction {
  /** The profile the reactor reacted under. */
  reactorProfile: Cell<ChatProfile>;

  /** The message reacted to. */
  message: Cell<ChatMessage>;

  /** A single emoji. */
  emoji: string;
}
```

A reaction is stored as `AuthoredByCurrentUser<TrustedActionWrite<ChatReaction,
…>>`, admitted only through the room's `react` stream, as a trusted gesture on
`ChatReactSurface` (see [`ChatRoomOutput`](ChatRoomOutput.md#streams)).

## Fields

- **`reactorProfile`** links the reactor's profile
  ([`ChatProfile.md`](ChatProfile.md)), which a client reads when it draws, as
  it does for a message's author.
- **`message`** links a message in the same room
  ([`ChatMessage.md`](ChatMessage.md)).
- **`emoji`** is any single emoji: exactly one emoji sequence that [Unicode
  Technical Standard #51](https://www.unicode.org/reports/tr51/) recommends for
  general interchange (`RGI_Emoji`), with its modifiers and joiners included.
  The room refuses anything else, including text, and two emoji written as one.
  A room has no fixed list. The four cat faces in today's `FABRICHAT_REACJI` are
  a demo placeholder, not part of this design. Which emoji a client puts within
  easy reach is the client's choice.

## Uniqueness

A room holds at most one reaction per reactor, message, and emoji. Adding or
removing one never changes anyone else's, and two people reacting at once both
land. Reacting again with the same emoji removes the reaction.
