---
status: historical
created: 2026-10-14
archived: 2026-10-15
reason: "Executed plan: a FabriChat room's messages and reactions became objects pushed onto lists, identified by their cells, with the request memory, used times, activity log, keyed records, and paging windows retired; all four stages landed in commonfabric/labs#8931."
---

# FabriChat messages as pushed elements

**Status:** done; all four stages landed in commonfabric/labs#8931, stage
4's rewrites with the stages that changed each behavior.
Written against `main` at `67143bae62` (2026-10-14). The two spikes it rests
on became `labels.test.tsx`, which drives the real handlers; their findings
are recorded below. Paths are under `packages/patterns/fabrichat/` unless they
say otherwise.

**Summary.** A FabriChat room stores far more than a chat needs. Beside the
messages it keeps a request memory, a set of used times, an activity log with
its numbering, and a separate reaction list per message, and it addresses every
message and reaction through `elementById` under a key derived from a request
id or a reactor. Each of those exists for a reason that no longer holds or that
nothing uses, and together they make every act read lists that grow with the
room. This plan replaces them: a message is a plain object pushed onto the
room's `messages` list, a reaction is a plain object pushed onto its message's
`reactions` list, each is labeled `authored-by` its writer, and every handler
reads at most the message it was handed. Rooms that hold the current shape are
left behind; they are not migrated.

## What the room keeps today, and why it goes

| Record | Why it exists | Why it goes |
| --- | --- | --- |
| `requests`, the request memory | The room acts on a sender's `requestId` at most once, against a served handler running an event twice, and against a client re-submitting an append its process no longer remembers (`ChatRoomOutput.md`, "Streams"; `FabriChatRoom.md`, "Redelivery ends"). | The runtime covers both. One durable stream entry is delivered to its handler exactly once as a completed run, and admission enforces `eventId` uniqueness above the stream's watermark, with a re-sent append a durable outbox row deduped at the target's `eventId` horizon (`docs/specs/server-side-execution/events.md`, "One entry, one COMPLETED delivery" and §4). |
| The replay check in a send | A send whose memo expired finds the message it made instead of overwriting it. | Same as above: there is no second run to guard against. |
| `usedTimes` | Every recorded time is unique in the room (`ChatMessage.md`, "Unique times"), so `t<sentAt>` can serve as a message's key in the views. | A key minted from a timestamp is the user-land id `docs/common/patterns/primitives.md` rules out. A message is identified by its cell. |
| The proposed-time window | A client proposes `sentAt` from its own clock, and the room records it within a window. | No client proposes a time. The room's own controls send text, and the handler stamps it. |
| `activity` and `counters` | `recentActivity` lets a client follow a room by reading what changed, and find the message its send produced (`ChatRoomActivity.md`). | Nothing reads it. In labs only `placement.tsx` passes it through; an external client's room reader watches the stored `messages` list instead. |
| `reactionLists`, keyed by request | A message links a list the send created at a derived address. | The send creates the list as a new cell and links it; nothing addresses it by key. |
| `elementById` addressing | The send writes its message at an address derived from sender and `requestId`, which the replay check reads back. | A pushed object is its own document already, with its own identity. |

## The target model

```ts
// Shown for illustration only.
interface MessageRecord {
  /** The profile the sender sent under; absent once obliterated. */
  authorProfile?: Cell<ChatProfile>;

  /** The current text, or the marker of a deleted message. */
  body: string | { deleted: true };

  /** The handler clock when the room recorded the message. */
  sentAt: FabricEpochNsec;

  /** The handler clock at the latest edit or deletion; absent until then. */
  editedAt?: FabricEpochNsec;

  /**
   * What this message replies to, and where it is shown. The link reads the
   * target as `RepliedMessage`, the message without its reactions and with
   * only where its own reply is shown, so a message's schema nests no message.
   * A link typed as the message itself nests without end; the generator cuts
   * the nesting at a depth that varies with the type a writer addresses the
   * message by, and a whole-message write cut shallower than the stored schema
   * drops the policies stored below the cut and is refused.
   */
  replyTo?: { message: Cell<RepliedMessage>; shownIn: ShownIn };

  /** Everyone's reactions; absent once the message is deleted. */
  reactions?: Writable<SentReaction[]>;
}

interface ReactionRecord {
  reactorProfile: Cell<ChatProfile>;
  emoji: string;
  sentAt: FabricEpochNsec;
}

// Each element is its own document, labeled with the writer of its current
// version. The element's policy governs pushing it, rewriting it, and removing
// it from its list; the lists themselves carry no policy.
type SentMessage = AuthoredByCurrentUser<
  WritePolicyAnyOf<MessageRecord, [/* the send handlers, edit, delete, obliterate */]>
>;
type SentReaction = AuthoredByCurrentUser<
  WritePolicyAnyOf<ReactionRecord, [/* react, unreact */]>
>;
```

The room's stored inputs shrink to `messages`, beside the records this plan does
not touch (`about`, `titles`, the participant roster).

- **Identity is the cell.** A handler is handed the message or reaction it acts
  on, and writes through it. Finding an item in a list is the exception, and
  `removeByValue(item)` removes the elements whose link matches it. It is the
  mergeable removal, resolved against durable state, so an unreact and a
  react on one message at the same moment both land; `remove()` reads the list
  and sets it whole, and one of the two would clobber the other.
- **Order is the list's order.** The conversation reads in the order messages
  were pushed. `sentAt` is the handler clock, shown to people, and not unique;
  nothing sorts or keys by it.
- **Every handler reads at most the message it acts on**, and a reaction
  handler reads that message's reaction list.

## What the spikes established

Two scratch `multiUserTest` pattern tests, one runtime per person, under
`enforce-strict` CFC.

**Labels.** Alice pushes a message, Bob reacts to it.

| Attempt | Result |
| --- | --- |
| Alice's message is labeled `authored-by` Alice | holds |
| Bob's reaction, pushed through the react handler, is labeled `authored-by` Bob | holds |
| Alice's message keeps her label after Bob reacts | holds |
| A write to Alice's body through no handler the message names | refused at `/` |

That holds only with `reactions` declared as a cell (`Writable<SentReaction[]>`)
that the send creates with `new Writable(...)` and links. Declared as an inline
array, the message's own policy covers `/reactions`, and Bob's push through the
react handler is refused at `/`: the list would be part of the message's
document.

**Removal.**

| Attempt | Result |
| --- | --- |
| Alice removes Bob's reaction through no handler | refused at `/*` |
| Bob removes his own reaction through the unreact handler | holds |
| Bob removes Alice's message from the room's list through no handler | refused at `/*` |

Removing an element writes `/*`, which the element's own policy governs, so a
list needs no policy of its own, and an element's policy has to name every
handler that removes it. The spike removed with `remove()`; the rewrite uses
`removeByValue()`, and stage 1 confirms the gate reads a mergeable removal the
same way. Which person a handler acts for is the handler's check,
not the label's: the label decides which code may write, and unreact compares
the reaction's `authored-by` principal with `currentPrincipal()` itself, as
edit and delete compare the author's profile today.

Two details the rewrite carries over. A link in a test event is typed without
its policy (`Cell<ReactionRecord>`, not the stored type), as
`docs/common/workflows/pattern-testing.md` says, or the test pattern's own setup
is refused. And the spikes named writers with `WriteAuthorizedBy`; the room
uses `TrustedActionWrite` with its surfaces, which the first stage confirms
with the same two tests.

## How handlers are written

The point of narrow handlers is that the pattern transformer shrinks each
handler's state schema to what its body uses, so the runtime reads and binds no
more than that. Probes of what the transformer emits, for a handler that checks
a message is in the room and rewrites it:

| Handler body | `messages` | its elements | `message` |
| --- | --- | --- | --- |
| Inline | `readonly` | `unknown`: identity only | `readonly` |
| Calls a helper taking the cell, `inRoom(messages, target)` | `readonly` | `unknown` | `readonly` |
| Calls a helper taking `state` | `cell` | the full record | `cell` |
| Destructures with a rest element, or passes `{ refusal }` to a helper | `cell` | the full record | `cell` |

Passing the handler's state, a rest element, or any object holding a cell to a
helper stops every field of that state from shrinking, including fields the
helper never touches. So:

- A handler destructures its state in its parameter list and uses the cells
  inline. A shared helper takes each cell as an argument of its own, never the
  state and never an object holding cells.
- `elementById` on a list keeps the list's whole element schema, since the
  analysis cannot reduce it to a path. The target model has no `elementById`.
- A `WriteonlyCell` or `ReadonlyCell` in a handler's state is usable in its
  body and can be handed on once `HandlerState` passes every kind of cell
  through whole, which commonfabric/labs#8923 does.

## The handlers

| Handler | Reads | Writes |
| --- | --- | --- |
| `commitSend` (the room's `sendMessage`) | the sender's profile; the reply target and its `replyTo` | pushes onto `messages`; a new reaction list |
| `commitComposerSend` | as `commitSend`, the reply from `composer.replyTo` | as `commitSend`; clears `composer.replyTo` |
| `commitThreadSend` | as `commitSend`, the reply from `composer.thread` | as `commitSend` |
| `commitReply` (a row's reply controls) | as `commitSend`, the reply bound to the row | as `commitSend` |
| `commitEdit` | the target; the sender's profile | the target; `composer.editing` |
| `commitDelete` | the target; the sender's profile | the target |
| `commitObliterate` | the target; the sender's profile and access; the room's policy | the target |
| `commitSendReaction` | the target's reaction list | pushes onto it |
| `commitDeleteReaction` | the reaction it is handed; the message's `reactions` link | removes the reaction from that list |

A reply's target, and an act's target, is checked to be one of the room's
messages by its space: a message in the space the room's records live in. The
check reads the target and nothing of the list, where a check by identity
against the list would read the list's links; and the push's element schema,
which carries the label, keeps the list's full element shape in a send's state
whichever check is made. So a send reads the target it replies to and no
other message, and the acts on a message take a `room: Cell<unknown>` that
names the space and reads nothing. A target in the room's space that is not
among its messages is a document the sender could write anyway, since the
label decides which handler may write a message and the space's access list
who may write there.

`commitDeleteReaction` takes the message and the emoji, as the stream does,
reads the message's reaction list, and removes the sender's reaction with that
emoji by its cell.

## Proposals for the decisions this plan has to make

### Delete

**Proposal:** a deleted message stays in the list as a tombstone. Its body
becomes `{ deleted: true }`, `editedAt` is set, and `reactions` is dropped; its
author, `sentAt`, and `replyTo` stay. Replies to it and a thread rooted at it
keep their links, which is why it is not removed from the list.

Dropping the `reactions` link is a write to the message, which the delete
handler is admitted to, so the reaction handlers' policy needs no entry for it.
The reactions themselves stay in storage, unreachable from the room. Removing
a message from the list outright, where nothing replies to it, is possible
later; it needs a scan of the replies, and this plan does not take it.

### Obliterate

**Proposal:** as delete, and `authorProfile` is dropped too, so nothing of what
was said or by whom remains in the message. The tombstone is labeled
`authored-by` whoever obliterated it, which is how a client shows who removed
it: an `AuthoredByCurrentUser` element is labeled with the writer of its
current version, so this follows from the model with no special case. The rules
for who may obliterate (`messageRightsOf()`) do not change.

### Edit history

**Proposal:** drop `earlierVersions`, and with it the policy's `keepsHistory`
from what the handlers read. Nothing shows history: the row reads only
`editedAt`, to mark a message edited. Today a deletion moves the deleted text
into the history, where it stays readable, which a tombstone with no history
does not. Keeping history is the alternative: an edit pushes the replaced
version onto `earlierVersions` within the message's own document.

### The room's outcomes

**Proposal:** the message and reaction streams drop `requestId`, and the room
drops `messageRequests`, its per-user record of each act's outcome by request.
A refusal is shown to the session that made it, through the composer's refusal
text as today, and the room's output offers that text so that a client which
does not render the room's UI can show it too.

`requestId` had two jobs: the at-most-once rule, which the runtime now
carries, and naming an act's outcome. The second serves a client that sends an
act and later asks what became of it; none exists. `addMember` and `setTitle`
keep their `requestId`s and their outcomes (`addRequests`, `titleRequests`),
which this plan does not touch.

### Smaller decisions

- **Reaction uniqueness.** The react handler reads the message's reaction list
  and adds nothing where the sender already has a reaction with that emoji. Two
  sessions of one person reacting at the same moment can each add one; the
  rendering tallies by reactor and emoji, so the duplicate shows once, and
  unreact removes the one it is handed.
- **The views.** The room derives each message's place (its thread, its reply
  count) once and maps the messages with their places, so a row receives its
  own place instead of looking it up by a time key. `places` keyed by
  `t<sentAt>`, `viewKeyOf()`, `timeKeyOf()`, and `openThreadKey` go; the open
  thread is `composer.thread`, a cell.
- **The message facts.** `messages.count`, `messages.oldestAt`,
  `messages.newestAt`, and `messages.latest` stay. Under list order, `oldestAt`
  is the first message's `sentAt` and `newestAt` the last's, with no sort.
  `latest` is still the newest `maxWindowCount` messages of the main
  conversation, so that policy field is still read. Home's recorded contract
  embeds `ChatRoomLink` with `messages.count` and `messages.newestAt` (the
  narrowed link `ChatIndexEntry.md` describes), so those two keep their names
  and types.
- **Windows.** `openWindow`, `closeWindow`, `ChatMessageWindow`, and
  `ChatWindowAnchor` page by `sentAt`, which is no longer unique. Nothing sends
  `openWindow` outside the specs and tests. **Proposal:** remove them; a
  window anchored by a message cell is the replacement if a client needs one.
- **`ChatRoomPolicy`.** Home's contract carries it, through the room's `about`
  record, and Home is a required pattern whose contract may not break without a
  ruling (`tasks/pattern-break-registry-guards.ts`). **Proposal:** keep its
  shape in this plan, with `proposedTimeMaxAgeNsec`, `proposedTimeMaxLeadNsec`,
  `recentActivityWindowNsec`, `keepsHistory`, and `maxOpenWindows` read by
  nothing, and retire them in a change of their own. `maxWindowCount` is still
  read, by `latest`.

## Consumers

- **`room.tsx`, `message-row.tsx`.** Rewritten with the handlers: bindings pass
  each handler the cells it uses, and the views follow "The views" above.
- **`placement.tsx`, `adapter.tsx`.** Lose `recentActivity` and, with windows,
  `openWindow` and `closeWindow`.
- **`manager.tsx`.** Creates a room with fewer stored inputs. Its own
  `requests`, the outcomes of `createGroup` and the rest, are a different
  record and stay.
- **`system/home.tsx`, `loom/main.tsx`.** Unchanged, given the `ChatRoomPolicy`
  proposal and the message facts Home's contract embeds.
- **An external client's room reader.** Reads `messages` as a list of cells
  holding `{ body, sentAt, authorProfile }` and keys each by its entity id;
  that shape stays. Nothing else in that client reads a room's records.
- **Integration fixtures and benchmarks.** `integration/fabrichat-room-fixture.ts`
  and `integration/fabrichat-send-burst.bench.ts` seed and drive the stored
  shape and follow it. `integration/fabrichat-update-rehearsal.test.ts`
  rehearses an update over data the deployed release stored; its fixture is the
  shape this plan leaves behind, so it starts again from the new shape.
- **Tests.** 29 of the room's pattern test files build the stored records by
  hand and change with them. The two spikes become tests of their own: the
  labels each writer leaves, and who can remove what.

## Contract gates

The room's contract breaks on purpose, and `pattern-compat` refuses a break
unless `tasks/pattern-compat-accepted-breaks.ts` names it, each `(pattern,
baseline)` pair with the schema paths it forgives and a decision record under
`docs/history/`. Stage 1 took that route: five entries, three for the room's
51 baselines by the result each reports beside the messages' changed `ifc`,
and one each for the placement and the adapter, all citing
`docs/history/fabrichat-pushed-messages-break.md`. Three earlier room entries
went with them, since they could forgive nothing once the messages broke
beside their paths. Home and the default app appear in no entry, which the
`ChatRoomPolicy` proposal keeps them out of.

## Specifications to rewrite

`ChatMessage.md` (fields, who wrote what, unique times, identity, deleted and
obliterated messages), `ChatReaction.md` (address and uniqueness),
`ChatRoomOutput.md` (streams, the rules that hold for every stream, recorded
times, `recentActivity`, `messageRequests`), `ChatMessageList.md` (windows),
`ChatThreadSummary.md` (`latestReplyAt` no longer identifies a reply),
`FabriChatRoom.md` (stored records, writers, prerequisites), `clients.md`
(proposed times, following a room, unacknowledged sends), and `README.md`.
`ChatRoomActivity.md`, `ChatMessageVersion.md`, `ChatMessageWindow.md`, and
`ChatWindowAnchor.md` describe surfaces this plan removes, and are archived.

## Stages

- [x] **1. Records and handlers.** New stored types and write policies in
  `room-records.tsx`, the nine handlers as above, and pattern tests for each
  act, including the two spikes as `labels.test.tsx` with
  `TrustedActionWrite`. The views key messages by entity rather than by time
  meanwhile, and `recentActivity`, `messageRequests`, and the activity and
  request records are gone from the room, the placement, the fixtures, and
  the specs; `messageRefusal` carries the session's refusal. The contract-gate
  route is settled below.
- [x] **2. Views.** The views key messages by their entity, which the room
  derives once and each row reads its own of; the windows, their streams, and
  the anchor and slice logic are gone, and a client reads past
  `messages.latest` from the stored messages themselves.
- [x] **3. Consumers and gates.** The placement, the adapter, the integration
  fixtures and the send-burst benchmark follow the new shape; the update
  rehearsal's fixture is refreshed from this branch, since the data the
  deployed release stored is left behind; the accepted breaks and their
  decision record are in place.
- [x] **4. Specifications.** The rewrites listed above landed with the stage
  that changed each behavior; `ChatRoomActivity.md`, `ChatMessageVersion.md`,
  `ChatMessageWindow.md`, and `ChatWindowAnchor.md` are archived.

## Open questions

Settled by stage 1's tests: a reaction list the send makes under
`TrustedActionWrite` admits the reaction handlers' pushes; the gate refuses a
`removeByValue()` by an element's policy as it refused the spike's `remove()`;
and an admitted rewrite by someone other than the author relabels the element
(`labels.test.tsx`, `owner-obliteration.test.tsx`).
- Whether `messageRefusal`, which the room's output offers and its own
  composer shows, should stay offered to a client that draws the room itself,
  or whether the refused act's absence from the room is enough for such a
  client.
