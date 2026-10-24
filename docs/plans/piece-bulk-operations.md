# Bulk piece operations

**Status:** proposed; stages 1 through 4 — the survey, repair, retarget, and
rollback libraries, their `cf` entry points, and their coverage in the CI
drill and the demo — are built. Stage 5 is unbuilt, and gated on the
measurement it names. This is the design and build sequence for changing
many pieces in one space as one reviewable, resumable operation. Driven by
recurring Topics board upgrades.

## The short version

**Three operations over many pieces share one spine and differ only in what
they apply.** Retargeting a piece's source, repairing its stored data, and
rolling either back are the same problem — select a set, record what each
piece looks like now, apply serially, verify, and resume from wherever it
stopped — with three different apply steps hanging off the end.

Building any one of them alone produces a tool that cannot become the other
two. Retarget is one source across many pieces; rollback is many pieces each
returning to its own recorded revision; repair does not go through the
source path at all. A design that starts from "apply one source to a list of
pieces" has already excluded two thirds of the subject.

What the caller supplies differs by operation, and that is the whole of the
difference: a source package for a retarget, a **fixer** for a repair, and
nothing at all for a rollback, which reads what the plan already recorded.
Everything else — selection, ordering, the pre-state record, the serial
apply, the stop, resume, and verification — is the same machinery.

## The consumer

The Topics board is upgraded on a recurring basis, and every upgrade is a
bulk operation: a retarget of every topic piece plus the board that holds
them, ordered children-first. Around it sit the other two — a repair when an
upgrade exposes stored data that no current write path would produce, and a
rollback when one goes wrong under a quiet window.

That recurrence is the requirement. Tooling that is built when an upgrade is
already looming is tooling that gets its first real exercise during the
operation it is supposed to make safe. So the goal is not only that these
operations exist, but that they are **known to work before anyone needs
them** — which is what the drill below is for, and why it is a success
criterion rather than a nicety.

### An upgrade is two runs, not one

Every upgrade is rehearsed against a scratch deployment holding a copy of the
board, and only then run against the deployment holding the live one. The two
runs are the same operation against different stakes, and the differences are
what the tooling has to respect:

- **The rehearsal can be reset; the live run cannot.** There is no space
  reset for a production deployment, so the only reversal available there is
  a rollback through this tooling, from a record captured before the run
  started. That makes rollback a prerequisite of the first live run rather
  than a later convenience.
- **The plan is the thing compared across the two.** A plan generated against
  the copy and a plan generated against the live board should differ only in
  ways someone can explain, and that comparison is the last check before the
  live attempt. It is only possible because the plan is a file.
- **The live run happens inside a quiet window**, against data that is being
  written to right up until it starts. Its plan is therefore generated at the
  start of that window, not inherited from the rehearsal.

A rehearsal that used different tooling from the live run would rehearse
something else. Both runs use the same commands and the same plan format;
what changes is the deployment they name.

## The operations

| | selects | applies | reverses with |
| --- | --- | --- | --- |
| **Retarget** | pieces on a given pattern, or an explicit list | one source package to every selected piece | rollback |
| **Repair** | pieces a supplied fixer would change | that fixer's output, as each piece's whole document | a second fixer, or restore from a content export |
| **Rollback** | pieces a plan previously moved | each piece's own retained prior revision | a second retarget |
| **Survey** | any enumerated set | nothing — it reads and reports | n/a; it writes nothing |

They are one subject because the risky parts are identical: deciding what is
in scope, proving each piece is in the state you think it is, not losing your
place when the run stops, and telling afterwards whether it worked. They are
separate operations because the write paths, the preconditions, and the
reversibility differ, and a tool that conflates them will get one of those
wrong for the others.

**Survey is the one that writes nothing, and it is not a lesser member.** It
answers "what does each of these pieces currently look like?" and "which of
them fails this test?" — the second being the same insight as a fixer being
its own predicate, with a validator in place of a transform. It earns its
place because those questions are otherwise unanswerable in bulk: when a
holder demands something one stored member cannot satisfy, the read fails for
the whole collection at once and names neither the offending member nor its
position, so finding the one bad piece among a hundred has no better method
than bisection by hand. A survey answers it in one pass.

Survey is also how the reference operations are judged. A survey taken
before a run is the pre-state record the plan needs; the same survey taken
afterwards is the verification; and the difference between them is the
report of what the run
actually did. One artifact, three uses — which is why it is built first.

## The spine

```text
select → plan → check preconditions → apply serially → verify → resume
```

**Select** names the set. The selector is not assumed to be pattern identity:
it may be a pattern, a holder's own collection, an explicit list, or — for a
repair — the supplied fixer itself, since the pieces it would change are
exactly the pieces that need it. Identity is one selector among several, and
treating it as the axis is what makes a tool board-shaped or upgrade-shaped
instead of general.

**Selection reads the holder's collection, not the space's piece registry.**
The registry records pieces that were explicitly registered, which is
something a piece-creation command does and a pattern's own handler has no
reason to do. So a board's collection and the registry listing describe
different sets, and the registry is the smaller and less truthful of the two
— on a board whose members are created through its own handler, most members
are absent from it. A tool that enumerates by registry silently operates on a
subset, reports success over that subset, and leaves the rest untouched with
nothing in the output to say so.

That failure is invisible by construction, so the design does not merely
prefer the collection — it requires **a second enumeration, compared by
containment, with a disagreement stopping the run**. The registry is the
cheap second source and is expected to be the smaller, so equality is the
wrong test; the test is that every registered piece on an in-scope identity
is also in the collection. One that is not is either a member the collection
read dropped or a piece of the same kind living outside the holder, and
either way the plan does not account for it — so the run stops, names it,
and the operator regenerates the plan with it named or excluded by name.
Where an offline copy of the store is available, as it is on a rehearsal
clone, a third enumeration — every piece in the space on an in-scope
identity — is the strongest check of all, and a rehearsal that fails it does
not proceed to the live run. Both counts and the containment result go into
the plan's header, so the check is reviewable after the fact and not only at
run time.

**Plan** freezes the selection into an artifact. See below.

**Check preconditions** classifies every row, before touching anything, from
one read of its piece: still in the state the plan recorded, and so
outstanding; already in the state the operation produces, and so landed; or
in neither, which means something other than this plan moved it. The third is
reported by name and the run does not start. The first two are what make
resume a re-invocation rather than a separate mode.

**Apply serially**, in plan order, stopping at the first failure. Serial is
not a limitation to be optimized away — a parent recomputing over children
mid-change is the failure this ordering exists to prevent.

**Verify** is a separate pass, never a side effect of applying. An apply
that exits zero is not a verdict: the source-update path reports success for
a piece whose source committed but whose running instance failed to refresh.
The instrument differs by operation: a reference operation is verified by
the survey-diff, while a repair is verified by re-reading the stored
document and re-asking the fixer — a distinct read after each row's write,
made row by row inside the same invocation, because the fixer is already in
hand and the survey-diff cannot see document work, which is why it refuses
repair rows. The whole-set after-pass is a dry run over the same selection:
it re-asks the fixer across every piece, and one that comes back
all-conforming is the verification an operator runs on its own.

**Resume** is the precondition check again: re-running the same command
re-derives what is outstanding, skips what landed, and stops on what moved
elsewhere.

## The plan is the artifact

A plan is a list of rows, each naming a piece, the state it must be in, and
what to do to it:

```text
piece         precondition                  operation
of:fid1:aaa…  reference=PB0Gum…#default     retarget=topic.tsx@<rev>
of:fid1:bbb…  reference=PB0Gum…#default     retarget=topic.tsx@<rev>
of:fid1:ccc…  document-hash=9f2c…           repair=<fixer>@<closure-id>
```

A repair row carries two pins, because it has two inputs that can drift: the
document hash holds the piece to the state the fixer's answer was computed
from, and the closure identity — the same no-compile identity a retarget's
source carries — holds the fixer to the implementation that was reviewed. A
plan whose fixer file changed after review, or whose spelling resolves to
different code elsewhere, refuses before the module is even imported.

Four properties follow from making this a file rather than a command line:

- **Rollback is derived from the plan, row by row.** The precondition becomes
  the state the retarget produced; the operation becomes a return to the
  retained revision carrying the identity each row recorded. Nothing has to
  be re-surveyed or re-supplied, which is the property a one-source-many-pieces
  interface cannot have.
- **It is reviewable before it runs, and diffable before it runs again.** A
  plan generated against a clone and a plan generated against production
  should differ only in ways someone can explain.
- **It carries order.** Children before parents is a correctness constraint,
  not a preference, and it belongs in the artifact rather than in the
  operator's shell history where nothing can check it.
- **It is the record of what the pieces looked like beforehand**, which is
  what makes both resume and rollback possible.

The plan is produced by a command, not by a pipeline transcribed from a
runbook. A plan that has to be re-derived by hand for each operation is
re-derived differently each time.

## Resume is decided from recorded pre-state

A piece is outstanding when it still satisfies its recorded precondition, and
landed when it is in the state its operation produces. Both are decided from
the plan and one read of the piece; neither compiles anything. Every such
comparison is on the full executable reference, `{identity, symbol}` — two
patterns one module exports share an identity and differ only in symbol, so
an identity-only match would call a retarget landed before it ran.

The landed half is cheap because the reference is a function of authored
source, not of a compile: the runtime computes the identity a source package
will be stored under without compiling it, the symbol is the export the
source names, and a plan carries both on every retarget row beside the
source. So "is this piece already on the reference this row produces?" is
answered the same way as "is it still on the reference this row recorded?" —
by comparing one reference read against a value already in the plan. What
neither question asks is "does this piece already run the source I am about
to apply?", which would need a compile and still would not see the source
transition, revision history, or repository metadata the update path owns.
Resume never needs that question.

The consequence is that resume costs one read per piece and is decided before
any write, which is why re-invoking a stopped run is safe and nearly free on
the pieces that already landed — and why a piece on neither reference is a
stop rather than a skip: nothing in the plan accounts for where it is.

It also bounds what resume can claim. A piece on the reference its row
produces is known to have moved as planned; it is *not* thereby known to be
healthy. Verification is the separate pass for that, and no amount of
pre-state checking substitutes.

## What a stop leaves behind

A run that stops has produced a partially changed space, and there is no
transaction to hide behind. So the stop is designed rather than incidental:

- Every piece that landed keeps its change.
- The pieces not attempted are written out **by name**, not counted, so the
  remainder is addressable without reconstructing it by hand.
- The failure is classified — a refusal about one piece, or the server having
  gone away — by a state check made *after* the failure. Never by a
  wall-clock probe before it: a healthy server here has been measured taking
  over a minute to answer while still completing writes, so a timeout would
  abort working runs.

Mid-run failure is expected, not exceptional. Resource exhaustion on a large
store is a known outcome, and the design assumes it.

## Where batching lives

Batching is an execution strategy under the apply step, not an operation and
not the subject. Four strategies exist, and only the first two words of that
sentence are about speed:

- **A process per piece.** Simple and isolated, and it does not work. Across
  a board-sized set a loop that spawns a command per piece fails outright
  well before the end, so the cost is not the per-piece startup — it is a
  partial result that looks like a complete one. This strategy is ruled out
  rather than deprecated.
- **One process, a session per piece.** The bare floor. It removes the spawn
  entirely while keeping each piece's session independent, so nothing
  accumulates across the run — and it recovers almost nothing, because
  process and session start-up are a small part of what a piece costs.
- **One process, one session per bounded group.** The working strategy. A
  session serves a fixed number of pieces and is then replaced, so the
  expensive warm-up is paid once per group rather than once per piece, while
  the number of pieces ever live at once stays bounded by the group size
  rather than by the length of the run.
- **One process, one session across the whole run.** Maximum amortization,
  and the only one whose risk grows with the work: every updated piece stays
  running for the rest of the run, so memory and cross-piece interference
  scale with the total. Unmeasured at the sizes that motivate it.

The grouped strategy is the floor for anything board-sized, and the reason is
arithmetic rather than caution. The warm-up dominates the per-piece cost, so
paying it once per group of twenty recovers most of what the whole-run
session would, while the thing that has never been measured — many pieces
live in one process — is held to twenty instead of hundreds. A group boundary
is also a natural resume point, so the strategy that bounds the risk is the
same one that bounds what a failure costs.

What no strategy recovers is the swap itself. Replacing a piece's source,
re-staging its argument, and letting it settle is the actual work, it is paid
once per piece, and it sets the floor on any run. Amortization changes what
surrounds that; it does not change that.

Whichever strategy applies, order stays serial and the spine above is
unchanged. That is the point of putting batching underneath it: the plan,
the preconditions, the stop behavior, and the verification do not change when
the execution strategy does.

## Building it

Stage 1 writes nothing and everything else stands on it. After that the order
follows what each operation can be undone by, since that is what decides how
much has to exist before it is safe to run:

- **Stage 1 is read-only, shared, and immediately useful on its own.** It is
  the answer to "what do these pieces currently look like, and which of them
  is wrong?" — a question that is asked during every upgrade and that has no
  bulk answer today.
- **Stage 2 is repair**, whose reversal is a restore from a content export
  that already exists and is already drilled. So it needs stage 1 and nothing
  else.
- **Stages 3 and 4 are the retarget track.** The apply is enough to rehearse
  against a resettable copy; a live run also needs rollback, which is not an
  improvement on that path but the only reversal available there, and which
  has to be exercised on a copy before it is relied on.
- **Stage 5 is under all of them.** A whole-run session only makes an
  existing operation faster.

**The first useful increment is stages 1 and 3.** A rehearsal-only retarget —
survey the board, apply the source across it, resume when it stops — needs
neither repair nor rollback, because a rehearsal's reversal is resetting the
copy. That increment is worth naming because it is what an upgrade waiting on
this tooling actually needs, and because it is a prefix of the design rather
than a detour from it: every part of it is a part of the finished thing.
Rollback is not skipped, it is sequenced — it returns before the first live
run, which is the point at which resetting the copy stops being an option.

### The shape of the first increment

Enough to start on, and no more than that.

**The core is library code; the entry point is thin.** Enumerating, reading
each piece's identity, emitting a plan, consuming one, applying a row, and
restoring a retained revision are ordinary functions with no opinion about
how they are invoked. They live in `packages/piece/src/ops/`, beside the
piece and pieces controllers they call — the layer that owns piece
operations, and one from which the runner's local-program resolution is
importable, so turning a row's source into a program belongs there too.
There they are tested on the package's own runtime fixtures, with no command
surface at all. Only a small wrapper in the CLI carries the spelling, which
decision 1 has since settled: the `piece` group holds every piece operation,
single or bulk.

**Two selectors to start, and the collection one carries the order.** A
selector is a value handed to the survey. `{kind: "collection", holder,
path}` names a holder piece and the path to its collection, and emits the
members followed by the holder as the last row — children first, parent last
is a property of the selector, not a step the operator performs.
`{kind: "list", pieces}` names pieces outright: the orphan the containment
check found, or any other hand-picked set. A space-wide "every piece on
identity X" is not a live selector — live, it could only come from the
registry or from running every piece, and both are ruled out above — so it
exists only as the third enumeration, offline, where a rehearsal clone's
store can be read. Selectors that take a fixer or a validator arrive with
their stages.

**The plan is line-oriented JSON.** One header object, then one object per
piece, and **line order is execution order** — the simplest encoding of a
constraint that has to survive review, and one a reader can check without
running anything.

```text
{"kind":"piece-plan","v":1,"space":"did:key:…","takenAt":"…","selector":"collection","enumerated":{"collection":113,"registry":7,"registeredOutside":0}}
{"piece":"of:fid1:aaa…","phase":"topics","expect":{"patternIdentity":"PB0Gum…","symbol":"default","retained":true},"op":{"kind":"retarget","source":{"main":"topic.tsx"},"rev":"…","patternIdentity":"Xk3Lp…","symbol":"default","allowIncompatible":true}}
{"piece":"of:fid1:bbb…","phase":"holder","expect":{"patternIdentity":"WpIRvA…","symbol":"default","retained":true,"revisionId":"rev-bbb…"},"op":{"kind":"retarget","source":{"main":"main.tsx"},"rev":"…","patternIdentity":"Nq8Hw…","symbol":"default","allowIncompatible":true}}
```

and the rollback row derived from the first of those:

```text
{"piece":"of:fid1:aaa…","phase":"topics","expect":{"patternIdentity":"Xk3Lp…","symbol":"default","retained":true},"op":{"kind":"restore","patternIdentity":"PB0Gum…","symbol":"default"}}
```

What the encoding buys — most of it a claim made earlier in this document
that would otherwise have no mechanism:

- **`expect` and `op` together are enough to derive the rollback.** A retarget
  row's `expect` holds the `{identity, symbol}` reference the piece runs —
  the pair, because two patterns one module exports share an identity and
  differ only in symbol — whether the source behind it is still retained in
  the space, the origin the piece follows when it follows one, and, for a
  piece that already keeps a revision log, the revision
  it is at; its `op` holds the source to apply and the reference that source
  produces, computed from the source without compiling it (a source that
  mounts other patterns over fabric imports is the exception, and a compile
  gives the same value; extra source roots and data files fold into the
  identity the way the compiler folds them). The rollback row's `expect` is
  that produced reference, and its `op` restores the retained revision
  carrying the recorded one — refusing up front any row whose prior source is
  not retained. The property is mechanical because each row carries both ends
  of the move.
- **A return to a recorded revision is the runtime's own operation, not a
  second retarget.** Every source update appends a revision to the piece that
  retains the exact source closure it ran, and the runtime can restore a piece
  to one of those revisions without being handed the source again
  ([piece source lifecycle](../specs/piece-source-lifecycle.md)). That is what
  `restore` names. A piece with no revision log yet gets one from the retarget
  itself: the transition first appends a baseline revision retaining the
  source the piece was on, provided that source is still retained in the
  space — so for most pieces the rollback target exists only after the
  retarget, which is why the rollback row names the recorded reference
  rather than a revision the survey could not have read. A piece whose prior
  source is no longer retained has no restore target, and the survey says so
  up
  front (`retained`), because the read that answers it is available before
  the run. A rollback that instead re-applied an old checkout of the source
  would re-derive, by hand and from outside the space, what the piece
  already retains — and is exactly, and only, what the unretained rows need
  an operator to supply before a live run.
- **The header records both enumerations and the containment check.**
  Selection error is the failure this design most wants to catch, and
  recording the collection count, the registry count, and how many registered
  in-scope pieces the collection lacks is what makes the check reviewable
  afterwards rather than only at run time. The header also says which
  selector produced the rows, and an incomplete survey rides the artifact:
  optional `problems` and `outside` lists name what the survey could not
  account for, the count and the list must agree, and a write stage — the
  rollback derivation today — refuses a plan carrying either.
- **The reference is the pin; `rev` is a label.** A row's `source` names a
  main file and, when the program has them, its root, tests, data files, and
  export, and the apply resolves it through the runner's local-program
  resolution so nothing attached is dropped. Before writing, the apply
  recomputes the identity of the source it actually resolved and refuses the
  row if that differs from `op.patternIdentity`, or if the export it would
  run is not `op.symbol` — a different checkout, an uncommitted edit, or a
  renamed export cannot slip through. The codec already refuses a row whose
  `symbol` disagrees with its source's named export. `rev` is recorded for
  readers and for diffing two plans, and is never enforced: enforcing it
  would add a second refusal for a condition the reference already proves,
  and would tie the plan to a git checkout.
- **The compatibility override is a field on the row, stamped at plan
  time.** `op.allowIncompatible` is what the apply honors, and nothing else;
  a flag on the plan command stamps it onto every row, or onto the rows a
  selector picks. One operator decision, as a per-run flag would be — but
  the plan shows exactly which rows ran with the gate open, a reviewer can
  strip it from rows that should not, and the record afterwards is per row.
- **`phase` labels rows; it does not sort them.** Order is already the line
  order. A phase is for grouping a report and for stopping between groups,
  which keeps one concept from doing two jobs.
- **A structured encoding avoids inventing a small language.** Preconditions
  and operations have fields, and a delimited format would need escaping
  rules that grow into a parser nobody chose to write.

**`op` is filled by naming an operation; `expect` is filled by reading.** A
survey given an operation — a source to retarget to, a fixer to apply —
emits complete rows. A survey given none emits rows with `expect` alone,
which is the pre-state record the after-survey is compared against and a
valid input to a later pass that adds the `op`. The two are one command with
one optional argument, not two tools.

**The validator is a schema.** A supplied validator is a JSON schema; the
survey reads each piece under it and names the ones that fail, which is the
question a broken holder read cannot answer. The canonical validator is the
holder's own demanded schema, so the common case supplies no code at all.
Code-shaped checking waits for the fixer, which is the same question asked
of a transform.

**The pin read returns the source pin and nothing else.** One piece in —
`{piece, patternIdentity, symbol, revisionId?, retained}` out: the reference,
the current source revision when the piece keeps a log, and whether the
reference's source is retained in the space. No input document, no result, no
link graph. Whether it surfaces as a flag on the existing per-piece inspection
or
as its own thing resolves with the entry-point question above; the function
underneath is the same either way, and it is what makes a survey over a large
board affordable.

### 1. Survey: enumeration, and the plan

A read-only pass that enumerates a set of pieces, reports what each one
currently holds, and writes the result as plan rows — `expect` filled from
the read, `op` filled when an operation was named. No writes, and therefore
nothing to undo — which is why it is first, and why it can be run against a
live deployment before anything else has been built.

Three things it has to get right, and each of them is a way a bulk operation
has been wrong:

**It enumerates from the holder's collection and cross-checks.** Per the
spine above, the piece registry is not a list of what exists, and a tool that
enumerates from it operates on a subset while reporting success. The registry
is compared against the collection by containment, and a registered in-scope
piece the collection lacks stops the run.

**It reads the identity alone, cheaply, and live.** A piece's pattern
identity is reachable without running the piece, but the paths that reach it
today are diagnostics: per-piece inspection also pulls the whole input, the
whole result, and the link graph both ways, and the space-wide listing runs
every piece it lists. A survey over a large board needs one small read per
piece. The snapshot-download path is not an alternative — it caches
indefinitely with no expiry and its re-download flag is on the pull command
rather than the reads, so a survey taken after a run would be served the
pre-run snapshot and report that nothing had changed. It is also unavailable
where it would matter most: the endpoint behind it refuses to mount in a
production environment and its routes answer as though they do not exist.

**It runs as one process over N pieces.** This is a correctness constraint
rather than a performance one. A shell loop spawning a command per piece does
not merely take a per-piece startup cost across a board-sized set — it fails
outright well before finishing, which turns a survey into a partial answer
that looks like a complete one.

**Delivers:** the identity read; the survey, with its plan file, tally,
containment result, and `retained` column — run against the live board on
day one, it answers which pieces sit on which identity and whether anything
registered sits outside the holder; the survey-diff, which compares a survey
against a plan or an earlier survey and is the verification every
reference operation uses — a repair's verification is re-asking its own
fixer, and the diff refuses repair rows rather than answering about work
it cannot see; the reference a local source produces, computed without
compiling; and the drill.

- [x] Enumeration comes from the holder's collection, and the registry is
      compared against it by containment: a registered in-scope piece the
      collection lacks stops the run and is named. A silent subset is the
      failure this exists to prevent.
- [x] Both counts and the containment result are recorded in the plan's
      header.
- [x] Each row records whether the source behind its recorded identity is
      still retained in the space, so a row with no rollback target is known
      before the run rather than during the incident.
- [x] One process handles a board-sized set, start to finish.
- [x] The read reports live state on every invocation, and a test proves it:
      a read taken after a change reflects the change.
- [x] The output is a plan — the same artifact the later stages consume —
      with `expect` filled, and `op` filled when the survey was given an
      operation. Op-less rows are the pre-state record and a valid input to
      planning later.
- [x] A tally accompanies it, so "do these pieces all agree?" is answered
      without reading every row.
- [x] A supplied validator — a JSON schema the survey reads each piece
      under — selects the pieces that fail it, naming each one. A collection
      whose read fails as a whole is diagnosable by this and by nothing else
      in bulk.
- [x] The survey-diff: a survey compared against a plan or an earlier
      survey, reporting per piece moved as planned, still outstanding, or
      moved to something the plan did not ask for.
- [x] The survey and the pin read are invocable from `cf`
      (`cf piece survey`, `cf piece inspect --pattern-identity`), the
      spelling decision 1 has since confirmed.
- [x] The stage-1 drill runs in continuous integration, under the CLI
      integration suite's `piece-call` section.

### 2. Repair, by a supplied fixer

The caller supplies a **fixer** — a pure transform from a piece's stored
document to the document it should hold — and the spine iterates it over the
selected pieces. The tooling owns selection, ordering, the write, the stop,
and resume; the fixer owns only what the change is. A fixer is a TypeScript
module the run imports: typed against the document shape, unit-testable
without a space, and checkable for the purity it has to have. Writing one is
a repository-local task, which is the trade that buys those three.

A vocabulary of built-in repairs is the wrong shape here. Every defect worth
a bulk repair is particular, so a fixed vocabulary is permanently one defect
behind, and each new one becomes a change to the tool rather than an input to
it.

**The fixer is its own predicate.** A fixer that returns a document unchanged
means that piece needs nothing, which collapses selection, resumption, and
verification into one mechanism:

- Selection is "run the fixer over the enumerated pieces and classify":
  the ones it would change are the work, and the ones it would not are
  already landed — recorded as such, since a resumable artifact needs the
  landed rows as much as the outstanding ones.
- Resume is the same question asked again — a piece already repaired is one
  the fixer no longer changes.
- Verification is the same question asked afterwards — a repair succeeded
  when re-running the fixer over the stored result is a no-op.

None of those needs a separate predicate language, and none of them can drift
from what the fixer actually does, because they *are* what the fixer does.
This is why a fixer must be a pure function of the document: a fixer that
reads a clock or a random source makes all three questions unanswerable.

**A fixer returns the whole document.** The write a repair goes through
replaces a piece's input document entirely, so a fixer that returns a
fragment silently drops every omitted field that has no schema default and
resets to its default every omitted field that has one. The tooling has to
hold that line rather than trusting it — a document that lost fields the
fixer never mentioned is a defect, not an intent, and the run should refuse
it.

**A fixer must not treat a link as data.** A stored document contains
references as well as values. Rewriting a reference as a plain value corrupts
it and dropping one destroys it, and neither is visible in the result until
much later. A fixer either round-trips them untouched or the run refuses the
document, and this is the constraint most likely to be discovered the
expensive way.

**Delivers:** the fixer runner; the dry-run per-piece document diff, which
stands alone as a read-only "what would change" report; and the
complete-document and links-intact refusals as library checks, which the
Topics restore script hand-rolls today and should import instead.

- [x] A fixer is supplied by the caller, and adding a new kind of repair
      requires no change to the tooling.
- [x] Selection, resume, and verification all derive from the fixer being a
      no-op, with no separately maintained predicate.
- [x] A dry run reports the exact per-piece document diff, and writes
      nothing. For a whole-document write this is a requirement, not a
      convenience.
- [x] A fixer that returns an incomplete document is refused rather than
      applied, and a test proves the refusal.
- [x] References survive a repair that does not mention them, and a fixer
      that would rewrite one as a value is refused.
- [x] Re-running a completed repair writes nothing.
- [x] The repair act in `packages/cli/integration/bulk-ops-demo.sh` stops
      being pending: the transcript runs a fixer live under the canonical
      spelling, `cf piece repair`.

### 3. Retarget

The upgrade apply: one source package across the pieces a plan names, serial,
in plan order, checking each row's precondition before writing it, stopping
at the first failure with the remainder named, and recomputing what is
outstanding on every invocation.

Verification is not a stage of its own, because stage 1 already is it: a
survey taken after a run, compared against the survey the plan was built
from, is the report of what the run did. What this stage adds is the
requirement that applying never implies it — an apply that exits zero is not
a verdict, and the two stay separate invocations.

**Delivers:** the plan consumer with grouped sessions; the stop report;
per-piece
timing, where the number from the first rehearsal run decides whether
siblings may run concurrently and whether stage 5 is worth building; and the
retarget drill. The entry point's spelling follows decision 1: the `piece`
group.

- [x] A retarget of a seeded board runs to completion from a checked-in plan.
- [x] Preconditions are proved for every row before the first write.
- [x] The identity of each row's resolved source is recomputed before the
      write and must equal `op.patternIdentity`, and the export it runs must
      be `op.symbol`; `rev` is never enforced.
- [x] The compatibility override is honored from the row field alone.
- [x] Every retarget row carries the `{identity, symbol}` reference its
      source produces, the identity computed without compiling, and the
      precondition check classifies each piece as outstanding, landed, or
      moved elsewhere against that row alone — comparing both halves of the
      reference, never the identity by itself.
- [x] A run interrupted partway is completed by re-invoking the same command,
      and the pieces that landed are not rewritten. A piece on neither of its
      row's references stops the run by name rather than being skipped or
      rewritten.
- [x] A stopped run names every unattempted piece, not a count of them.
- [x] The after-survey distinguishes "moved as planned", "still outstanding",
      and "moved to something the plan did not ask for" — the third being
      what an upgrade that half-converged looks like.
- [x] It composes with the existing space-level checks rather than replacing
      them; those remain the acceptance gate.
- [x] Sessions are grouped rather than per-piece or per-run, and the group
      size is a knob rather than a constant in the code.
- [x] A group boundary is a resume point: a run that dies inside a group
      resumes from the start of that group, having lost at most a group's
      worth of warm-up.
- [x] Per-piece timing is reported as the run proceeds. A run whose cost per
      piece is unknown cannot be improved, and the number is the input to
      every decision below about whether to go faster.
- [x] The apply and survey-diff acts in
      `packages/cli/integration/bulk-ops-demo.sh` stop being pending: the
      transcript applies a stamped plan and diffs the after-survey against
      it where it now shows the provisional spellings.

### 4. Rollback

The plan derived in the other direction — each row returning its piece to the
revision the plan recorded it at, through the runtime's own restore of a
retained revision rather than through a second retarget.

**Delivers:** the restore seam — the first command in front of the runtime's
retained-revision restore, useful on its own for any single piece; the
rollback-plan derivation; and the rollback drill.

- [x] A completed retarget is fully reversed from its own plan, with no
      second artifact needed: each rollback row's precondition is the
      reference the retarget row produced, and its operation restores the
      retained revision carrying the recorded reference.
- [x] A row whose prior source was not retained is refused by rollback with
      the reason named, never silently skipped — and a live run is not
      started with such rows unless the operator has supplied the legacy
      source for them or accepted, by name, that they cannot be rolled back.
- [x] The restore of a retained revision is reachable from the same entry
      point as the other operations. Today it is a runtime operation with no
      command in front of it, so this stage is where one appears.
- [x] Rollback checks preconditions the same way, so a piece changed by
      something else since the retarget stops the reversal rather than being
      overwritten — and a piece already back on its recorded reference is
      landed, which is what makes a rollback resumable.
- [x] A rollback is itself resumable.
- [x] The reversal is exercised against a copy, in the drill, before any live
      run is allowed to depend on it. A rollback path first attempted during
      the incident it exists for is not a rollback path.
- [x] The rollback act in `packages/cli/integration/bulk-ops-demo.sh` stops
      being pending: the transcript derives and restores live where it now
      shows the provisional spelling.

### 5. A session across the whole run

The widest execution strategy under the apply step: one session serving every
piece in the run rather than a bounded group of them, so session start-up,
replica warm-up, and source resolution are paid once in total. Grouped
sessions are stage 3's floor; this stage is only the step from a group to the
whole run. Last, because it is an optimization over a spine that must exist
first, and because it is the only stage gated on measurement.

**Delivers:** a measurement, and nothing else unless the measurement says so.

- [ ] Revisited only after the client's execution responsibilities settle.
      This stage optimizes work that may not stay here; see the scope section.
- [ ] Measured at the piece count a real board carries, not a sample of it —
      wall-clock, peak memory, and whether every piece completes.
- [ ] The spine is unchanged by the strategy: same plan, same preconditions,
      same stop behavior, same verification.
- [ ] A failure under the shared session degrades to the same stop report,
      with the same remainder named.

### Documentation

The stages deliver behavior; this is what states it outside the plan, so that
archiving the plan does not take the description of a live feature with it.

- [x] A feature document —
      [bulk piece operations](../features/piece-bulk-operations.md) — carries
      the spine, the plan artifact's semantics, the safety model with the
      moment each refusal fires, the drill's standing guarantees, and the
      session and timing contracts, and stands alone once this plan is
      archived. Command and flag detail stays in `packages/cli/README.md`.

## The drill

Every stage above is finished by a drill that runs in continuous integration
against a seeded space, in the manner of the content-safety drill that
already guards export and restore: deploy a board, seed it, take the store
snapshot, run the operation, and assert the outcome.

The drill is what converts this design from documentation into a standing
guarantee. Its subject is the real pattern, so a change that breaks bulk
operations should break the drill, and the answer to "does the migration
tooling still work?" is a CI result rather than an expedition. Without it,
each upgrade re-discovers the tooling's condition at the moment it is least
affordable to.

An interrupted run is part of what the drill exercises, not an edge case
left to production: stopping a run midway and completing it by re-invocation
is the property most likely to rot silently, because nothing else exercises
it.

The seeded board is a checked-in fixture pair — a trimmed "prior generation"
pattern and a "current" one — deployed and then retargeted, not the Topics
pattern at two revisions. That keeps the drill fast and stable, and it means
the drill reds when bulk operations break and not when Topics changes; the
Topics rehearsal remains the place where the real pattern is exercised.

## Open decisions

Each is named with the stage that forces it, so none of them has to be
settled before work starts.

1. ~~**How bulk is spelled.**~~ **Resolved: the `piece` group holds every
   piece operation, single or bulk.** The first write operation is stage 2's
   repair, and it lands as `cf piece repair` beside `cf piece survey` and
   `cf piece inspect`: one group, one word for "one piece", and the later
   write stages follow the same shape. A separate bulk group would buy a
   second home at the cost of the consistency that
   [CLI surface shape](../history/plans/cli-surface-shape.md) established.
2. ~~**Where preconditions are evaluated.**~~ **Resolved: over the API, and
   stage 1 builds the read.** A piece's pattern identity is readable from a
   live deployment without running the piece — the piece inspection path
   loads the cell with execution off and reports the identity ref — so the
   same check serves a rehearsal and a live run, and neither is verified by
   a mechanism the other does not use. The alternative decided itself: the
   snapshot endpoint the offline path depends on refuses to mount in a
   production environment, so there is no offline option there to weigh.
   What does not yet exist is a read of the right *shape*: see stage 1.
3. ~~**Scope of a compatibility override.**~~ **Resolved: a field on the
   row, stamped by a flag at plan time.** An override that lets one refused
   piece through is a per-piece decision today; applied to a plan, one flag
   covering every row turns many decisions into one, which is a different
   risk from the same flag used many times. The row field keeps the record
   per row and the plan-time flag keeps the decision single; the apply reads
   only the row. See the plan encoding above.
4. ~~**Whether repair gets a narrow write.**~~ **Resolved: the wide write,
   guarded.** The fixer contract already produces a whole document, so the
   wide write is the one that matches it, and the blast radius is held by
   refusals rather than by narrowing: an incomplete document is refused
   before any write, a reference either round-trips untouched or the
   document is refused, and purity is probed on every evaluation. What made
   the narrow write attractive — sparing untouched fields and references —
   the guards deliver at the document level: a raw read written back whole
   carries its sigil links intact, measured at the library seam. A narrow
   path write remains available as a later addition if rehearsal shows the
   wide write's cost, but it would be a new runner write primitive and is
   not what repair waits on.
5. ~~**How a fixer is supplied.**~~ **Resolved: a validator is a JSON
   schema; a fixer is a TypeScript module the run imports.** A module can be
   type-checked against the document shape, tested without a space, and
   checked for the purity a fixer has to have; a program piped a document is
   language-agnostic but can only be asked for those. The validator needs no
   code at all, because the canonical one is the holder's demanded schema.
   Writing a fixer is therefore a repository-local task, which is the trade
   the choice makes.
6. **Whether siblings may be applied concurrently** — *stage 3, and open
   until the first pass is measured.* Serial ordering exists because a parent
   recomputing over changing children is what storms, but the children of one
   parent are independent of each other, so bounded concurrency across them
   with the parent last is the largest speed lever available. It is also the
   one that contradicts the operating procedure, which says to migrate
   serially. The honest sequence is to run serially once while watching the
   churn the procedure already teaches how to read, and let that decide —
   rather than to reason about the storm from either direction.
7. **Whether one session across a whole run is viable at the sizes that
   motivate it** — *stage 5*, and open until measured. The grouped strategy
   is the floor precisely so that this stays a question rather than a
   prerequisite.

## Scope, and what sits next to it

**This is the shape half of a larger division.**
[Verb evolution](verb-evolution.md) already splits the problem three ways —
migration handles the shape, versioned interfaces handle the callers, and a
per-piece upgrade policy handles the rollout. This document is the first of
those and none of the others. It says how to change many pieces safely; it
says nothing about which pieces *should* change, when, or on whose authority,
and a reader who arrives here looking for that should go there instead. The
division is worth stating because both documents are live and neither is
legible as a part without it.

**Many pieces in one space, not many spaces.** Every operation here is scoped
to a single space, because that is what the consumer needs and because the
alternative is not a free generalization. A run across many spaces changes
things this design currently settles by assuming one: a plan would need to
name a space per row rather than once in its header, selection would have to
enumerate spaces before enumerating pieces, a session strategy would group by
space before grouping by piece, and a stop would leave a remainder spanning
spaces rather than a list within one. None of that is precluded — the spine
survives it — but it is a second design and not a flag.

**How much to invest in a shared session is gated on more than measurement.**
The execution strategies above are arithmetic about work the client does:
warming a replica, swapping a source, letting a piece settle. Where that work
runs is itself moving — [server-primary execution](server-execution-v2.md) is
sequencing a change to which responsibilities remain client-side. The spine
is indifferent to the outcome, since selection, preconditions, ordering,
stopping, and resumption are about operator control rather than about where a
computation happens. The strategies are not. So the execution strategy stays
behind a seam and the widest of them stays unbuilt: it is the part most
likely to be answered rather than optimized.

**What durable state answers "has this piece been migrated?"** The
precondition check above answers "is it on the reference this row recorded,
or on the one this row produces", which is enough for resume and rollback and
is
deliberately all this design relies on. A piece does keep a durable record of
its own source transitions — the append-only revision log that rollback
restores from — but that log says what the piece ran and when, not which plan
moved it or why. A stronger claim, that a piece has been migrated by a
particular plan, would need that attribution recorded somewhere, and whether
a revision should carry it is a question about piece semantics rather than
about tooling. It belongs with whoever owns the piece source transition rather
than being settled here.

## Related

- [The space-clone rehearsal procedure](../development/space-clone-rehearsal.md)
  is the operating loop a bulk operation runs inside: clone, serve, verify,
  reset.
- [Topics board migration](../history/plans/topics-migration-rehearsal.md) is a worked
  instance of the retarget operation, with a manifest, an ordering, and a
  rollback record.
- [CLI surface shape](../history/plans/cli-surface-shape.md), an executed plan now archived,
  set the command vocabulary that decision 1 above would change.
- [Piece source lifecycle](../specs/piece-source-lifecycle.md) specifies the
  revision log a piece keeps and the restore operation rollback is built on.
