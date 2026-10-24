---
status: historical
created: 2026-10-24
archived: 2026-10-24
reason: "Record of the deliberate contract break taken when a FabriChat message's reply came to name the thread it joins and the message it quotes apart, in place of the one message a reply named, which leaves every stored reply as it was, counted and shown as replying to nothing."
---

# FabriChat: a reply names its thread and its quote apart

A FabriChat message's reply (`ChatReply`, `StoredReply`,
`packages/patterns/fabrichat/`) named one message, and where the reply was
shown. That one link did two jobs: the thread the message joined, found by
walking reply chains to a message in no thread, and the message it answered.
So a plain post in a thread and an explicit reply to the thread's root were
the same record, and the room could tell neither a quote in a thread nor a
message's thread without the walk.

A reply now names `thread`, the root of the thread the message joins, and
`quotes`, the message it answers, each optional, each by the message's own
cell, with `shownIn` as before. A thread is flat by what is stored: the room
refuses a send whose `thread` is in a thread itself, whose `quotes` beside a
`thread` is outside that thread, or whose links don't fit its `shownIn`, which
are the room's first checks on a reply. The same change adds each thread's
messages to its summary, and a title per thread, kept in a list of records of
its own, `threadInfo`, which a send that starts a thread and a retitle write.

## What the gate reports

Against twenty-seven of the room's recorded baselines, from
`20261016T053638Z-KQKz6B5ir-i_b2SS` through
`20261024T171044Z-nGvvC4U9_mwy0apw`, the pattern-update proof reports
`result.$VIEWS.room.deleteMessage.message.replyTo.message: existing result
field was removed`. Every message the room's views hand on is typed by its
record, so a stored reply's `message` is gone from each of them; the proof
reports one issue per role, and names `deleteMessage`'s event first. The older
baselines report the breaks already recorded against them
(`fabrichat-pushed-messages-break.md`), ahead of this one. The argument's
messages narrow no stored value: a stored reply's `message` is a key the new
schema doesn't declare, and its schemas set no `additionalProperties`.

Twenty-five of those also report the scope the room's `participantEntries`
declares, which `fabrichat-view-scopes-per-user-break.md` records, and so does
the baseline recorded with this change before that scope reached it. The proof
reports one issue per role, so one entry names both paths for all of them, in
place of that break's own entry for the room.

`threadInfo` is a new argument field with a default, so it breaks nothing.
Its records' write policy names `commitSend`, `commitThreadSend` and
`commitSetThreadTitle` from the start: a later schema can neither add a writer
to a stored policy nor drop one, so a policy naming only the two send handlers
would have taken a break of its own when the retitle arrived.

## What is left behind

Every room adopts the new source, as an open of a room adopts what its
`system:` origin serves: the messages' handlers and policies are the ones
stored, so nothing refuses the release. The update rehearsal
(`packages/patterns/integration/fabrichat-update-rehearsal.test.ts`), run once
against the deployed release's frozen copy before the copy was refreshed,
measured it: Home and each room adopted this tree's source, refusing and
dropping nothing, every stored slot read back, and the updated room edited and
reacted to a message the deployed release stored.

The replies those rooms store aren't migrated. A reply that names neither a
thread nor a quote is the old shape, which no send stores now, so the room
counts each as one of its `legacyReplies` and shows how many there are. It
shows one shown in the main conversation as a message in no thread, and none
shown only in a thread, whose root it no longer names. The rehearsal's group
room, which stored one thread reply, read back one such reply, no thread, and
its two other messages in the main conversation. The count is part of the
room's derivation of its messages, which runs when they change, so it adds no
subscription, timer or write, and nothing retries.

## The decision

@danfuzz ruled, on 2026-10-24, that old rooms show the count with a banner,
their main and both-ways replies as plain posts and their thread-only replies
counted and hidden, and that "details about old rooms don't matter. we will
abandon them eventually." Breaking old rooms is acceptable as long as it is
neither silent nor a spiral of work, so no compatibility reading of `message`
is kept. The entry in `tasks/pattern-compat-accepted-breaks.ts` forgives the
removed field against those baselines, and the contract recorded
with this change is gated as usual from then on.
