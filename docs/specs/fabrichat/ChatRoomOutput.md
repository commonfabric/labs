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

  sendMessage: Stream<{ body: string; replyTo?: ChatReply }>;
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

Each stream is a one-way, asynchronous request to the room. Sending an event
finishes when the event is accepted, not when it takes effect, and returns no
value: a sender observes the effect in the room's facts. An event is appended in
the room's space, so sending needs write access there, and the room acts on it
later, possibly in another runtime.

Each stream below is written as a call, with its event's keys as the
parameters: `react(message: Cell<ChatMessage>, emoji: string)` sends
`{ message, emoji }`.

These rules hold for every stream:

- A stream that names a reviewed surface admits an event only as a trusted
  gesture on that surface (see
  [`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)), and the
  record it writes is labeled `authored-by` the principal who sent it.
- An event that arrives before the viewer's profile resolves is refused.
- A refused event is spent: it is not retried, and the sender sends again.

| Stream | Reviewed surface | Effect |
| --- | --- | --- |
| [`sendMessage`](#sendmessagebody-string-replyto-chatreply) | `ChatSendSurface` | appends a message from the viewer |
| [`react`](#reactmessage-cellchatmessage-emoji-string) | `ChatReactSurface` | adds the viewer's reaction, or removes it |
| [`join`](#join) | none | adds the viewer's own profile to `roster` |
| [`invite`](#inviteprincipal-string-access-write--owner) | `ChatMembersSurface` | grants a principal access, or issues an invitation |
| [`remove`](#removeprincipal-string) | `ChatMembersSurface` | revokes a principal's access |

### `sendMessage(body: string, replyTo?: ChatReply)`

Sends a message from the viewer.

- **Event:** `body` is the text exactly as the person saw it when they sent it.
  `replyTo` optionally says which message this one replies to, and whether it
  is shown in the main conversation, in that message's thread, or both (see
  [`ChatReply`](ChatReply.md)).
- **Admitted:** as a trusted gesture on `ChatSendSurface`.
- **Effect:** appends a [`ChatMessage`](ChatMessage.md) to `messages`, with the
  viewer's profile as `authorProfile` and the handler's clock as `sentAt`.
- **Refused:** an empty `body`, a `replyTo` whose `message` is in another room,
  a `shownIn` other than `"main"`, `"thread"`, or `"both"`, or a `"main"` reply
  to a message shown only in a thread.

### `react(message: Cell<ChatMessage>, emoji: string)`

Adds the viewer's reaction to a message, or removes it.

- **Event:** `message` links a message in this room. `emoji` is a single emoji
  (see [`ChatReaction`](ChatReaction.md)).
- **Admitted:** as a trusted gesture on `ChatReactSurface`.
- **Effect:** if the viewer has no reaction with `emoji` on `message`, adds a
  [`ChatReaction`](ChatReaction.md) to `reactions`. If they have one, removes it.
  No one else's reaction changes.
- **Refused:** a `message` in another room, or an `emoji` that isn't a single
  emoji.

### `join()`

Adds the viewer's own profile to `roster`.

- **Event:** none. The profile is the viewer's own `#profile`, never one the
  sender names.
- **Admitted:** without a reviewed gesture. It asserts nothing but the viewer's
  own profile, and an entry stays a claim, as
  [shared-profile rosters](../shared-profile-rosters.md) describe.
- **Effect:** adds the profile to `roster`, unless it's already there.
- **When to send:** a client SHOULD send it when it first shows a room to a
  member. It has no effect once the room's space has a member set.

### `invite(principal: string, access: "WRITE" | "OWNER")`

Admits another person to a group room. This is an outward act: it grants
someone else access.

- **Event:** `principal` is the DID to admit, and `access` what to grant.
- **Admitted:** as a trusted gesture on `ChatMembersSurface`, and only from a
  member the room space's access list makes OWNER.
- **Effect:** grants `principal` the access, or issues a space invitation for
  them to redeem.
- **Open:** an invitation issued here has to be delivered, as the manager's are
  (see [`ChatManagerOutput`](ChatManagerOutput.md#delivering-invitations)), but
  the room has no way to hand it to the sender's client yet. The manager's
  `outgoingInvitations` holds only invitations its own requests issue.
- **Refused:** on a direct room, and on a space's own chat, neither of which
  offers it.

### `remove(principal: string)`

Removes a person from a group room. This is an outward act: it withdraws
someone else's access.

- **Event:** `principal` is the DID to remove.
- **Admitted:** as a trusted gesture on `ChatMembersSurface`, and only from a
  member the room space's access list makes OWNER.
- **Effect:** revokes `principal`'s access to the room's space. Their messages
  and reactions stay in the history.
- **Refused:** on a direct room, and on a space's own chat, neither of which
  offers it.

## Renderings

- **`[UI]`** is the room's own rendering, with its reviewed surfaces. An
  adapter's rendering embeds it, so a composer is always the room's own surface.
- **`[VIEWS]`** holds a `room` group with the facts and streams above, for hosts
  that draw natively. A client uses it to show a room outside any container.
  Inside a container, it reads the placement's `chat` group instead
  ([`FabriChatPlacement.md`](FabriChatPlacement.md#outputs)).
