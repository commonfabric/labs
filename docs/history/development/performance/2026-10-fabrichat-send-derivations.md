---
status: historical
created: 2026-10-15
archived: 2026-10-15
reason: "Measurement of what a FabriChat room's derivations cost on the thirty-first send, before and after they became one walk over plain entries (the change after commonfabric/labs#8931), with the costs that remain and are the runtime's, October 2026."
---

# The thirty-first send's derivations, before and after one walk, October 2026

After commonfabric/labs#8931 a send into a FabriChat room was, on the worker,
mostly re-derivation over the whole message list for one pushed element
(`2026-10-fabrichat-room-send-30-profile.md`, "Where a send's 1.2 s goes").
This records what those derivations cost on the pattern-test rung before and
after they became one computation over plain entries, and which of the costs
that remain belong to the runtime.

## Setup

A scratch pattern test over `FabriChatRoomCore` with one viewer and no
roster: thirty-one `composerSend`s, a `{ render: room[UI] }` step before the
last send and another after it, run with
`cf test --verbose --stats-threshold 0 --no-idempotency-check
--stats-action-limit 80`. The send handler's own transaction is not counted
(`packages/cli/README.md`, "Pattern test read costs"), and nothing is demanded
between steps, so the thirty-first send's re-derivation and re-render are what
the second render step reports: the runs that follow one pushed element into a
rendered room of thirty messages. Counts are exact; the milliseconds are a
Deno process compiling and settling, not the browser's, and are not reported.

The scratch test is not committed. One laptop, the tree at this record's
commit against its parent.

## The thirty-first send, before and after

| | before | after |
| --- | --- | --- |
| runs | 53 | 36 |
| proxy accesses | 493 | 266 |
| link hops | 558 | 515 |
| documents per run, summed | 568 | 451 |

Before, four room-level derivations walked the list, each for the one pushed
element, and between them were 439 of the 493 accesses and 161 of the 558
hops:

| derivation | accesses | hops | what it read |
| --- | --- | --- | --- |
| `entries` (`messageEntries`) | 156 | 64 | every record, resolving every element's link |
| `places` (`viewPlaces` over the entries) | 125 | 1 | key, time and reply of every entry |
| `participants` (`participantsOf`) | 95 | 95 | every entry's record and its author link, compared with `equals()` |
| `mainEntries` (`entries.filter(isInMain)`) | 63 | 1 | every entry whole, through an imported helper |

After, one room-level derivation over the list: 218 accesses and 126 hops.
No other room-level derivation ran; the main list's `map` still walked the
list, as the next section says.

| cut | cause |
| --- | --- |
| four walks become one | `messageFacts()` reads the records once into entries and derives the places, the main conversation, the authors, and the view's `messages` from those plain values in the same run; the views read a field of it |
| `participants` leaves the list | the entries carry each author's key, `messageEntries()` lists each author once, and `participantsOf()` compares the listed profiles against the authors: as many comparisons as the room has people, however many messages |
| `messageRights` leaves the records | each entry carries whether it is live and its author's key, and the reader's key is their resolved profile's, so the rule is decided from two plain values per entry |
| `mainEntries` costs nothing | each entry carries `inMain`, decided where the record is read |
| the open thread's root is not searched for | `openThreadKey` takes the root's own key, `viewKeyOf(root)`, and asks `places[key]` whether the room holds it; before, `entryFor()` found the root's entry by `equals()` against every entry |
| the main list maps the main conversation | `facts.main` holds the main conversation's cells, so a reply shown only in a thread has no hidden row, and a row has no display computed and no conditional for it: two fewer runs per row |
| the new row's rights read two fields | the row hands `messageRightsOf()` the message's author and body rather than the whole record: 8 accesses and 24 hops in place of 9 and 25, so the record's other links were not what that run resolved |

The entries' own walk grew from 64 to 126 hops: reading each record's author
link to key it is a hop per message, and that is the hop `participants` and
`messageRights` no longer pay per message. Keeping the author's link in each
stored entry, or only in the distinct-authors list, made no difference to
either count.

## What remains, and whose it is

After the change the second render step's 36 runs are: the one derivation
(218 accesses, 126 hops), the new row's seventeen computeds (about 45
accesses, 60 hops in all), and the rest with no pattern reads at all:

- The main list's `map` ran twice and cost 219 hops: a link resolution per
  element per run over thirty-one links, for one appended element. Mapping the
  derived `facts.main` costs 58 more hops than mapping the stored list did
  (161), the extra indirection through the computed's result; the row count is
  the same here, since every message is in the main conversation. A map that
  tracked which element was appended rather than re-resolving every link is
  the runtime's (`packages/runner/src/builtins/map.ts`), as is the second run.
- The test rig's sink over the room's result: 62 hops per send, the harness
  holding the whole result live.
- Twenty-odd render sinks and `ifElse` and `unless` builtins for the new row's
  nodes, 1–10 hops each.

So after the change the pattern's own share of a send is one walk that reads
each record once and resolves each element's link once, and the walks over
the list that remain are the `map` builtin's.
