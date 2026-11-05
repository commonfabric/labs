---
status: historical
created: 2026-10-03
archived: 2026-10-03
reason: "Review follow-up for #8395: union deduplication, rebasing onto main, notebook deletion coverage, and renewed corpus and label comparisons."
---

# Generic-normalization review audit

This follows the [October 1 audit](generic-normalization-pattern-audit-2026-10-01.md)
and [Opus's review of #8395](https://github.com/commonfabric/labs/pull/8395#pullrequestreview-5402897942).
It compares main `8d2cc3f864c85477ca8ddc07c34d25fafee61aaf` with
compiler and test candidate `eb2856bbd350a8bab76db56a7155759c1ba389c4`.
Later baseline, acceptance-registry and audit commits do not change that
compiler or the authored pattern sources used by the corpus comparison.

## Review changes

The writer-query walker now recognizes the resolved `WriteAuthorizedBy`
declaration without a name check for the test alias `Owned`. Declaration
walking already reaches the writer; an ordinary alias named `Owned` has no
special treatment. Input and result tests cover `Partial<Owned<Shape, Binding>>`
when that alias simply returns `Shape`.

Node-formatted union arms are deduplicated by data-model value equality before
single-arm unwrapping. `FrameworkProvided<string>` now emits one string schema.
The new generic marker-union test failed with the duplicate alternatives before
the fix. The mapping specification records this formatting rule. A newly introduced
mapped-type test is also retitled to describe reading under its bindings,
matching the supported behavior it asserts.

The rebase preserves #8360's handling of labeled nullable cells, including
`getCellWrapperInfo` alongside the generic-binding imports. Its generator and
pipeline tests pass with the normalization work.

The notebook pattern test now registers two selected notes and one unselected
note in the actual `#pieceRegistry`. After select-all and delete, it checks
that both selected notes are absent by `equals`, and that the unselected note
remains with its original title and content. All 40 assertions pass. In an
isolated main checkout, removing the production registry-filtering write makes
this test fail exactly the new registry-removal assertion: 39 pass, one fails.
The production source was restored after that control. The notebook producer
itself has no change in this review follow-up.

## Corpus method and result

`tasks/pattern-files.ts` supplied 403 authored pattern entry points on both
revisions. Each was resolved with `resolveLocalProgram` and compiled through
`RuntimeHarness.compileToRecordGraph`; `getTransformedProgram` captured every
non-declaration module. Comparison replaced content-addressed module prefixes
and checkout roots with common paths. Both revisions compiled all 403 entry
points with zero errors. Pattern-test files are excluded by that collector;
the notebook behavior test is separate evidence.

317 entry points have byte-identical normalized emitted modules. All changes
in the remaining 86 are inside schemas. Structural comparison follows chains
of local `$refs`, preserving siblings and guarding recursive pairs, and ignores
definition names, required-field order, type-array order and equivalent
union-arm order. 38 entry points then have only representation changes. Every
remaining difference is classified against the authored types and narrowed
capture annotations. Four current FabriChat entry points replace its retired
main entry point in the earlier corpus.

The codes retain the meanings from the October 1 audit:

- **R — representation:** definition sharing, inlining, renumbering and ordering.
- **D — default normalization:** a capture's value and literal-default union
  become the narrowed value with its default at the property. Full object
  defaults are validated against the authored target. The data-model example
  also retains its written `Default<null>` on an `any` input and capture.
- **A — authored any:** the prompt-injection demo's handler-result bodies read
  `ReadResourceResult<any>.body` as `true`, matching the argument.
- **C — comparison capability:** notebook deletion reads registry elements as
  `unknown` with `asCell: ["comparable"]`, as required by its narrowed `equals`
  observation. The containing cell mark and array default remain.

Across entry points, R occurs 61 times, D 47 times, A once and C five times;
the codes overlap. The previous U category is gone after deduplication: the
common-fabric command handler's `FrameworkProvided<string>` matches main.

A second comparison extracts IFC metadata from every schema in every
corresponding emitted module, using canonical data-model hashes to compare each
kind, value and occurrence count. It checks 1,762 emitted-module observations,
of which 251 contain labels, across all 403 entry points. There are zero
kind, value or count differences. This count comparison supplements the
pipeline tests for writer placement; it does not by itself prove placement.

The two corpus runs overlapped other validation and host activity. Their elapsed
times are not used as a performance comparison. The earlier isolated pair
remains a historical observation of a different main revision.

## Historical compatibility

The initial full check found four current contracts without a record, and two
pre-slot records added by this PR that report #8373's default-profile migration.
The latter are `system/home.tsx` over
`20261002T030859Z-0aFLnq2HTDw4iEju`, at `result.defaultProfile`, and
`system/profile-picker.tsx` over `20261002T030859Z-Am2mYYcxRoMIAoQs`, at
`argument.defaultProfile`. Both report defaults changed below a constraint that
is not stable under default insertion.

Those two pairs are added to the existing #8373 slot-migration acceptance
entries, with the same paths, reason and ruling. The decision to preserve
existing defaults is recorded in
[the existing migration record](../home-default-profile-slot-break.md).
No new migration ruling is introduced, and all earlier baseline files remain.
Current main has 122 standing accepted pairs; this integration adds these two,
for 124. Normalization itself introduces no accepted contract break.

Four current records are appended for `fabrichat/room.tsx`, `system/home.tsx`,
`system/profile-create.tsx` and `system/profile-picker.tsx`, bringing this PR's
new records to 18. The scoped update check passes for all four.

The final full check passes for all 319 exported pattern contracts, accounting
for all 124 accepted pairs. 84 files have no pattern contract; none are skipped
because of an evaluation error. There are no missing current records or stale
acceptances.

## Validation

- Full schema-generator suite: 75 tests and 1,057 steps pass.
- Full ts-transformers suite: 1,232 tests and 1,759 steps pass.
- Root type check, formatting, lint, all 633 documentation blocks, and
  repository gates pass for the compiler and test candidate.
- Patterns package: 51 tests and 356 steps, plus its browser test, pass.
- Notebook behavior test: 40 assertions pass; registry-write mutation control
  fails its new assertion.
- [CI at the compiler/test candidate](https://github.com/commonfabric/labs/actions/runs/37158270662)
  passes all five test shards and Status. Generator coverage debt is 659
  uncovered lines against a 699-line baseline; transformer debt remains 1,352
  against 1,352. No coverage-debt acceptance was added.

The scope boundaries remain as in the earlier audit: #8374 owns creation-site
fatality and inferred-result policy treatment; the inferred-result default
contract remains with Robin and Berni; the `Nest<T[]>` hang and computed-output
writability gap are separate Topics. A printed capture of a required-object
default can still carry an extra literal alternative.

## Changed entry points

Paths are relative to `packages/patterns/`. A row includes changes in modules
that entry point imports.

| Entry point | Classification |
| --- | --- |
| `activity-log/activity-log.tsx` | D |
| `annotation-manager.tsx` | R |
| `annotation.tsx` | R |
| `battleship/multiplayer/lobby.tsx` | R |
| `book-recommendations/main.tsx` | R |
| `book-recommendations/seeded-live-demo.tsx` | R |
| `calendar/calendar.tsx` | D |
| `card-piles/main.tsx` | D |
| `catalog/catalog.tsx` | D, R |
| `catalog/stories/note-story.tsx` | D, R |
| `catalog/ui/sidebar/sidebar.tsx` | D, R |
| `catalog/ui/story-renderer.tsx` | D, R |
| `cell-link.tsx` | D, R |
| `cfc-agent-prompt-injection-demo/main.tsx` | A |
| `cfc-group-chat-demo/main.tsx` | R |
| `cfc-group-chat-demo/trusted.tsx` | R |
| `contacts/contact-book.tsx` | D |
| `cozy-poll/main.tsx` | R |
| `deep-research.tsx` | R |
| `do-list/do-list.tsx` | D, R |
| `examples/arbitrary-wish-example.tsx` | R |
| `examples/cf-picker.tsx` | D, R |
| `examples/suggestion-test.tsx` | R |
| `experimental/chat-note.tsx` | R |
| `fabrichat/manager.tsx` | D, R |
| `fabrichat/message-row.tsx` | D, R |
| `fabrichat/room-records.tsx` | D, R |
| `fabrichat/room.tsx` | D, R |
| `factory-outputs/lot-watch/main.tsx` | R |
| `factory-outputs/lot-with-coordinator-demo/main.tsx` | D, R |
| `factory-outputs/parking-coordinator/main.tsx` | D, R |
| `fair-share/main.tsx` | D |
| `file-share/main.tsx` | D |
| `form-demo.tsx` | D |
| `gideon-tests/array-length-repro.tsx` | D |
| `gideon-tests/computed-array-repro.tsx` | D |
| `gideon-tests/notebook-nest-bug/main.tsx` | C, D, R |
| `gideon-tests/proxy-length-repro.tsx` | D |
| `gideon-tests/test-cross-piece-server.tsx` | D |
| `gideon-tests/test-llm-dumb-map-generateobject.tsx` | R |
| `gideon-tests/test-reactive.tsx` | R |
| `group-chat-lobby.tsx` | D, R |
| `habit-tracker/habit-tracker.tsx` | D |
| `lobby/main.tsx` | R |
| `loom/main.tsx` | D |
| `lunch-poll/main.tsx` | R |
| `lunch-poll/participant-identity-card.tsx` | R |
| `lunch-poll/poll-option-card.tsx` | R |
| `notes/daily-journal.tsx` | D, R |
| `notes/note-md.tsx` | D |
| `notes/note.tsx` | D, R |
| `notes/notebook.tsx` | C, D, R |
| `person-workbench/main.tsx` | R |
| `primitives/amount-ledger.tsx` | D |
| `primitives/check-list.tsx` | D |
| `primitives/demo/atoms-demo.tsx` | D |
| `primitives/sortable-table.tsx` | D |
| `recommend-a-book/agents.tsx` | R |
| `recommend-a-book/library.tsx` | R |
| `recommend-a-book/main.tsx` | R |
| `recommend-a-book/shared-invitation.tsx` | R |
| `scoped-group-chat/main-plain-inputs.tsx` | D |
| `scoped-group-chat/main-with-writable-inputs.tsx` | D |
| `scrabble/scrabble.tsx` | R |
| `self-improving-classifier.tsx` | D |
| `shared-note/main.tsx` | R |
| `shared-profile-demo/main.tsx` | R |
| `shopping-list.tsx` | R |
| `system/common-fabric.tsx` | R |
| `system/default-app-ben.tsx` | C, D, R |
| `system/default-app.tsx` | C, D, R |
| `system/home.tsx` | D, R |
| `system/omnibox-fab.tsx` | R |
| `system/profile-create.tsx` | R |
| `system/profile-embed.tsx` | R |
| `system/profile-picker.tsx` | R |
| `system/quick-capture.tsx` | C, D, R |
| `system/space-overview.tsx` | R |
| `system/suggestion.tsx` | R |
| `test/data-model-test.tsx` | D |
| `todo-list/todo-list.tsx` | D |
| `topic-workbench/main.tsx` | R |
| `topics/main.tsx` | R |
| `topics/topic.tsx` | R |
| `weekly-calendar/weekly-calendar.tsx` | D |
| `work-snapshot/main.tsx` | D, R |
