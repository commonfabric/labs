---
status: historical
created: 2026-10-16
archived: 2026-10-17
reason: "Design spike whose recommendation was rejected: it prices what a FabriChat room's cold load pays for thirty row instances and what rendering rows as a view over one computed would remove, and records the ruling that the map builtin stays the idiomatic flow and is made faster instead, since a computed's output is a flat source the trust machinery cannot trace through."
---

# What a FabriChat row instance costs a load, and why a view is not the answer

A design spike, written up and not built, with its recommendation rejected.
It asked what the FabriChat room's cold load would stop paying if a message
row were a view over its message's cell instead of a nested pattern
instance, found what a row owns that an instance need not own, sketched where
each piece would go and what the runtime would need, and priced the result.
The owner rejected the design on 2026-10-17 for two reasons recorded at the
end, and the record is kept for what it measured: a per-element account of
what the `map` builtin's children cost a load, which is what making the
builtin faster has to remove.

The numbers are from the thirty-message room's second signed-in load as the
performance records of 2026-10-16 measured it
(`2026-10-16-fabrichat-room-cold-load-phases.md` and the records that
followed it), on a worker profile of 12,665 busy samples with the two schema
changes of that evening in place.

## What a row is, and what a load pays for thirty of them

`FabriChatRoomCore` rendered its main conversation as
`facts.main.map((message) => <FabriChatMessageRow … />)` and its open thread
as the same map over a per-session list
(`packages/patterns/fabrichat/room.tsx`).
The transformer lowers each map to the `map` builtin with the callback as an
op pattern (`docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`
§9.4), so each message is a list child: an instance with a durable result
slot, started by the coordinator inside its own run (`Runner.#startWithTx`),
pre-synced as a family on a resume, and instantiating `FabriChatMessageRow`
inside it.

What one row instance held (`packages/patterns/fabrichat/message-row.tsx`):

| kind | count | what |
| --- | --- | --- |
| per-session writable | 1 | `pickerOpen` |
| computeds | 16 | `tallies`, `isDeletedNow`, `rights`, `isEditing`, `text`, `isEdited`, `quote`, `replies`, `threadLabel`, `threadLinkDisplay`, and six display strings derived from those |
| actions | 5 | `togglePicker`, `startReply`, `openThread`, `startEdit`, `stopEdit` |
| handler bindings | 11, plus 6 static ones for the quick reactions and 2 per reaction tally | `commitSendReaction` ×3, `commitDeleteReaction` ×2, `commitEdit`, `commitDelete`, `commitObliterate`, `commitReply` ×3 |
| ternaries in JSX | 7 | each an `ifElse` node |
| reactive list | 1 | `tallies.map(…)`, an op instance per tally |

About forty nodes per row, thirty rows, and the thread's rows again while a
thread is open. Against the load's counts:

| per load | measured | the rows' share |
| --- | --- | --- |
| scheduler runs | 1,157 | about 750: 606 derivation runs are the rows' computeds and `ifElse` nodes; the coordinator's child starts are 894 busy samples (`#startWithTx`) |
| commits | 190 | 167 are session-scoped derivation commits, 130 of them `computed:` sets, about four to five per row (`isEditing`, the editor and picker displays, the picker label) |
| commit finalization | 1,028 samples, 86% CFC preparation | not attributed per row by the profile; the load made 615 preparations for 190 commits, and the rows' session derivations are 167 of those commits |
| resume pre-sync | about 900 samples; 1,663 list-child syncs and 285 cell syncs | each row is a family of a result slot and some forty owned cells; the participants' twelve chips are the rest |
| render sinks | 3,005 samples, 24% | about 25 bound props per row; not the instance's, the view's |

Together the instances cost about a third of the busy samples, and the
server stored 167 commits a load for them, carrying 490 space-scoped reads
between them, about three each on average, for validation even when
`localSessionDocuments` emptied their operations
(`2026-10-16-fabrichat-room-cold-load-local-session-documents.md`). The
first load of a room, which builds the rows, took 36 s against the second
load's 25 s; opening the fixture's thread of five replies started six rows
the same way, the root's among them.

Read per element rather than per load, this is what one list child of the
`map` builtin cost: a start, a family pre-sync of its result slot and every
owned cell, a run per node, and a CFC preparation and a commit per
session-scoped derivation. None of those is a cost of the row's logic. They
are the cost of the child being an instance, and they are what a faster
builtin removes.

## What a row owns that an instance need not own

Four things, and the fourth was the one that decided the design.

**Its own session state.** `pickerOpen` was the row's one writable.
Everything else that differs by viewer or by session is derived: `isEditing`
compares the room's `composer.editing` to the message; `rights` reads the
viewer's profile and the message's author.

**Its handlers.** Eleven bindings of the handlers in
`packages/patterns/fabrichat/room-records.tsx`, each a stored node bound to
the message, the room's messages, the viewer's profile, the composer, the
picker and the manager stream. A handler re-runs only on a stale-read
rejection, so the binding is what the instance stores: a stream document and
an argument document per handler per row, pre-synced as owned cells. All but
one of these handlers already took their message from the event before the
binding, as `(event?.message ?? message)?.resolveAsCell()` in
`commitSendReaction`, and guarded it with `isInRoomOf(room, target)`,
because the room's tests send `{ message }` to room-level streams. The one
was `commitReply`, which hands its bound message to `sendInto()`;
`commitSend`, bound once at the room, reads the same reply from
`event.replyTo`.

**Its labels.** Each per-row derivation is a document whose label is minted
at commit from what the run read: the message's document and, for `rights`,
the viewer's profile. That mint is the `prepareCfc` under finalization. The
rendered values reach the page through display sinks, and
`packages/html/src/worker/display-fit.ts` fits each sink's consumed labels
against the render policy (CFC §8.10.6) whether the cell is a row's stored
derivation or the message itself.

**Its identity to the reconciler.** The map keys its children by the link of
each element's cell. The worker's reconciler keys a reactive children array
by a projection of each node in which a cell stands as its link
(`packages/html/src/worker/keying.ts`), so a row rendered as a view would
keep the same identity as long as its tree bound the message's cells.

What the instance does own, and what the ruling below turns on, is the
provenance of each value it renders: every bound prop of a row is a cell of
the row's own graph, with a document, a label and a trace of its own behind
it, so an element on the page can be followed back through the sink to the
derivation and from there to what it read.

## The design that was priced

The view design moved the row's derivations into records the room keys by
message, the way `facts.places` already is: shared facts into
`messageFacts()`'s record, `rights` into one per-user record, the editor
display into one per-session record, the tallies into one per-user computed
building each tally's controls as view nodes, and the picker into one keyed
per-session writable. The handlers became thirteen room-level bindings
taking the message from the event. The rows themselves came from one
space-scoped `computed()` over `facts.main` building thirty view-node trees
with the message's cells bound as links and nothing read, so that it ran on
membership changes only, and the thread's rows from a second such computed
over `threadMessages`.

Inside a `computed()` an auto-unwrapped reactive receiver's `.map` is not
lowered (§9.4), so that map is a plain loop in one run, and nothing per
element exists in the scheduler or the store. The row's reactivity would
have moved to the sinks, where the view nodes hold links, and to the
records, each one node and one commit in place of thirty copies.

The runtime would have needed one addition: an event prop carrying arguments
to a shared stream, `{ stream, with: { message } }`, since a view node's
event prop is a stream and the reconciler's registered handler sends the
browser's event to it with nothing in the node saying which message the
click was on. Review of the spike established how that merge would have to
be defined. The main thread's applicator serializes the browser's event
(`serializeEvent` in `packages/html/src/main/events.ts`), the reconciler
marks that serialized object as renderer-trusted when
`Reconciler.dispatchEvent()` calls `markRendererTrustedEvent`, the mark is
membership of the exact object in a weak set
(`packages/runner/src/cfc/ui-contract.ts`), and `Cell.send()` carries it
only from the object handed to it. An event built as `{ …event, …with }` is
a new object the reconciler never marked, which every handler gated on a
trusted gesture would refuse, and an argument named `provenance` would
replace the renderer's. The arguments would have had to be set on the marked
event, never over a field it carries, with `h()` refusing a reserved name at
build time, and the reconciler change classified under the CFC
correspondence procedure first.

A template list the reconciler expands per element, which the transformer
would lower a bind-only `.map` callback to, was named as the end state that
also removes the list document and the computed's run per send; no document
under `docs/features/` describes such a primitive.

## What the load would then have paid

Estimated from the measured counts:

| per load | measured | estimated after | removed |
| --- | --- | --- | --- |
| child starts (`#startWithTx`) | 894 samples | 0; the chips remain, and they were not in this number | 894 |
| scheduler runs | 1,157 | about 400: the room's own, plus the records' | 750 runs, about 500 samples |
| commits | 190 | about 25: the 167 session derivation commits become one per record | 165 commits |
| commit finalization | 1,028 samples | about 350, if it falls with the commits | about 680 |
| resume pre-sync | about 900 samples | about 200: the chips' families and the room's own | about 700 |
| render sinks | 3,005 samples | the same; the records' per-key sinks replace the rows' result sinks one for one | 0 |
| module evaluation | 12% | the same | 0 |

About 2,800 of 12,665 busy samples, 22%, up to a third if the rows' share of
the hashing and validation under the removed frames is at the high end,
which the profile cannot separate. The server would have stopped storing 167
commits a load. The first load of a room would have cost what the second
does, and a thread open would have started nothing.

What a change would have paid is the trade in kind: today an edit re-runs
one row's `text` and a reaction one row's `tallies`; the records would have
re-walked every message's body or every message's reactions. For thirty
messages that is hundreds of link hops; for a thousand, every edit walking a
thousand messages in three records. Neither design is incremental. The
instances make a load pay per message and the records would make an edit
pay per message.

## The ruling

Rejected on 2026-10-17 by the owner, for two reasons.

**The map builtin is the idiomatic flow, and is to be made faster rather
than worked around.** A `.map` over a reactive list in a pattern body is how
a pattern says "one of these per element", and the per-element instance is
the runtime's model of that. A pattern that reaches for a `computed()` to
avoid what the builtin costs is a pattern working around the runtime, and
every pattern with a list would have to do the same. The per-element costs
the table above itemizes are the builtin's to lose: the child start, the
family pre-sync, the run per node, the CFC preparation and commit per
session-scoped derivation.

**A computed's output is a flat source.** A view node built inside one
computed is one value in one document, and an element on the page rendered
from it can be followed back only as far as that document. Through an
instance, the same element is followed back through its sink to a cell of
the row's graph, from there to the derivation that wrote it, and from there
to what that derivation read; the display gate's consumed labels, the event
provenance of a gesture on the element, and the authorship a component such
as `cf-cfc-authorship` shows all rest on that trace. For FabriChat's rows the
spike kept the message's own values bound as links, which may have been
enough in this case; it is not enough in general, and a rendering model the
runtime recommends has to hold generally.

What stands from the spike is the account of what a list child costs, by
kind, and the two findings about the event path recorded above, which hold
for any shared handler a view might one day bind.
