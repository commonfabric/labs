# CFC spec correspondence: the process and what enforces it

_Proposed 2026-10-05 from the findings in
[the correspondence assessment](../history/specs/cfc-spec-correspondence-assessment-2026-10-05.md).
Stage 1 is in force; each later stage says whether it is in place._

## What this plan holds to

Contextual Flow Control (CFC) is specified in `commonfabric/specs` under `cfc/`
as three artifacts that are kept equivalent: the prose specification, whose
critical parts are TypeScript pseudocode; the Lean development under
`cfc/formal/`, which mechanizes that pseudocode and proves properties of it;
and the paper under `cfc/paper/`, whose claims name both. A change to the
design reaches all three before it is a change to the design.

The runtime in this repository is an implementation of that specification. For
every function the specification states as pseudocode and the Lean development
mechanizes, the runtime holds one function of the same name and the same
shape, and that function is the only place the runtime decides what the
pseudocode decides. Everything the runtime needs beyond the pseudocode is
either an adapter around such a function, or a change to the specification
first.

The assessment found neither property holding. This plan says how an agent
working here keeps them, and what fails when one does not.

## The procedure and its vocabulary

Both live in
[`docs/development/cfc-spec-correspondence.md`](../development/cfc-spec-correspondence.md):
what a critical function, the kernel, an adapter, the pin and a ruling are;
the six steps an agent follows; the three classes of change and the fourth
activity of filing a ruling; the `SPEC-PENDING` marker with its budget of three
and its fail-closed condition; and what a contributor without access to the
private specs repository does. This plan does not restate them. It holds what
enforces them, the stages that build the enforcement, and the decisions taken.

## Two repositories, one of them public

`commonfabric/labs` is public and `commonfabric/specs` is private. A comment
here may cite the private spec, but nothing the public build runs may read it.
That fixes where each check lives:

- **Labs CI reads only what labs commits.** The snapshot holds the specs
  commit, section numbers, pseudocode function names, and one SHA-256 per
  pseudocode block. Function names already appear in the runner, section
  numbers already appear in its comments, and a hash is not reversible, so
  the file carries no spec text. Someone with a specs checkout regenerates it
  locally. Against it, labs CI checks that every kernel function matches the
  hash it claims, that every citation names a section that exists, and that
  pending markers stay under budget.
- **Specs CI reads both.** The private repository may depend on the public
  one. Its workflow clones labs main, regenerates the snapshot from the specs
  head, and runs the same labs check: a ruling that changes a critical block
  turns that job red until a labs change re-derives the kernel. The checks
  that need the spec's text, that every critical block type-checks and that
  the coverage matrix's runtime column names symbols that exist in labs, run
  there too. The cross-repository job is a report on specs `main`, not a gate
  on a specs pull request: a ruling that changes a critical block merges
  first, the job goes red, and the labs re-derivation turns it green. Gating
  the ruling on labs would deadlock with the labs rule that the ruling merges
  first.

Each direction of drift is therefore caught in CI, in the repository that can
see the inputs. What no check can do is make a spec change land in labs; it can
only refuse to let labs claim a pin it no longer matches.

Verbatim extraction (stage 4) is where the boundary bites: a pseudocode block
that is the runner's source is public. The case for accepting that is that the
block states nothing its public implementation does not already reveal, and
that the private value is in the prose, the proofs and the paper. The owner
decides this before stage 4; if the answer is no, the affected functions stay
hand-written and hash-pinned, with equivalence a review obligation that the
specs-side check can still assist against the private text.

## What enforces it

### Instruction surfaces (stage 1)

The assessment's third finding is that no surface an agent loads before
choosing its work names the specification. Three surfaces fix that, each
sized to its budget:

- One paragraph in `AGENTS.md` under "Runtime Development", naming the specs
  repository, the live process document, and the rule that a semantic change
  to CFC goes through the specification first. This is the always-on line
  every agent sees, including those without path-scoped rules.
- A path-scoped rule `.claude/rules/cfc.md` for `packages/runner/src/cfc/**`,
  `packages/html/src/worker/reconciler.ts`, `packages/cf-harness/src/**` where
  it enforces, and `docs/specs/cfc-*.md`. It carries the procedure above in
  the short form, the classification test, and the two commands (snapshot
  regeneration, correspondence check).
- A live document `docs/development/cfc-spec-correspondence.md` carrying the
  full procedure, the vocabulary, and the triage rule for documents. The rule
  and the `AGENTS.md` paragraph cite it rather than restate it.

The `cf-review` skill gains a CFC subsection under "Coherence ripple": a
reviewer classifies the change independently of the author, checks the
manifest row for every kernel file touched, and treats a MUST-force rule in a
labs document as a blocking finding.

### The correspondence manifest and the spec snapshot (stage 2)

Two committed files and one task make correspondence a thing CI can see.

`packages/runner/src/cfc/kernel/spec-snapshot.json` is generated from a local
specs checkout by `deno task cfc-spec-snapshot` and holds: the specs commit;
every section number in `cfc/*.md`; and, for every critical function, its
chapter file, section, name, and the SHA-256 of its pseudocode block. It holds
no spec prose, so it carries no copy of the spec to drift and nothing the
public repository may not hold.

`packages/runner/src/cfc/kernel/manifest.ts` is hand-maintained in the shape of
`packages/cf-harness/audit/citations.ts`: one row per critical function with
the spec section, the kernel symbol, the Lean definition from the coverage
matrix, and a relation of `exact` (the kernel is the pseudocode) or `adapted`
with the reason and the specs pull request that ruled the adaptation
acceptable.

`deno task check-cfc-correspondence` fails when:

- a kernel function's recorded pseudocode hash differs from the snapshot's
  (the spec moved; re-derive);
- a critical function in the snapshot has no manifest row, or a manifest row
  names a kernel symbol that does not exist;
- a `§` citation anywhere under `packages/runner/src/cfc/` names a section the
  snapshot does not list;
- `SPEC-PENDING` markers exceed the budget, or one names no specs pull
  request;
- a kernel file imports anything outside `kernel/` and the shared type module,
  which is the mechanical half of "pure".

The hash check is what turns a spec edit into a labs failure, and the manifest
is what turns a labs edit into a reviewable claim about the spec. Together
they replace the 509 unchecked citations with a relation that has to be
re-stated every time either side moves.

### The conformance statement (stage 2)

§18.6.4 says a deployment claiming the reactive-runtime profile MUST document
eight things: its relevance mechanism, its read exclusions, its reference
residuals, its integrity staging level, its matrix position, its persistence
idempotence, its trigger-read treatment, and its observation-class residuals.
No labs document answers that list. `docs/specs/cfc-conformance-statement.md`
does, one section per item, each citing the adapter that implements it and the
manifest rows it rests on, with every known non-conformance stated with its
direction (over-taints or under-taints). It replaces the "Where the runner
stands" preamble of `cfc-runner-future-work.md`, which becomes the backlog it
was meant to be.

### One tracker, in the specs repository (stage 2)

`cfc-spec-changes.md` is a labs-side queue for the specs repository. The specs
repository already has `cfc/notes/FUTURE-SPEC-WORK.md`, whose sections are
written per topic as formal, paper, and runtime tasks, which is the triad
ledger this plan wants. A gap is therefore filed where it is ruled: as a specs
pull request (a ruling, or a direct edit when the answer is not in doubt), with
the labs pull request linking it.

Migration: each of the eighteen open entries becomes a specs pull request;
`cfc-spec-changes.md` closes to new entries when stage 1 lands, is reduced to
an index from `SC-n` to the specs pull request that holds it, and is archived
to `docs/history/specs/` once every row points somewhere. New gaps do not get
an `SC` number.

The migration is also the test drive of the process. Three groups of entries
stand alone and between them exercise every leg:

- `SC-49`, `SC-50`, `SC-51`: three items on §8.17.6 rule 4, prose only, from
  one build, and dependent on one another (`SC-51`'s answer differs under
  `SC-49`'s two derivations). Proposed as `commonfabric/specs#47`, with its
  Lean model in the same change.
- `SC-52`: a space's own DID is not a member of the space (§4.9.3, §18.4.5,
  `Cfc/Membership.lean`). The one open entry that names a Lean file, so prose
  and proof move in one ruling.
- `SC-54` with `SC-56`: the default display ceiling and remote loads at render
  (§8.10.6, §8.10.5.2). Both sit on `defaultDisplayCeiling`, a named
  pseudocode block, so the ruling moves a hash and the kernel re-derives.

`SC-53`, `SC-47` with `SC-48`, and `SC-44` depend on other entries or open new
sections and go after the three groups.

### The kernel (stage 3)

The runtime's critical functions move into `packages/runner/src/cfc/kernel/`
with the pseudocode's names and shapes. The adapters in `packages/runner/src/cfc/prepare.ts` (`prepare.ts` below) and its
siblings keep their runtime concerns and call the kernel. Where today's
runtime function carries an input the pseudocode lacks, the move is itself a
semantic gap and follows the procedure: the specs pull request adds the input
to the pseudocode and the Lean model, or rules that the input belongs to the
adapter, and the kernel follows.

The assessment's `verifyInputRequirements` example shows the kind of split
expected. Of its nine runtime arguments, the identity resolver and the metadata
resolver are how the adapter materializes the pseudocode's `env` and
`inputLabels`; the deferred-refusal hook and the policy-application flag are
adapter concerns about what to do with a refusal; the verdict tag is adapter
output. The per-write prefix bounds are the one argument that changes what the
function decides, and the specification already has a ruling on that
approximation (`SC-23`, `SC-24`); the kernel version takes them as part of its
read set, which is what the pseudocode's `consumedReads` is, and the manifest
row records the relation.

The end state has two candidate forms, and choosing between them is the first
open decision below:

- **Same name, same shape, hash-pinned.** The kernel is written by hand to
  match the pseudocode; the hash check makes a spec change loud; equivalence
  is a review obligation.
- **Verbatim extraction.** The pseudocode blocks are valid TypeScript over an
  abstract interface (`Label`, `MatchEnv`, `JSONSchema`), the specs repository
  already type-checks one of them this way, and the kernel files are
  generated from the blocks by the snapshot task. Equivalence is a diff.

The second is the stronger reading of "one to one" and the plan is written so
the first is a stage on the way to it rather than an alternative.

### The specs side (stage 4)

Changes proposed for `commonfabric/specs`, recorded here because labs is where
they were found:

- The continuous-integration workflow `commonfabric/specs#46`, merged
  2026-10-05 beside stage 1 (`lake build`, `check-architecture.py`, the §8.10.3
  pseudocode check; the full build took 56 seconds of wall-clock time on one
  machine on 2026-10-05) gains the generalized pseudocode check and the
  cross-repository correspondence job.
- `check-input-requirement-pseudocode.py` generalized to every critical
  function, so a pseudocode block that stops type-checking fails there.
- A "Runtime counterpart" column in the Pseudocode Coverage Matrix naming the
  labs kernel symbol, so the triad ledger shows all three legs in one table.
- A check that every Lean name and spec section the paper's claim-to-artifact
  map cites still exists.
- The ruling form of `13-11-decisions.md` adopted as the template for a specs
  pull request that settles a question, so that who ruled and who reviewed is
  recorded for every ruling and not only the §13.11 set.

## Where a document goes

The triage rule: a labs document under `docs/specs/` cites the spec section it
arranges and contains no rule the spec does not already state. Anything else in
it is spec text and moves. Applied to the twenty-one documents, with the
disposition proposed and not yet confirmed by each document's owner:

| Document | Disposition | Why |
| --- | --- | --- |
| `cfc-commit-preparation.md` | stays | where the pass runs in this transaction model |
| `cfc-stored-envelope.md` | stays | the bytes of the §4.6.4 storage profile |
| `content-addressed-cfc-labels.md` | stays | a storage format |
| `cfc-enforcement-matrix.md` | stays, §5 moves | dials are host; its "Spec-owed" section is a ruling |
| `cfc-render-boundary-composition.md` | split | reconciler mechanics stay; "boundaries compose monotonically" is spec text |
| `cfc-write-destination-reads.md` | stays | mechanism behind the §18.6.2 class the spec adopted (`SC-41`) |
| `cfc-write-prefix-provenance.md` | stays | the runtime's approximation; ruled by `SC-23`/`SC-24` |
| `cfc-exchange-rules-authoring.md` | stays, debts move | a pattern authoring surface; its "still owes" items are rulings |
| `cfc-exchange-rules-authoring-extensions.md` | stays, debts move | same |
| `cfc-cross-space-integrity.md` | stays, gaps move | a test and authoring guide |
| `cfc-persisted-declassification.md` | promote | the §8.12.7 route-2 rewrite event is a label transition |
| `cfc-observation-classes.md` | split | §4.6.3 semantics were adopted; implementation stages stay |
| `cfc-template-population.md` | split or archive | `SC-4`/`SC-8` applied; what remains is a shipped design |
| `cfc-label-metadata-confidentiality.md` | promote remainder | invariant 12; parts adopted as §4.6.4.1 |
| `cfc-custody-seal.md` | split | the trusted-declassifier custody rule is spec text; the host operation stays |
| `cfc-reviewed-intent.md` | split | single-use intent verification is §6.4.3/§7.5.2 text; the host surface stays |
| `cfc-protected-initialization.md` | mostly done | `specs#32` adopted the authority split; runtime mechanics stay |
| `cfc-transformed-by-input-witnesses.md` | promote | `SC-43` is open against it |
| `cfc-range-scoped-integrity.md` | promote as proposal | belongs beside §14.4.8 |
| `cfc-value-level-provenance.md` | stays as plan | unscheduled; `SC-24` recorded the spec's position |
| `cfc-runner-future-work.md` | stays, re-derived | the backlog, re-read against the conformance statement |

## Stages

Each stage is a pull request or a short series, and each ends with a check
that did not exist before it.

**Stage 1: instruction surfaces.** In place since 2026-10-05: the `AGENTS.md`
paragraph, `.claude/rules/cfc.md` as a pointer, the live procedure in
`docs/development/cfc-spec-correspondence.md`, the `cf-review` subsection, and
the `docs/specs/README.md` preamble. The rule is Claude Code's mechanism and
carries nothing the `AGENTS.md` paragraph does not; the Codex-side equivalent
is a follow-up made from Codex. Done when a fresh agent asked to change a CFC
rule opens the specification first.

**Stage 2: visibility.** The snapshot task, the manifest with a row per critical
function marked `missing` where no kernel exists yet, `check-cfc-correspondence`
in CI, the conformance statement, and the migration of the eighteen open
entries to specs pull requests. Done when the check is green with every
critical function accounted for, `cfc-spec-changes.md` is an index, and the
labs pin is a single committed value.

**Stage 3: the kernel.** Critical functions move into the chapter files under
`kernel/` one at a time, each with its red test from the pseudocode's cases and
its manifest row turned from `missing` to `exact` or `adapted`. Suggested order, by how close today's
code already is: `atomLe`, `isMoreRestrictiveCNF`, `canUpdateStoreLabel`
(§8.12.1); `joinLabels`, `canAccess` (§3.1); `matchRuleWithBindings`,
`applyExchangeRule`, `evaluateExchangeRules` (§4.4.5); `pathsOverlap`,
`collectConsumedLabelsOverlapping`, `resolveCeiling`,
`verifyRequiredIntegrityCoherent`, `verifyInputRequirements` (§8.10.3);
`canonicalizeBoundaryActivity` (§8.10.1.1); `verifyIntegrityBinding` (§8.10.4);
`verifyTransition` (§8.10.2); `propagateLabels`, `taintPc`,
`deriveTransformedLabel` (§8.9); `inspectConfLabel` (§4.6.4); `authorizeWrite`
(§8.15). `executeBoundaryInvocation` (§8.10.1) stays an adapter: it is the
loop that calls the others, and its runtime form is the prepare-and-digest
factoring the spec blessed in `SC-5`. Done when no manifest row reads
`missing` and `prepare.ts` contains no decision a kernel function makes.

**Stage 4: the specs side and the stronger form.** The specs workflow of
`commonfabric/specs#46` gains the generalized pseudocode check and the
cross-repository job, the coverage matrix gains the runtime column and its
missing rows, and the paper hook check is added; then, function by function, the kernel files become the extracted
pseudocode and the manifest relation becomes a generated diff.

## What this costs, and what it does not do

The procedure adds a specs pull request to every change that alters what CFC
decides. The assessment's commit counts say most CFC churn is host arrangement
and conforming implementation, which pay only the classification and a
manifest row; the gate falls on the class that was being skipped. The
`SPEC-PENDING` path keeps a ruling from blocking unrelated work, and its budget
keeps that path from becoming the default.

The process does not make the runtime correct. It makes the runtime's claim
about which specification it implements precise, re-stated on every change,
and failed by a machine when it stops being true. Proof of the runtime itself
remains out of scope, as the specification says of every §18 profile.

## Decisions

Taken by the CFC owner on 2026-10-05:

1. **Kernel end state.** Verbatim extraction, reached incrementally through
   hand-written hash-pinned functions; files grouped by spec chapter, not one
   per function.
2. **Test drive.** The process is proven by migrating the open entries,
   starting with the three self-contained groups named under "One tracker".
3. **The `SPEC-PENDING` budget** is three; marked code ships at the strict
   default only when fail-closed, otherwise behind a dial.
4. **The spec-change list** closes to new entries when stage 1 lands and
   drains through the test drive.
5. **Specs CI** is wanted, as it is cheap: `lake build`, the architecture
   check, the pseudocode check, and the cross-repository correspondence job.

6. **Publishing the pseudocode.** Verbatim extraction makes the critical
   blocks public as the runner's source; accepted.
7. **Reviewer.** Ian Hickson reviews the pull requests that change the
   procedure or the machinery behind it.
