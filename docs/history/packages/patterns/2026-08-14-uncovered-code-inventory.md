---
status: historical
created: 2026-08-14
archived: 2026-08-14
reason: "Inventory: where the uncovered lines in packages/patterns were, what a round of high-ratio pattern tests reached, and what was left."
---

# What was uncovered in `packages/patterns`, and what a round of tests reached

`packages/patterns` carried 232,303 uncovered lines. This is where they were,
what a round of pattern tests written against them reached, and what remains.

The measurement is the coverage-debt metric the gate uses, described in
[COVERAGE.md](../../../development/COVERAGE.md): the whole pattern unit test
lane run with `CF_PATTERN_COVERAGE_DIR` set, its per-test LCOV files joined,
and the result handed to the same accounting that
[`tasks/coverage-metrics.ts`](../../../../tasks/coverage-metrics.ts) applies in
CI. Two numbers matter throughout. A file with no coverage record is charged
every one of its tracked lines, so it reads as entirely uncovered whether it is
a thousand-line program nothing loads or a file one test barely touches. A file
with a record is charged only the lines within it that no test ran.

## Where the lines were

One file held 77% of the total.
`packages/patterns/scrabble/scrabble-words.ts` is the TWL06 Scrabble
dictionary: 178,696 lines, one `Set` literal, and nothing in the repository
imports it. `scrabble.tsx` validates words against its own 300-word
`EXAMPLE_WORDS` set instead. So the largest single item in the package's
coverage debt is a file no code reads, and a test that imported it would cover
178,696 lines while proving nothing about any pattern. It is left alone here
and wants a decision of its own: either wire the game to the real dictionary,
or delete the file.

Setting that file aside, 53,607 lines were uncovered, and they split cleanly.
39,113 of them sat in 208 files with no coverage record at all — patterns
nothing had ever built. The other 14,494 sat in 162 files that a test loaded
but only partly ran, mostly the branches behind a signed-in account or a
language-model response.

By directory, before and after this round:

| Directory | Before | After |
| --- | ---: | ---: |
| `google/` | 18,529 | 11,132 |
| `catalog/` | 7,360 | 86 |
| top level | 6,626 | 3,922 |
| `gideon-tests/` | 3,269 | 3,269 |
| `examples/` | 1,960 | 876 |
| `experimental/` | 1,697 | 545 |
| `system/` | 1,665 | 1,020 |
| `base/` | 1,392 | 416 |
| everything else | 11,109 | 8,116 |
| **total, excluding the word list** | **53,607** | **29,382** |

## What the tests did

Ten pattern tests, 1,568 lines between them, closed 24,225 lines: a 45% cut in
everything but the word list. The ratio comes from a property of the
measurement rather than from anything clever. Pattern coverage counts
statements, and most of a pattern's lines are one statement each — a module's
schema table, its type declarations, the pattern body, the rendered tree.
Building a pattern runs all of them. So a test that instantiates a pattern with
plausible inputs and reads what it publishes covers the bulk of it, and a test
that also reads the rendered tree covers the derived expressions inside it,
which only run when something reads the node they build.

The tests are not bare smoke tests. Each checks what the pattern claims: the
name it goes under, the collections it derives, the text its tree carries, and,
where the pattern turns on one, the state a headline action moves. The Gmail
extractors are checked for coming up empty rather than failing when no account
is linked. The catalog is driven through picking a story, collapsing its
sidebar, reopening it, and picking another. The contacts list is driven through
both its add buttons. The folksonomy demo is checked for a tag landing on the
item it was written to and nowhere else.

The largest single result was `catalog/`, which went from 7,360 uncovered to
86. Sixty stories, each about 120 lines of component example, are covered by
two test files of about 215 lines each: build the story, check the name the
catalog lists it under, check it built an example.

## What building the patterns found

Nothing had ever instantiated most of these patterns, so the tests found
patterns that do not build at all. Six were fixed alongside the tests:

- `usps-informed-delivery.tsx` annotated its pattern-body parameter `: any` and
  cast the body back with `as any`. That hides from the transformer which
  values are reactive, so `.map(...)` over a reactive array in the rendered
  tree was left un-lowered and threw on instantiation. The `any` was also
  masking an `error` field typed `unknown`, which the runner reads back as
  `undefined` rather than materializing.
- `hotel-membership-gmail-agent.tsx` built its multi-account summary as a
  record keyed by brand and walked it with `Object.entries(...)` inside the
  rendered tree. Entries taken off a reactive record yield reactive values, and
  `.map` on one throws the same way.
- `person.tsx` and `family-member.tsx` wrote every collapsible section header
  as a helper call inside a JSX expression slot with the toggle handler bound
  inline: `{header(label, toggle({ section }))}`. The whole expression compiles
  as one unit and the binding is not available inside it, so all nine headers
  across the two forms failed at render with "toggle is not a function".

Four more were left for their own change, because each needs more than a test
around it:

- `google/core/imported-calendar.tsx` (1,211 lines) throws "Cell.of() only
  accepts static data, but found a reactive value".
- `google/WIP/google-docs-importer.tsx` is rejected by the compiler over a
  string in `google/core/util/google-docs-markdown.ts` that reads as an HTML
  comment. That util is 477 uncovered lines and is under `core/`, so it is
  worth reaching whatever happens to the importer.
- `examples/cf-picker.tsx` throws "Bidirectionally bound property $items is not
  reactive".
- `suggestable/budget-planner.tsx` opens a language-model request as it builds.

`record-icon.tsx` was left out for a different reason. It builds in under a
second on its own, takes about thirty seconds when any second pattern shares
the runtime, and takes over two minutes for two copies of itself. That cost is
superlinear, so it is not the price of the emoji list it embeds.

Two patterns are untestable as they stand, by design or by dependency.
`scope-bug-computed-vnode-blank/main.tsx` is a harness whose enabled section
exists to produce a runtime error on purpose. `examples/llm.tsx` and
`examples/write-and-run.tsx` each open a language-model request as they build.

## What is left

29,382 lines outside the word list. 10,709 of them are in 74 files with no
record; 18,673 are in 226 files that a test reaches but does not run through.

The three largest groups:

- **`google/`, 11,132 lines.** Most of what remains here is behind a signed-in
  Google account: the fetch paths, the response handling, and the branches that
  run once an email or a calendar event has arrived. Reaching them means a
  fixture that stands in for the account rather than another instantiation
  test. `google/core/util/gmail-client.ts` (601), `calendar-write-client.ts`
  (436), and `gmail-send-client.ts` (302) are plain modules and the easiest
  starting point, since a plain unit test can drive them directly.
- **`gideon-tests/`, 3,269 lines, untouched.** Twenty-five regression fixtures,
  each pinning down one runtime behavior. They are tiered "fixture — never
  imitate" in [index.md](../../../../patterns/index.md), and several
  are written to fail. Whether they should be covered at all is a question
  worth answering before covering them.
- **The partly-run large patterns.** `record/extraction/extractor-module.tsx`
  (1,348 of 2,723), `gmail-agentic-search.tsx` (1,102 of 2,302),
  `self-improving-classifier.tsx` (787 of 2,318), and `store-mapper.tsx` (659
  of 2,092) are each loaded by a test that exercises one path. What is left is
  the rest of the paths, which is ordinary test writing rather than a new
  technique.

`tools/lunch-poll-diagnose.ts` (760) is a diagnostic script rather than a
pattern; it is charged as tracked source because it sits under `packages/`.
