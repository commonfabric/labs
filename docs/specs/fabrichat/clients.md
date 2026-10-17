# FabriChat: requirements on clients

A client is a program that reads and writes FabriChat on a person's behalf. The
shell is one. This document is about the others: a separate application that
embeds the runtime, and in particular one that draws chats with its own toolkit
instead of rendering the patterns' `[UI]`. It states what FabriChat requires of
such a program. None of it depends on how the program is built.

## Acting as the person

A client acts as the person's own principal, through a runtime that holds their
key. It MUST resolve the person's profile with `#profile` and their manager with
`#chatManager`, and MUST NOT ask the person to type in either.

Everything a client shows is read under the person's own access. A client MUST
NOT read a room through any identity other than the person's, and MUST NOT show
a room to anyone its space doesn't admit.

## Finding conversations

- **All of the person's rooms** are the manager's `rooms`.
- **The conversation with one person** is `openDirect` with that person's
  principal. A client MUST use it, and MUST NOT create a direct room any other
  way. It is what keeps one person's conversation from splitting. A client
  SHOULD name the person's profile too, when it can resolve one: the room is
  then offered to them, a room it finds included, when that room was offered
  them nothing.
- **The conversations a container shows** are the adapters the container holds,
  each linking to a placement of one room, plus the container's own chat when it
  is a social space that has one. A client that wants a `loom` root's own chat
  sends the root's `ensureChatRoom`, which creates the room unless the root
  names one, and reads it from `chatRoom`. A client MUST NOT create that room
  itself: a piece created at the top level of the space is registered through
  the root's `addPiece`, which shows it as a panel.
- **The people a client offers** when starting a conversation from a social
  space are that space's participants, as claims, until it offers a member set
  (see [social spaces](README.md#social-spaces)). When starting a group from
  the person's chats, they are the manager's `people`, the profiles of those
  the person shares a room with, by the principal each attests. A client names
  each person picked there by profile, in `createGroup`'s `profiles`, so the
  manager offers them the room.
- **A notice** says the person has been admitted to a room. Its claim of who
  sent it is unauthenticated. Before sending `accept` for a direct room, a
  client MUST read the principal the room's `about.record` is labeled
  `authored-by` (see [`ChatRoomAbout`](ChatRoomAbout.md#who-created-the-room)),
  as `cf-cfc-authorship` reads a message's label, and pass that principal as
  `counterpart`, never the notice's claim. The manager makes the same check, and
  refuses a `counterpart` that isn't the room's creator. A client shows who
  created the room from the same label. Whether to add the room to their list is
  the person's decision, so a client SHOULD accept only after showing them who
  created the room, and what it is.
- **An offer** of a room needs nothing from a client. The person's host vets
  it, registers the room in their Home's catalog, and accepts it on their
  behalf, with `keepArchived`, so the room is in their `rooms`, and a direct
  room is in their `direct` unless that already holds a room with its creator.
  Either way their later `openDirect` with the creator finds the room `direct`
  holds (see [`ChatManagerOutput`](ChatManagerOutput.md#offers)).

## Showing a room

A client that draws natively reads a placement's `chat` group, which the adapter
a container holds re-exports, or a room's `room` group for a room shown outside
any container, and drives the manager through its `chats` group. It reads a
room's newest messages from its `messages`
([`ChatMessageList`](ChatMessageList.md)), and the rest from the room's stored
messages themselves, each a cell, deriving a thread from their `replyTo` (see
[reading the rest](ChatMessageList.md#reading-the-rest)). Both are in `[VIEWS]`
(see [views a host draws
itself](../../common/components/COMPONENTS.md#views-a-host-draws-itself)). A
client that renders VDOM shows the adapter's `[UI]`, which also shows who has
the Loom the room is in open right now, from the Loom's presence room
(`cf-loom-presence`); a client that draws natively does not show presence
through the room, and a host that shows it reads the room itself.

A client that draws natively MUST:

- **Show authorship as the runtime attests it.** For each message, it shows
  whether the message is verified: whether the principal in the body's
  `authored-by` label is the principal the linked profile represents. That is
  the check `cf-cfc-authorship` makes, and a client makes it from the labels,
  never from a stored flag or a name.
- **Show people from their profiles**, read when drawn and redrawn when they
  change, so a changed name shows on everything the person sent. A profile that
  can't be read shows as a neutral placeholder (see
  [`ChatProfile.md`](ChatProfile.md#when-a-profile-cant-be-read)).
- **Show the room's title as the room holds it**, from `about.title`, read when
  drawn and redrawn when it changes, since any member can change it. A direct
  room with no title is shown by its other member.
- **Identify people by their profile links**, compared with `equals()`, and
  never by display name. The reader's own is the room's `viewer.profile`, the
  same link a message the reader sent holds as its `authorProfile`.
- **Show members from the room's space.** A room's `participants` are its
  space's participants, as claims, plus its authors. None of them is proof that
  someone can read the room. To name each of them, and to tell which one is the
  reader, as when titling a direct room with the other person's name, a client
  reads the room's `participantEntries`, which pairs each participant's profile
  with the principal it attests. It is best effort and derived for each reader:
  an entry whose profile the reader can't read holds no principal, and it is
  not an access list.
- **Offer any single emoji as a reaction** (see
  [`ChatReaction`](ChatReaction.md)), and show any that others have used, even
  ones the client wouldn't offer itself.
- **Follow the room through its messages**: `messages.latest` and
  `messages.count`, which stay current as messages arrive.
- **Use each message's cell as its identity**, compared with `equals()`, and
  never its `sentAt`, which is not unique (see
  [times](ChatMessage.md#times)).
- **Show edits and deletions.** A client shows a deleted message as deleted,
  and marks a message with `editedAt` as edited. A message keeps no earlier
  text.
- **Show obliterated messages as removed**, by whoever the tombstone is labeled
  with, and drop anything the client had kept of the message: its text, its
  sender, and its reactions.
- **Show replies where they say they are shown**: the main conversation and each
  thread, derived from `replyTo` as [`ChatReply`](ChatReply.md#the-two-views)
  states, with flat threads. A thread's reply count and latest reply time are
  the room's `messages.threads` (see
  [`ChatThreadSummary`](ChatThreadSummary.md)).
- **Show a room it can't read as unreadable**, and nothing more (see
  [`FabriChatPlacement.md`](FabriChatPlacement.md#viewers-who-arent-members)).

A client MUST NOT copy a room's contents into any other space, including as a
cache inside a piece. A copy loses the room's label and is readable by everyone
that space admits.

## Writing: the reviewed-gesture requirement

Every write that states the person's intent is admitted only from a trusted
gesture on the reviewed surface its policy names:

| Act | Pattern | Stream | Reviewed surface |
| --- | --- | --- | --- |
| send a message | room | `sendMessage` | `ChatSendSurface` |
| edit a message | room | `editMessage` | `ChatEditSurface` |
| delete a message | room | `deleteMessage` | `ChatDeleteSurface` |
| obliterate a message | room | `obliterateMessage` | `ChatObliterateSurface` |
| add a reaction | room | `sendReaction` | `ChatReactSurface` |
| remove a reaction | room | `deleteReaction` | `ChatReactSurface` |
| start a conversation | manager | `openDirect`, `createGroup` | `ChatStartSurface` |
| add a member | room | `addMember` | `ChatAddMemberSurface` |
| retitle a room | room | `setTitle` | `ChatRetitleSurface` |

Which of editing, deleting, and obliterating the room takes on each message,
from the reader, is in the room's `messageRights`, decided by the same rules the
room admits those acts by. A client reads it there rather than deciding for
itself, since the room refuses any other silently.

A client that draws natively sends `addMember` through
[the sanctioned issuing path](#the-sanctioned-issuing-path) on
`ChatAddMemberSurface`, as it sends the acts above. It finds the stream in
`[VIEWS]`, beside `canAdd`, which says whether the reader may add anyone, false
in a direct room, and `addRequests`, where each add's outcome is recorded under
its `requestId` (see
[`ChatRoomOutput`](ChatRoomOutput.md#addmemberrequestid-string-target--value-string--profile-cellchatprofile)).
An add that is done carries `delivery` once it is known how the person added
was told of the room, and until then it is still being delivered: every add
that is done gets one. Where it is `access-only`, nobody told them, and the
client asks the adder to send them the room's link. A client offers people to add from its
user's manager's `people`, and names a person picked there by their profile as
well as their address, so the manager offers the room through that profile.
To leave the people already in the room out of its add control, it reads the
room's `participantPrincipals`, the principals the room's `participantEntries`
hold. It is a best-effort set to leave out, not an access list: someone who
has been added but has never joined isn't among them, and neither is a
participant whose profile the reader can't read.

A client that draws natively retitles a room the same way: it sends `setTitle`
through the sanctioned issuing path on `ChatRetitleSurface`, finds it in
`[VIEWS]` beside `titleRequests`, where each retitle's outcome is recorded under
its `requestId`, and checks that the title has some text in it before sending
(see
[`ChatRoomOutput`](ChatRoomOutput.md#settitlerequestid-string-title-string)).
Any member who can write in the room may retitle it, in a group room or a
direct one, but not a space's own chat, which is shown by its space's name.

A client sends to the room's own streams, never through a placement or an
adapter.

A room drops a message act outside its stream's rules without a word, so a
client MUST check each event against those rules before sending it: a
non-empty body, a reply whose target is in the room, not deleted, and allowed
for its `shownIn`, a single emoji (see
[`ChatRoomOutput`](ChatRoomOutput.md#streams)), and it offers an act only
where `messageRights` and `canSend` allow it.

A client never sends an event again on its own. It can't re-issue a trusted
gesture from its code (rule 2 below), so an event it sent again would be
refused, and getting an event to the room is its runtime's job: a runtime
re-submits an event it can't tell was appended, with its trusted mark and the
same event id, which the room's runtime deduplicates, and runs an appended
event once. A client sees a send take effect when the message appears in the
room's `messages`; nothing else is owed, and a client offers no retry of its
own, since a person who sends again sends another message.

A client that resumes an interrupted `createGroup` MUST resend it with its
original `requestId`, and SHOULD do the same for `openDirect` (see
[`ChatManagerOutput`](ChatManagerOutput.md#creating-a-room-partial-states)).

**A client that renders the patterns' `[UI]`** meets this by construction. The
renderer marks a gesture on the pattern's own markup, and the mark travels with
the event to wherever the handler runs.

**A client that draws natively** has no DOM for the renderer to see. It must
issue the trusted gesture itself, which makes the client the renderer and puts
it inside the trust boundary. The runtime's mark certifies that a write came
from a reviewed surface, and not that the person meant it ([host
embedding](../../features/host-embedding.md#6-policy-record-trusted-mark-threat-model),
§6). A native client that issues the mark vouches for that surface itself. So it
MUST behave as a trustworthy renderer:

1. **One issuing point.** The client has exactly one place in its code that
   issues a trusted gesture. It is reachable only from the controls the client
   presents as one of the surfaces above.
2. **A real gesture.** It issues only in response to the person's own input on
   that control. Never on a timer, never from a restored state, and never
   because something else asked.
3. **What was shown is what is sent.** The event carries exactly the text,
   emoji, message, people, and choice of where a reply is shown that the control
   displayed when the person acted. A client MUST NOT alter, fill in, or
   substitute any of them after the gesture.
4. **No other way in.** Nothing reaches the issuing point except those controls.
   That includes the client's own automation and test interfaces, scripting or
   command interfaces, local network endpoints, links and URL handlers, agents
   or assistants acting within the client, and any content or code the client
   loads on behalf of other pieces.
5. **Isolation from what it runs.** When the client also runs pattern code or
   web content in the same process, none of that code can reach the issuing
   point or the channel it uses to deliver a marked event to the runtime.
6. **The surface it names is the one it drew.** The provenance a client issues
   names the surface and action from the table above, and only for a control
   that performs that act.

A client that can't meet all six MUST NOT issue trusted gestures. It can still
read and show conversations, and it can host the room's `[UI]` for writing.

### The sanctioned issuing path

A native client hands the runtime a gesture it vouches for through the
sanctioned issuing path that [host
embedding](../../features/host-embedding.md#10-native-reviewed-controls), §10,
describes. A host running the runtime in its own process binds each control to
its stream with `bindNativeUiControl()` from `@commonfabric/runner/native-ui`,
naming the surface and action from the table above once, when it binds the
control. The function that returns sends the control's payload with `native`
provenance for that surface and action, carrying the renderer-trust mark. A
host whose runtime runs in a worker sends the same act with
`CellHandle.sendReviewed(event, { surface, action })`, which waits for the
handler's run, and rejects with the reason when its write is refused. Either
way, the runtime checks the surface and action against the write's policy as
it checks a rendered gesture's provenance, and the mark reaches a served
handler the way a rendered gesture's does. The generic `cell:send` marks
nothing, and pattern code can reach neither path.

A native reviewed act counts wherever a trusted gesture does ([host
embedding](../../features/host-embedding.md#11-policy-record-native-reviewed-acts-count-as-trusted-gestures),
§11), a change to a space's access list included. So adding a member works the
same way: `addMember` admits someone with `grantSpaceAccess()`, which admits a
native reviewed act as it admits a gesture on the room's rendered add control.

## Delivering notices

Until a pattern can deliver to a principal it shares no space with, delivering a
notice is the client's job. A client finds the notices waiting in its user's
manager and reports each one once it's delivered (see
[`ChatManagerOutput`](ChatManagerOutput.md#delivering-notices)). A client MUST
deliver only the notice: which room, and who sent it. It MUST NOT deliver any of
the room's contents.

## What a client must not do, in one place

- Create a direct room except through `openDirect`.
- Relay a send or a reaction through a placement, an adapter, or any other
  piece.
- Issue a trusted gesture from anything but a person's own act on the matching
  control.
- Copy a room's contents into another space.
- Identify a person by name, or treat a participant entry as access.
- Trust a notice's claim of who sent it.
- Show a room's title, members, or history to someone its space doesn't admit.
- Place a direct room in a container that admits anyone besides the room's two
  members.
