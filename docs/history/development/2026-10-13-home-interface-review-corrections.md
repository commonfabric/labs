---
status: historical
created: 2026-10-13
archived: 2026-10-13
reason: "Review corrections and stored-state measurements for the Home interface draft, PR #8820."
---

# Home interface review corrections

Opus reviewed #8820 at `7c255938d8`, based on `27cc0885fa`, in
[review 5508106351](https://github.com/commonfabric/labs/pull/8820#pullrequestreview-5508106351).
This record follows the
[first-pass snapshot](2026-10-12-home-space-interface-first-pass.md). That
snapshot's FabriChat role implementation was removed from the draft during this
review pass.

## Send boundary

The role implementation selected a manager with nullish-coalescing expressions
and reached commands through nested objects. The transformed selections loaded
private manager data into lifts stored in the room's shared space. A test with
Home's wrapper → document-valued link → root-private core shape reproduced the
send refusal; its unlabeled control sent successfully.

Flat field bindings without the selection lifts restored sending. The test
also exercised the production room's `#chatManager` discovery and the room core
with supplied bindings. Both labeled and unlabeled cases sent successfully.
Manager-derived private UI computations still produced CFC refusals in the
labeled fixture; this measurement establishes message storage, not successful
private UI computation or member admission in a manager-created room.

## State retention

An in-place Home update whose candidate also carried the role change's
`manager.tsx` and `room.tsx` first appeared to empty seeded `requests`,
`direct`, and `outgoingNotices`. That seed did not fit the manager's schema:
the direct room's `about` had no `policy`, and the refused request had no
`reason`. The manager's swap setup refused the stored arguments ("updated
arguments do not match the candidate schema"), and the manager then read as
empty. With a seed that fits the schema, the same candidate kept all three
fields, as Opus measured in the
[second review round](https://github.com/commonfabric/labs/pull/8820#discussion_r4262880854).
The FabriChat role change stays removed from this draft; its production
FabriChat files match main at `676e4cae1b`. A manager update whose schema
refuses any stored record still leaves the manager reading as empty.

The final measurement compiles the real Home entry from `676e4cae1b`, with the
production manager and its dependencies, seeds the actual manager argument
cells, and applies the candidate Home through `PiecesController.setPattern`.
Requests include a refusal, direct records include a counterpart and room
reference, and the notice argument holds a queued delivery. The manager's
public notice list is a computed copy, so seeding that list would not seed its
stored notice argument.

After the Home-only code update, the same Home root runs the new interface and
all three stored fields retain their complete raw values and addresses. A
fresh runtime opens the updated Home from the same loopback storage and reads
the same records. This is an isolated in-place source-update measurement, not a
production toolshed restart or live deployment. The regression test and frozen
Home entry are committed under `packages/patterns/integration/`.

## Other review findings

The draft was brought onto `676e4cae1b`, including #8816's revert of #8804.
Home command-only consumers, both directly bound and discovering the role via
Home, passed with serving disabled and enabled. The negative observation
fixture is explicitly described as a synthetic CFC control.

A compiler-backed drift check compares fields and requiredness in the host
entry, collection, and receipt projections with schemas emitted from the
authored TypeScript types. Adding a field to either side fails that comparison.
The deterministic DID comparison remains valid: `isSharedSpaceCatalog` calls
`validTarget`, which requires `isWellFormedDID`; its DID Core expression admits
only ASCII identifiers, including ASCII percent escapes.

The draft retains the Home catalog interface and Social spaces browser. A
FabriChat role refactor remains separate work; its update must keep stored
manager arguments valid under the candidate schema. Existing main baselines are
retained; only the draft's superseded FabriChat and Home baselines are removed.

## Validation

- All 43 Home-system and FabriChat authored entries passed 448 assertions under
  strict CFC with persisted labels.
- Targeted integration passed seven suites and 12 steps. Thirty unrelated Home
  catalog steps were explicitly skipped for this focused run.
- The patterns package passed 60 suites and 409 steps plus its browser test;
  the Home-schemas package passed six steps.
- Workspace formatting, lint, types, 637 documentation code blocks, history
  indexing, and Home/collection compatibility passed.
