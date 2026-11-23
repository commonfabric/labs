# Compiled pattern language: where each branch stands and what to do next

This document is for a session that continues the build of the compiled
pattern language without the conversation that produced it. It says which
branch holds what, which branches are not merged with each other, what each
open line of work needs next, and how a round of work is briefed and
verified. The design is in `docs/specs/compiled-pattern-language/`, the
decisions and open questions in
[compiled-pattern-language.md](compiled-pattern-language.md), and the
measurements in
[compiled-pattern-language-integration.md](compiled-pattern-language-integration.md).

## Branches

Every branch is in the repository `commonfabric/labs`. Worktrees are under
`.claude/worktrees/` of the main checkout. A branch marked "local" has
commits that are not pushed; push it before relying on it.

| Branch | Worktree | Holds | Pull request |
| --- | --- | --- | --- |
| `claude/fable-pattern-language-redesign-vvh48e` | `mystifying-bassi-ae84b4` | The specification and the plans | #9788 |
| `claude/compiled-pattern-prototype` | `compiled-pattern-prototype` | The crate, the plan emitter and a first executor | #9942 |
| `claude/compiled-pattern-topics` | `compiled-pattern-topics-merge` | The crate on the corpus of `main`, Topics on the executor | #10016 |
| `claude/compiled-pattern-runner-m3` | `compiled-pattern-m3` | The trunk of the build: milestones 3 to 6 merged, the store with frozen values, a resume by units | #10140 |
| `claude/compiled-pattern-serving-m6` | `compiled-pattern-m6` | Lists of links in documents by default, the window construct, the cost of a FabriChat send | none |
| `claude/compiled-pattern-sandbox-m5` | `compiled-pattern-m5` | The runtime's own `wish` and built-ins, fetch effects, a toolshed that compiles, scopes; the trunk at `a467194a96` and the carry branch are merged into it | none |
| `claude/compiled-pattern-write-integrity` | `compiled-pattern-write-integrity` | Write policies, write authorizations and the acting principal of a compiled piece | none |
| `claude/compiled-pattern-carry` | `compiled-pattern-carry` | Review fixes of #9942 carried onto the trunk's code | none |
| `claude/compiled-pattern-topics-runs` | `compiled-pattern-topics-runs` | The measured Topics boards; the serving branch is merged into it for measurements (local) | none |

Four pull requests against `main` came out of the work and are independent
of the experimental option: #10142, #10145, #10146 and #10147. Each is on a
branch of its own cut from `main`. The owner's instruction of 2026-11-23
(Z89) is to open one for any significant fix to today's runtime.

## What is not merged

The trunk is `claude/compiled-pattern-runner-m3`. Four branches were cut from
it, or from each other, at different commits and each changed
`base/pattern-compiler/exec/executor.ts`, `exec/store.ts`,
`runtime/runner/src/compiled/piece.ts`, `transactions.ts` and `resume.ts`:

1. `claude/compiled-pattern-sandbox-m5` (cut from the trunk at `5f45021c1d`).
   The trunk at `a467194a96` and the carry branch are merged into it (head
   `ad153f2c34`, note 892). The trunk has since moved to `7b2a492b82`, which
   is not merged. The merge settled how a resume treats a piece with scoped
   documents: a piece that has named a document of a scope resumes whole,
   with no row left as stored, its basis names a source with no number
   (P354), and it writes no list of readers. A piece with no scoped document
   is woken by units as on the trunk. A piece with a `wish` has scoped
   state, so under the serving loop with resume 71 corpus pieces are found
   current where the trunk finds 80, and `apps/redactor/vault.tsx` does not
   resume there: its whole resume is refused for writer fit.
2. `claude/compiled-pattern-write-integrity` (cut at `5f45021c1d`). It
   cherry-picked three commits of the sandbox branch (`d391e27356`,
   `f84027cabb`, `e6f2b7b96e`), so it merges with that branch first.
3. `claude/compiled-pattern-serving-m6` (cut at `820fa700ee`, before the
   store round). The store round rewrote `exec/store.ts`; this branch added
   list documents in the adapter and changed `Handle.key`.
4. `claude/compiled-pattern-carry` (cut at `aabee19586`). Merged into the
   sandbox branch; nothing of it is left to merge.

Merge in this order, one merge at a time, each by an agent that is given
both sides' notes and tests as the bar: the trunk head `7b2a492b82` into the
sandbox branch, then write integrity, then serving; the result becomes the
trunk. For each merge: resolve the textual
conflicts, then check the places where both sides changed the same
machinery without a textual conflict, regenerate the emitted fixtures
(`cargo build --release` in `base/pattern-compiler`, then the script the
sandbox notes name, which runs `pattern-compiler emit --unchecked` for each
`compare/fixtures/*.emit.json`), run the gates below, rerun one figure of
each side, and run `compare/runner-corpus.ts` in its four modes. Three
merges each produced defects neither parent had (two time values compared
as equal; a handler-sent event that was either not durable or threw; in the
merge of the trunk into the sandbox branch, every row evaluated at a wake
and a restore that dropped another principal's memo entry), so a merge is
not finished when the conflicts are gone.

Provisional decisions were numbered per round to avoid collisions: P250 to
P253 serving, P270 to P275 and P330 to P335 resume by units, P290 to P296
and P350 to P360 sandbox and scopes, P310 to P316 and P370 to P382 write integrity, P410 and
P411 specification review; P420 to P425 resume by units, fourth round; P390
to P394 serving, round fifteen. Note
numbers in `SPEC-NOTES.md` likewise: 692 to 704, 860 to 875 and 960 to 975
trunk, 940 to 944 carry, 742 to 752 and 880 to 892 sandbox, 760 to 772
and 900 to 914 write integrity, 851 to 866 and 920 to 932 serving. The plan documents hold decisions up to
P210 and P410 to P411; the rounds after that are in `SPEC-NOTES.md` of their
branches only and need a document round after the merges.

## Open lines of work

Each line names the notes that hold its plan. The notes are in
`base/pattern-compiler/SPEC-NOTES.md` on the branch named.

**A piece loaded again in another process** (trunk; notes 843, 860 to 875,
960 to 975).
"Takeover" in the notes and tables means that a serving runtime starts over
a space that already holds a compiled piece: a restart or deploy of the
server, or a move of the space to another process. It is not the first run
of a pattern. A piece whose sources did not change is found current from its
basis and evaluates nothing. The first event afterwards evaluates the whole
derivation unless the piece's collections are left as stored. Rows of a
`map` over an array of references are left as stored, with or without
handler bindings, at a named path or in a view node. By what the plan of
each module says, the wake takes 47 of the corpus's 84 row-document
collections at the trunk commit `a467194a96` and 81 of 84 at `7b2a492b82`,
which adds rows over the output of a `lift` (the `lift` is evaluated once at
the wake), over a `filter` and over a `sortBy` (the source evaluates one
body and reads one item document per element at the wake, so the wake still
follows the collection there), and rows whose body holds a `computed`,
another collection or a read of its position. A collection the plan takes
does not always leave its rows: in the corpus run with a takeover and
arrays written as references, the plan takes a collection in all 19 modules
that have row documents and an event behind the takeover, and 14 of them
leave rows as stored (note 971); with plain values in the argument none
does. Not
built, each with a plan that names the functions to change and the tests to
write first: the result of a body stored per element key, which the index,
the sort, the `flatMap` and an upstream left as stored all need (note 966);
the entries of the pattern's own body (967); the costs of the wake itself,
that is the registration per row and binding, the table formed whole and a
refused commit that evaluates every row (968). An array of plain values, in
place or generated by a `lift`, is evaluated whole. On the list fixture the
first event after such a start takes 172 ms at 10,000 rows against today's
55 ms, and peak memory is below today's at every size measured (resident
set 1.5 to 1.7 GB against 4.7 GB at 10,000 rows, with the server, the loop
and two clients in one process); the load is the peak, at about 23 KB
retained per row. Topics therefore still evaluates its whole
derivation at the first edit after such a start: 8.5 s at 2,000 topics. The
owner ruled on 2026-11-23 (Z90) that this step matters a lot: it is to be no
slower than today's path for the same pattern, and tearing a worker down and
bringing it back up is to be cheap. Peak memory is measured on the list
fixture alone; on Topics at 2,000 topics it is still to be measured, so
that a process is known not to run out there. This is the line of work with
the largest gap to the owner's rule.

**A step that changes a list as long as the collection** (serving branch;
notes 851 to 866 and 925 to 930). Row links are stored in list documents by
default (P392); a list of at most 128 rows is one document and reads as an
array (P393, option `listWhole`). Under the serving loop at 2,000 topics an
edit of the mentions takes 121 to 134 ms against 347 to 405 ms with the
links in place, and a create 205 to 236 ms against 560 to 737 ms. Open:
above 128 rows a runtime client reads an array of chunks, and no flattening
is built in the runtime; a reader of one row of a chunked list pays about
35 ms more for the edit of a middle title, not profiled; the record of
bucket links stays one document (P394; 349 KB changed by an edit of the
`shortName` at 2,000 topics). A handler's write of an input it changes at
one position is already positional (test `handler-positions.test.ts`).

**A piece set up under the serving loop that is never run** (serving
branch; note 931). In 4 of about 66 runs of the Topics `serving` arm the
serving runtime was quiescent, the setup had committed, the result document
held nothing at `mentionable`, and no failure was reported. The cause is not
found. `SCALE_LAYOUT` on the Topics harness prints the layout and the count
of pieces the serving runtime runs. This is the first thing to diagnose on
that branch.

**A FabriChat send** (serving branch; notes 732 to 741, 860 to 862, 920 to
932). The owner's rule that a send does not grow with the room is not met:
at the head `c0e0a41014` a send on the runner path takes 66 to 72 ms at 10
messages, 197 to 207 at 100 and 829 to 892 at 1,000, about 0.75 ms and
1.3 KB per message held. Built in round fifteen: the record of a place a
comparison left as it was is not given again (P390, `exec/inputs-digest.ts`;
88 to 90 records per send); the window construct `xs.last(n)` and
`xs.first(n)` (P391), which an append moves by one splice over an array of
references and over the result of a `filter` or `sortBy` over one, and which
is formed whole over the result of a `map`; the main conversation of the
room's copy as a `filter` of the stored messages, a `map` over its result
and a window. Open, with the plan in note 923: `places`, `authors`,
`entries`, `threads` and the counts are still one body, so `facts` reads 5
positions per message held; `Instance.#noteRecord` registers each record at
every position its inputs reach (331 of 830 ms in one profile at 1,000);
`rowFactsForSession` reads every row of the rights; `Store.#deep`; the
`filter` branch of `Instance.#reassemble` forms its rows from every element;
a `map` over the result of a body kept by key and the schema of a link
stored once (note 861); `elementById` and `resolveAsCell` in the reactive
tier; the keys of a `groupBy` in creation order. A soundness defect seen on
the fixture `unchanged-place.tsx` is open: a cone that is evaluated again,
binds a slot to another position and returns an equal value gives no record,
so the place keeps the label formed from the earlier position.

**More than one user on a piece** (sandbox branch; notes 880 to 892).
Documents of the scopes `user` and `session` are held once per principal.
Open: the runs of one pass for several principals do not see each other's
writes, so an entry of a scope that reads a row document written in the same
pass is refused and runs again (plan: two scheduler actions, one for the
space and one for the scopes); a piece with a `wish` or scoped state resumes
whole and is never found current (P354, note 892; needs a basis per scope key); the
assembly of a scoped collection is formed again per principal; memory
follows the principals ever seen; a `wish` for a seeded profile does not
resolve under the serving loop (not diagnosed); FabriChat with two users was
not run.

**Write integrity** (write-integrity branch; notes 760 to 772 and 900 to
914; P310 to P316 and P370 to P382). A compiled handler is named by the
crate's content-addressed module identity and the binding path, only where a
writer policy of the program names the binding and the artifact is one the
runtime compiled or a host vouched for (`CompiledPieceOptions.attested`).
FabriChat's room sends and Home starts with their declared policies. A
harness, `compare/both-paths.ts`, runs one scenario on today's path and on
the compiled path with the same gestures and principals and compares
commit, message, values and stored claims: 12 of 14 hand-written scenarios
are equal, and in the 28 corpus modules that declare a write policy and run
compiled no step is committed on one path and refused on the other. The
harness found six cases where the compiled path committed what today's
refuses or stored a weaker claim; all six are fixed. Open:

- A piece a serving runtime starts from a stored argument: the client
  writes the argument document under no schema, so the claims of the
  argument type are stored for a field only when a handler of the piece
  first writes it, and its first values are attributed to no one. This is
  the path a deployed piece takes, so it is the first thing to close.
- A state cell document created by a write other than its seed stores no
  policy of the cell's schema; no path to that state is known.
- No module succession for a compiled writer (note 910 lists what an update
  of a compiled pattern needs).
- FabriChat's room with two principals was not run on both paths.
- The compiled path is stricter than today's for a computed output whose
  result type names a writer (P379).

The rules the specification pull request has to state are the first three
deferred questions of the first round and the first six of the second.

**Stand-ins that remain in the FabriChat and Home copies**
(`base/pattern-compiler/compare/fabrichat/`, `compare/home/`): `any` and the
re-typing overloads removed, handle declarations changed, a guard written as
a conditional expression, `elementById` and `resolveAsCell` moved into
authored functions, Home without a hand-made schema. Seven built-ins and
every effect other than the four fetch effects are unanswered.

**A server that compiles** (sandbox branch; note 749). A toolshed installs a
compiler for the serving loop on the main thread. Open: the loop in Workers,
and the compile inside the serving loop's wait.

**Review fixes carried** (carry branch, pushed; notes 940 to 944). The four
findings of the first review of #9942 and the missing observation for
`Object.fromEntries` (P411) are fixed there, and a round of tests for a
handler that writes, reads and fails found and fixed one soundness defect: a
cone whose side-write a refused commit took back was never evaluated again
(`Instance.restore` now drops the memo entries of the cones that wrote a
restored document). Open from that round:

- `compare/values-corpus.ts run` gives 7,314 of 7,463 values equal on the
  trunk's code where note 571 has 7,325; the comparator fix does not change
  the count, and which change lowered it by 11 is not found.
- The agreement figures of note 534 (6,013 of 6,107 and 1,484 of 1,584) were
  taken on the prototype branch and are not rechecked there:
  `pattern-compiler emit --corpus` panics on that branch. On the trunk's
  code every comparison that `firstDifference` decides was run with the
  comparator before and after its fix and gave the same counts and the same
  lists of differences, so the fix lowers no figure there; whether note
  534's own figures hold at their commit stays open until the panic is
  fixed or the figures are replaced by the trunk's.
- The fix for the left operand of `??`, `||` and `&&` on the prototype
  branch (#9942, `Host.selected`) tests the operand through an `identity`
  slot; the same form failed the stored-labels soundness check on the
  trunk (fixture `held-in-place`), where the fix was built differently
  (`Host.operand`). Check the prototype branch's form against that check.
- A handle on a kept output in a handler's state reads the result-document
  position, which only the store step of a derivation writes, so the second
  event of a batch can read a stale value through it.
- `new Map(v)` in `src/footprint.rs` records no `value` at `v/*/0`, the gap
  closed for `Object.fromEntries`.
- `CompiledPiece.#keepMinted` writes into a transaction a failed handler
  aborted and logs an uncaught error.
- `compare/values-fixtures.ts` stops at the first fixture today's runtime
  refuses to compile and prints no table; run it per fixture.

**Review findings on #9942 not yet addressed** (three, from the review of
the commit `b11109b6fb`; each is a claim to check with a failing test first,
on the prototype branch, and then on the trunk, whose `exec/store.ts` was
rewritten since):

- `Store.write` and `Store.put` in `exec/store.ts` compare stored values by
  a serialization that erases the difference between an `undefined` position
  and `null`, so a change of `[undefined]` to `[null]` is dropped (review
  comment 4670306219). On the trunk the comparison is `sameStored`; check
  whether it tells the two apart.
- `Store.undo` restores the previous value of a write beyond the end of an
  array and not the array's length, so an undone write at index 3 of an
  empty array leaves length 4 (comment 4670306234).
- `structure` in `src/emit.rs` joins the entries of an array literal with no
  final separator, so a literal that ends in a hole loses a position:
  `[x,,]` is emitted with length 1 and `[,]` with length 0 (comment
  4670306243).

Each thread on the pull request gets a reply and is resolved when its
finding is fixed or shown not to hold.

**Review findings on #9788 not yet addressed** (three, from the review of
the commit `243e0368a4`; each is a claim to check against the specification
text, and a design point settled is a provisional decision with a question
for the owner, as P410 and P411 were):

- `footprint-analysis.md`, the array methods table: `entries()` of an input
  array is modeled as the members `rows/*` and not as pairs of a computed
  index and `v/*`, so `for (const [, row] of rows.entries())` followed by
  `row.price` gives an observation at `rows/*/1/price` where `rows/*/price`
  is read; `keys()` likewise needs computed indices (review comment
  4670309323). A wrong footprint narrows the argument wrongly.
- `scheduler-and-serving-loop.md` §10.4, the basis index: for an array of
  references `[D, D, E]` the two occurrences of D are two cone instances
  that share one basis row for the document D. Demanding the first after D
  changed advances that row while the second occurrence's stored output is
  stale, and a restart then takes the stale output as current (comment
  4670309332). This bears on the resume by units as built: check whether
  `PieceUnits` and the basis of a piece have the same gap for a document two
  rows read.
- `footprint-analysis.md` §7, the syntactic exclusions that make a handle
  read conditional: the body of a `do...while` and a bypass through `break`
  or `continue` are not among them, so
  `do { if (skip) break; h.get(); } while (false)` has its read classed as
  static, and the target is demanded and its label joined on the path that
  skips the read (comment 4670309338). That is an over-label and an
  unneeded demand, against §1.4.

**Questions of Contextual Flow Control** are deferred by the ruling Z88 and
listed in the plan as questions 391 to 467 and 512, and per round under
"CFC questions deferred" in `SPEC-NOTES.md`. Several are suspected
under-labels; a construct that has one is not to be relied on for labels.

**The window is to be written as `slice`** (Z92, 2026-11-23; not built).
The owner ruled that the language adds no method regular JavaScript arrays
lack. After the serving branch is merged: the crate recognizes
`xs.slice(-n)` and `xs.slice(0, n)` on a collection and plans the window of
P391 for them (`api::is_window_method`, `window` in `plan.rs`,
`array_method` in `infer.rs`, `collection_call` in `check/mod.rs`); `last`
and `first` are removed, with their entry in `api::is_handle_member`; the
room's copy, the fixtures and the tests `window-construct.test.ts` and
`window.test.ts` are rewritten to `slice`. The round reports a FabriChat
send with the window and with the `slice` evaluated whole, and does not
extend the window over the result of a `map` before the general costs of a
send are fixed (the registration of a record at every position, the deep
comparison in the store).

**`sortBy` is to be written as `toSorted`** (Z93, 2026-11-23; not built).
The crate recognizes `xs.toSorted(compare)` on a collection and plans the
sorted collection the trunk built for `sortBy(key)`, which is removed. The
executor keeps order by a key today, so a comparator needs either an
insertion by comparison or the recognition of comparators of the form
"compare one key of each". `groupBy`, `keyBy` and `lookup` are methods of
today's runtime and stay until the owner decides otherwise.

**Authored `computed` bodies that are not promoted** (all branches).
`language-subset.md` §6.1 promotes a `computed` whose body is
expression-shaped and pure, and a per-element construct inside a promoted
body is planned as one. The bodies of the FabriChat room that read every
message are not promoted because of gaps of the crate, not of the
specification: a guard in the block body of a collection callback, and
`elementById` and `resolveAsCell` in a promoted body. Closing those gaps is
a general fix for the send that grows with the room, and comes before any
construct added for the room.

**The owner's rule on optimizations** (Z91, 2026-11-23). A goal is to be
met because the compiled approach is generally better, not by an
optimization for the measured case that today's runtime has no counterpart
of. An outlier, such as the first edit after a restart or a FabriChat send
that grows with the room, is studied as the sign of a general defect, and
the fix sought is one that helps every pattern. Each brief repeats this, and
each round reports figures with and without an optimization it adds.

## How a round is briefed and checked

A round is one agent in one worktree with a written brief. The briefs of
the rounds so far are kept outside the repository, under the session's
project directory, as `work/r<N>-<subject>-brief.md`; a new brief repeats
these rules:

- Work in the one worktree; never in another, never in the private
  specification repository, never in the main checkout. Do not push.
- Read `AGENTS.md`, `docs/development/DEVELOPMENT.md` and
  `docs/development/code-comment-style.md` first, and
  `docs/development/cfc-spec-correspondence.md` for code that decides a
  label.
- Test first: the failing test, seen failing for the stated reason, then the
  code. One commit per step, each type-checking.
- No timeouts, sleeps, retry loops or polling; no browser.
- With the experimental option off nothing changes.
- A question of Contextual Flow Control is written down and reported, not
  resolved, unless the owner asked for it. A change that could store or
  consume less label is said first in the report.
- A decision the round takes is a provisional decision of the coordinator,
  numbered in a range given in the brief, never worded as an owner ruling.
- Structural, scaling and soundness findings lead the report.
- An optimization the round proposes says whether today's runtime has the
  corresponding mechanism, and its figures are reported with and without
  it. An outlier is studied as the sign of a general defect, and the fix
  sought helps every pattern (Z91).
- No method that regular JavaScript arrays lack is added to the language;
  the crate recognizes the JavaScript form (Z92).
- When writing about `map`, `filter` or another per-element construct, name
  the case: an array of references, an array of plain values in place, or
  the result of another per-element construct.

Gates of a round, each read by its exit status: `deno task check`,
`deno fmt --check`, `deno lint`, `deno task check-cfc-correspondence`,
`deno task check-skill-facts`, `deno task check-dependency-direction`,
`deno task check-package-cycles`, `deno task check-no-waitfor`,
`deno task check-test-shuffle`,
`deno test -A base/pattern-compiler/compare/test/ base/pattern-compiler/exec/test/`;
from `runtime/runner`,
`ENV=test deno test --shuffle=1 --no-check --preload=test/clock-preload.ts -A test/compiled/`
and the same with `COMPILED_PIECE_STORAGE=socket`; after a change of Rust,
`cargo test --no-fail-fast`, `cargo fmt --check` and
`cargo clippy --all-targets -- -D warnings` in `base/pattern-compiler`.

The coordinator then reruns the tests and one measured figure itself before
pushing, because a round's report is model output and two reports so far
held a wrong explanation (a missing label that was a missing input label;
a figure taken in a posture no deployment runs).

Harnesses, all run from `base/pattern-compiler` with
`deno run -A --no-check`: `compare/topics/scale.ts <arm> <topics>` (arms
`runner`, `serving`, `serving-today`, `today-labeled`; needs the boards of
the measurement branch), `compare/fabrichat/scale.ts <executor|runner|serving> <room|manager|home> [sizes]`,
`compare/serving-path.ts`, `compare/runner-path.ts`,
`compare/sandbox-cost.ts`, `compare/runner-corpus.ts run <file>` then
`report <file>` (with `--serving`, `--resume`, `--references`).
