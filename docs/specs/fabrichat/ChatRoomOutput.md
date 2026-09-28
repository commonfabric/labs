# ChatRoomOutput

Status: proposed design (see [`README.md`](README.md)).

The result of a chat room: what a room piece offers everyone the room's space
admits. It is the contract that placements, adapters, and clients read, and it
is named for the role rather than for an implementation.
[`FabriChatRoom`](FabriChatRoom.md) is an implementation of it: its result
satisfies `ChatRoomOutput`, and another pattern that satisfies it can fill the
same role. Everything in this document binds every implementation.

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

## Where a room lives

A room is a piece in a shared space (see [shared
spaces](README.md#shared-spaces)), in one of two ways:

- **A room of its own.** A direct room, or a group room, lives in a space
  created for it, and nothing else of consequence lives in that space. It is
  created by the user's chat manager
  ([`ChatManagerOutput`](ChatManagerOutput.md)), and never by a placement, an
  adapter, or a container.
- **A space's own chat.** The chat of everyone in a shared space is a room in
  that space itself. It is created in the space by whatever sets the space up,
  and a space has at most one.

For a room of its own, the space's access list MUST grant only the room's
members. Its creator holds OWNER. The other members of a direct room hold WRITE.
A group room MAY grant OWNER to more than one member, so that more than one
person can add people. The access list MUST NOT contain the `"*"` wildcard: a
room is not open to principals it hasn't admitted. A space's own chat takes the
space's access list as it is, and adds nothing to it.

## Membership

The room space's access list is the room's membership. Its member set is how a
room and its clients read the membership: who the members are, and which profile
shows each of them. A room keeps no membership of its own.

Until the runtime provides member sets, a room offers `roster`, a set of profile
claims that members contribute with `join`, and consumers combine it with the
access list themselves. The two can disagree: a member who has never joined has
no roster entry, and a roster entry whose principal has lost access stays until
it's cleaned up. A consumer MUST NOT treat a roster entry as proof of access.

A direct room's membership is fixed at creation. A group room's changes through
`invite` and `remove`. A space's own chat changes when the space's membership
does, and offers neither stream.

## Facts

- **`about`** is a [`ChatAbout`](ChatAbout.md), set once when the room is
  created.
- **`messages`** are [`ChatMessage`](ChatMessage.md)s, oldest first, and
  **`reactions`** are [`ChatReaction`](ChatReaction.md)s. Each is labeled
  `authored-by` the principal who wrote it, and is never edited or deleted
  (reactions are removed only by their own reactor).
- The room stores no names or avatars. Messages, reactions, and the roster link
  people's profiles ([`ChatProfile`](ChatProfile.md)) and copy nothing from
  them.
- **`roster`** and **`participants`** are links to profiles, compared with
  `equals()`. `participants` is `roster` plus any author without a roster entry.
  Neither is proof of access.

## Streams

| Stream | Reviewed surface | Effect |
| --- | --- | --- |
| `sendMessage` | `ChatSendSurface` | appends a message from the viewer |
| `react` | `ChatReactSurface` | adds the viewer's reaction, or removes it if present |
| `join` | none | adds the viewer's own `#profile` to `roster` |
| `invite` | `ChatMembersSurface` | grants a principal access, or issues an invitation |
| `remove` | `ChatMembersSurface` | revokes a principal's access |

An event on a stream with a reviewed surface is admitted only as a trusted
gesture on that surface (see
[`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)), and the
record it writes is labeled with the principal who made it.

- **`sendMessage`** takes the text exactly as the person saw it. An empty body
  is refused. A `replyTo` MUST link a message in the same room.
- **`react`** takes a message in the same room and a single emoji (see
  [`ChatReaction`](ChatReaction.md)). Reacting again with the same emoji removes
  the reaction.
- **`join`** contributes the viewer's own `#profile` link, as [shared-profile
  rosters](../shared-profile-rosters.md) describe. It needs no reviewed gesture,
  because it asserts nothing but the viewer's own profile, and an entry stays a
  claim. A client SHOULD join when it first shows a room to a member.
- **`invite`** and **`remove`** are outward acts: they grant or withdraw another
  person's access. They exist only on group rooms, and are admitted only from a
  member the access list makes OWNER.

Every stream refuses an event that arrives before the viewer's profile resolves.
A refused event is spent: it is not retried, and the caller sends again.

## Renderings

- **`[UI]`** is the room's own rendering, with its reviewed surfaces. An
  adapter's rendering embeds it, so a composer is always the room's own surface.
- **`[VIEWS]`** holds a `room` group with the facts and streams above, for hosts
  that draw natively. A client uses it to show a room outside any container.
  Inside a container, it reads the placement's `chat` group instead
  ([`FabriChatPlacement.md`](FabriChatPlacement.md#outputs)).
