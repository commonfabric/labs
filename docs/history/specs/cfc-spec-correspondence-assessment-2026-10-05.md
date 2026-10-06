---
status: historical
created: 2026-10-05
archived: 2026-10-05
reason: "Assessment of how far the labs CFC implementation and its documents have drifted from the CFC specification, its Lean proofs, and the paper in commonfabric/specs, taken before the correspondence process was designed."
---

# CFC spec correspondence assessment, 2026-10-05

The Contextual Flow Control (CFC) design is held in three artifacts in the
`commonfabric/specs` repository under `cfc/`: a prose specification whose
critical parts are stated as TypeScript pseudocode, a Lean 4 development that
mechanizes that pseudocode and proves properties of it, and a paper whose
claims are pinned to both. The discipline those three are meant to keep is that
each change reaches all three, and that an implementation corresponds one to
one with the pseudocode wherever the pseudocode is normative.

This document records where the labs implementation stands against that
discipline on 2026-10-05. It is the evidence base for the process design in
[`docs/plans/cfc-spec-correspondence-process.md`](../../plans/cfc-spec-correspondence-process.md).
Every figure below was read from the two trees named in the next section; none
was taken from an earlier report.

## Trees read

| Tree | Commit | Date |
| --- | --- | --- |
| `commonfabric/labs` | `f25fe54732` | 2026-10-05 |
| `commonfabric/specs` (`cfc/`) | `9e751d58` | 2026-10-03 |

The specs tree was read at `~/src/specs/cfc`; a working copy of the Lean
development was present there but its build artifacts were older than its
sources (see "Freshness" below).

## Finding 1: the implementation moves an order of magnitude faster than the spec

Commits touching the CFC implementation (`packages/runner/src/cfc/`) or the labs
CFC documents (`docs/specs/cfc-*.md`), against commits anywhere under
`specs/cfc/`:

| Month | labs CFC commits | specs `cfc/` commits |
| --- | --- | --- |
| 2026-06 | 43 | 30 |
| 2026-07 | 103 | 36 |
| 2026-08 | 62 | 0 |
| 2026-09 | 159 | 32 |
| 2026-10 (to the 5th) | 23 | 6 |

Over the sixty days to 2026-10-05, 214 commits touched
`packages/runner/src/cfc/`; 24 of them also touched the labs spec-change list
(`docs/specs/cfc-spec-changes.md`). `prepare.ts` alone changed in 118 of them.
Nine human authors are named on those commits, and every one of them carries a
model co-author line, so the churn is agent-driven work landing under many
owners.

## Finding 2: the spec-change list has become a debt ledger that records decisions already implemented

`docs/specs/cfc-spec-changes.md` is 1,791 lines holding 56 entries (`SC-1` to
`SC-56`). Of the entries that carry a machine-readable status, 18 are `open`,
3 `adopted`, 9 `applied`; the first 37 entries predate the status convention and
record their state in prose. Fourteen of the eighteen open entries were filed
after 2026-09-23. The list cites three specs pull requests in total
(`specs#11`, `specs#14`, `specs#39`).

The open entries are not questions. They state a rule the runner already
enforces and ask the spec to adopt it. `SC-53`, filed 2026-10-01, ends:
"Implemented in `packages/runner/src/cfc/prepare.ts`
(`currentPrincipalIntegrityReason`); described in `current-principal.md`." The
runtime's behavior is settled, and the specification, the proofs, and the paper
have not seen it. Most of the fourteen recent entries have this shape.

## Finding 3: no always-loaded instruction tells an agent the specs repository exists

The surfaces an agent reads before it knows what it is working on were searched
for any mention of the specs repository, its path, or the spec-change list:

| Surface | Mentions |
| --- | --- |
| `AGENTS.md` | none; the string `cfc` does not occur |
| `.claude/rules/*.md` | none |
| `skills/*/SKILL.md` | none |
| `docs/development/DEVELOPMENT.md` | none |
| `docs/README.md` | none |

The `spec-audit` skill, which its name suggests covers this, is scoped to the
TypeScript-transformer and schema-generator documents. The `cf-review` skill
asks a reviewer to surface a change that makes "a normative spec" wrong but does
not name the CFC specification or say where it lives. The only places that
state the obligation are the preamble of the spec-change list itself and the
"spec ground" paragraphs that open individual CFC design documents, which an
agent reads only after it has already decided to work in that area.

The instruction the owner believed agents were following does not exist on any
surface they load.

## Finding 4: a second specification corpus has grown inside labs

`docs/specs/` holds 21 CFC documents, about 8,000 lines in total, beside the
spec-change list and the runner backlog. They divide into two kinds, and the
tree does not distinguish them:

- **Host arrangement.** Where the boundary pass runs in the transaction, the
  stored envelope's bytes, how render boundaries compose in the reconciler, the
  dial names and their rollout order. A different conforming runtime would do
  these differently, and the CFC specification deliberately leaves them to
  §18's implementation profiles.
- **Normative design.** Persisted declassification and the rewrite event,
  observation classes, sealed custody, reviewed intents, write-destination read
  exclusion, input-witnessed `TransformedBy`, label-metadata confidentiality.
  Each states rules with MUST force, each carries a "spec ground" paragraph and
  a list of what "the spec still owes," and each was written in labs because
  that is where the agent was working. Several have since been adopted by the
  spec (the enforcement matrix became §18.6.3.1; the read exclusions became
  §18.6.2), which shows the content was spec content.

Nothing in `docs/README.md` or `docs/specs/README.md` says which kind belongs
where, so an agent designing a CFC rule has no reason to leave the repository.

## Finding 5: the pseudocode and the implementation correspond by citation, not by structure

The normative chapters (`04`, `06`, `07`, `08-*`) define 98 named functions in
TypeScript pseudocode. The runner's CFC sources (`packages/runner/src/cfc/`,
`cfc.ts`, `storage/`) contain 12 of those names:

```text
applyExchangeRule  atomLe  canUpdateStoreLabel  canWrite  consumedCellId
evaluateExchangeRules  inspectConfLabel  instantiate  pathsOverlap
substituteVars  trustedEdgesForUser  verifyInputRequirements
```

Where a name does match, the shapes have parted. The spec's
`verifyInputRequirements` (§8.10.3) takes four arguments, the consumed reads,
their labels, the input schema and the match environment, and returns a
boolean. The runner's takes nine: the transaction, a schema, a target address,
an identity resolver, per-write prefix bounds, a metadata resolver, a
provenance accumulator, a deferred-refusal hook and a policy-application flag,
and returns a refusal reason tagged with whether it is a terminal verdict. The
extra arguments are each defensible as runtime concerns, and each is a place
where the implementation decides something the pseudocode does not say.

The boundary loop itself, `executeBoundaryInvocation` (§8.10.1), is about sixty
lines of pseudocode with five named steps. Its runner counterpart is
`prepare.ts`:

| Measure | Value |
| --- | --- |
| Lines | 12,478 |
| Top-level definitions | 214 |
| Exported functions | 1 (`prepareBoundaryCommit`, eight lines delegating to a stage function) |
| `§` citations in the file | 179 |
| `§` citations across `packages/runner/src/cfc/` | 509 |

The 509 citations are the only correspondence. No check resolves one: a section
can be renumbered, reworded, or deleted in the spec and every citation stays
green. The one mechanism in labs that does pin a quote to a document and fail
on drift, `packages/cf-harness/audit/citations.ts` with its
`citation-drift.test.ts`, covers only the labs-local agent-harness documents.

The spec repository has the matching artifact for its other leg: the
"Pseudocode Coverage Matrix" and "Spec Snippet Correspondence" in
`formal/FORMALIZATION.md` give every critical pseudocode function its Lean
definition, proof status and remaining gap. There is no equivalent table for
the runtime, in either repository.

## Finding 6: pins and freshness

The two repositories pin each other by hand, in different places, at different
dates:

| Pin | Where | Points at | Dated |
| --- | --- | --- | --- |
| specs commit | `docs/specs/agent-harness/04-cfc-spec-correspondence.md` | `8b8613ea` | — |
| labs commit | `specs/cfc/notes/runtime-gap-readiness.md` | `e059494c` | 2026-09-09 |

Neither pin is checked by anything. Labs CI cannot see the specs repository,
and the specs repository has no CI at all: its `formal/docs/CONTRIBUTING.md`
asks every contributor to run `lake build` and `check-architecture.py` locally
before committing. On the machine read for this assessment, the newest Lean
source was dated 2026-10-02 and the newest build artifact 2026-09-09; four
commits since then changed `formal/`, and nothing recorded whether the suite
builds at head. (A build was started while this document was written; the
result is recorded in the process plan rather than here, since this document
is frozen.) The paper's "Artifact and Current Status" section states that
`lake build` succeeds "on the state checked on September 9, 2026", which is
accurate and dated.

Exactly one pseudocode block in the spec is machine-checked:
`formal/scripts/check-input-requirement-pseudocode.py` extracts the §8.10.3
block and type-checks it with Deno against stub fixtures. The other 97 named
functions are prose.

## Finding 7: the loop does close when somebody drives it

Three cases show the intended path working and are the template for the
process:

- **specs#36** (`2d0b145b`, 2026-09-28): a labs pull request, `labs#8145`, was
  reviewed inside the specs repository against the spec; the review proposed
  rules for §4.6.3, §8.12.8, §8.17.6 and §18.6.2 as options for ruling; the
  rulings were applied to the prose and then mechanized in Lean
  (`eca166ab`, `79a0c19e`).
- **§13.11 rulings** (`13-11-decisions.md`): seven open questions were written
  as blocks with options and proposed spec text, ruled by two people on
  2026-09-23, reviewed by the owner on 2026-09-25, and applied in a separate
  normative pull request. The document records who ruled, who reviewed, and
  what was deferred.
- **specs#39** (`SC-55`): the spec ruled on value-relative label-map entries
  first; the runner then refactored its digest record address type to match
  the ruling (`labs#8361`), and the labs entry was marked `applied` in the same
  change.

In each case a person chose to route through the specs repository. Nothing
made that the default, and the figures in Finding 1 say it was the exception.

## What the gaps are

| Gap | Evidence | Consequence |
| --- | --- | --- |
| Agents are not told the spec exists | Finding 3 | Spec-first is not the default path; it depends on the agent already knowing |
| Spec design is written in labs | Finding 4 | Normative rules exist in one artifact of three; proofs and paper cannot see them |
| Open rulings accumulate | Finding 2 | 18 implemented behaviors await a ruling that may reverse them |
| Pseudocode and code share names, not shapes | Finding 5 | The proofs are about functions the runtime does not call |
| Citations are unchecked | Finding 5 | Spec edits break nothing in labs; labs edits break nothing in specs |
| Pins are manual and stale | Finding 6 | No one can say which spec the runner implements |
| Proof build is local-only | Finding 6 | A Lean regression at head is invisible until someone builds |
| One pseudocode block is checked | Finding 6 | Pseudocode can stop type-checking without notice |

The gaps are mutually reinforcing: because no surface names the spec, agents
design in labs; because the design is in labs, the spec falls behind; because
the spec is behind, the runtime's shape diverges from the pseudocode; because
nothing checks the correspondence, the divergence is silent. The process plan
addresses them in that order.
