---
status: historical
created: 2026-10-01
archived: 2026-10-01
reason: "Corpus and compile-time audit of the generic-normalization follow-up to #8325."
candidate-commit: b0a31fa02789ef74f0329cd2b1f6dfe2b14e07f3
---

# Generic-normalization pattern audit

This audit compares main `75199b828d06260a0765f69edb2b41481cd7d8f7`
with the generic-normalization candidate on `sol/generic-normalization-oct1`.
The candidate reads plain generic declarations through
`GenerationContext.boundTypeParameters`, ports #7859's acceptance cases,
and extends authored writer reads through containers and utility aliases.
It does not change the creation-site policy owned by #8374.

## Method and result

The collector in `tasks/pattern-files.ts` supplied 397 authored pattern entry
points. Each was resolved with `resolveLocalProgram` and compiled through
`RuntimeHarness.compileToRecordGraph`; `getTransformedProgram` captured every
non-declaration module. Comparison replaced content-addressed module prefixes
and checkout roots with common paths. Both revisions compiled all 397 entry
points without an error.

The normalized emitted modules changed for 83 entry points; 314 were
byte-identical. Every change was inside an emitted schema. Structural comparison
resolved local `$refs`, followed recursive pairs once, and ignored definition
names, required-field order, type-array order and equivalent union-arm order.
34 entry points then had only representation changes. All remaining differences
were reviewed against the authored types and the narrowed capture annotations.
The table below classifies all 83 changed entry points, including changes in
modules they import. Multiple codes mean multiple kinds of change.

- **R — representation:** definition sharing, inlining, renumbering and ordering.
  Optional alternatives retain `undefined`; existing wrapper and policy marks
  remain at the same semantic position. The picker example's recursive
  `MentionablePiece[]` and `NotePiece[]` are distinct after the array-identity
  regression fix, and its schemas differ only by representation.
- **D — default normalization:** a capture's value and literal-default union
  become the narrowed value with its default at the property. Array defaults
  retain the observed element type; object defaults are validated against the
  full authored target, not the capture's reduced observation. This affects
  length-only array reads, note backlinks, loom presentation and work-snapshot
  captures. `test/data-model-test.tsx` also retains its written `Default<null>`
  on an `any` input and capture. It does not change the general rule about
  carrying an input's `Default` into an inferred pattern result.
- **A — authored any:** three handler-result positions in the prompt-injection
  demo read `ReadResourceResult<any>.body` as `true`, matching its argument,
  rather than `unknown`. These are schemas of values, not new writer claims.
- **C — comparison capability:** the notebook's delete handler reads its
  registry array elements as `unknown` with `asCell: ["comparable"]`, matching
  the emitted narrowed annotation used only by `equals`. It preserves the
  containing cell mark and array default; it removes the unrelated full note
  observation. Five entry points import this changed module.
- **U — union encoding:** `FrameworkProvided<string>` in the common-fabric
  module's command handler emits two identical string alternatives rather than
  one string schema. The accepted values and marks are unchanged; ten entry
  points import the module.

The historical update-compatibility gate compared 316 pattern contracts with
all their recorded contracts. It passed after appending 14 new contract records;
81 entry points have no exported pattern contract. The 91 standing accepted
breaks were unchanged. No break exception, baseline deletion or pattern-source
edit was added.

## Compile time

One sequential corpus pass per revision on the same macOS host, with the same
Deno and TypeScript 6.0.3 runtime, measured resolution and compilation separately.
No other compiler or test suite ran during either recorded pass. These single
samples are descriptive, not a statistically controlled benchmark.

| Measurement | Main | Candidate |
| --- | ---: | ---: |
| Resolve + compile elapsed | 91.066 s | 93.969 s |
| Sum of compilation spans | 89.841 s | 93.204 s |
| Median per-entry compilation | 137.407 ms | 145.262 ms |
| 95th percentile compilation | 782.006 ms | 832.347 ms |

The candidate's elapsed pass was 3.2% longer. The data does not establish a
repeatable performance regression or improvement.

## Changed entry points

Paths below are relative to `packages/patterns/`.

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
| `deep-research.tsx` | R, U |
| `do-list/do-list.tsx` | D, R, U |
| `examples/arbitrary-wish-example.tsx` | R |
| `examples/cf-picker.tsx` | D, R |
| `examples/suggestion-test.tsx` | R, U |
| `experimental/chat-note.tsx` | R |
| `fabrichat/main.tsx` | R |
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
| `notes/daily-journal.tsx` | D, R, U |
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
| `system/common-fabric.tsx` | R, U |
| `system/default-app-ben.tsx` | C, D, R, U |
| `system/default-app.tsx` | C, D, R |
| `system/home.tsx` | R |
| `system/omnibox-fab.tsx` | R, U |
| `system/profile-create.tsx` | R |
| `system/profile-embed.tsx` | R |
| `system/profile-picker.tsx` | R |
| `system/quick-capture.tsx` | C, D, R, U |
| `system/space-overview.tsx` | R, U |
| `system/suggestion.tsx` | R, U |
| `test/data-model-test.tsx` | D |
| `todo-list/todo-list.tsx` | D |
| `topic-workbench/main.tsx` | R |
| `topics/main.tsx` | R |
| `topics/topic.tsx` | R |
| `weekly-calendar/weekly-calendar.tsx` | D |
| `work-snapshot/main.tsx` | D, R |

## Boundary cases

The ported tests cover generic defaults, scope wrappers, cells and arrays,
aliases, interface and class inheritance, nested instantiations and union
instantiation matching. Additional cases pin mapped views, synthetic references,
bound `Pick`/`Omit` keys, concrete template literals, optional cell references
and recursive arrays of different element types. The full pipeline pins
`PerUser<Box<string>>` in input, result and capture schemas, and readonly array
captures.

A required-object default can still have an extra literal alternative in a
printed capture. That quirk predates this change and is not reported as fixed.
The question of carrying an input's default into inferred results remains with
Robin and Berni. The polymorphic `Nest<T[]>` hang and computed-output document
writability gap are tracked separately; this audit did not reproduce or fix them.
