# ChatRoomOutput

Status: proposed design (see [`README.md`](README.md)).

The result of a chat room: what a room piece offers everyone the room's space
admits. It is the contract that placements, adapters, and clients read, and it
is named for the role rather than for an implementation.
[`FabriChatRoom`](FabriChatRoom.md) is an implementation of it: its result
satisfies `ChatRoomOutput`, and another pattern that satisfies it can fill the
same role.

```ts
// Shown for illustration only.
interface ChatRoomOutput {
  about: ChatAbout;

  /** The conversation, oldest first. */
  messages: ChatMessage[];

  /** Every reaction, in no particular order. */
  reactions: ChatReaction[];

  /** Members' profiles, as claims; only until the space has a member set. */
  roster: Cell<ChatProfile>[];

  /** `roster`, plus any author with no roster entry. */
  participants: Cell<ChatProfile>[];

  sendMessage: Stream<{ body: string; replyTo?: Cell<ChatMessage> }>;
  react: Stream<{ message: Cell<ChatMessage>; emoji: string }>;
  join: Stream<void>;
  invite: Stream<{ principal: string; access: "WRITE" | "OWNER" }>;
  remove: Stream<{ principal: string }>;

  [UI]: VNode;
  [VIEWS]: { room: object };
}
```

## Facts

- **`about`** is a [`ChatAbout`](ChatAbout.md), set once when the room is
  created.
- **`messages`** are [`ChatMessage`](ChatMessage.md)s and **`reactions`** are
  [`ChatReaction`](ChatReaction.md)s, each labeled with the principal who wrote
  it.
- **`roster`** and **`participants`** are links to profiles
  ([`ChatProfile`](ChatProfile.md)), compared with `equals()`. Neither is proof
  of access. Once the room's space has a member set, a consumer reads members
  from it instead (see [shared spaces](README.md#shared-spaces)).

## Streams

Each stream reaches one of the room's writers
([`FabriChatRoom.md`](FabriChatRoom.md#writers)):

| Stream | Reviewed surface | Effect |
| --- | --- | --- |
| `sendMessage` | `ChatSendSurface` | appends a message |
| `react` | `ChatReactSurface` | adds the viewer's reaction, or removes it if present |
| `join` | none | adds the viewer's own `#profile` to `roster` |
| `invite` | `ChatMembersSurface` | grants a principal access, or issues an invitation |
| `remove` | `ChatMembersSurface` | revokes a principal's access |

An event on a stream with a reviewed surface is admitted only as a trusted
gesture on that surface (see
[`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)). `invite`
and `remove` exist only on group rooms, and are admitted only from a member the
access list makes OWNER.

## Renderings

- **`[UI]`** is the room's own rendering, with its reviewed surfaces. An
  adapter's rendering embeds it, so a composer is always the room's own surface.
- **`[VIEWS]`** holds a `room` group with the facts and streams above, for hosts
  that draw natively. A client uses it to show a room outside any container.
  Inside a container, it reads the placement's `chat` group instead
  ([`FabriChatPlacement.md`](FabriChatPlacement.md#outputs)).
