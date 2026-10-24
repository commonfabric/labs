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

  /** The room's participants, plus any author it doesn't list. */
  participants: Cell<ChatProfile>[];

  /** Those who joined the room itself, in the order they joined. */
  roster: Cell<ChatProfile>[];

  /** Each participant's profile, with the principal it attests. */
  participantEntries: PerSession<
    { profile: Cell<ChatProfile>; principal?: string }[]
  >;

  /** The principals `participantEntries` holds, once each. */
  participantPrincipals: PerSession<string[]>;

  /** Adds a profile to those who joined the room, once. */
  addParticipant: Stream<{ profile: Cell<ChatProfile> }>;

  /** The room's messages: facts, the newest, and its threads. */
  messages: ChatMessageList;

  /** Whether this reader can send, edit, delete, and react. */
  canSend: boolean;

  /** Who is reading the room: their profile, its principal, their access. */
  viewer: {
    profile?: Cell<ChatProfile>;
    principal?: string;
    role?: "OWNER" | "WRITE" | "READ" | "none";
  };

  /** What this reader may do to each message, oldest first. */
  messageRights: {
    message: Cell<ChatMessage>;
    canEdit: boolean;
    canDelete: boolean;
    canObliterate: boolean;
  }[];

  sendMessage: Stream<{ body: string; replyTo?: ChatReply }>;
  editMessage: Stream<{ message: Cell<ChatMessage>; body: string }>;
  deleteMessage: Stream<{ message: Cell<ChatMessage> }>;
  obliterateMessage: Stream<{ message: Cell<ChatMessage> }>;
  sendReaction: Stream<{ message: Cell<ChatMessage>; emoji: string }>;
  deleteReaction: Stream<{ message: Cell<ChatMessage>; reaction: Cell<ChatReaction> }>;

  /**
   * Admits someone to the room's space, from a trusted gesture, and has the
   * reader's manager tell them of the room.
   */
  addMember: Stream<{
    requestId: string;
    target?: { value: string };
    profile?: Cell<ChatProfile>;
  }>;

  /** Whether this reader can add someone to the room's space. */
  canAdd: boolean;

  /** The outcome of each of this reader's adds, by its `requestId`. */
  addRequests: Record<
    string,
    | {
      status: "done";
      delivery?: "offered" | "noticed" | "access-only";
      deliveryRefusal?: string;
    }
    | { status: "refused"; reason: string; code?: "direct-room" }
  >;

  /** Sets the room's title, which every member shares. */
  setTitle: Stream<{ requestId: string; title: string }>;

  /** The outcome of each of this reader's retitles, by its `requestId`. */
  titleRequests: Record<
    string,
    | { status: "done" }
    | {
      status: "refused";
      reason: string;
      code: "not-member" | "invalid-title" | "fixed-title";
    }
  >;
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
shows the room, and the room lists the space's participants itself. The room
is at the address the space's genesis reserves for a root, and the space
declares itself a `fabrichat-room`
([space kinds](../../features/space-kinds.md)), which is how a host vetting an
offer of the room tells what the space is. An existing social space's chat is
created in it by whatever sets the space up, and that space's root stays its
own. Either way, a room can also be shown in any other social space, through a
placement and an adapter, and there the other space's root stays the root.

When the manager creates a space for a conversation, the creator and each
other member hold OWNER. Its access list MUST NOT contain the `"*"`
wildcard, so a room is not open to principals its space hasn't admitted,
except for a group room its creator makes joinable by its link (see
[`createGroup`](ChatManagerOutput.md#creategrouprequestid-string-members-string-profiles-cellchatprofile-title-string-joinablebylink-boolean)):
that one grants `"*"` WRITE, and its address is all that keeps it private. A
direct room is never joinable by its link. A room in
an existing space takes the space's access list as it is, and adds nothing to
it.

## Membership

The room space's access list is the room's membership, and a member is any
principal it admits. Every action on a room appends an event in the room's
space, which needs WRITE. A member with only READ can read the messages, which
needs no event, but can't send or react.

A room keeps no membership of its own. Who is in its space, and with what
access, is the space's business: its access list changes through the space's
own tools, such as the CLI's `cf acl`, and, for a group room in a space of its
own, through the room's [`addMember`](#addmemberrequestid-string-target--value-string--profile-cellchatprofile), from
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

- **`about`** is a [`ChatRoomAbout`](ChatRoomAbout.md), set when the room is
  created. Its `title` changes through
  [`setTitle`](#settitlerequestid-string-title-string), and the rest of it
  never does.
- **Messages.** The room holds its [`ChatMessage`](ChatMessage.md)s, in the
  order it recorded them, each identified by its cell. A client reads the
  newest of them from `messages`, and the rest from the stored messages
  themselves (see [`ChatMessageList`](ChatMessageList.md#reading-the-rest)). An
  obliterated message stays as a tombstone. A message is labeled `authored-by`
  the principal who last wrote it. A message changes only through
  `editMessage`, `deleteMessage`, and `obliterateMessage`, and is never removed.
  A deleted message accepts nothing further except obliteration (see [deleted
  messages](ChatMessage.md#deleted-messages)).
- **Reactions** live on their messages, as each message's `reactions`
  ([`ChatReaction`](ChatReaction.md)), each labeled `authored-by` its reactor. A
  reaction is removed only by its own reactor, or goes out of reach with its
  message when the message is deleted or obliterated.
- The room stores no names or avatars. Messages and reactions link people's
  profiles ([`ChatProfile`](ChatProfile.md)) and copy nothing from them.
- **`participants`** are links to profiles, compared with `equals()`: the
  profiles its space's root lists, as [membership](#membership) says, plus any
  author none of them is, each once. They are not proof of access.
- **`roster`** holds the profiles of those who joined the room itself, each
  added once through
  [`addParticipant`](#addparticipantprofile-cellchatprofile), in the order they
  were added: for a room in a space of its own, its space's participants. It
  lists no author it doesn't hold, so it is read from what the room stores
  alone, without reading the room's messages, which is how a chat manager reads
  who is in each of its user's rooms (see
  [`ChatIndexEntry`](ChatIndexEntry.md#fields)). Like `participants`, it is a
  claim, not proof of access.
- **`participantEntries`** pairs each of `participants` with the principal it
  stands for: one entry per participant, in the order of `participants`,
  holding its `profile` and, as `principal`, the principal its profile's
  `represents-principal` label attests. An entry has no `principal` when its
  profile attests none, or when the label can't be read where the list is
  derived, as when the profile's space refuses the reader, so two readers can
  read different principals for the same participant. It is derived for each
  reader and is best effort, not an access list, and like `participants` it is
  a claim, not proof of access. A client uses it to name each participant and
  to tell which of them is the reader, whose entry holds the reader's own
  principal.
- **`participantPrincipals`** is derivable from `participantEntries`: each
  `principal` the entries hold, once, in the order of `participants`. Like the
  entries, it is a best-effort list of who is already in the room, not an
  access list. A client uses it to leave the people already in the room out of
  its own add control.
- **`messages`** is a [`ChatMessageList`](ChatMessageList.md): how many messages
  the room holds, the span of their times, `latest`, the newest messages of
  the main conversation, and `threads`, each thread's reply count and latest
  reply time, which every member can read, a READ member included.
- **`canSend`** says whether the reader can send, edit, delete, and react right
  now: their access is WRITE or OWNER, and their profile resolves. It lets a
  client tell a READ member why their gestures would be refused before they
  make one.
- **`viewer`** says who is reading the room. Its `profile` is the reader's
  profile, absent until it resolves, as a link to the profile itself: the link
  `sendMessage` records as a message's `authorProfile`, so a client tells the
  reader's own messages from the rest by comparing the two links, and finds
  the reader among `participants` the same way. Its `principal` is the
  principal that profile's `represents-principal` label attests, absent where
  it attests none or the label can't be read, as for `participantEntries`. Its
  `role` is the reader's access to the room's space, as the space's access
  list grants it (`OWNER`, `WRITE`, `READ`, or `none`), absent while that
  isn't known. Like `participantEntries`, the profile and the principal are
  claims, not proof of access.
- **`messageRights`** says what the reader may do to each of the room's
  messages: one entry per message, oldest first, holding the `message`, as the
  link to its own cell that every field of the room naming it holds, and
  `canEdit`, `canDelete`, and `canObliterate`, decided by the rules the streams
  below admit an event by, so a client offers exactly the acts the room would
  take. Every entry is all `false` while `canSend` doesn't hold.
- **`canAdd`** says whether the reader can add someone to the room's space: the
  room is a group room in a space of its own, and their access is OWNER. It is
  false in a direct room, whose space keeps its two members, and in a space's
  own chat. A client offers its own add control only where it holds.
- **`addRequests`** holds the outcome of each of the reader's
  [`addMember`](#addmemberrequestid-string-target--value-string--profile-cellchatprofile)
  requests, by its `requestId`, and for each add that is done, how the person
  added was told of the room, once that is decided. It reads the verdicts from
  the reader's own manager, so it is the reader's alone, like the outcomes it
  holds.
- **`titleRequests`** holds the outcome of each of the reader's
  [`setTitle`](#settitlerequestid-string-title-string) requests, by its
  `requestId`. Like `addRequests`, it is the reader's alone.
- **`fileStore`** links the store of the files of the room's space (see
  [`FileStore`](../fabrifile/FileStore.md#where-it-lives)): for a room that is
  its space's root, the store the room names itself, and for any other, the
  one its space's root names. It is absent while that names none, and in a
  space whose root keeps no store.
- **`fileStoreRecord`**, for a room that is its space's root, is where it keeps
  that store, offered as any root offering its space's store offers it (see
  [`FileStore`](../fabrifile/FileStore.md#where-it-lives)). Any other room
  keeps none, and offers none.
- The lists here are projections. An implementation may keep each message's
  reactions as a list of their own, as long as what it offers satisfies these
  rules.

## Scopes

A room's fields fall into three [scopes](../scoped-cell-instances.md#summary),
plus two values computed for each reader, and the difference matters to a
client:

- **`PerSpace`**: one instance for the whole room, the same for everyone the
  room's space admits. That is nearly everything: `about`, the messages,
  `participants` and `roster`, and the streams. These are the room: a link to the room names them,
  and passing the link around, to another component or another person, passes
  the room.
- **`PerSession`**: one instance per memory session in the room's space. That is
  `participantEntries` and `participantPrincipals`, which each session derives
  under its own access. Passing the room's link to someone else passes neither:
  they read their own.
- **`PerUser`**: one instance per user, which follows them across sessions.
  That is only `addRequests` and `titleRequests`, the outcomes of the reader's
  own adds and retitles. No one else reads them.
- **Computed for each reader**: `canSend`, `canAdd`, `viewer`, and
  `messageRights`. Each is derived when it's read, from the reader's own access
  and profile, so each reader sees their own answer, and it needs no instance
  and no write. A placement carries `canSend` and `canAdd` as well.

Some values are derived when they're read, and stored nowhere, so reading them
needs no instance of anything: `participants`, `roster`, and everything in
`messages`.

## Streams

Each stream is a one-way, asynchronous request to the room. Sending an event
finishes when the event is accepted, not when it takes effect, and returns no
value: a sender observes the effect in the room's facts. An event is appended in
the room's space, so sending needs write access there, and the room acts on it
later, possibly in another runtime.

Each stream below is written as a call, with its event's keys as the parameters:
`sendReaction(message: Cell<ChatMessage>, emoji: string)` sends
`{ message, emoji }`.

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

- Every event takes effect at most once: the runtime delivers each durable
  stream entry to its handler exactly once, and deduplicates a client's re-sent
  append at its event id ([events](../server-side-execution/events.md), §4),
  so the room keeps no memory of the events it has acted on. A client doesn't
  send an event again itself: a trusted gesture can't be re-issued from a
  client's code (see
  [`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)), and a
  person who tries again makes a new request, which takes effect again: two
  sends of the same text are two messages.

- A stream that names a reviewed surface admits an event only as a trusted
  gesture on that surface (see
  [`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)), and the
  record it writes is labeled `authored-by` the principal who sent it.
- `sendMessage`, `editMessage`, and `sendReaction` record the sender's profile,
  and `deleteMessage` and `deleteReaction` read it to tell the sender's own
  message or reaction. Each refuses an event that arrives before it resolves.
  `obliterateMessage` reads it only to tell whether a message is the sender's
  own.
- Writing in a room is joining it. When `sendMessage` appends a message,
  `sendReaction` adds a reaction, or `setTitle` sets the title, in a room in a
  space of its own, the room
  sends the sender's manager's
  [`joinRoom`](ChatManagerOutput.md#joinroomrequestid-string-room-cellchatroomoutput),
  so a room the sender reached by its link, or forgot, becomes one of their
  chats. A message or a reaction marks its `joinRoom` `messageAct`, which
  leaves the title the manager's catalog lists the room under as it is; a
  retitle's carries no mark. The manager checks membership in its own
  Home-space event and leaves an already saved room unchanged. The room reads no private catalog and sends
  nothing for a sender with no manager. It sends `joinRoom` in an event of its
  own, once the write has landed, so the write reads nothing of the manager. A
  manager in a person's Home can carry a confidentiality label, such as their
  `PersonalSpace`, that the room's space doesn't admit, and anything the room
  stores that read it would be refused. So what the room stores about joining
  says only whether the room is one a manager can take the sender into, and
  only the join's own event, which writes nothing in the room's space, reads
  whether the sender has a manager: such a manager is still told of the join.
- A message act the room refuses writes nothing, and its run fails with a
  reason a person can read. A send that awaits its handling, as a reviewed act
  does, is rejected with that reason, and under server execution it is the
  event's error consequence (see [events](../server-side-execution/events.md)).
  The room's rendering offers only acts the viewer can take, so a refusal is
  how a client learns that an event it sent broke the stream's rules, a
  payload of the wrong shape included. An act that would change nothing, such
  as adding a reaction that is already there, is no refusal: it succeeds and
  writes nothing. An add's outcome is recorded in `addRequests`, and a
  retitle's in `titleRequests`, each `refused` with a reason and a code. A
  client checks an event against the stream's rules before sending it (see
  [`clients.md`](clients.md#writing-the-reviewed-gesture-requirement)).
- A refused event is spent: it is not retried.

| Stream | Reviewed surface | Effect |
| --- | --- | --- |
| [`sendMessage`](#sendmessagebody-string-replyto-chatreply-attachments-cellfileentry) | `ChatSendSurface` | appends a message from the sender, once |
| [`editMessage`](#editmessagemessage-cellchatmessage-body-string) | `ChatEditSurface` | records a new version of the sender's message, once |
| [`deleteMessage`](#deletemessagemessage-cellchatmessage) | `ChatDeleteSurface` | records the sender's message as deleted |
| [`obliterateMessage`](#obliteratemessagemessage-cellchatmessage) | `ChatObliterateSurface` | removes a message and its history, leaving a tombstone |
| [`sendReaction`](#sendreactionmessage-cellchatmessage-emoji-string) | `ChatReactSurface` | adds the sender's reaction, if it isn't there |
| [`deleteReaction`](#deletereactionmessage-cellchatmessage-reaction-cellchatreaction) | `ChatReactSurface` | removes the sender's reaction, the one named |

### `sendMessage(body: string, replyTo?: ChatReply, attachments?: Cell<FileEntry>[])`

- `body: string` — The message's text, exactly as the person saw it when they
  sent it. It must be a string, not empty or only whitespace unless the
  message has attachments.
- `replyTo?: ChatReply` — What the message replies to, and where it is shown
  (see [`ChatReply`](ChatReply.md)). Absent for a message that isn't a reply,
  which is shown in the main conversation. `replyTo.message` must be a message
  in this room, and a `"main"` reply must be to a message the main conversation
  shows.
- `attachments?: Cell<FileEntry>[]` — The files sent with the message, in
  order: entries of the store of the room's space (see
  [`FileEntry`](../fabrifile/FileEntry.md)), none of them removed, and no more
  of them than the room's `maxAttachments` (see
  [implementation-defined behavior](#implementation-defined-behavior)). Absent
  or empty for none. A client adds a file to the store before it attaches it
  (see [attaching a file](../fabrifile/clients.md#attaching-a-file)).

Sends a message from the sender.

- **Admitted:** as a trusted gesture on `ChatSendSurface`.
- **Effect:** appends a [`ChatMessage`](ChatMessage.md) to the room's messages,
  with the sender's profile as `authorProfile`, `body` as `body`, links to the
  `attachments` in their order where there are any, the handler clock as
  `sentAt` (see [times](ChatMessage.md#times)), and no reactions. The room
  reads each attachment's entry, and nothing else of the store.
- **Refused:** a `body` that isn't a string, or is empty in a send with no
  attachments; a sender whose profile hasn't resolved; a `replyTo` whose
  `message` is outside the room's space; more attachments than the room's
  `maxAttachments`; or an attachment that names no entry, an entry outside the
  room's space, one whose blob is in another space's blob store, or one removed
  from its store.
  Otherwise the room takes `replyTo` as sent: a client sends a reply only to a
  message of the room that is not deleted, with a `shownIn` its target allows
  (see [`ChatReply`](ChatReply.md)).

Two messages with the same text are two sends, so sending "YES!" three times
makes three messages.

### `editMessage(message: Cell<ChatMessage>, body: string)`

- `message: Cell<ChatMessage>` — The message to edit. Must be a message in this
  room, sent by the sender, and not deleted.
- `body: string` — The new text, exactly as the person saw it when they edited
  it. It must be a string, not empty or only whitespace unless the message has
  attachments.

Records new text for one of the sender's messages.

- **Admitted:** as a trusted gesture on `ChatEditSurface`, and only from the
  message's sender.
- **Effect:** makes `body` the message's text, and the handler clock its
  `editedAt`. The text it replaces is gone. `authorProfile`, `sentAt`,
  `replyTo`, the attachments, and the reactions don't change.
- **Refused:** a `message` outside the room's space, sent by someone else, or
  deleted, or a `body` that isn't a string, or is empty in a message with no
  attachments.

### `deleteMessage(message: Cell<ChatMessage>)`

- `message: Cell<ChatMessage>` — The message to delete. Must be a message in
  this room, sent by the sender, and not already deleted.

Records one of the sender's messages as deleted.

- **Admitted:** as a trusted gesture on `ChatDeleteSurface`, and only from the
  message's sender. No one deletes a message someone else sent, an OWNER
  included, whatever the room's policy.
- **Effect:** depends on whether the implementation makes deletion obliteration
  (see [implementation-defined behavior](#implementation-defined-behavior)):
  - If it does, the message is obliterated, exactly as `obliterateMessage` would
    by its sender: a tombstone labeled with the sender, with no `authorProfile`
    or reactions (see [obliterated
    messages](ChatMessage.md#obliterated-messages)).
  - If it doesn't, the message's `body` becomes exactly `{ deleted: true }`,
    recorded at the handler clock as `editedAt`, and its attachments and
    reactions are gone. Its `authorProfile` stays.

  Either way, no attachment or reaction outlives the deletion, and the message
  stays among the room's messages, so replies to it and threads rooted at it
  keep their links. The files it attached stay in their store.
- **Refused:** a `message` outside the room's space, or sent by someone else.
  Deleting a message that is already deleted changes nothing.

### `obliterateMessage(message: Cell<ChatMessage>)`

- `message: Cell<ChatMessage>` — The message to obliterate. Must be a message in
  this room that the sender may obliterate: anyone's, if the sender is an OWNER
  and the room's policy lets OWNERs obliterate; and in a direct room, also one
  the sender sent.

Removes a message entirely. Where the room's policy allows
it, it is how an OWNER curates the conversation, in a direct room as in a group
room, and an outward act when it removes someone else's words. In a direct
room, it is also how either person removes their own words completely.

- **Admitted:** as a trusted gesture on `ChatObliterateSurface`: from a member
  the room space's access list makes OWNER, for any message, whoever sent it,
  where the room's `ownersMayObliterate` holds (see [implementation-defined
  behavior](#implementation-defined-behavior)); and in a direct room, also from
  a message's own sender, whatever their access and whatever the policy. Where
  `ownersMayObliterate` doesn't hold, being an OWNER confers nothing here: an
  OWNER obliterates only what anyone else may, and no more deletes someone
  else's message than they could otherwise. A member of a group room who can't
  obliterate takes back their own message completely by deleting it, where the
  implementation makes deletion obliteration.
- **Effect:** reduces the message to a tombstone (see [obliterated
  messages](ChatMessage.md#obliterated-messages)): its `body` becomes
  `{ deleted: true }`, its `editedAt` the handler clock, and its
  `authorProfile`, `attachments` and `reactions` are removed. `sentAt` and
  `replyTo` stay. The files it attached stay in their store.
  The tombstone is labeled `authored-by` the sender, whoever obliterated it.
- **Refused:** a `message` outside the room's space; and, unless the room is a
  direct room and the message is the sender's own, a sender who isn't an
  OWNER, or any sender where the room's `ownersMayObliterate` doesn't hold.
  Obliterating a message that is already obliterated changes nothing.

### `sendReaction(message: Cell<ChatMessage>, emoji: string)`

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
  the handler clock as its `sentAt`. If they already have one, nothing
  changes, and it keeps its `sentAt`. No one else's reaction changes, and
  neither does the message itself.
- **Refused:** a `message` outside the room's space, or deleted, or an `emoji`
  that isn't a single emoji.

Adding a reaction that's already there changes nothing, and so does removing
one that isn't.

### `deleteReaction(message: Cell<ChatMessage>, reaction: Cell<ChatReaction>)`

- `message: Cell<ChatMessage>` — The message whose reaction to remove. Must be a
  message in this room.
- `reaction: Cell<ChatReaction>` — The reaction to remove, one of the
  message's `reactions`, by its cell. A client takes it from the message's
  `reactions` as it read them; it never describes the reaction by its emoji.

Removes the sender's reaction from a message.

- **Admitted:** as a trusted gesture on `ChatReactSurface`.
- **Effect:** removes `reaction` from `message`'s reactions. One that is no
  longer there, or reads as no reaction, removes nothing. No one else's
  reaction changes, and neither does the message itself.
- **Refused:** a `message` outside the room's space, or deleted, an event that
  names no `reaction`, or a `reaction` that isn't the sender's.

A client never toggles: it sends whichever of the two the person asked for, so a
repeated or delayed event can't undo what the person meant.

### `addMember(requestId: string, target?: { value: string }, profile?: Cell<ChatProfile>)`

- `requestId: string` — Chosen by the sender, and unique among its adds. The
  outcome is recorded under it in `addRequests`, and sending the same event
  again with it changes nothing. The rendered add control's click carries none,
  and is given one of its own.
- `target.value?: string` — The chat address of the person to admit: a
  principal's DID, as the room's add control holds it.
- `profile?: Cell<ChatProfile>` — The person's profile, whose
  `represents-principal` label names them, as the reader's manager lists it in
  its `people`. Given with `target.value`, the two must name the same person;
  given alone, the label names whom to admit.

Admits someone to a room's space, and has the reader's chat manager
([`ChatManagerOutput`](ChatManagerOutput.md)) tell them of the room. Unlike the
streams in the table, it takes a gesture of its own, and it is in `[VIEWS]`
with them.

- **Admitted:** as a trusted gesture on `ChatAddMemberSurface`, from the room's
  rendered add control, which takes an address or a pick from the people the
  reader's manager lists who aren't in the room yet, or from a client's own
  control through the sanctioned issuing path (see
  [`clients.md`](clients.md#the-sanctioned-issuing-path)), from an OWNER of the
  room's space, for a group room in a space of its own.
- **Effect:** grants the principal OWNER on the room's space, so they too may
  add others. Granting someone the OWNER they already hold changes nothing.
  Then, in an event of its own, so that the add reads nothing of the manager,
  for the reason a write that joins a room doesn't (see the rules every stream
  holds to), for a reader with a manager the room sends the manager's
  [`offerRoom`](ChatManagerOutput.md#offerroomrequestid-string-room-cellchatroomoutput-member-string-profile-cellchatprofile),
  naming the person and the `profile` when the add has one, under a
  `requestId` composed of the room's space and the add's own. The manager
  offers them the room through their profile's share inbox, or, given only
  their address, through the profiles its `people` lists for them, and
  otherwise produces a notice for them. An add with no manager to send to,
  because the reader has none or theirs hasn't resolved yet, tells the person
  nothing more.
- **Refused:** a direct room, whose space keeps its two members; an address
  that is not a principal's DID, a `profile` that attests no principal or
  names someone other than `target.value`, a sender without OWNER, a room that
  shares an existing space, and anything the space's access list refuses. The
  rendering tells the session what came of its add, and how the person was
  told of the room once that is decided, and shows a direct room no add
  control.
- **Outcome:** recorded in `addRequests`: `done`, or `refused` with a `reason`
  for a person to read. A direct room's refusal also carries the `code`
  `direct-room`, which stays the same whatever the `reason` says; the others
  carry none. An add the stream doesn't admit, as one without the gesture,
  records nothing.
- **Delivery:** a `done` add carries `delivery`, how the person was told of
  the room: `offered`, sent to at least one share inbox, which says nothing of
  whether it arrived; `noticed`, a notice in the manager's `outgoingNotices`
  for a client to deliver; or `access-only`, told nothing, so that the adder
  has to send them the room's link. An add with no manager to send to records
  `access-only` in that event: the reader has no manager, or theirs hasn't
  resolved yet. Nothing is ever offered for such an add, even once a manager
  resolves, since nothing runs then to send it. Otherwise
  `delivery` is the manager's verdict, which `addRequests` reads from the
  manager's `requests` once it is recorded, and is absent until then. A
  manager that refuses to tell anyone of the room, as it does for a room its
  catalog doesn't list, makes it `access-only`, with the manager's `reason` as
  `deliveryRefusal`. The manager records a verdict for every `offerRoom` it
  receives, so every add that is done gets a `delivery` eventually, either at
  once or when the verdict lands, and an absent one always means the verdict
  is still coming.

### `addParticipant(profile: Cell<ChatProfile>)`

- `profile: Cell<ChatProfile>` — A person's profile, as the live cell in its
  own space.

Adds a profile to those who joined the room: for a room in a space of its own,
the participants it keeps for its space. Unlike the streams in the table, it
takes no `requestId`: a profile already listed is not added again, so a repeat
changes nothing. Like them, and like `addMember`, it is in `[VIEWS]`. Any
participant may add any profile, so an entry is a claim. A member's chat
manager adds its user when it creates or accepts the room.

- **Admitted:** without a reviewed gesture.
- **Effect:** adds the profile to the room's participants, unless it is listed
  already. The profile's document must carry a label, as a profile does; one
  that carries none is refused.

### `setTitle(requestId: string, title: string)`

- `requestId: string` — Chosen by the sender, and unique among its retitles.
  The outcome is recorded under it in `titleRequests`, and sending the same
  event again with it changes nothing. The rendered retitle control's click
  carries none, and is given one of its own.
- `title: string` — The new title, exactly as the person saw it when they set
  it. It must have some text in it: a string, not empty or only whitespace.

Sets the room's title, which every member shares: the `title` the room's
`about` shows (see [`ChatRoomAbout`](ChatRoomAbout.md)), and the name a
manager's list shows it by, read through the room's link (see
[`ChatIndexEntry`](ChatIndexEntry.md#fields)). Like `addMember`, it takes a
gesture of its own, records its outcome, and is in `[VIEWS]`.

- **Admitted:** as a trusted gesture on `ChatRetitleSurface`, from the room's
  rendered retitle control, or from a client's own control through the
  sanctioned issuing path (see
  [`clients.md`](clients.md#the-sanctioned-issuing-path)), from any member who
  can write in the room, in a group room or a direct one.
- **Effect:** records the title, trimmed of the whitespace around it, labeled
  `authored-by` the sender, as the title a member last set. It replaces any
  title set before, and outranks the one the room was created with, which
  `about.record` keeps. Nothing else about the room changes: a client
  follows the title by reading `about.title`. Then, as a write in the room
  does, it sends the sender's manager's `joinRoom`, in an event of its own,
  and the manager brings the title its catalog lists the room under up to the
  new one (see
  [`joinRoom`](ChatManagerOutput.md#joinroomrequestid-string-room-cellchatroomoutput)).
- **Refused:** a sender who can't write in the room, or isn't signed in
  (`not-member`); a `title` with no text in it (`invalid-title`); and a room
  that shares an existing space, a space's own chat, which is shown by its
  space's name (`fixed-title`).
- **Outcome:** recorded in `titleRequests`: `done`, or `refused` with a
  `reason` for a person to read and a `code` a client acts on, which stays the
  same whatever the `reason` says. A refusal changes nothing else. A retitle the
  stream doesn't admit, as one without the gesture, records nothing.

### `ensureFileStore()`

Creates the store of the room's space's files, unless the space names one
already, which is how something that needs to put a file in the space, such as
an attachment, makes sure there is somewhere to put it. Like `addParticipant`,
it takes no `requestId`, since a repeat changes nothing, and it is in
`[VIEWS]`.

- **Admitted:** without a reviewed gesture, from anyone who can write in the
  room's space; the space's access list decides.
- **Effect:** for a room that is its space's root, creates a store as a piece
  in the space and names it as the room's own. For any other room, it does the
  same where its space's root keeps its store, when that root offers a record
  of it (see [`FileStore`](../fabrifile/FileStore.md#where-it-lives)), and
  does nothing in a space whose root offers none. Where the space names a store
  already, it changes nothing, so the space keeps the one store it names.

## Renderings

- **`[UI]`** is the room's own rendering, with its reviewed surfaces. An
  adapter's rendering embeds it, so a composer is always the room's own surface.
- **`[VIEWS]`** holds a `room` group with the facts and streams above, for hosts
  that draw natively. It includes `messages`, `canSend`, `viewer`,
  `messageRights`, `addMember` with `canAdd` and
  `addRequests`, `setTitle` with `titleRequests`, and `ensureFileStore` with
  `fileStore`. A client uses it to show
  a room outside any container. Inside a container, it reads the placement's
  `chat` group instead
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
- **Obliteration by OWNERs.** Whether an OWNER may obliterate messages,
  anyone's (`ownersMayObliterate`), in a direct room as in a group room.
- **How many of the newest messages `messages.latest` holds**
  (`maxWindowCount`).
- **How many attachments a message may have** (`maxAttachments`), 10 where a
  room's policy doesn't say.

An implementation may make these configurable, per room or otherwise, and how it
does so is its own business (see
[`FabriChatRoom`](FabriChatRoom.md#configuration)).

`about.policy` links a [`ChatRoomPolicy`](ChatRoomPolicy.md), and an
implementation MUST state it correctly: a client reads a room's choices there,
and can rely on them. Two things are not choices: no one deletes a message
someone else sent, and a direct room MUST let either person obliterate their
own messages.

## Open questions

- **Membership's open questions belong to the space.** Returning after leaving,
  and being added without consent, are questions about a space's access list
  and its tools, and a room changes neither.
