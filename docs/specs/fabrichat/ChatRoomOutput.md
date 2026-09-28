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

  /** Whether the viewer can send, react, and join right now. */
  canSend: boolean;

  sendMessage: Stream<{ body: string; replyTo?: ChatReply }>;
  react: Stream<{ message: Cell<ChatMessage>; emoji: string }>;
  join: Stream<void>;
  /** Group rooms of their own only. */
  add?: Stream<{ principal: string; access: "WRITE" | "OWNER" }>;
  remove?: Stream<{ principal: string }>;
  delivered?: Stream<{ id: string }>;

  /** Notices from `add` that no one has delivered yet; with `add`. */
  outgoingNotices?: { id: string; recipient: string }[];

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

For a room of its own, the creator holds OWNER. The other members of a direct
room hold WRITE. A group room MAY grant OWNER to more than one member, so that
more than one person can add people. The access list MUST NOT contain the `"*"`
wildcard: a room is not open to principals it hasn't admitted. A space's own
chat takes the space's access list as it is, and adds nothing to it.

## Membership

The room space's access list is the room's membership. A member is any principal
it admits, at any level. A member with READ can read the room; sending,
reacting, and joining append to the room's streams, so they need WRITE; adding
and removing members needs OWNER. The space's member set is how a room and its
clients read the membership: who the members are, their access, and which
profile shows each of them. A room keeps no membership of its own.

Until the runtime provides member sets, a room offers `roster`, a set of profile
claims that members contribute with `join`, and consumers combine it with the
access list themselves. The two can disagree: a member who has never joined has
no roster entry, and a roster entry whose principal has lost access stays until
it's cleaned up. A consumer MUST NOT treat a roster entry as proof of access.

A direct room's membership is decided at creation, and never changes after. A
group room of its own changes through `add` and `remove`. A space's own chat
changes when the space's membership does. Only group rooms of their own offer
`add`, `remove`, `delivered`, and `outgoingNotices`; the others have none of
them.

## Facts

- **`about`** is a [`ChatAbout`](ChatAbout.md), set once when the room is
  created.
- **`messages`** are [`ChatMessage`](ChatMessage.md)s, oldest first, each
  labeled `authored-by` the principal who sent it. Messages are append-only:
  never edited or deleted.
- **`reactions`** are [`ChatReaction`](ChatReaction.md)s, each labeled
  `authored-by` its reactor. A reaction is removed only by its own reactor.
- The room stores no names or avatars. Messages, reactions, and the roster link
  people's profiles ([`ChatProfile`](ChatProfile.md)) and copy nothing from
  them.
- **`roster`** and **`participants`** are links to profiles, compared with
  `equals()`. `participants` is `roster` plus any author without a roster entry.
  Neither is proof of access.
- **`canSend`** says whether the viewer can send, react, and join right now:
  their access is WRITE or OWNER, and their profile resolves. It is computed for
  each viewer, so a READ-only member's client can tell them why their gestures
  would be refused before they make one.
- **`outgoingNotices`**, on group rooms of their own, holds a notice for each
  person `add` admitted, until a client reports it delivered.
- The lists here are projections. An implementation may keep reactions and the
  roster as keyed collections, as long as what it offers satisfies these rules.

## Streams

Each stream is a one-way, asynchronous request to the room. Sending an event
finishes when the event is accepted, not when it takes effect, and returns no
value: a sender observes the effect in the room's facts. An event is appended in
the room's space, so sending needs write access there, and the room acts on it
later, possibly in another runtime.

Each stream below is written as a call, with its event's keys as the parameters:
`react(message: Cell<ChatMessage>, emoji: string)` sends `{ message, emoji }`.

No event names its sender. The room learns who sent it from the event's actor:
the principal the memory server stamps on the appended event from its
authenticated commit, beside the payload rather than in it (`firedAt.user`, see
[events](../server-side-execution/events.md)), or, for a handler that runs in
the sender's own runtime, that runtime's user. Below, **the sender** is that
principal, and **the sender's profile** is the profile
`wish({ query: "#profile" })` resolves to for it (see
[per-demanding-identity wish resolution](../server-side-execution/builtins.md)):
the sender's default profile, or their most recently used one. The sender can't
choose which, and when it resolves to none, as when they have several profiles
and no default, the event is refused.

These rules hold for every stream:

- A stream that names a reviewed surface admits an event only as a trusted
  gesture on that surface (see
  [`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)), and the
  record it writes is labeled `authored-by` the principal who sent it.
- An event that arrives before the sender's profile resolves is refused.
- A refusal is silent: the room records no outcome, so a sender can't tell a
  refused event from one that hasn't taken effect yet. A client MUST check an
  event against the stream's rules before sending it (see
  [`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)).
- A refused event is spent: it is not retried, and the sender sends again.

| Stream | Reviewed surface | Effect |
| --- | --- | --- |
| [`sendMessage`](#sendmessagebody-string-replyto-chatreply) | `ChatSendSurface` | appends a message from the sender |
| [`react`](#reactmessage-cellchatmessage-emoji-string) | `ChatReactSurface` | adds the sender's reaction, or removes it |
| [`join`](#join) | none | adds the sender's profile to `roster` |
| [`add`](#addprincipal-string-access-write--owner) | `ChatMembersSurface` | grants a principal access |
| [`remove`](#removeprincipal-string) | `ChatMembersSurface` | revokes a principal's access |
| [`delivered`](#deliveredid-string) | none | the notice removed from `outgoingNotices` |

### `sendMessage(body: string, replyTo?: ChatReply)`

- `body: string` — The message's text, exactly as the person saw it when they
  sent it. Must not be empty, or only whitespace.
- `replyTo?: ChatReply` — What the message replies to, and where it is shown
  (see [`ChatReply`](ChatReply.md)). Absent for a message that isn't a reply,
  which is shown in the main conversation. `replyTo.message` must be a message
  in this room, and a `"main"` reply must be to a message the main conversation
  shows.

Sends a message from the sender.

- **Admitted:** as a trusted gesture on `ChatSendSurface`.
- **Effect:** appends a [`ChatMessage`](ChatMessage.md) to `messages`, with the
  sender's profile as `authorProfile` and the handler clock as `sentAt` (see
  [`ChatMessage`](ChatMessage.md#fields)).
- **Refused:** an empty or whitespace-only `body`, a `replyTo` whose `message`
  is in another room, a `shownIn` other than `"main"`, `"thread"`, or `"both"`,
  or a `"main"` reply to a message shown only in a thread.

### `react(message: Cell<ChatMessage>, emoji: string)`

- `message: Cell<ChatMessage>` — The message reacted to. Must be a message in
  this room.
- `emoji: string` — A single emoji: exactly one emoji sequence that [Unicode
  Technical Standard #51](https://www.unicode.org/reports/tr51/) recommends for
  general interchange (`RGI_Emoji`). It may be more than one code point, as with
  a skin-tone modifier or a ZWJ-joined sequence, but it is one emoji. Not text,
  and not two emoji together.

Adds the sender's reaction to a message, or removes it.

- **Admitted:** as a trusted gesture on `ChatReactSurface`.
- **Effect:** if the sender has no reaction with `emoji` on `message`, adds a
  [`ChatReaction`](ChatReaction.md) to `reactions`. If they have one, removes
  it. No one else's reaction changes.
- **Refused:** a `message` in another room, or an `emoji` that isn't a single
  emoji.

### `join()`

No parameters. The profile added is always the sender's profile, as the room
resolves it, never one the sender names.

Adds the sender's profile to `roster`.

- **Admitted:** without a reviewed gesture. It asserts nothing but the sender's
  own profile, and an entry stays a claim, as [shared-profile
  rosters](../shared-profile-rosters.md) describe.
- **Effect:** adds the profile to `roster`, unless it's already there.
- **When to send:** a client SHOULD send it when it first shows a room to a
  member. It has no effect once the room's space has a member set.

### `add(principal: string, access: "WRITE" | "OWNER")`

- `principal: string` — The DID of the person to admit.
- `access: "WRITE" | "OWNER"` — What to grant. WRITE lets them send, react, and
  join; OWNER also lets them add and remove members.

Admits another person to a group room of its own. This is an outward act: it
grants someone else access.

- **Admitted:** as a trusted gesture on `ChatMembersSurface`, and only from a
  member the room space's access list makes OWNER.
- **Effect:** grants `principal` the access to the room's space, by principal.
  It issues no space invitation, for the reason
  [`ChatManagerOutput`](ChatManagerOutput.md#admission-to-a-room) gives.
- **Notice:** the grant tells `principal` nothing, so the room also adds a
  notice for them to `outgoingNotices`. The client that sent `add` delivers it,
  as it delivers the manager's (see
  [`ChatManagerOutput`](ChatManagerOutput.md#delivering-notices)), and reports
  it with `delivered`. Kept in the room, a notice outlives a client that stops
  before delivering it, and any OWNER's client can deliver it instead.

### `remove(principal: string)`

- `principal: string` — The DID of the member to remove. Must not be the room's
  last OWNER, since a space's access list always keeps one.

Removes a person from a group room of its own. This is an outward act: it
withdraws someone else's access.

- **Admitted:** as a trusted gesture on `ChatMembersSurface`, and only from a
  member the room space's access list makes OWNER.
- **Effect:** revokes `principal`'s access to the room's space. Their messages
  and reactions stay in the history.
- **Refused:** removing the room's last OWNER.

### `delivered(id: string)`

- `id: string` — The id of a notice in `outgoingNotices`. An id that isn't there
  is ignored.

Reports that a notice from `add` has been delivered. Offered with `add`, on
group rooms of their own.

- **Admitted:** without a reviewed gesture, from any member with WRITE or above.
- **Effect:** removes the notice from `outgoingNotices`.

## Renderings

- **`[UI]`** is the room's own rendering, with its reviewed surfaces and its
  composer's state: the draft, and the reply being composed. An adapter's
  rendering embeds it, so a composer is always the room's own surface.
- **`[VIEWS]`** holds a `room` group with the facts and streams above, for hosts
  that draw natively. A client uses it to show a room outside any container.
  Inside a container, it reads the placement's `chat` group instead
  ([`FabriChatPlacement.md`](FabriChatPlacement.md#outputs)).
