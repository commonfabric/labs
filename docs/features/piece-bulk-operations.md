# Bulk piece operations

Three write operations over many pieces in one space — retarget a piece's
source, repair its stored document, and reverse either — share one spine and
differ only in what they apply, with a read-only survey under all of them.
This document is the contract they hold: what a plan row means, what is proved
before a write, what a stop leaves behind, what a resume may claim, and which
refusal fires at which moment.

Command spellings, flags, and output modes are in
[`runtime/cli/README.md`](../../runtime/cli/README.md). The operating loop
for rehearsing a run against a copy of real data is
[`space-clone-rehearsal.md`](../development/space-clone-rehearsal.md).

## The spine

```text
survey → plan → preflight → apply serially → survey diff
```

Every operation walks it, and only the apply step differs.

| operation | applies | its row's precondition | verified by | reversed by |
| --- | --- | --- | --- | --- |
| survey | nothing; it reads and reports | — | — | it writes nothing |
| retarget | one local source package, resolved from disk | the `{identity, symbol}` pair the piece is on | the survey diff | rollback, derived from the same plan |
| repair | a fixer's whole-document answer | the hash of the stored document | re-asking the fixer after the write | nothing derivable |
| restore | a revision of the piece's own retained source log | the pair the retarget produced | the survey diff | a second retarget |

Retarget and restore run on the shared engine in
[`bulk-apply.ts`](../../runtime/piece/src/ops/bulk-apply.ts), each supplying
one write step. Repair runs its own pass over the same survey selection,
because its rows are classified from a document rather than from a reference.

## The plan artifact

A plan is one header line and one row per piece, encoded as line-oriented
JSON, and **line order is execution order** — the ordering constraint sits in
the artifact a reviewer reads rather than in a shell history nothing can
check.

The header records the space every row's piece lives in, when the survey was
taken, which selector produced the rows, and the enumeration the selection was
cross-checked by: the number of pieces selected, the number the piece registry
lists, and the number of registered in-scope pieces the selection lacks.
Optional `problems` and `outside` lists name what the survey could not account
for, so an incomplete survey rides the artifact rather than encoding as a
clean one.

A row carries the piece's canonical bare address, an optional `phase` label,
the `expect` record the operation requires, and — once an operation is chosen
— the `op` that performs it. `expect` holds the pattern identity the piece is
on, the export symbol that identity runs, whether that source is verifiably
retained in the space, the origin the piece follows when it follows one, the
current source revision when the piece keeps a log, and the stored document's
hash when a repair recorded one. The origin is the string the piece stores and
nothing derived from it: the canonical URL and the kind are both computed from
it, against the host this deployment routes the space to, so either would read
differently elsewhere. It records what the plan was built against rather than
what a run detaches, which the report carries instead. An `op` is a
retarget (a local source, the identity it produces, the symbol, and a per-row
compatibility override), a restore (the reference to return to, and the
revision when one was read), or a repair (the fixer's name and the content
identity of its authored closure).

`normalizePlan` is the one validator the decoder and every executor share, so
an in-memory plan handed straight to a run receives exactly the scrutiny a
decoded file receives. It refuses:

- a first line that is not a `piece-plan` v1 header;
- a header whose `registeredOutside` count disagrees with its `outside` list,
  which is what keeps deleting the list from laundering an incomplete plan
  into a complete one;
- a plan listing one piece twice, the `of:` alias and the bare spelling
  folding to one key before the check;
- a reference row whose `op` pair equals its `expect` pair, which no diff
  could tell landed from never-ran;
- a retarget row whose `symbol` disagrees with its source's requested export,
  or whose requested export is the empty string — the resolver drops a falsy
  export and runs the default, so such a row would execute something its own
  text does not say;
- a repair row without a document hash, or a repair `op` without a fixer
  identity: without either, nothing about the row can be checked.

A retarget row's `rev` is a label for readers and for diffing two plans. It is
never enforced. The pin is the identity, recomputed at the write.

## What a survey reads, and what it refuses

A collection selector names a holder piece and the path to a collection inside
its stored input (or its result, when asked), and emits the members in stored
order with the holder last under the phase `holder`. Children first, parent
last is the selector's property rather than a step an operator performs. A
list selector names pieces outright, under the phase `list`.

The survey refuses, rather than surveying a subset silently: an empty
collection path or an empty segment; a holder that stores nothing at the path,
since a misspelled path and a never-written collection read identically; a
value at the path that is not an array; a member slot that holds no piece
link, named by its position; a collection whose last path segment is `holder`,
which would share a phase label with the holder's own row; and a piece
selected twice.

Per piece it takes one synced read for the source pin and never runs the
piece, plus one retained-source load per distinct identity, cached across the
run — bare document existence would be cheaper and would lie, since a
malformed entry document exists while nothing can restore from it. A supplied
validator adds a second read per piece. Every read is live: a survey taken
after a change reflects the change, with no snapshot to invalidate.

The registry is read once, serving both the header count and the containment
check, so the two can never describe different enumerations. Every registered
piece the selection does not hold is read for its reference; one on an
in-scope `{identity, symbol}` pair is reported as outside the selection, which
is a stop and is recorded in the header. A list survey claims no containment
and is not cross-checked.

An operation supplied to the survey is keyed by phase and stamped onto that
phase's rows. A phase no selected row carries is refused rather than dropped,
because an operation resolved from disk and then silently discarded leaves a
pre-state record the operator believes is a retarget plan. A piece already on
the operation's reference gets no `op` at all: such a row would be
unverifiable, and it stays a pre-state record.

A validator is a JSON schema each piece's result is read under, and it names
the pieces that fail it. The read uses ordinary read semantics, so a field a
schema default rescues passes here exactly as it would for the holder. A
validator failure is a finding, not an incompleteness: it does not make the
plan incomplete and does not stop a later stage.

## Classification, resume, and the stop

Every comparison is on the full executable reference, `{identity, symbol}`.
Two patterns exported by one module share an identity and differ only in
symbol, so an identity-only match would call a retarget landed before it ran.

One read of a piece classifies it against its row three ways: **landed** (on
the pair the `op` produces), **outstanding** (on the pair `expect` records), or
**moved-elsewhere** (on neither — nothing in the plan accounts for where it
is).

A run begins with a preflight: every row classified from one read, before the
first write. A row that is moved-elsewhere, or that cannot be read at all,
keeps the run from starting — every row reports where it stands, and nothing
is applied. The serial pass then proves each row again in the session that
writes it, the preflight's verdict deciding nothing there: a row proved landed
is reported without a write, and a row moved to something no row of the plan
names stops the run by name. Past that read the write carries the reference
the recheck proved, refused inside the transaction that would commit it, so a
move landing between the two is refused rather than overwritten.

One case is absorbed rather than caught, and the plan cannot see it: a second
writer that moves a piece onto the very reference the row was going to write
leaves it indistinguishable from a row this run had already landed, and it is
reported landed and skipped. The general statement is the honest one — a plan
is a record of what a run intended and a check on what it finds, not an
interlock against another writer.

Resume is therefore re-invocation of the same command, not a mode. It costs
one read per piece, is decided before any write, and rewrites nothing that
landed. What it may claim is bounded: a piece on the reference its row
produces is known to have moved as planned, and is not thereby known to be
healthy.

A stop is designed rather than incidental. Every piece that landed keeps its
change; the run stops at the first refusal, failure, or mid-run move; and
every remaining row is reported by name as `unattempted`, never as a count. A
report's verdicts are:

| verdict | meaning |
| --- | --- |
| `landed` | already on the pair the row's operation produces |
| `outstanding` | still on the pair the row recorded; on a dry run, not a defect |
| `applied` | this run performed the row's operation |
| `moved-elsewhere` | on neither pair; the run stops or never starts |
| `refused` | the row must not apply, and nothing was written |
| `failed` | an operational failure, state-checked after the fact |
| `unattempted` | untouched, after a stop or a session that never opened |

An operational failure is classified by a state check made *after* it, never
by a wall-clock probe before it: a server slow to answer here may still be
completing its writes, so a probe that gave up on one would abort a run that
was working. The row's problem text says where the failure left the piece: on
the target reference, still on its recorded one, on neither, or unreadable.

A row's `problem` and its `warning` are different facts. A `problem` belongs
to a row that did not apply. A `warning` belongs to a row that **did** —
the source was saved and something after it complained — so a warned row is
still complete, and the warning rides the report rather than a console nobody
keeps. A row's `origin` is neither: it is a fact about the plan's row rather
than about this run's outcome, so it rides every verdict, the dry run's
included — which is the only moment the detach below is still a decision. Its
`detachedOrigin` is the matching fact about the outcome, and rides only a row
this run wrote.

`complete` is true when every row reached what the run was for and no session
boundary failed: under an apply, every row landed or applied; on a dry run,
every row landed or outstanding. `stopReason` carries the run's own trouble as
distinct from any piece's — a session that would not open, would not release,
or opened onto another space — and its presence makes `complete` false
whatever the rows say.

Before any read, a run refuses: a plan whose header names pieces the survey
did not account for; a plan carrying rows of another operation's kind, one run
applying one kind; a plan with no rows of this kind, since an empty run reads
as a completed one; and a group size that is not a positive integer.

## The origin a retarget detaches

A retarget's write detaches the piece from the origin it follows. The source
it runs afterwards is the one the plan names, chosen by a human and reviewed
as part of the plan; a piece still carrying that origin could be repointed
afterwards to whatever the origin ships, which is not what the plan's
reviewer approved.

The detach is recorded rather than gated, and recorded twice over, because a
survey's reading of an origin and a write's are not the same fact. The survey
reads the origin into the row's `expect.origin` and the apply carries that
onto every report row, labelled as the plan's. A row this run wrote carries a
second value beside it — `detachedOrigin`, the origin the write actually
detached, taken from the snapshot its transaction committed against.

The two disagree when the plan went stale before the run reached the row.
Only the `{identity, symbol}` pair is a retarget's precondition, so a piece
whose origin alone moved since the survey is still written, and is detached
off the origin it holds then rather than the one the plan recorded — including
the case where it holds none by that point and the write detaches nothing.
Reporting the recorded value there would send an operator re-attaching by hand
to an origin the run never touched, which is worse than recording nothing: a
wrong record is confidently actionable. Substituting the live value silently
would be a smaller lie and still a lie, so both ride the row, the report names
both when they differ, and re-attaching is from the report rather than from
the plan. Re-attaching afterwards is by hand. Nothing re-attaches on
its own: the runtime's `follow` resolves an origin as it currently stands and
adopts whatever source it now ships, which is not the reference the plan or
its rollback promises to land, and a restore detaches in its own right by
design — so that reverting to repair a regression is not undone by the next
load.

It is recorded rather than gated because a detached origin is not the kind of
loss an unretained source is. An unretained row names a piece that can never
be returned; a detached origin is recoverable by hand from the record the run
leaves. Gate the irreversible, report the recoverable. An acceptance that
fired on nearly every row would be a rubber stamp rather than a decision,
which is the same risk the per-row compatibility override exists to avoid.

Which mechanism moves a piece follows from who chose the source and whether
there is a set. Bulk is the operator's lane: a set that has to move together
in a chosen order, from a plan a human reviewed. It is also the only lane for
a piece that records no origin.

The other lane is origin-following — one piece moving to whatever source its
origin ships, the choice belonging to whoever ships that origin rather than
to the operator. What a piece does with an origin today is narrower: the
origin is recorded on the piece, and explicit history actions act on it, one
clearing it and another repointing the piece to what the recorded origin now
ships. Following an origin as one mechanism, triggered by a user opening the
piece, is specified and not built.
[`piece-source-lifecycle.md`](../specs/piece-source-lifecycle.md) is where
that status is recorded — its logical-state table gives a repository status
per state — so a reader checks it there rather than inferring it here. A
retarget detaches the recorded origin whichever lane would have moved the
piece next, which is why every row records it.

## The safety model

Each refusal below fires at a named moment, and the moment is the point.

**Selection, at the survey.** A registered in-scope piece the collection lacks
stops the survey and is named. A run over a silent subset reports success over
what it enumerated and leaves the rest behind with nothing recording that they
were missed.

**Reversibility, before the first write.** A retarget row whose prior source
is not retained names a piece that cannot be returned once it moves. Under an
apply, every such row must be accepted by name or the run refuses and names
the ones that were not. Acceptance is per piece, with deliberately no blanket
form: one flag covering every row would turn many decisions into one, a
different risk from the same decision taken many times. An acceptance covering
no unretained row of the plan is itself refused, because accounting for none
looks exactly like accounting for one. A dry run is not gated — it moves
nothing, and reporting where such a piece stands is how an operator learns
there is something to decide.

**Reversibility, at the derivation.** The rollback derivation holds the same
rows to the same rule, in the same spelling: an unretained row is refused by
name, and naming it as accepted leaves it out of the reversal. Asking after
the forward run has already moved the piece is asking past the point of no
return, which is why the gate exists at both moments rather than only at the
one where the restore is missing.

**The source's identity, at the write.** A retarget resolves its row's source
from disk immediately before writing, recomputes the identity that source
produces — without compiling it — and refuses the row when it differs from
what the row recorded. A different checkout, an uncommitted edit, or a renamed
export cannot slip through. No separate export check is needed: the codec
refuses a row whose symbol disagrees with its source's requested export, and
the resolver echoes that request, so a decoded row's symbol is the export the
program runs by construction.

**Compatibility, per row.** The override is a field on the row, stamped across
a run at plan time and honored by the apply from the row and nowhere else. One
operator decision, as a per-run flag would be — but the plan shows exactly
which rows ran with the gate open, a reviewer can strip it from rows that
should not, and the record afterwards is per row. A restore carries no
override at all: getting one piece back over a compatibility refusal means
retargeting it onto that source, where the row-level override already lives.

**The space, at every session.** A piece address names a piece within a space,
so the same address names a different piece elsewhere. The plan's space is
held against the preflight session's and against every group's. A mismatch at
preflight refuses the run outright; a mismatch later stops it with the
remainder named, the rows untouched.

**The reference, inside the transaction.** The engine's read can only
classify; a writer landing between the classification and the write is
invisible to it. So the reference the recheck proved is handed to the write as
its own precondition — `expectedPattern` on the runtime's source-change and
source-set calls — and that snapshot becomes the transition's precondition,
checked again inside the transaction that commits it. A piece something else
moved is refused by name and the row stops the run; it is never overwritten.
The pin is a precondition and nothing else: it confirms no compatibility
review and opens no gate the row's own override does not.

**Session boundaries, once outcomes exist.** A session that cannot be opened
leaves its group unattempted, its state known rather than unknown. A session
that cannot be released after its group's writes committed stops the run with
those rows standing. Neither is any piece's fault, so both are reported as the
run's `stopReason` and never thrown away — the rows a partial migration
produced are exactly what its operator needs.

**A run that ends without reporting.** Every stop above is a report the engine
returns. An await inside the run that never settles is not: a process whose
main promise is pending with nothing left on its event loop does not hang, it
drains and exits at code 0, having written part of a migration and said
nothing about it. So the report is not the only thing that decides how `cf`
ends. Each of `retarget`, `rollback`, and `repair` arms a guard over its whole
run and stands it down the moment it has reported; a process that ends first
names the verb, says what had settled, and exits nonzero. The guard runs off
the process ending rather than a clock, so it costs a run that finishes
nothing and can never cut one short.

The guard spans the writing of the report as well as the run, because that
stretch can end the process too — a `--out` write that fails, a stdout that
will not take the document. Releasing the guard the moment the engine returned
would leave it unguarded, and the silence would simply move one step later. So
the guard stays and its CLAIM moves instead: a run whose engine never returned
is reported as one still in flight, and a run whose report never finished is
reported as exactly that. The second is the more useful of the two, because the
tally it carries is the very thing the failed report did not print.

That summary is the operator's only account of such a run, so no reading of it
may be false. The retarget and the rollback watch their rows in every output
mode — `--json` and `--out` hand the engine a reporter that observes and never
prints, since what a document mode cannot do is stream to stdout, and those
are the modes with the most to lose: the document is built from the returned
report, so a run that never returns writes no file at all. Their line therefore
counts rows and names their verdicts, and a count of zero is a fact about a run
that was being watched. The repair's engine reports its rows only in the report
it returns, so its line says the number is not known rather than saying zero —
its rows really do settle, and a number an operator can act on must never be
one this process is in no position to give. That reason names the missing row
reporter rather than the missing return, so it stays true of a repair whose
report was the part that failed. Neither line claims that rows it
does not name were left alone: whether anything past the settled rows was
written is a question for a fresh read, and the line sends the operator to the
same command without `--apply` — every verb that arms a guard has a dry mode
that classifies each piece where it now stands, while a survey reads
references and would say nothing about a repair, whose work is in the
documents.

## The fixer contract

A fixer is a TypeScript module the run imports, whose default export is a pure
transform from a piece's stored input document to the document it should hold.
The tooling owns selection, ordering, the write, the stop, and resume; the
fixer owns only what the change is.

The fixer is its own predicate, which collapses three questions into one
mechanism: selection is the pieces it would change, resume is the pieces it no
longer changes, and verification is re-asking it over the stored result. None
of the three can drift from what the fixer does, because they are what the
fixer does — and that is why purity is part of the contract rather than a
style preference. Each evaluation therefore runs the fixer twice over
independent copies of the document and refuses an answer that differs.

The write is the wide one — the whole input document replaced — made safe by
refusals rather than by narrowing. An evaluation is refused when the fixer
throws, when it returns something that is not a document, when it returns a
document the store cannot hold (a function, an accessor, or a class instance
anywhere in it), when the answer is not pure, when the answer drops a field
the input held at any depth, or when it rewrites or drops a sigil link the
input carried. A document that lost fields the fixer never mentioned is a
defect, not an intent, and a reference rewritten as a value is corrupted while
a dropped one is destroyed.

Each row's evaluation and write happen in one transaction, so on a commit
conflict the closure re-runs against fresh state and the report describes the
evaluation that committed. A supplied plan's recorded document hash is
rechecked inside that same transaction: a row whose stored document still
needs the repair but no longer hashes to what the plan recorded is `moved` — a
stop, not an overwrite — while a row the fixer no longer changes is landed,
whatever it hashes to now. After a write the document is read back and the
fixer asked again, and a stored document that does not satisfy the fixer fails
the row and stops the run. A repaired row's reported changes are measured
between the stored documents rather than restated from the fixer's answer,
since the write path hydrates schema defaults and an addition the report never
mentioned is how a repair quietly widens.

Repair's selection is the survey's, not a plan's. A supplied plan must agree
with that selection exactly — same space, same fixer name, same pieces — and a
disagreement regenerates the plan rather than reconciling silently. The fixer
pin is held before the module is imported, because a dynamic import runs
top-level code and an implementation the plan's reviewer never saw must not
run even that much. On a collection selector the holder's own row is not
repaired: a fixer is typed against the members' document shape, and a holder
wanting repair is a one-piece list selection of its own.

## Rollback and single-piece restore

A rollback is derived from the retarget plan row by row, with no second
artifact and nothing re-surveyed: each row's precondition becomes the
reference the retarget produced, and its operation restores the retained
revision carrying the reference the row recorded. Survey-only and restore rows
are left out, a repair row is refused by name — its reversal is an inverse
fixer nothing can derive — and a derivation that would produce no rows at all
is refused, because an empty rollback reads as having one.

The reversal is the runtime's own operation rather than a second retarget.
Every source update appends a revision retaining the exact source closure it
ran, and a piece with no log yet gets a baseline from the retarget itself,
provided the source it was on is still retained. That is why a rollback row
names the recorded reference rather than a revision the survey could not have
read, and why a rollback needs no filesystem: it runs from what the space
retains, which is what makes it the reversal available during an incident.

Resolving a reference to a revision is shared by the bulk rollback and the
single-piece restore, so the two cannot disagree about which revision a
reference names or whether it can be restored at all. A recorded revision id
must exist in the piece's log *and* carry the recorded reference; without one,
the reference selects the most recent revision carrying it. A revision whose
source is no longer retained is not a restore target, however it was selected.

Restoring detaches the piece from the origin it follows, as a retarget does.
So a piece is already where a restore would leave it only when it runs the
revision's reference **and** follows no origin; a piece that runs the reference
while still following an origin is written, and the run names the origin it
detaches. A compatibility
verdict against the piece as it now stands is a refusal naming the piece and
the reason, and an argument the restored source cannot use at all is the
runtime's hard refusal, which arrives as an operational failure instead. Both
stop the run; they differ only in the verdict the row carries.

## Verification is a separate pass

An apply that exits zero is not a verdict. The verification of a reference
operation is the survey diff: a survey taken afterwards, held against the plan
the run was made from, as a separate invocation.

Each planned row lands in one of three outcomes — moved as planned, still
outstanding, or moved to something the plan did not ask for, the third being
what an upgrade that half-converged looks like. A row that carries no
operation is a pre-state record and diffs to unchanged or changed. Pieces the
after-survey holds and the plan does not are reported as unplanned rather than
dropped, so a selection that grew mid-run stays visible.

The diff refuses three comparisons outright: a plan carrying repair rows,
since a repair moves the document and not the reference and a reference diff
would report unchanged about work it cannot see; two plans from different
spaces, where matching addresses would read as landed while saying nothing
about either space; and an incomplete side, whose unaccounted pieces would
read as clean rather than as unknown.

A repair's verification is its own: re-asking the fixer, row by row after each
write inside the run, and as a whole-set dry run over the same selection
afterwards. One that comes back all-conforming is the verification an operator
runs on its own.

## Sessions, groups, and cost

Sessions are grouped: one session serves a bounded number of pieces and is
then released, so the expensive warm-up is paid once per group while the
pieces live at once stay bounded by the group size rather than by the length
of the run. The size is a knob with a default of twenty-five, not a constant
in the code. A group boundary is therefore a resume point — a run that dies
inside a group loses at most that group's warm-up, because every landed row
reads as landed on the next invocation.

Serial order is a correctness constraint and not a limitation to optimize
away: a parent recomputing over children mid-change is the failure the
ordering exists to prevent. Whether siblings may be applied concurrently is
open, and it is gated on measurement.

That measurement is why every row an apply session began work on reports its
own wall-clock cost. A row reclassified as landed, moved, or refused paid for
the reads and resolution that reclassified it and reports that cost as an
applied row reports its write; a preflight classification and an unattempted
row report none, neither having been worked on. The cost rides each row rather
than a run summary, so it is in hand while there is still a run to reason
about — a run whose cost per piece is unknown cannot be improved.

## What the drill guarantees

[`bulk-survey-drill.sh`](../../runtime/cli/integration/bulk-survey-drill.sh)
runs in continuous integration under the CLI integration suite's `piece-call`
section, against a fresh space with no prior state and no store access. It
deploys a checked-in fixture pair — a trimmed prior-generation member pattern
and a current one, with the board holding them — so it reds when bulk
operations break rather than when a real pattern changes. A change that breaks
this surface breaks the drill, which is what makes "does the migration tooling
still work?" a CI result rather than an expedition.

It holds, among the rest: a board-sized collection surveyed in one process;
the header's enumeration and containment; members in order with the holder
last, and the retarget stamp on member rows alone; the single-piece pin
agreeing with the holder's row; a survey reflecting a change made since the
last one; a repair run dry, applied from its own plan, resumed as all-landed
writing nothing, and a field-dropping fixer refused by name; a retarget dry
run writing nothing; an edited source refused with every unattempted piece
named; an unretained move refused until accepted by name; a completed plan
re-running without writes; a piece on neither of its row's references stopping
the run by name; the after-survey telling the three outcomes apart; a
registered in-scope orphan making the survey refuse; a list survey claiming no
containment; a rollback derived from the retarget's own plan and putting the
board back where the plan found it; and one piece returned on its own to a
revision of its own log.

Interruption is exercised rather than left to production, for both the
retarget and the rollback, because it is the property most likely to rot
silently. The drill reads the report's streamed rows, kills the run inside its
second group — past one group boundary — and completes it by re-invoking the
same command. The interruption itself is proved twice over: the killed run's
exit status must be a signal death, and a read-only pass between the two
invocations must find real work on both sides of the cut. A run that had
finished on its own would satisfy every assertion about the second invocation
while exercising none of what the step is for. A repair stopped midway — by a
row whose fixed document the schema refuses — is completed the same way, by
re-invoking with an amended fixer, and the rows that landed are not rewritten.

[`bulk-ops-demo.sh`](../../runtime/cli/integration/bulk-ops-demo.sh) shows the
same surface live, narrating each command and then running it. Run it against
any host:

```bash
API_URL=http://localhost:8000 runtime/cli/integration/bulk-ops-demo.sh
```

## Where the code lives

Under [`runtime/piece/src/ops/`](../../runtime/piece/src/ops/):

- [`bulk-plan.ts`](../../runtime/piece/src/ops/bulk-plan.ts) — the plan's
  types, its codec and shared validator, the acceptance rule for unretained
  rows, and the rollback derivation
- [`bulk-survey.ts`](../../runtime/piece/src/ops/bulk-survey.ts) — the
  selectors, the per-piece pin read, the containment check, the validator
  pass, and the tally
- [`bulk-apply.ts`](../../runtime/piece/src/ops/bulk-apply.ts) — the shared
  engine: classification, preflight, grouped sessions, the stop, and the
  report
- [`bulk-retarget.deno.ts`](../../runtime/piece/src/ops/bulk-retarget.deno.ts)
  — the retarget's write step
- [`bulk-local.deno.ts`](../../runtime/piece/src/ops/bulk-local.deno.ts) —
  resolving a row's source from disk and computing the identity it produces
  without compiling it
- [`bulk-rollback.ts`](../../runtime/piece/src/ops/bulk-rollback.ts) — the
  restore write step the reversal runs on
- [`bulk-repair.ts`](../../runtime/piece/src/ops/bulk-repair.ts) — the fixer
  contract, its guards, and the transactional apply
- [`bulk-diff.ts`](../../runtime/piece/src/ops/bulk-diff.ts) — the survey
  diff
- [`piece-restore.ts`](../../runtime/piece/src/ops/piece-restore.ts) —
  reading a piece's restorable revisions and resolving a reference to one

Under [`runtime/cli/`](../../runtime/cli/):

- [`lib/unreported-run.ts`](../../runtime/cli/lib/unreported-run.ts) — the
  process-end guard a run that writes arms over itself, and the summary it
  reports when the process ends first

## Where to read further

- [`docs/plans/piece-bulk-operations.md`](../plans/piece-bulk-operations.md) —
  the design and build sequence, including the stage that is still gated on
  measurement
- [`docs/specs/piece-source-lifecycle.md`](../specs/piece-source-lifecycle.md)
  — the append-only revision log a piece keeps, the restore built on it, and
  the origin-following lane it specifies: one piece moving at its user's next
  open, on an origin a retarget detaches. That lane is specified there and
  not built; the document's logical-state table carries what has landed
- [`runtime/cli/README.md`](../../runtime/cli/README.md) — the commands,
  their flags, and the reference forms their selections take
- [`space-clone-rehearsal.md`](../development/space-clone-rehearsal.md) — the
  procedure for rehearsing a run against a writable copy of a real space
