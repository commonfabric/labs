---
status: historical
created: 2026-09-22
archived: 2026-09-22
reason: "Record of the two clone rehearsals of the full Topics numbering procedure on the post-#7774 source, at Estuary's deployed revision: the retarget, the backfill's one deterministic straggler, the refused rollback, and what the procedure's own checks did and did not see."
---

# Rehearsing the Topics numbering procedure on the #7774 source

The procedure is `skills/topics/references/namespace-backfill.md`: move the
board, move every Topic with `cf piece survey` and `cf piece retarget
--dangerously-allow-incompatible-schema`, then run `backfillNames`. Before this
run it had never been rehearsed against a clone in that shape.

## Setup

- A `VACUUM INTO` snapshot of the Estuary Topics space taken 2026-09-22, cloned
  with `cf space clone`: 451 Topics on two source generations (301 and 150).
- Server and `cf` both at `4e3d5274b`, the revision Estuary ran. The board and
  Topic sources compile byte-identically at `8cd70c0ff`, the revision deployed
  by the time this was written up.
- Two passes, with `cf space reset` between them. The board step had already
  been applied to production; each pass applied it to the clone first.

## What both passes showed

- **Retarget.** 451 of 451 moved, `applied: 451 · written: 451`, in 14 and 16
  minutes from a laptop against the clone's local server. `survey --diff`
  reported every row moved as planned and none outstanding.
- **Backfill.** One `backfillNames` run numbered the namespace and 450 of the
  451 Topics stored their numbers. The same Topic missed in both passes: the
  newest one in the snapshot. A second run in pass one changed nothing for it; a
  direct `recordName` with the number the namespace held for it stored it. Every
  run logged `Event dropped: speculative origin failed` once per Topic, so the
  log line counts sends, not misses.
- **Verification.** `cf space verify --expect-migration` exited zero with
  nothing removed. The authored fields — `title`, `body`, `comments`, `links`,
  `createdAt`, `createdBy` — were byte-identical on all 902 Topic input and
  result entities. The only stored-data change was `shortName` on each Topic's
  input.
- **Start time.** The same three Topics, stepped through the CLI, took 1.8–5.5 s
  on the old source and 1.5–1.7 s on the new.

## What the procedure's own checks did not see

- The fingerprint's per-kind tally never listed a Topic input as a changed
  `free-cell`. The 451 `shortName` writes landed on entities it classifies
  otherwise, so the space-clone procedure's "a changed free-cell is a clobber"
  reading would have passed a clobbered Topic too. The authored fields had to be
  compared directly.
- `deno task cf cell get /top/<n> title` failed on the clone with `Slug "top"
  not found`. Reading `names/<n>` on the board with `--input --select @`
  resolved the entry instead.
- An offline count of stored numbers read each Topic's result document rather
  than its input and reported 7 of 451. The CLI's `--input` read is the one that
  resolves a Topic's input the way the runtime does.

## Rollback

`cf piece rollback --plan` against the retarget's plan refused its first row,
`result.recordName: existing result field was removed`, and wrote nothing.
Neither `rollback` nor `restore` accepts an override. Once a Topic moves, its
source cannot be moved back through the source log.
