---
status: historical
created: 2026-10-03
archived: 2026-10-03
reason: "Baseline cleanup after Opus's second review of #8395: remove never-shipped candidate contracts and retain only final contract records."
---

# Generic-normalization baseline cleanup

[Opus's second review](https://github.com/commonfabric/labs/pull/8395#pullrequestreview-5403519507)
verified the compiler fixes, corpus comparison and notebook coverage at
`090297ef8762f2f7db751f88f0eb6abdde9fa071`. Its remaining finding concerns the
14 contract records added on the PR's original, unmerged head. Keeping those
records after the rebase had required adding two pairs to the existing
default-profile slot migration acceptance entries.

Those candidates never shipped in main. Their files are absent from both the
PR's merge base, `8d2cc3f864c85477ca8ddc07c34d25fafee61aaf`, and fetched main
`60d4e92340a6256cb46933c008cb9fee6dc4028d`. The append-only gate protects the merged baseline history. Removing
these branch-only additions before merge preserves that history while avoiding
permanent compatibility obligations to an unshipped candidate.

All 14 `20261002T030859Z-*.json` records are removed. The two additions to the
home and picker migration acceptance entries are reverted, together with their
comment edits; the registry is byte-identical to the PR's merge base. The four
current `20261003T2247*` records are retained. `deno task pattern-compat --update`
records any remaining current contracts without baselines.

The [October 1 audit](generic-normalization-pattern-audit-2026-10-01.md) and
[earlier review audit](generic-normalization-review-audit-2026-10-03.md) remain
frozen records of those heads. Their baseline counts and acceptance integration
are superseded by this cleanup. Their compiler and corpus evidence remains
applicable: no compiler, transformer, authored pattern or test source changes
in this cleanup.

## Final validation

The update pass records 11 current contracts; together with the four retained
records, this PR adds 15 final contract records. The subsequent read-only gate
passes for all 319 exported contracts and accounts for the unchanged 122
accepted pairs. 84 files have no pattern contract, with zero evaluation errors.
The append-only and history-index gates pass.

Root type checking, formatting and lint pass. The tooling suite passes 683
tests and 3,461 steps; the patterns package passes 51 tests and 356 steps,
plus its browser test.

## Removed candidate records

Paths are relative to `packages/patterns/baselines/`.

| Pattern | Removed record |
| --- | --- |
| `annotation.tsx` | `20261002T030859Z-6RckeyaAEcVBvSTz.json` |
| `book-recommendations/main.tsx` | `20261002T030859Z-RG9CkXhT9Y8zMON8.json` |
| `book-recommendations/seeded-live-demo.tsx` | `20261002T030859Z-Uae2gNquN1m1hysE.json` |
| `cfc-group-chat-demo/main.tsx` | `20261002T030859Z-kUNF5sBKWx27omx3.json` |
| `experimental/chat-note.tsx` | `20261002T030859Z-wUMMSFlicpCExFQg.json` |
| `gideon-tests/test-llm-dumb-map-generateobject.tsx` | `20261002T030859Z-EYzv5OWW2gKO2xcU.json` |
| `gideon-tests/test-reactive.tsx` | `20261002T030859Z-XpAQ5-quJtPbJ7i4.json` |
| `recommend-a-book/library.tsx` | `20261002T030859Z-FDGcLrmOksZ7VR3v.json` |
| `system/home.tsx` | `20261002T030859Z-0aFLnq2HTDw4iEju.json` |
| `system/omnibox-fab.tsx` | `20261002T030859Z-dufAXqhHK1DTVVXj.json` |
| `system/profile-create.tsx` | `20261002T030859Z-pDE8CNq5UWw-35WW.json` |
| `system/profile-picker.tsx` | `20261002T030859Z-Am2mYYcxRoMIAoQs.json` |
| `system/suggestion.tsx` | `20261002T030859Z-aBL2DgOoWmZwOMwI.json` |
| `test/data-model-test.tsx` | `20261002T030859Z-2L1kQgKsNFwpZHgs.json` |
