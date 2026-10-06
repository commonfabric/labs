# Changing Contextual Flow Control: the correspondence procedure

Contextual Flow Control (CFC) is specified outside this repository, and the
runtime here implements that specification. This document is what an agent or
a person follows when a change touches CFC: how to find the governing text, how
to classify the change, when the specification moves first, and what to do
while a ruling is pending. The plan that stages the machinery behind it is
[`../plans/cfc-spec-correspondence-process.md`](../plans/cfc-spec-correspondence-process.md);
the assessment that motivated it is
[`../history/specs/cfc-spec-correspondence-assessment-2026-10-05.md`](../history/specs/cfc-spec-correspondence-assessment-2026-10-05.md).

## Where the specification lives

The specification is the `cfc/` directory of the `commonfabric/specs`
repository. It is three artifacts kept equivalent, and the implementation in
this repository is the fourth thing held consistent with them:

- the prose chapters `cfc/NN-*.md`, whose critical parts are stated as
  TypeScript pseudocode;
- the Lean 4 development under `cfc/formal/`, which mechanizes that pseudocode
  and proves properties of it, with `cfc/formal/FORMALIZATION.md` holding the
  table from each pseudocode function to its Lean definition;
- the paper under `cfc/paper/`, whose claims name both.

A change to the design is a change to all three, in one specs change: the
prose, the pseudocode, and the proof land together, and the implementation
follows. A change to one that leaves the others behind is a defect in the
specification, in the same way a live document here that no longer matches the
code is a defect.

The specs repository is private; this one is public. A comment or document
here may cite the specification by section, and nothing the public build runs
may read it. The developer points the agent at their checkout, through
`CF_SPECS_DIR` or by naming it; the location is theirs to give, and nothing
here assumes one. An agent that cannot reach the repository at all follows
"Without access to the specification" below. Cite a section by number
(`§8.10.3`) and chapter file, and quote the sentence the point rests on. Never
cite a line number: it names a different sentence the moment a paragraph is
inserted above it.

## The standard this repository holds to

For every function the specification states as pseudocode and the Lean
development mechanizes, the runtime holds one function of the same name and the
same shape, pure, and that function is the only place the runtime decides what
the pseudocode decides. Everything the runtime needs beyond the pseudocode is
either an adapter around such a function or a change to the specification
first.

The vocabulary:

- **Critical function.** A function the specification states as pseudocode
  that this runtime executes. The set is the manifest's rows; where the
  "Pseudocode Coverage Matrix" in `cfc/formal/FORMALIZATION.md` has a row for
  one, that row names its Lean source.
- **Kernel.** The runtime's copies of the critical functions, grouped by spec
  chapter, each opening with a header naming its chapter file, section,
  pseudocode name, and the hash of the block it was derived from. A kernel
  function takes no transaction, reads no dial, calls no hook, and records no
  diagnostic. The kernel is being carved out of the boundary adapter one
  function at a time; the plan names the order.
- **Adapter.** Everything else under `packages/runner/src/cfc/`. An adapter
  gathers a kernel function's inputs from the transaction, calls it, and
  interprets the result for this runtime: retry against terminal verdict,
  diagnostics, dial posture, persistence. `prepare.ts` is the boundary
  adapter.
- **Pin.** The specs commit the snapshot at
  `packages/runner/src/cfc/kernel/spec-snapshot.json` records in its
  `specsCommit` field, which is the commit every kernel header's hash and
  every `§` citation is checked against. `deno task cfc-spec-snapshot`
  regenerates the snapshot from a specs checkout (`CF_SPECS_DIR`, or
  `~/src/specs/cfc`) at a revision (`--rev`, default `HEAD`), reading the
  chapters through git so a working tree on another branch cannot leak in.
  The snapshot holds the commit, every section number of the numbered
  chapters, and for every function a pseudocode block of chapters 03 through
  08-*, 10, 17 and 18 defines its chapter file, section, name and the SHA-256
  of the block; it holds no spec text.
- **Ruling.** A specs pull request that settles a question the specification
  did not answer, in the form `cfc/13-11-decisions.md` uses: the question, why
  it is open, the options, the proposed text, who ruled, who reviewed.

## The procedure

1. **Read the specification before the code.** A change under
   `packages/runner/src/cfc/` or `packages/runner/src/cfc.ts`, to the CFC
   tests under `packages/runner/test/`, to the render boundaries in
   `packages/html/src/worker/reconciler.ts` and
   `packages/html/src/worker/display-fit.ts`, to the harness's CFC enforcement
   in `packages/cf-harness/src/` (`cfc-*.ts`, `contracts/cfc-*.ts`,
   `sandbox/runsc-cfc-result.ts`), or to a `docs/specs/cfc-*.md` document
   starts by reading the governing section at the pin, and the kernel function
   for any critical function the change touches, or, until that function has
   been carved out, the adapter code that decides it today, which the kernel
   manifest names. A `§` citation in the code you are about to change is the
   pointer; follow it. Then read every
   section the governing rule itself cites, not only the one named: a rule
   about an address or an identifier also answers to §2.4, whose rule that a
   derived identifier joins the labels of all its inputs can contradict a
   local edit. The harness audit's clause derivation is recorded in
   `docs/specs/agent-harness/04-cfc-spec-correspondence.md`; the harness's
   enforcement sources named above follow this procedure.

2. **Classify the change.** Exactly one of the three below. A fourth
   activity, filing or migrating a ruling, has no labs diff to classify and
   carries its own required statement instead; "Filing a gap" has it.

   - **Host arrangement.** The specification is silent by design, because
     chapter 18 leaves it to the implementation profile: where the boundary
     pass runs in the transaction, the stored bytes, diagnostics and denial
     reporting, dial plumbing, performance. No spec action, and no kernel
     change.
   - **Conforming implementation.** The specification already says what the
     change does. The pull request names the section. A kernel change carries
     the pseudocode hash it was derived from.
   - **Semantic gap.** The specification does not answer, answers
     differently, or the runtime needs a kernel function to take an input the
     pseudocode does not. This is the only class that touches the design, and
     it goes through step 3 before code.

   Three tests settle doubtful cases, and a reviewer applies them to the
   author's classification afresh. A change that adds an argument to a kernel
   function is a semantic gap. A change that adds a case the pseudocode lacks
   is a semantic gap. A labs document that states a rule with MUST force is
   spec text, and the change that writes it is a semantic gap.

3. **For a semantic gap, open the specs pull request first.** It carries the
   prose delta, the pseudocode delta, and the Lean delta together: the model
   and the theorems that make the new rule a proved property land in the same
   change, so the three artifacts never disagree at a commit. The Lean delta
   is what the specs repository's `cfc/formal/docs/CONTRIBUTING.md` lists under
   its required documentation updates: the model and proof modules,
   `FORMALIZATION.md`, `THEOREM-MAP.md`, `COVERAGE.md`, `MODULE-INDEX.md`
   when the module map changes, `PROOF-ROADMAP.md` when the frontier does, and
   the chapter's own formal-correspondence note, which is where a reader of
   the prose meets the proof. A residual the ruling accepts is a theorem under
   an explicit hypothesis; a cryptographic assumption is prose beside an
   abstracted definition, never a theorem; a variant the ruling rejects is a
   `decide`-checked counterexample in the examples module. Deferring a
   proof is the exception, taken when the model the rule needs does not exist
   yet; the body says why, and the deferral is an entry in
   `cfc/notes/FUTURE-SPEC-WORK.md` in that file's shape (a
   `## <Topic> Follow-Ups` heading with `### Formal proof tasks`,
   `### Paper tasks` and `### Runtime tasks` beneath it, the first sentence
   dating the entry and naming the ruling pull request). The request also
   edits `cfc/paper/README-paper-notes.md` when a paper claim is affected. Write it
   as a ruling when the question has more than one defensible answer. The labs
   pull request links it in its description.

4. **Land code behind the ruling, or behind a marker.** The labs change lands
   when the specs pull request has merged, and re-derives the kernel from the
   new pin in the same change. Where waiting would block unrelated work, code
   may land first with the deciding site marked:

   ```text
   // SPEC-PENDING https://github.com/commonfabric/specs/pull/NN
   ```

   The tree holds at most three such markers at once. Marked code may run at
   the `enforce-strict` default only when it is fail-closed, meaning it refuses
   more than the ruled behavior would and persists nothing new, since the
   ruling can then only loosen it. Anything that admits more, or changes what
   is stored, waits behind a dial that defaults to the current behavior until
   ruled. The change that re-derives the kernel at the merged pin removes the
   marker.

5. **Keep the pin current.** When specs `main` changes a critical function's
   pseudocode, the next CFC pull request here re-derives every kernel function
   whose recorded hash no longer matches, or argues the divergence in review
   and records it with its reason. Nothing lands against a stale pin while a
   mismatch is open.

6. **Write the document where it governs.** A rule with MUST force, a label
   transition, a read exclusion, an atom's meaning, or a claim's semantics is
   spec text and goes to `commonfabric/specs`. A labs document under
   `docs/specs/` describes how this runtime arranges what the specification
   requires, and cites the section it arranges. The test for an existing
   document: it cites the section it arranges and contains no rule the
   specification does not already state; anything else in it moves.

## Filing a gap

New gaps are filed as specs pull requests, not as entries in
[`../specs/cfc-spec-changes.md`](../specs/cfc-spec-changes.md). That list is
closed to new entries; its open rows are being migrated to specs pull requests,
and it is archived once every row points at one.

### The ruling form in a pull request

`cfc/13-11-decisions.md` in the specs repository is the form written as a
chapter: for each block, the question, why it is open, lettered options, the
proposed spec text, the cases it determines, and a decision record. In a pull
request the diff is the proposed text, and the body carries the rest, in this
order, for each question the request settles:

1. the question, in one sentence;
2. why the current text leaves it open, with the sections quoted;
3. the options, lettered, each stated so that an implementer could build it;
4. which option the diff applies, and why;
5. the conformance statement: whether this runtime conforms to the current
   text (and if not, in which direction it errs, over-taint or under-taint),
   whether it conforms to the applied option, and whether a labs code change
   follows;
6. the cases the ruling determines, where a worked case exists;
7. a decision record, a table of ruling, ruled by, date and notes, left for
   the CFC owner, who rules by merging.

Specs pull requests 36 and 39 show the loop closing, from a labs review to a
ruling to a runner change, and are not examples of the form.

### Migrating an entry from the change list

- Re-read the section at specs `main` first, and say in the body whether the
  entry is already answered there. The entries are frozen prose written
  against an older text.
- One pull request per group the plan names. Entries in a group can depend on
  one another, and the body says which depends on which.
- Commit subjects follow the house style visible in `git log` (`cfc: …`);
  your harness's attribution trailers apply. Before pushing a change that
  touches `cfc/formal/` or a chapter, run `lake build`,
  `scripts/check-architecture.py` and
  `scripts/check-input-requirement-pseudocode.py` in `cfc/formal/`; they take
  under a minute on a warm build, and the specs repository's `cfc-formal`
  workflow runs the same three on every such pull request.
- When the pull request is open, the labs row's status becomes `proposed`,
  naming the request and the option applied; when it merges, `adopted` or
  `applied` as the change list's legend defines them.

The labs pull request that implements a ruling says in its description which
specs pull request it implements and which class the change is. A reviewer who
cannot find that sentence asks for it before reading the diff.

## Reviewing a CFC change

The `cf-review` skill carries the reviewer's side: classify the change
independently of the author, check the kernel header for every critical
function touched, and treat a semantic gap with no linked specs pull request,
a kernel function given an input the pseudocode lacks, or a MUST-force rule in
a labs document as a blocking finding. A reviewer of a specs ruling pull
request checks that the body says whether the entry was already answered at
specs `main`, states the runtime's conformance under the current and the
applied text, carries its proof, and, where it defers one, says why and names
the `FUTURE-SPEC-WORK.md` entry. Ian Hickson reviews the pull requests that
change this procedure or the machinery behind it; the CFC owner rules.

## Without access to the specification

The specs repository is private, so a contributor here may be unable to read
it. The procedure still applies; what changes is who completes which step.

- **Say so.** The pull request description states that the change was made
  without access to the specification, so a reviewer with access knows to
  verify the classification rather than trust it.
- **Use what is public.** The kernel manifest and spec snapshot under
  `packages/runner/src/cfc/kernel/` give the section numbers, the pseudocode
  function names and their hashes; `docs/specs/cfc-conformance-statement.md`
  says how this runtime answers §18.6.4; the `§` citations in the code and
  the sentences they quote say what each decision rests on; the labs CFC
  documents cite the sections they arrange. That is enough to classify most
  changes and to carry out any host arrangement.
- **A conforming implementation** can be completed when the cited sentence in
  the code or a labs document states the rule the change implements. Where it
  does not, treat the change as a semantic gap.
- **A semantic gap cannot be completed without the text.** Write the proposal
  into the labs pull request description in the ruling form (the question, the
  options, the recommendation, the conformance statement) and mark the request
  as needing a specs-side counterpart. A developer with access files the specs
  pull request from that text and links it; the labs change then lands by the
  usual rule, behind the ruling or behind a `SPEC-PENDING` marker.
- **Kernel functions are off limits**: their text is the pseudocode, and a
  change to one without reading the spec is a change to the spec by guesswork.

## What checks what

`deno task check-cfc-correspondence` runs in CI as a repository gate and fails
on four things, each read against the committed snapshot:

- A manifest row in `packages/runner/src/cfc/kernel/manifest.ts` naming a
  function the snapshot does not define in the section the row says, or a
  section `CRITICAL_SECTIONS` does not list; a function the snapshot defines
  in a critical section that is neither a row nor a recorded companion; a row
  marked `exact` or `adapted` whose kernel file does not export the function
  under a `@spec` header for the row's section; a row marked `missing` whose
  function the kernel does export; or a kernel export whose header names a
  block that is neither a row nor a companion.
- A function exported from a file under `packages/runner/src/cfc/kernel/`
  with no `@spec` header, with a header whose hash is not the snapshot's for
  that function, or in a file whose value imports reach past the kernel and
  the shared type module `@commonfabric/api/cfc`. Type-only imports are
  erased before anything runs and are not held to that. The manifest and the
  header module are the ledger: they carry no header and are held to the
  import rule.
- A `§` citation in `packages/runner/src/cfc.ts` or under
  `packages/runner/src/cfc/` naming a section number the snapshot does not
  list. A citation written on purpose to something else, such as a section
  of a labs document, is recorded in `EXEMPTIONS` in
  `tasks/check-cfc-correspondence.ts` with the file, the citation and the
  reason, and an entry whose file stopped writing its citation fails too.
  The check resolves numbers, not meaning: a citation that lands on another
  existing section after a renumbering passes, and the second number of a
  range written without its own `§` is not read.
- More than three `SPEC-PENDING` markers across the files the CFC rule
  governs, which `GOVERNED_SOURCE` in the task lists: the runner's CFC
  sources and their tests, the render boundaries `reconciler.ts` and
  `display-fit.ts` in `packages/html`, and the harness's `cfc-*.ts`,
  `contracts/cfc-*.ts` and `sandbox/runsc-cfc-result.ts`; or one on a line
  naming no `https://github.com/commonfabric/specs/pull/<n>`. A marker
  outside those files is not counted, and the rule does not reach there.

The header a kernel function carries is one `@spec` tag in its doc comment,
`@spec <chapter-file> §<section> <name> sha256:<hash>`, parsed by
`packages/runner/src/cfc/kernel/spec-header.ts`. The hash is the snapshot's
for that function, so a specs change to the block fails the check once the
snapshot is regenerated, and a header naming a block the specification no
longer has fails the same way.

Two things the plan describes are not in place. The specs-side job that
clones labs and runs this check from the specification's side does not exist
yet, so a specs change goes unnoticed here until someone regenerates the
snapshot. And the kernel directory holds only the ledger: every manifest row
reads `missing`, and the header and import rules are exercised by the
check's unit test rather than by the tree.

The conformance statement the specification asks for is
[`../specs/cfc-conformance-statement.md`](../specs/cfc-conformance-statement.md),
pinned to the snapshot's commit and changed whenever the behavior it
describes changes.
