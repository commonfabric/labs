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
repository. It is three artifacts kept equivalent:

- the prose chapters `cfc/NN-*.md`, whose critical parts are stated as
  TypeScript pseudocode;
- the Lean 4 development under `cfc/formal/`, which mechanizes that pseudocode
  and proves properties of it, with `cfc/formal/FORMALIZATION.md` holding the
  table from each pseudocode function to its Lean definition;
- the paper under `cfc/paper/`, whose claims name both.

A change to the design is a change to all three. A change to one that leaves
the others behind is a defect in the specification, in the same way a live
document here that no longer matches the code is a defect.

The repository is private; this one is public. A comment or document here may
cite the specification by section, and nothing the public build runs may read
it. The developer checkout is at `~/src/specs/cfc`, or wherever `CF_SPECS_DIR`
points; without a checkout, read it on GitHub. Cite sections by number
(`§8.10.3`) and chapter file, never by line.

## The standard this repository holds to

For every function the specification states as pseudocode and the Lean
development mechanizes, the runtime holds one function of the same name and the
same shape, pure, and that function is the only place the runtime decides what
the pseudocode decides. Everything the runtime needs beyond the pseudocode is
either an adapter around such a function or a change to the specification
first.

The vocabulary:

- **Critical function.** A function the specification states as pseudocode and
  the Lean development mechanizes: the rows of the "Pseudocode Coverage Matrix"
  in `cfc/formal/FORMALIZATION.md` that a reactive runtime executes.
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
- **Pin.** The specs commit a kernel function was derived from. Until the
  committed snapshot the plan describes exists, the pin is the specs `main`
  head at the time of the change, named in the pull request.
- **Ruling.** A specs pull request that settles a question the specification
  did not answer, in the form `cfc/13-11-decisions.md` uses: the question, why
  it is open, the options, the proposed text, who ruled, who reviewed.

## The procedure

1. **Read the specification before the code.** A change under
   `packages/runner/src/cfc/`, to the render boundaries in
   `packages/html/src/worker/reconciler.ts`, to the CFC enforcement in
   `packages/cf-harness/`, or to a `docs/specs/cfc-*.md` document starts by
   reading the governing section at the pin, and the kernel function for any
   critical function the change touches. A `§` citation in the code you are
   about to change is the pointer; follow it.

2. **Classify the change.** Exactly one of:

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
   prose delta and the pseudocode delta; the Lean delta, or a dated entry in
   `cfc/notes/FUTURE-SPEC-WORK.md` naming the proof it owes; and an edit to
   `cfc/paper/README-paper-notes.md` when a paper claim is affected. Write it
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

A specs pull request that settles a question carries, in order: the question
in one sentence; why the current text leaves it open, with the sections
quoted; the options, each stated so that an implementer could build it; the
proposed text for the option recommended; and, once decided, who ruled and who
reviewed. `cfc/13-11-decisions.md` in the specs repository is seven worked
examples of the form.

The labs pull request that implements the ruling says in its description which
specs pull request it implements and which class the change is. A reviewer who
cannot find that sentence asks for it before reading the diff.

## Reviewing a CFC change

The `cf-review` skill carries the reviewer's side: classify the change
independently of the author, check the kernel header for every critical
function touched, and treat a semantic gap with no linked specs pull request,
a kernel function given an input the pseudocode lacks, or a MUST-force rule in
a labs document as a blocking finding. Ian Hickson reviews the pull requests
that change this procedure or the machinery behind it.

## What checks what

Today the procedure is held by review. The plan adds, in order: a committed
snapshot of the specification's structure (commit, section numbers, function
names, one hash per pseudocode block, no prose) that labs CI checks kernel
headers and citations against; a specs-side job that clones labs and runs the
same check from the specification's side, so a ruling that moves a block turns
red there until labs re-derives; and a conformance statement answering §18.6.4
for this runtime. Each is described in the plan, and this document changes
when one lands.
