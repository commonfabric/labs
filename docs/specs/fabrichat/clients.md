# FabriChat: requirements on clients

Status: proposed design (see [`README.md`](README.md)).

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
  way. It is what keeps one person's conversation from splitting.
- **The conversations a container shows** are the adapters the container holds,
  each linking to a placement of one room, plus the container's own chat when it
  is a shared space that has one.
- **The people a client offers** when starting a conversation from a shared
  space are that space's member set.
- **An invitation** is redeemed under the person's own signature, followed by
  `accept` to their manager. Joining a room is the person's decision, so a
  client SHOULD redeem only after a gesture that shows who is inviting them, and
  to what.

## Showing a room

A client that draws natively reads a placement's `chat` group, reached through
an adapter's `placement` output, or a room's `room` group for a room shown
outside any container. Both are in `[VIEWS]` (see [views a host draws
itself](../../common/components/COMPONENTS.md#views-a-host-draws-itself)). A
client that renders VDOM shows the adapter's `[UI]`.

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
- **Identify people by their profile links**, compared with `equals()`, and
  never by display name.
- **Show members from the member set.** Members are the room space's member set.
  Where a room still keeps its own roster, a roster entry is a claim, not proof
  that someone can read the room.
- **Offer any single emoji as a reaction** (see
  [`ChatReaction`](ChatReaction.md)), and show any that others have used, even
  ones the client wouldn't offer itself.
- **Use each message's entity as its id.**
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
| add or remove a reaction | room | `react` | `ChatReactSurface` |
| add or remove a member | room | `invite`, `remove` | `ChatMembersSurface` |
| start a conversation | manager | `openDirect`, `createGroup` | `ChatStartSurface` |

A client sends to the room's own streams, never through a placement or an
adapter.

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
   emoji, message, or people the control displayed when the person acted. A
   client MUST NOT alter, fill in, or substitute any of them after the gesture.
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

### Prerequisite: a sanctioned issuing path

A native client needs a sanctioned way to hand the runtime a gesture it vouches
for. The host embedding record already names this as the right posture: "a
sanctioned headless issuance path, **not** a weakening of the in-runtime
surface-origin defense". No such path exists yet. The runtime client's generic
`cell:send` doesn't mark an event, and the in-repository precedents that do mark
one (`packages/cli/lib/trusted-action-event.ts`, the pattern test runner's
`trustedUi` steps) are not for embedding hosts. The path this design needs:

- It is available only to the host, never to pattern code that the runtime runs.
- It takes the surface and action with the event, and the runtime checks them
  against the write's policy as it checks a rendered gesture's provenance.
- It carries the mark to wherever the handler runs, as `rendererTrusted` already
  does between runtimes.

## Delivering invitations

Until a pattern can deliver to a principal it shares no space with, delivering
an invitation is the client's job. A client finds the invitations waiting in its
user's manager and reports each one once it's delivered (see
[`ChatManagerOutput`](ChatManagerOutput.md#delivering-invitations)). A client
MUST deliver only the invitation: who it's from, which room, and how to redeem
it. It MUST NOT deliver any of the room's contents.

## What a client must not do, in one place

- Create a direct room except through `openDirect`.
- Relay a send, a reaction, or a membership change through a placement, an
  adapter, or any other piece.
- Issue a trusted gesture from anything but a person's own act on the matching
  control.
- Copy a room's contents into another space.
- Identify a person by name, or treat a roster entry as access.
- Show a room's title, members, or history to someone its space doesn't admit.
- Place a direct room in a container that admits anyone besides the room's two
  members.
