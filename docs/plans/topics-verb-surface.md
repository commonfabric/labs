# The Topics verb surface

Topics is a multi-user tracker over `#topic` pieces: a title, a living body
document, a flat comment thread, and typed links out to other objects. Humans
drive it in the browser; agents drive it over the CLI, which is a generic
projection of a pattern's verbs. That makes the verb surface *the* agent
product surface, and it is why this plan exists — the surface is deliberately
minimal, and how it grows without breaking the pieces already holding data is
the design problem.

This plan sequences that growth. The design argument behind it, the survey of
what the surface looks like today, and the discussion with Topics' author are
in the topic *"Topics verb surface: design and evolution"* on the team board;
this document is the part that has to stay accurate as the work proceeds.

## The position

**A holder demands only what it uses.** The board stores topics, so it writes
down the shape it requires of a stored one. That declaration is write-once: a
deployed holder cannot add a required member later, and a verb can never carry
a default, so a verb named in the holder's demand prices every future verb as a
deliberate break.

The board calls no topic verb. Its demand therefore names none, and a topic
grows verbs without the board's shape moving at all. This is what keeps a verb
**non-optional**: the alternative is a verb declared optional on the shared
projection, which pushes a maybe to every call site whose obvious spelling
skips in silence.

**A caller reaches a topic by its own address.** Survey the board through
`index`, take the row's address, and call the topic there, where its own schema
governs. A consumer reading through the board's projection sees the display
fields and nothing else — which is the correct model rather than a concession.

**What a pattern publishes is bounded by what it demands.** A pattern cannot
serve a wider view of a stored piece than the one it requires, so narrowing a
demand narrows the publication with it. Losing the thread, the links, and the
verbs from the board's published projection is accepted: the board is a
directory, and details come from navigating to the topic.

## The demand

`TopicDemand` in `packages/patterns/topics/main.tsx` is what the board requires
of a stored topic. Nine members, no verbs:

| member | why it is demanded |
| --- | --- |
| `title` | the card, and the index row |
| `body` | the card's snippet |
| `commentCount` | the card, and the index row |
| `createdBy` | the card's attribution, and the index row |
| `lastActivityAt` | the card, the index row, and the activity sort |
| `createdAt` | the index row |
| `mentions` | the crossref pivot's join |
| `[NAME]` | the display name of each topic's mention-universe row, which the autocomplete matches on, with the title behind it |
| `shortName` | the card's badge, and the mention-universe row that `#42` matches |

Neither the card nor the index row carries `[NAME]`. `mentionableIndex` reads
it off each topic and copies it into that topic's row of the board's mention
universe as the display name the editor's autocomplete lists and matches on,
with the topic's title standing in where `[NAME]` is absent or blank.

Seven of the nine carry a default, and the two that do not are safe for
different reasons rather than by oversight. `createdAt` is required: the topic
pattern defaults its own `createdAt` input to `0` and publishes it
unconditionally, so every topic produces the path whether or not it was ever
stamped. `shortName` is optional rather than defaulted, because a default
there would sit below an array constraint the compatibility proof cannot show
stable under default insertion, while an optional property carries no default
to move and tolerates a topic that publishes no name.

That is the property the demand rests on, and defaults are how it is usually
bought. A demanded path a stored topic cannot produce makes the whole array
unreadable — not the one row, the array — while a value the topic always
produces is simply read. A tenth member is safe to read when the topic always
produces its path, and otherwise when the demand grants itself the tolerance:
a default, or an optional declaration.

## Stages

| stage | carries | state |
| --- | --- | --- |
| A | compatible updates: verb and event prose, the describe layer, `setTitle`, a compact `addTopic` result | landed and deployed |
| B | one rehearsed break, four items batched | landed and deployed |
| C | retraction and edit, plus items waiting on a review or on usage | one item built, the rest not started |

### Stage A

Landed and deployed. Every item passed the update gate as an ordinary deploy.
`setTitle` went onto the topic's own output rather than the shared projection,
which is the pattern every new verb follows.

### Stage B

Four items, batched into a single rehearsed migration rather than paying the
rehearsal four times:

All four landed together in #6143 and are deployed: the Estuary board and every
Topic on it run these patterns. They merged together or not at all, which is
what batching a single rehearsed migration means.

The migration itself is recorded in
[`../history/topics-board-migration-2026-08-28.md`](../history/topics-board-migration-2026-08-28.md).
The ordering it establishes is the reusable part: the board moves FIRST,
because the narrowed board reads both the old and the new topic shape while
the old board reads only the old one. That inverts the children-first rule the
generic clone-rehearsal runbook gives, and the inversion is a property of which
side's demand moved rather than of this board.

1. **Narrow the board's `topics` demand and the topic's `mentionable`
   demand** to the fields above.
2. **Require `agentName` on every authored-content verb**, eliminating the
   unsigned path and with it the misattribution where an unsigned body edit
   leaves the previous author's name on content they did not write. The
   reference-only `mention` and `unmention` calls carry no content attribution.
3. **Retire `myName`, `setMyName`, `createdByName`, `authorName`** and their
   mirrors in results.
4. **Open the `kind` value domains** on links and authors, which are closed
   enums in provided data and so cannot widen — and with them relax
   `addLink`'s `kind` and `label`, which the handler already defaults and
   which the gate refuses to relax on their own.

Baselines are recorded ONCE, when the batch is complete — not after each item.
A baseline recorded mid-batch describes a contract that never ships, and the
next item in the batch breaks it, so it has to be forgiven by an accepted-break
entry that exists only to excuse an artifact. Baselines cannot be deleted
either, so that churn is permanent. The cost of waiting is that the
compatibility gate reports unrecorded contracts, and stays red, until the last
item lands; that is the honest state of a break that has not finished being
taken.

Item 1 additionally needed, before it could land, and each is in the PR:

- an accepted-break entry for `topics/main.tsx` and `topics/topic.tsx` naming
  the baselines the narrowing cannot apply over and only the paths it blames,
  plus the break record the entry points at;
- removal of the accepted-break entries that no longer forgive a finding, since
  an exemption cannot outlive its break;
- baselines recorded for the contract the break leaves behind, and a
  `pattern-vintage` run, which replays a real deployed board and refuses a card
  field that lost its default.

### Stage C

One item is built. What remains waits on a review this plan does not own, or on
usage:

- **`removeLink`, and comment edit and removal — built.** A retraction stamps
  `removedAt` and `removedBy` and leaves the record in place; `editComment`
  stamps `editedAt` and leaves `author` and `sentAt` alone. The verbs name
  their target by reference, which is what the no-synthetic-ids rule prepared
  for, and `removeLink` additionally takes `url` because a link record carries
  no fid a CLI caller could name.

  They sit on `TopicOutput` rather than on the `TopicPiece` projection boards
  store, which is what makes them need no migration. That placement is the
  interim rule below doing the work it was kept for, and it is now measured
  rather than predicted: only `topic.tsx` needed a new baseline, because
  `main.tsx`'s contract never moved.

  The reader retracts a comment or a link from the row it is rendered in.
  Those rows come from a filtered, sorted `computed()`, and an element of one
  keeps the identity of the record it was derived from, so a control bound to
  it writes the stored record rather than a copy of it. That is measured
  rather than assumed, across three files: `view-identity.test.tsx` pins the
  property, `topics-rejections.test.tsx` holds the negative half — a
  structural copy of a real stored record is refused, which is the case that
  separates identity from content — and
  `integration/topic-retraction-controls.test.ts` proves the shipped controls
  through a real click, including the step that tells a control bound to the
  view apart from one bound to the underlying array position.

  Each control proves membership before it writes. That check is not redundant
  with the property above; it is what decides how a regression in it would
  present, refusing rather than stamping a record no reader shows.

  A revised comment says so: the row carries an `edited` marker wherever
  `editedAt` is set, so a comment whose body is no longer what its author sent
  cannot read as one never touched. `sentAt` is deliberately left showing when
  the thread reached that point rather than when the revision happened.

  A control for `editComment` is not built, and revising therefore stays a
  verb call. It needs per-row session state that a retraction does not — which
  comment is open, and its draft.

  Two other gaps are open against this item. An agent can add a comment and
  cannot retract one, because these verbs name their target by reference and a
  comment carries no fid an inline JSON event could name — [#6713], where the
  candidate keys are set out. And the rule that a retracted link stops
  resolving into `mentions` is carried by reading rather than by a test.

- **`AgentActor` execution provenance** replacing per-event `agentName`, when
  the retention-and-provenance track clears its review. That review has not
  happened and nothing in that plan has started, so this item cannot begin
  here. Required-now relaxes to optional-then-deprecated, which is the
  compatible direction and the reason Stage B tightened rather than waited.

- **`Demand<T>` markers — decided against, for now.** The interim rule they
  would have replaced therefore stands: a new verb goes on the topic's own
  output, never into the board's demand. Item 1 is the worked example.

  What the repository gives up by not having them is legibility rather than
  capability. A holder's demand stays indistinguishable from its own state, so
  nothing can count what a change would hit before it is attempted, and a
  deliberate break is still acknowledged by turning the whole gate off for a
  pattern rather than by naming the demand it breaks. The next board break
  therefore costs what the Stage B one cost.

- **Statuses, labels, assignees, and whatever else usage asks for**: optional
  fields and new verbs, compatible on the topic's own schema and invisible to
  the board until the board widens its demand with an optional field. Nothing
  to build until a use asks for one.

## Testing the board through a narrowed demand

Several properties of the topics a board creates are guarded in
`packages/patterns/integration/topic-board-child-contract.test.ts`, which does
what a caller does: file through the board, resolve the row to the topic's own
address, then read and call the topic there. That covers `addTopic` wiring its
child to the pivot, a body given at create not being recorded as a body update,
an index row tracking a thread that grew after the row was built, and the
pivot's own rules.

Two facts shape what can be tested where, and both are worth knowing before
writing a case:

- A board built in a pattern test with topics in its argument lists them, one
  topic twice included, and runs its pivot over them. Those topics get no
  `referencedBy` of their own, because the board wires `boardCrossrefs` only
  into the topics `addTopic` and the composer create. An action that pushes a
  Topic built in a pattern body does not run: its argument reads as undefined,
  which the runner logs as a potential schema mismatch.
- The pivot excludes a topic from its own inbound edges by identity rather than
  array position. Only a list holding the same topic twice separates those. A
  board can hold one: writing the live handle of a topic the board already
  lists into its `topics` through the piece controller's `input`, or linking
  that topic there with `PiecesController.link`, adds a second entry for it.
  The pivot hands its join the list `distinctByIdentity` returns, which names
  that topic once, so `mentionedBy` is exported for a test to hand a duplicated
  list directly.

## Deploying to the team board

Stage B rewrote the shape of live team data, so it went through a rehearsal
before it went to the team board: a snapshot first, passes against a clone, the
board before its children, and a content export the restore drill exercised
rather than assumed. It was deployed on 2026-08-28. The script is archived at
[`../history/plans/topics-migration-rehearsal.md`](../history/plans/topics-migration-rehearsal.md)
and what the run found — including where that script was wrong — is in
[`../history/topics-board-migration-2026-08-28.md`](../history/topics-board-migration-2026-08-28.md).

A later break to these patterns needs the same treatment, and the record is the
better starting point of the two: the ordering rule it establishes is that the
side able to read BOTH shapes moves first, which is a question about which
demand changed rather than about which piece is the parent.

Two preconditions belong to the board rather than to the code:

- **The board must converge.** Its topics run more than one child pattern
  identity, and a migration that assumes one shape will not find one.
- **The space must be healthy enough to rehearse against.** A clone of a space
  whose pieces cannot start is not a rehearsal.

## Decisions

- A result narrowing happens in place rather than under a new verb name;
  breaking source-level consumers is accepted and updating them is part of the
  work.
- `removeLink` takes a reference, the form `unmention` established. It carries
  a URL spelling as well, which is not the interim form this plan once weighed
  against waiting: it is an addition on top of the reference form, and it earns
  its inconsistency by being the only way an agent can retract a link, since a
  link record has no fid to name from the CLI. Where a URL appears more than
  once the spelling stamps the newest un-tombstoned record, so removing twice
  removes two.
- **A removal is stamped, not performed.** `removeLink` and comment removal
  write `removedAt` onto the record and leave it in place; the reader does not
  render it by default. Three consequences, and the first is the reason:
  `lastActivityAt` is a max over the array, so a real removal would move a
  topic's activity *backwards* and visibly reorder the board, while a stamped
  one cannot. `lastActivityOf` therefore keeps counting stamped records, and
  changing it to skip them reintroduces that silently. `commentCount` is the
  other side: it counts the records carrying no `removedAt` stamp, so a card
  never promises more comments than the topic shows. Both are computations
  rather than schema, so neither needs a migration.
- Every field a stamped removal adds is optional, for the reason recorded on
  `TopicComment`: a stored record type has to accept what is already stored,
  and the deployed board holds records written before these fields existed.
- **Anyone may remove or edit anyone's comment or link**, matching the
  References card, which already lets anyone retract any mention. Narrowing
  this to the author is expected to come later.
- An edited comment carries `editedAt` beside its original `sentAt`, and the
  edit does not rewrite the author.
- **`Demand<T>` markers are not adopted.** The interim rule they would have
  replaced becomes the standing one: a new verb goes on the topic's own output,
  never into the board's demand. This is a decision about legibility, not about
  what can be built — every Stage C item remains reachable without them. What
  it accepts is that a change's blast radius cannot be counted before the
  change is attempted, and that a deliberate break is acknowledged for a whole
  pattern rather than for the demand it actually breaks.
- **A new verb goes on `TopicOutput`, not on `TopicPiece`.** The board stores
  that projection, so it is a demand on every topic already held, and a
  required verb added to it refuses every piece deployed before the verb
  existed. No pattern in the tree writes a verb with a default, so in practice
  a newly demanded verb has nothing to rescue it — but that is a fact about
  what patterns emit, not a rule the gate enforces: a stream node carrying a
  `default` is ACCEPTED, which is [#6673]. Optionality would also work; the
  placement is what `setTitle` established and what keeps the board's contract
  still. The tell that it worked is a baseline recorded for `topic.tsx` and
  none for `main.tsx`.
- **`unmention` keeps removing rather than stamping**, and the pattern carries
  two removal semantics until [#6573] closes it. Not because an edge matters
  less than content, but because a mention is a bare reference with no record
  to stamp: giving it one means changing what the array's elements are, and
  `mentions` is in the board's demand and is a union of three sources, only one
  of which `unmention` reaches. The gap underneath is that a mention is the
  only authored act here with no attribution at all.
- Stage B keeps the existing verb names. The rehearsed break is the *one*
  deliberate break in this plan: anything break-shaped discovered along the way
  rides it, and every other change stays gate-clean.
- The board's demand names the nine members above, and losing the excluded
  fields from the board's published projection is accepted.

[#6573]: https://github.com/commonfabric/labs/issues/6573
[#6673]: https://github.com/commonfabric/labs/issues/6673
[#6713]: https://github.com/commonfabric/labs/issues/6713
