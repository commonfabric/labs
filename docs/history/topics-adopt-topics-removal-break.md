---
status: historical
created: 2026-11-27
archived: 2026-11-27
reason: "Decision record for removing the Topics board's `adoptTopics` verb and its legacy `topics` list: an existing board moves by being recreated on a fresh board, not by adopting its list in place."
---

# Topics `adoptTopics` removal

The Topics board (`patterns/apps/topics/main.tsx`) holds its topics in an
indexed collection. While that change was in review (#10025), the board kept
the `topics` list it had held its topics in as an input that nothing appended
to, and gained an `adoptTopics` verb that added the listed topics to the
collection, at most 200 a call, so that a deployed board could move to the
collection in place. `backfillNames` adopted the whole list the same way before
it numbered anything.

## The decision

An existing board moves to the collection board by being exported and
recreated on a freshly deployed board (`scripts/topics-export.ts`, then
`scripts/topics-recreate.ts`), not by adopting its list in place. The owner
asked for `adoptTopics` to be removed once the collection's handle kept its
identity across an update of the board's source (#10182), which has landed.

With in-place adoption gone, nothing puts a topic on a board's list: `addTopic`
and the composer add each topic they create to the collection, and a recreate
files every topic through `addTopic`. So these went with the verb:

- `adoptTopics`, `ADOPT_BATCH`, `AdoptTopicsEvent` and `AdoptTopicsResult`.
- The `topics` argument. Dropping an argument property is compatible, so the
  gate reports nothing for it. An old board's stored list stays in its
  argument document, and nothing reads it.
- `backfillNames`' adoption of the list. The verb now numbers the topics of
  the collection that the namespace lacks, and it left the collection's write
  guard, since it no longer adds to the collection.
- `scripts/topics-bind-board.ts`, which linked the `board` input of a topic
  filed before its board held a collection. A recreated topic is wired to its
  board by its create.

`backfillNames` stays, with its event and result unchanged. Every way of filing
a topic numbers it, so on a board of this pattern the verb finds work only
where the namespace lacks a topic the collection holds. Removing it as well
would be a second break, against every board baseline since 2026-09-05, and
would leave `recordNames` in the naming library with no caller; that is a
separate decision.

## What broke, on purpose

`result.adoptTopics` is gone from the board's contract. Three baselines carry
it, all recorded while #10025 was in review: `20261121T012444Z-Q-VeHQzYK_RuIsiV`,
`20261124T004805Z-dOfO6DiHwzroh4ML` and `20261124T022719Z-cuWchNVcu3UjvKbz`. No
board deployed from `main` published it. The accepted break forgives that one
path over those three baselines.

## Disposition of deployed pieces

No board deployed from `main` published `adoptTopics`. A rehearsal copy of the
team's board that ran the reviewed source keeps its stored `adoptTopics` stream
as data no handler answers.

A board deployed from `main` before #10025 holds its topics as a list. Updated
in place to this source, it reads a new, empty collection, so it lists no
topics: its `topics`, `topicCount`, `index` and `mentionable` come back empty.
Each topic keeps everything it holds at its own address, and the old list stays
in the board's argument document, where nothing reads it. That is the
consequence of moving by recreate rather than in place, not a separate loss, so
the state-continuity gate's entry for the board
(`tasks/pattern-vintage-accepted-drops.ts`) lists those four roots whole, over
the Topics vintages captured through 2026-11-16. The team's board on Estuary was
deployed and updated with `cf piece setsrc`, and its source log shows a create
and edits, no followed origin, so it does not move to this source when the
deployment does; it is recreated with `scripts/topics-recreate.ts`.
