---
status: historical
created: 2026-10-26
archived: 2026-10-26
reason: "Decision record for forcing each deployed Topic, once, past the update proof's refusal of the profile picture's optional field, for the kept-activity rollout of #9256."
---

# Topics: one forced update past the profile picture's narrowing

The kept-activity change (#9256) moves every Topic and the Topics board to a new
source. Rehearsed on a clone of the live Topics space, `cf piece retarget`
refused every Topic and the board before writing anything. This record says why,
why the refusal guards against no value the space holds, and why each deployed
Topic takes the update once with the compatibility gate open rather than through
a source change that would pass the proof.

## What refuses

The refusal is not the kept-activity change's. `cf piece setsrc --check` with
`topic.tsx` as it stood on `main` at `78e68d6b26`, before #9256, refuses the
same Topic with the same message. The source of both is #8975, which gave the
Topic author an optional `picture?: FabricBytes`
([profile-picture-break.md](profile-picture-break.md)). Both deployed Topic
generations, `NqWGhxuS…` and `PzQdVpiD…`, predate it.

A Topic is refused on its comments:

```
piece source is incompatible with retained input: input link at comments.0
schema is not compatible: input link at comments.0.author.picture: the
candidate no longer accepts every previous type
```

Each comment is a document of its own, linked from the Topic's `comments`
argument, and carries no producer schema. `resolveDurableSource`
(`packages/piece/src/ops/piece-controller.ts`) holds such a document to the
piece's prior argument contract at its path. That contract declared the author
as `{ kind, name, avatar? }` and left the object open, so it admits a `picture`
of any type. The proof for a retained link, `assertSchemaSubset`
(`packages/piece/src/schema-compatibility.ts`), runs without the evolution
policy that lets an argument object name a previously uncontracted optional
field, so a typed `picture` reads as a narrowing of "anything".

The board is refused on its members:

```
piece source is incompatible with retained input: input link at topics.0
schema is not compatible: input link at topics.0.createdBy: a schema
alternative accepted previously is not accepted by the candidate
```

A member's `createdBy` is one branch of a union, and the proof withholds the
evolution policy inside a union. That is the finding the profile-picture record
forgave for `topics/main.tsx` in the pattern-update gate. The gate compares a
pattern's recorded contracts; the proof a running piece's update runs over its
retained links is a separate check, and it refuses the same narrowing again at
update time. On the clone, the board's first seven member links carry their
Topic's producer schema and passed once those Topics moved; from the eighth on
the links name documents without one, which the proof holds to the board's
prior argument contract. So the board needs the one forced update as well.

## Why the refusal guards nothing the space holds

The proof is about what the prior contract could admit, not what is stored. In
the 2026-10-26 snapshot of the live space, no stored revision holds an author
with a `picture`: the seven revisions that mention the word are profile schema
fragments. A deployed Topic's handlers build an author from a profile's `name`
and `avatar` and cannot write one.

Measured on the clone, `picture` is the whole of the incompatibility. A copy of
the candidate differing only in `picture?: unknown` on the author passes the
update check on all 1,362 Topics and on the board, so no other path of any of
them is incompatible.

## The decision

Each deployed Topic, and then the board, takes this update once with
`--dangerously-allow-incompatible-schema`, and each is proven normally on every
update after it.

The rejected alternatives:

- **Typing the stored author's `picture` as `unknown`.** It passes every check
  with no forcing, but permanently: the prior contract a later update is held to
  would then admit anything at `picture`, so narrowing it back to bytes would be
  refused the same way, and every reader of an author has to test the value's
  type before drawing it. It trades a one-time operation for a standing loss of
  the field's type.
- **Changing the proof.** Granting the evolution policy to a union branch whose
  companion fragment constrains nothing, as the profile-picture record already
  proposes, would clear the board. Clearing the Topics would also need the
  policy on a link held to a prior open contract, which the proof withholds on
  purpose: such a document could be written by a writer the proof cannot see.
  Either is a runtime decision for the proof's owners, not a Topics one.

The cost the mention-universe record gave for forcing
([topics-mentionable-readonly-break.md](topics-mentionable-readonly-break.md))
was a pre-flight check that could never again tell a safe Topic update from an
unsafe one, because every update would have needed forcing. That does not hold
here: after one forced update a piece's prior argument contract is the new one,
and an ordinary check of the same source passes, for the Topics and the board
alike.

## The gate

Forcing opens the whole compatibility gate for that update, and `cf piece
retarget` records nothing about what a forced row accepted. So the rollout runs
the decision per row before the apply, in a driver that rewrites the plan:

1. Run the update check (no writes) with the candidate source.
2. Compatible: the row stays unforced. A Topic with no comment or link record
   is one.
3. Refused with the expected finding (a `picture` type narrowing on a Topic,
   or the `createdBy` union alternative on the board): run the check again
   with the variant typing `picture` as `unknown`. Forced only if the variant
   passes, since the refusal names only the first failing link and the variant
   passing is what proves nothing else is incompatible.
4. Anything else: the row is held out of the plan and the run stops.

Topics are applied first and the board after them, each through its own gated
plan, and each apply is followed by a survey diffed against its plan.

## Rehearsal

A snapshot of the live space taken 2026-10-26 (19.77 GB, sha256 checked on
the host and after the copy) was cloned with `cf space clone` and served on
loopback. Two passes ran from the same checkout, at #9256's `01566c5500`,
stopping the server, resetting the clone and restarting it between them. Each
pass verified the pristine baseline, ran the gate and apply for the Topics, then
for the board, and judged the result. The two passes agreed on every count
below; only the write rate's peak and the time each step took differed.

- **The gate.** Of 1,362 Topics, 1,098 were forced, every one on a `picture`
  finding with the variant compatible, and 264 went unforced. The unforced
  ones are exactly the Topics with no comment or link record, so no retained
  link reaches an author. None was held. The board was forced on its
  `createdBy` finding with the variant compatible.
- **The applies.** 1,362 Topics applied in about 16 minutes (a row's median
  490 ms, p90 775 ms), and the board in under two. Each survey diffed against
  its gated plan converged.
- **Proven again afterwards.** An unforced update check of the same source
  passed on each of the 30 Topics of a forced pilot run before the passes, and
  on the board after its forced update.
- **The kept values.** Read through the board by number, all 1,362 Topics
  store state version 2, and their stored and published comment count and
  activity time equal the values computed from their own records. No step was
  needed: the update runs the Topic, and the upgrade's lift completes.
- **Authored content.** Read offline from the pristine and the working
  stores, every Topic's argument document differs in exactly
  `topicStateVersion`, `commentCount` and `lastActivityAt`, and in nothing
  else; all 6,421 comment and link records are unchanged; the board's argument
  is unchanged. `cf space verify --expect-migration` reported none removed.
  The changed documents it counts as free-cells are view trees, link
  redirects and the board's derived rows, which include stale index rows
  catching up: one row went from "0 comments" to "2 comments" and gained the
  `[RESOLVED]` its Topic's title already carried.
- **Churn.** The Topics apply wrote about 7,000 commits a minute for its
  fourteen to sixteen minutes (peaks of 7,976 and 8,511), and the store was
  quiet within a minute of the last apply. Reading every Topic afterwards
  wrote another 13,600 commits of read-time materialization, which settled
  when the reads did.

`cf space verify` took 13 minutes after the first pass and 106 after the
second, over stores whose counts matched entity for entity; the cause was not
established, and the second pass's separate fingerprint was stopped rather
than waited out, since verify reports the same breakdown.

The write rate is the one figure that does not carry to production as it
stands: on Estuary it is well above the rate the 2026-10-07 write storm ran at
([the write storm record](development/performance/2026-10-07-topics-space-write-storm.md)).
The production run is to apply the gated plan in batches cut from it, as the
2026-10-06 numbering rollout did
([topics-number-rollout-2026-10-06.md](topics-number-rollout-2026-10-06.md)),
watching the board between them.

The drivers that ran the passes are kept beside this record, in
[`topics-profile-picture-forced-update/`](topics-profile-picture-forced-update/):
the gate (`gate.ts`), the pass script (`pass.sh`), the kept-value scan
(`kept-scan.ts`), the offline authored-content check (`authored-check.ts`), the
whole-board update check used for the variant (`check-all.ts`), the field diff
of changed free-cells (`field-diff.ts`) and the pass summary (`judge.py`). They
import the CLI's and the state inspector's modules from the checkout `PIN_ROOT`
names, and `pass.sh` names the clone's paths on the machine that ran it. Its
last step, the authored-content check, was added after the passes, which ran
that check by hand.

## Before production

- A team ruling on forcing, which the Topics pattern-update rule
  (`skills/topics/references/pattern-updates.md`) requires.
- The same gated driver, against production, with a fresh survey, gating each
  batch immediately before applying it. The gate's checks read the stored
  state of the moment, and what the apply pins is narrower than what the gate
  checked: a row's reference pin refuses a piece whose source another writer
  moved in between, but not a change to its records, and the forced write then
  accepts whatever the update check would have found. The window is a batch's
  duration. The records a deployed Topic's own verbs can add in it are the
  shapes the gate already proved, so the remaining exposure is a writer outside
  those verbs; announcing a quiet window for agent writes to the board during
  the rollout closes most of it.
- Rollback: every Topic's prior source is retained, so the rollout's plans
  roll back with `cf piece rollback`; the pristine snapshot of 2026-10-26 is
  the reference copy.
