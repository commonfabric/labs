# ChatRoomOutput

The result of a chat room: what a room piece offers everyone the room's space
admits. It is the contract that placements, adapters, and clients read, and it
is named for the role rather than for an implementation.
[`FabriChatRoom`](FabriChatRoom.md) is an implementation of it: its result
satisfies `ChatRoomOutput`, and another pattern that satisfies it can fill the
same role. Everything in this document binds every implementation.

```ts
// Shown for illustration only.
interface ChatRoomOutput {
  about: ChatRoomAbout;

  /** What the room recorded recently, in `seq` order. */
  recentActivity: ChatRoomActivity[];

  /** The room's participants, plus any author it doesn't list. */
  participants: Cell<ChatProfile>[];

  /** Adds a profile to those who joined the room, once. */
  addParticipant: Stream<{ profile: Cell<ChatProfile> }>;

  /** The highest `seq` dropped from `recentActivity` for age; 0 for none. */
  recentActivityExpiredThrough: number;

  /** The room's messages: facts, the newest, and this session's windows. */
  messages: ChatMessageList;

  /** Whether this reader can send, edit, delete, and react. */
  canSend: boolean;

  sendMessage: Stream<{
    requestId: string;
    version: ChatMessageVersion;
    replyTo?: ChatReply;
  }>;
  editMessage: Stream<{
    requestId: string;
    message: Cell<ChatMessage>;
    version: ChatMessageVersion;
  }>;
  deleteMessage: Stream<{ requestId: string; message: Cell<ChatMessage> }>;
  obliterateMessage: Stream<{
    requestId: string;
    message: Cell<ChatMessage>;
  }>;
  sendReaction: Stream<{
    requestId: string;
    message: Cell<ChatMessage>;
    emoji: string;
  }>;
  deleteReaction: Stream<{
    requestId: string;
    message: Cell<ChatMessage>;
    emoji: string;
  }>;
  [UI]: VNode;
  [VIEWS]: { room: object };
}
```

## Where a room lives

A room is the chat of a social space (see [social
spaces](README.md#social-spaces)): a piece in that space, and a space has at
most one. A conversation the user starts, direct or group, gets a space of its
own, which the user's chat manager ([`ChatManagerOutput`](ChatManagerOutput.md))
creates with the room as its root, and never a placement, an adapter, or a
container. Such a room is a social space in its own right: opening its space
shows the room, and the room lists the space's participants itself. An existing
social space's chat is created in it by whatever sets the space up, and that
space's root stays its own. Either way, a room can also be shown in any other
social space, through a placement and an adapter, and there the other space's
root stays the root.

When the manager creates a space for a conversation, the creator and each
other member hold OWNER. Its access list MUST NOT contain the `"*"`
wildcard, so a room is not open to principals its space hasn't admitted,
except for a group room its creator makes joinable by its link (see
[`createGroup`](ChatManagerOutput.md#creategrouprequestid-string-members-string-title-string-joinablebylink-boolean)):
that one grants `"*"` WRITE, and its address is all that keeps it private. A
direct room is never joinable by its link. A room in
an existing space takes the space's access list as it is, and adds nothing to
it.

## Membership

The room space's access list is the room's membership, and a member is any
principal it admits. Every action on a room, reading a window of its messages
included, appends an event in the room's space, which needs WRITE. A member with
only READ can read the newest messages, through the room's `messages.latest`,
which needs no event, but can't open other windows, send, or react.

A room keeps no membership of its own. Who is in its space, and with what
access, is the space's business: its access list changes through the space's
own tools, such as the CLI's `cf acl`, and, for a room in a space of its own,
through the room's [`addMember`](#addmembertarget--value-string-), from
which any OWNER admits someone else as OWNER. Its root lists its
participants' profiles, claims each member contributes by joining the space: a
room in a space of its own is that root, and keeps them itself, each added
through [`addParticipant`](#addparticipantprofile-cellchatprofile); a room in
an existing social space reads them from that space's root
(`wish({ query: "#default" })`), then lists those who joined the room itself.
The two can disagree:
a member who has never joined has no entry, and an entry whose principal has
lost access stays until it's cleaned up. A consumer MUST NOT treat an entry as
proof of access.

A direct room's space is meant to keep its two members. Nothing in the room adds
anyone, but the room can't stop its space's OWNER from granting someone else
access, and a direct room whose space has grown stays `kind: "direct"`. A person
leaves a conversation by forgetting it in their manager, or by leaving its
space.

## Facts

- **`about`** is a [`ChatRoomAbout`](ChatRoomAbout.md), set once when the room
  is created.
- **Messages.** The room holds its [`ChatMessage`](ChatMessage.md)s, ordered by
  `sentAt`, which is unique in the room. A client reads the newest of them from
  `messages`, and the rest through windows (see
  [`ChatMessageList`](ChatMessageList.md#windows)), a window at a time. An
  obliterated message stays as a tombstone. Each version of a message is labeled
  `authored-by` the principal who recorded it. A message changes only through
  `editMessage`, `deleteMessage`, and `obliterateMessage`, and is never removed.
  A deleted message accepts nothing further except obliteration (see [deleted
  messages](ChatMessage.md#deleted-messages)).
- **Reactions** live on their messages, as each message's `reactions`
  ([`ChatReaction`](ChatReaction.md)), each labeled `authored-by` its reactor. A
  reaction is removed only by its own reactor, or with its message when it is
  obliterated.
- The room stores no names or avatars. Messages and reactions link people's
  profiles ([`ChatProfile`](ChatProfile.md)) and copy nothing from them.
- **`participants`** are links to profiles, compared with `equals()`: the
  profiles its space's root lists, as [membership](#membership) says, plus any
  author none of them is. They are not proof of access.
- **`messages`** is a [`ChatMessageList`](ChatMessageList.md): how many messages
  the room holds, the span of their times, and `latest`, the newest messages of
  the main conversation, which every member can read, a READ member included. It
  also holds the reading session's own windows onto the messages, and the
  streams that open and close them.
- **`canSend`** says whether the reader can send, edit, delete, and react right
  now: their access is WRITE or OWNER, and their profile resolves. It lets a
  client tell a READ member why their gestures would be refused before they
  make one.
- **`recentActivity`** is a log of what the room recorded recently: each message
  sent, edited, deleted, or obliterated, and each reaction added or removed, as
  a [`ChatRoomActivity`](ChatRoomActivity.md), in `seq` order. A client follows
  a room by reading it, rather than by comparing messages with what it had, and
  finds the message a send of its own produced there. It holds entries within
  the room's `recentActivityWindowNsec`.
- **`recentActivityExpiredThrough`** is the highest `seq` the room has dropped
  from `recentActivity` for age, or 0 if it has dropped none. A client compares
  it with the highest `seq` it has seen to tell whether it has missed anything
  (see [`ChatRoomActivity`](ChatRoomActivity.md#catching-up)).
- The lists here are projections. An implementation may keep each message's
  reactions as keyed collections, as long as what it offers satisfies these
  rules.

## Scopes

A room's fields fall into two [scopes](../scoped-cell-instances.md#summary),
plus one value computed for each reader, and the difference matters to a client:

- **`PerSpace`**: one instance for the whole room, the same for everyone the
  room's space admits. That is nearly everything: `about`, the messages,
  `recentActivity` and `recentActivityExpiredThrough`, `participants`, and the
  streams. These are the room: a link to the room names them, and passing the
  link around, to another component or another person, passes the room.
- **`PerSession`**: one instance per memory session in the room's space. That is
  only `messages.windows`, the windows a session has opened onto the messages
  (see [`ChatMessageList`](ChatMessageList.md#scope)). Passing the room's link
  to someone else never passes a session's windows: they read their own.
- **Computed for each reader**: `canSend`. It is derived when it's read, from
  the reader's own access and profile, so each reader sees their own answer,
  through the room or through a placement, and it needs no instance and no
  write.

Some values are derived when they're read, and stored nowhere, so reading them
needs no instance of anything: `participants`, and in `messages`, everything but
`windows`. A session's windows come into being with its first `openWindow`, so a
READ member, who can't write, never has any, and can still read
`messages.latest`.

Nothing in a room is `PerUser`.

## Streams

Each stream is a one-way, asynchronous request to the room. Sending an event
finishes when the event is accepted, not when it takes effect, and returns no
value: a sender observes the effect in the room's facts. An event is appended in
the room's space, so sending needs write access there, and the room acts on it
later, possibly in another runtime.

Each stream below is written as a call, with its event's keys as the parameters:
`sendReaction(requestId: string, message: Cell<ChatMessage>, emoji: string)`
sends `{ requestId, message, emoji }`.

No event names its sender. The room learns who sent it from the event's actor:
the principal the memory server stamps on the appended event from its
authenticated commit, beside the payload rather than in it (`firedAt.user`, see
[events](../server-side-execution/events.md)), or, for a handler that runs in
the sender's own runtime, that runtime's user. Below, **the sender** is that
principal, and **the sender's profile** is the profile
`wish({ query: "#profile" })` resolves to for it (see [per-demanding-identity
wish resolution](../server-side-execution/builtins.md)): the sender's default
profile, or their most recently used one. The sender can't choose which, and
when it resolves to none, as when they have several profiles and no default, the
event is refused.

These rules hold for every stream:

- Every event carries a `requestId`, which the sender chooses, unique among its
  requests, such as a random 128-bit value. The room acts on a given sender's
  `requestId` at most once: an event whose sender and `requestId` it has already
  acted on changes nothing. That protects against the same event taking effect
  twice, as when a served handler runs an event again because its first run's
  completion wasn't recorded. (A client runtime's own re-submission of an event
  is ignored when it arrives, by its event id.) A client doesn't send an event
  again itself: a trusted gesture can't be re-issued from a client's code (see
  [`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)), and a
  person who tries again makes a new request.
- The room remembers a `requestId` for at least `proposedTimeMaxAgeNsec` plus
  `proposedTimeMaxLeadNsec`, and at least `recentActivityWindowNsec`, measured
  from when it recorded the request. By then a repeated `sendMessage` or
  `editMessage` is refused anyway, since its proposal is outside the window. For
  other streams, a repeat later than that could undo a later request, such as a
  reaction removed and then restored. So a room relies on its runtime finishing
  or dropping every event well within that time (see
  [`FabriChatRoom`](FabriChatRoom.md#prerequisites)).

- A stream that names a reviewed surface admits an event only as a trusted
  gesture on that surface (see
  [`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)), and the
  record it writes is labeled `authored-by` the principal who sent it.
- `sendMessage`, `editMessage`, and `sendReaction` record the sender's profile,
  and refuse an event that arrives before it resolves. The
  other streams don't depend on a profile.
- A refusal is silent: the room records no outcome, so a sender can't tell a
  refused event from one that hasn't taken effect yet. A room could record
  outcomes, as the manager does in `requests`, but a room's record is shared by
  every member, so an outcome there would tell everyone about each member's
  refused requests. A room keeps them to itself instead. A client MUST check an
  event against the stream's rules before sending it (see
  [`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)).
- A refused event is spent: it is not retried.

| Stream | Reviewed surface | Effect |
| --- | --- | --- |
| [`sendMessage`](#sendmessagerequestid-string-version-chatmessageversion-replyto-chatreply) | `ChatSendSurface` | appends a message from the sender, once |
| [`editMessage`](#editmessagerequestid-string-message-cellchatmessage-version-chatmessageversion) | `ChatEditSurface` | records a new version of the sender's message, once |
| [`deleteMessage`](#deletemessagerequestid-string-message-cellchatmessage) | `ChatDeleteSurface` | records the sender's message as deleted |
| [`obliterateMessage`](#obliteratemessagerequestid-string-message-cellchatmessage) | `ChatObliterateSurface` | removes a message and its history, leaving a tombstone |
| [`sendReaction`](#sendreactionrequestid-string-message-cellchatmessage-emoji-string) | `ChatReactSurface` | adds the sender's reaction, if it isn't there |
| [`deleteReaction`](#deletereactionrequestid-string-message-cellchatmessage-emoji-string) | `ChatReactSurface` | removes the sender's reaction, if it's there |

### `sendMessage(requestId: string, version: ChatMessageVersion, replyTo?: ChatReply)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  room acts on a request at most once (see [streams](#streams)).
- `version: ChatMessageVersion` — The message to send, as a
  [`ChatMessageVersion`](ChatMessageVersion.md):
  - `version.body` is the message's text, exactly as the person saw it when they
    sent it. It must be a string, not empty or only whitespace.
  - `version.sentAt` is the time the sender's client proposes for the message,
    chosen once when the person sends it. It is a hint to the room about when
    the message was sent, not an identifier: two sends can propose the same
    time.
- `replyTo?: ChatReply` — What the message replies to, and where it is shown
  (see [`ChatReply`](ChatReply.md)). Absent for a message that isn't a reply,
  which is shown in the main conversation. `replyTo.message` must be a message
  in this room, and a `"main"` reply must be to a message the main conversation
  shows.

Sends a message from the sender.

- **Admitted:** as a trusted gesture on `ChatSendSurface`.
- **Effect:** appends a [`ChatMessage`](ChatMessage.md) to the room's messages,
  with the sender's profile as `authorProfile`, `version.body` as `body`, no
  `earlierVersions`, and no reactions. Its `sentAt` is chosen as [recorded
  times](#recorded-times) describes. A reply's is then raised, if need be, to
  later than its target's `sentAt`, so a reply never sorts before the message it
  replies to. Last, it is made unique as [unique
  times](ChatMessage.md#unique-times) states.
- **Refused:** a `version.body` that isn't a non-empty string, a
  `version.sentAt` outside the room's window (see [recorded
  times](#recorded-times)), a `replyTo` whose `message` is in another room, a
  `shownIn` other than `"main"`, `"thread"`, or `"both"`, a `"main"` reply to a
  message shown only in a thread, or a reply to a deleted message.

Two messages with the same text are two sends with two request ids, so sending
"YES!" three times makes three messages, whatever times they propose.

#### Recorded times

A room decides the time it records for a send (`sentAt`) or an edit (`editedAt`)
from the sender's proposed time and its own handler clock, within a window its
policy states (`proposedTimeMaxAgeNsec` and `proposedTimeMaxLeadNsec`, see
[`ChatRoomPolicy`](ChatRoomPolicy.md)). Every time here is a `FabricEpochNsec`.
The handler clock reads a coarse time in milliseconds, which a room converts by
multiplying by 10⁶, as conversion from a `Date` does.

The handler clock is the time of the event that set the handler running (see the
[timing side-channel mitigations](../sandboxing/TIMING_SIDE_CHANNELS.md)). When
the room's handler runs on the room's side (served execution), that is when the
room took the event, and the window below bounds how far a sender's clock can
place a message. When the handler runs in the sender's own runtime, the handler
clock is the sender's own clock, and the window bounds only a proposal against
that same clock, which is a formality.

The window reaches a different distance on each side of the handler clock,
because a proposal lands on each side for a different reason:

- **Before the clock**, by up to `proposedTimeMaxAgeNsec`. A proposal is older
  than the clock for ordinary reasons: the network's delay, a retry, a client
  that queued the send while offline. So this side can be generous.
- **After the clock**, by up to `proposedTimeMaxLeadNsec`. A proposal is newer
  than the clock only because the sender's clock runs ahead of the room's, so
  this side only needs to cover clock skew, and can be small.

A proposal within the window is recorded as the time, except that a proposal
after the clock is recorded at the current time (see below). The room MAY adjust
the time first, for example to coarsen it to the system's clock resolution. A
proposal outside the window is refused, silently, like any refusal: it is a very
stale retry, a badly wrong clock, or a forgery.

Whatever the proposal, a room MUST NOT record a time later than its own current
time, meaning its handler clock's reading when it makes the record. A proposal
after the clock, within `proposedTimeMaxLeadNsec`, is accepted, but recorded at
a time no later than the current time.

Two things can carry a recorded time past the current time. One is the floor
that keeps a reply later than its target (see
[`sendMessage`](#sendmessagerequestid-string-version-chatmessageversion-replyto-chatreply)),
since the target may have been recorded by a clock ahead of this one. The other
is the steps added to make a time unique (see [unique
times](ChatMessage.md#unique-times)), which never carry it past the end of the
current clock tick. A handler clock reading stands for a whole tick of the
system's clock resolution, so a reading of `t` with a resolution of `r` covers
times from `t` up to, but not including, `t + r`, and a bumped time stays within
that range.

Accepting a sender's time lets a sender place a message earlier than it arrived,
by up to `proposedTimeMaxAgeNsec`, but never later than it arrived. That is the
cost of the window's older side, and why each room states it.

### `editMessage(requestId: string, message: Cell<ChatMessage>, version: ChatMessageVersion)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  room acts on a request at most once (see [streams](#streams)).
- `message: Cell<ChatMessage>` — The message to edit. Must be a message in this
  room, sent by the sender, and not deleted.
- `version: ChatMessageVersion` — The new version, as a
  [`ChatMessageVersion`](ChatMessageVersion.md):
  - `version.body` is the new text, exactly as the person saw it when they
    edited it. It must be a string, not empty or only whitespace.
  - `version.sentAt` is the time the sender's client proposes for the edit,
    chosen once when the person makes it. It is a hint to the room, as for
    `sendMessage`.

Records a new version of one of the sender's messages.

- **Admitted:** as a trusted gesture on `ChatEditSurface`, and only from the
  message's sender.
- **Effect:** makes `version.body` the message's current version. Its `editedAt`
  is chosen as [recorded times](#recorded-times) describes, then made unique as
  [unique times](ChatMessage.md#unique-times) states. The version it replaces
  goes to `earlierVersions`, as far as the implementation's history rules keep
  it. `authorProfile`, `sentAt`, `replyTo`, and the reactions don't change.
- **Refused:** a `message` in another room, sent by someone else, or deleted, a
  `version.body` that isn't a non-empty string, or a `version.sentAt` outside
  the room's window.

Two edits with the same text are two edits with two request ids, so they record
two versions.

### `deleteMessage(requestId: string, message: Cell<ChatMessage>)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  room acts on a request at most once (see [streams](#streams)).
- `message: Cell<ChatMessage>` — The message to delete. Must be a message in
  this room, sent by the sender, and not already deleted.

Records one of the sender's messages as deleted.

- **Admitted:** as a trusted gesture on `ChatDeleteSurface`, and only from the
  message's sender.
- **Effect:** depends on whether the implementation makes deletion obliteration
  (see [implementation-defined behavior](#implementation-defined-behavior)):
  - If it does, the message is obliterated, exactly as `obliterateMessage` would
    by its sender: a tombstone labeled with the sender, with no `authorProfile`,
    history, or reactions (see [obliterated
    messages](ChatMessage.md#obliterated-messages)).
  - If it doesn't, the version being deleted goes to `earlierVersions` first, as
    `{ body, sentAt }` with the time it was recorded, where the room's policy
    keeps history (`keepsHistory`). Then the message's `body` becomes exactly
    `{ deleted: true }`, recorded at the handler clock as `editedAt`, made
    unique as [unique times](ChatMessage.md#unique-times) states, and its
    reactions are removed. Its `authorProfile` and history stay, so a room that
    keeps history keeps the deleted text in it.

  Either way, no reaction outlives the deletion, and the message stays among the
  room's messages, so replies to it and threads rooted at it keep their links.
- **Refused:** a `message` in another room, sent by someone else, or already
  deleted.

### `obliterateMessage(requestId: string, message: Cell<ChatMessage>)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  room acts on a request at most once (see [streams](#streams)).
- `message: Cell<ChatMessage>` — The message to obliterate. Must be a message in
  this room that the sender may obliterate: in a direct room, one the sender
  sent; elsewhere, anyone's, if the sender is an OWNER.

Removes a message entirely, with its history. In a group room, it is how an
OWNER curates the conversation, and an outward act, since it removes someone
else's words. In a direct room, it is how either person removes
their own words completely.

- **Admitted:** as a trusted gesture on `ChatObliterateSurface`. In a direct
  room, from either member, for their own messages only: being the room's
  creator, and so its OWNER, doesn't extend to the other person's messages.
  Elsewhere, only from a member the room space's access list makes OWNER, if the
  implementation allows OWNERs to obliterate (see [implementation-defined
  behavior](#implementation-defined-behavior)). A member who isn't an OWNER
  takes back their own message completely by deleting it, where the
  implementation makes deletion obliteration.
- **Effect:** reduces the message to a tombstone (see [obliterated
  messages](ChatMessage.md#obliterated-messages)): its `body` becomes
  `{ deleted: true }`, its `editedAt` the handler clock, made unique as [unique
  times](ChatMessage.md#unique-times) states, and its `authorProfile`,
  `earlierVersions`, and `reactions` are removed. `sentAt` and `replyTo` stay.
  The tombstone is labeled `authored-by` the sender, whoever obliterated it.
- **Afterward:** the times the removed versions and reactions were recorded at
  stay used, and a retry of the original send doesn't send the message again:
  the room still remembers the send's `requestId`, for as long as it remembers
  any.
- **Refused:** a `message` in another room, a direct room's message sent by the
  other person, or, elsewhere, a sender who isn't an OWNER, or an OWNER the
  implementation doesn't allow to obliterate. Obliterating a message that is
  already obliterated changes nothing.

### `sendReaction(requestId: string, message: Cell<ChatMessage>, emoji: string)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  room acts on a request at most once (see [streams](#streams)).
- `message: Cell<ChatMessage>` — The message reacted to. Must be a message in
  this room.
- `emoji: string` — A single emoji: exactly one emoji sequence that [Unicode
  Technical Standard #51](https://www.unicode.org/reports/tr51/) recommends for
  general interchange (`RGI_Emoji`). It may be more than one code point, as with
  a skin-tone modifier or a ZWJ-joined sequence, but it is one emoji. Not text,
  and not two emoji together.

Adds the sender's reaction to a message.

- **Admitted:** as a trusted gesture on `ChatReactSurface`.
- **Effect:** if the sender has no reaction with `emoji` on `message`, adds a
  [`ChatReaction`](ChatReaction.md) to that message's `reactions`, recorded at
  the handler clock as its `sentAt`, made unique as [unique
  times](ChatMessage.md#unique-times) states. If they already have one, nothing
  changes, and it keeps its `sentAt`. No one else's reaction changes, and
  neither does the message itself.
- **Refused:** a `message` in another room or deleted, or an `emoji` that isn't
  a single emoji.

Adding a reaction that's already there changes nothing, even under a new
`requestId`, and so does removing one that isn't.

### `deleteReaction(requestId: string, message: Cell<ChatMessage>, emoji: string)`

- `requestId: string` — Chosen by the sender, and unique among its requests. The
  room acts on a request at most once (see [streams](#streams)).
- `message: Cell<ChatMessage>` — The message whose reaction to remove. Must be a
  message in this room.
- `emoji: string` — A single emoji: exactly one emoji sequence that [Unicode
  Technical Standard #51](https://www.unicode.org/reports/tr51/) recommends for
  general interchange (`RGI_Emoji`). It may be more than one code point, as with
  a skin-tone modifier or a ZWJ-joined sequence, but it is one emoji. Not text,
  and not two emoji together.

Removes the sender's reaction to a message.

- **Admitted:** as a trusted gesture on `ChatReactSurface`.
- **Effect:** if the sender has a reaction with `emoji` on `message`, removes
  it. If they don't, nothing changes. No one else's reaction changes, and
  neither does the message itself.
- **Refused:** a `message` in another room or deleted, or an `emoji` that isn't
  a single emoji.

A client never toggles: it sends whichever of the two the person asked for, so a
repeated or delayed event can't undo what the person meant.

### `addMember(target: { value: string })`

- `target.value: string` — The chat address of the person to admit: a
  principal's DID, as the room's add control holds it.

Admits someone to a room's space. Unlike the streams above, it is part of the
room's own rendering, not of `[VIEWS]`: only that rendering's add control can
send it.

- **Admitted:** as a trusted DOM gesture on `ChatAddMemberSurface`, from an
  OWNER of the room's space, for a room in a space of its own. A host's
  reviewed action that is not a DOM gesture is refused.
- **Effect:** grants the principal OWNER on the room's space, so they too may
  add others. Granting someone the OWNER they already hold changes nothing.
- **Refused:** an address that is not a principal's DID, a sender without
  OWNER, a room that shares an existing space, and anything the space's access
  list refuses. The rendering tells the session what came of its add.

### `addParticipant(profile: Cell<ChatProfile>)`

- `profile: Cell<ChatProfile>` — A person's profile, as the live cell in its
  own space.

Adds a profile to those who joined the room, the participants a room in a
space of its own keeps for its space. Like `addMember`, and unlike the streams
in the table, it takes no `requestId`: a profile already listed is not added
again, so a repeat changes nothing. Any participant may add any profile, so an
entry is a claim, and the room's rendering offers a viewer whose profile isn't
listed a control that adds their own.

- **Admitted:** without a reviewed gesture.
- **Effect:** adds the profile to the room's participants, unless it is listed
  already. The profile's document must carry a label, as a profile does.

## Renderings

- **`[UI]`** is the room's own rendering, with its reviewed surfaces. An
  adapter's rendering embeds it, so a composer is always the room's own surface.
- **`[VIEWS]`** holds a `room` group with the facts and streams above, for hosts
  that draw natively. It includes `messages`, through whose link a client
  reaches its own windows and their streams, and `canSend`. A client uses it to
  show a room outside any container. Inside a container, it reads the
  placement's `chat` group instead
  ([`FabriChatPlacement.md`](FabriChatPlacement.md#outputs)).

## Implementation-defined behavior

This contract leaves some of what a room allows to its implementation, because
rooms legitimately differ. A room where people share personal details may let
anyone take back what they said, while a room under a strict retention
requirement may be legally required to keep everything. The contract doesn't fix
these, and an implementation MUST state its choice for each in its rooms'
`about.policy`:

- **Deletion as obliteration.** Whether a sender deleting their own message
  obliterates it, which is how a member of a group room takes back what they
  said completely.
- **Obliteration at all.** Whether an OWNER may obliterate messages.
- **What an edit keeps** in a message's history.
- **The limits on message windows**: how many messages a window holds
  (`maxWindowCount`), and how many a session can have open (`maxOpenWindows`).
- **The window of accepted proposed times**, on each side of the clock (see
  [recorded times](#recorded-times)).
- **How long recent activity lasts** in `recentActivity`, at least as long as
  the window's older side.

An implementation may make these configurable, per room or otherwise, and how it
does so is its own business (see
[`FabriChatRoom`](FabriChatRoom.md#configuration)).

`about.policy` links a [`ChatRoomPolicy`](ChatRoomPolicy.md), and an
implementation MUST state it correctly: a client reads a room's choices there,
and can rely on them. One thing is not a choice: a direct room MUST let either
person obliterate their own messages.

## Open questions

- **Membership's open questions belong to the space.** Returning after leaving,
  and being added without consent, are questions about a space's access list
  and its tools, and a room changes neither.
