# ChatReaction

Status: proposed design (see [`README.md`](README.md)).

One person's reaction to one message, with one emoji. A room
([`FabriChatRoom.md`](FabriChatRoom.md)) keeps its reactions, in no particular
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
…>>`, admitted only from `commitReact` on the room's react surface (see
[`FabriChatRoom.md`](FabriChatRoom.md#writers)).

## Fields

- **`reactorProfile`** links the reactor's profile
  ([`ChatProfile.md`](ChatProfile.md)), which a client reads when it draws, as
  it does for a message's author.
- **`message`** links a message in the same room
  ([`ChatMessage.md`](ChatMessage.md)).
- **`emoji`** is any single emoji: exactly one emoji sequence that [Unicode
  Technical Standard #51](https://www.unicode.org/reports/tr51/) recommends for
  general interchange (`RGI_Emoji`), with its modifiers and joiners included.
  `commitReact` refuses anything else, including text, and two emoji written as
  one. A room has no fixed list. The four cat faces in today's
  `FABRICHAT_REACJI` are a demo placeholder, not part of this design. Which
  emoji a client puts within easy reach is the client's choice.

## Where it is kept

Each reaction is kept at an address derived from its reactor's profile, its
message, and its emoji (`reactionKeyFor`). One person's one reaction to one
message has a single address in every session, so adding or removing it never
rewrites anyone else's, and two people reacting at once write different records.
Reacting again with the same emoji removes the reaction.
