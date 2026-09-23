---
status: historical
created: 2026-09-20
archived: 2026-09-20
reason: "Point-in-time measurements of the shipped cf view Python parser path."
---

# `cf view` Python on Tree-sitter: shipped measurements

This report records what the shipped `cf view` Python path costs, measured
against the operating maximums in the
[`cf view` language coverage plan](../../../plans/cf-view-language-coverage.md).
Those maximums were set from a probe, before an implementation existed; this is
the first measurement of the implementation itself. Every figure here is from
the real language object, so what was measured is what the pager runs.

Five of the seven recorded maximums are met. The other two are the
5-millisecond edit maximum, which describes an operation the implementation
does not perform, for the reason under "Why an update colors the whole
document"; and the 500-line owned-source maximum, which it exceeds by 84.

## Environment and method

The probe ran on a MacBook Pro identified as `Mac17,6`, with an Apple M5 Max,
18 cores and 128 GB of memory. It ran arm64 macOS with Deno 2.9.4, V8
15.0.245.2-rusty, and TypeScript 6.0.3. It used `web-tree-sitter` 0.26.12 and
the official `tree-sitter-python` 0.25.0 package. The dependency cache was
warm.

The adjacent retained
[probe](cf-view-python-treesitter-2026-09-probe.ts) performs the timing work.
It runs from `packages/cli`, where those two packages are declared:

```sh
cd packages/cli
deno run --allow-read --allow-env --allow-run \
  ../../docs/history/packages/cli/cf-view-python-treesitter-2026-09-probe.ts
```

The source, the same-length middle edit, and the sample counts are those of the
[August 2026 operating-envelope report](cf-view-tree-sitter-operating-envelope-2026-08.md),
so the two runs compare directly. The Python source contained 100,009 UTF-8
bytes, included non-ASCII text before the edit, and had no final newline.

Each initialization sample came from a fresh Deno process. The clock began at
the first statement. The measured path imported the Python language module,
loaded the Tree-sitter runtime and the Python grammar through the language's
own preparation call, and colored an empty source. Deno process startup was
outside the clock.

Full highlighting called the language's `highlightLines`, which parses, runs
the highlight query, resolves overlapping captures into one class per
character, and splits the result into the pager's line topology. Document
parsing called `parseDocument`, which is that work plus the structure tree and
the definition index, and is what opening a file and every deferred re-parse
run. Editing called the language's incremental highlighter with the edited
source, which edits the warm tree, re-parses from it, and colors the document
from that parse; each sample's lines were checked against the edited source.
Each operation ran once before its measured samples, and each editing sample
used a fresh highlighter, with the first discarded.

The run collected 40 fresh-process initialization samples and 50 of each of the
other three. No deadline, retry, or sleep participated. The adjacent raw
[results](cf-view-python-treesitter-2026-09-results.json) contain every sample.

## Timing results

| Operation | Median | 95th percentile | Accepted maximum |
| --- | ---: | ---: | ---: |
| Lazy selected-language initialization | 28.54 ms | 29.41 ms | 75 ms |
| Complete highlight of 100,009 bytes | 24.99 ms | 27.89 ms | 50 ms |
| Complete document parse, with structure | 33.19 ms | 35.56 ms | none recorded |
| Re-color after one edit | 13.93 ms | 15.07 ms | 5 ms, for a different operation |

Initialization and complete highlighting are inside their maximums.
Initialization is faster than the August probe's 40.36 ms at the 95th
percentile, which is consistent with the shipped path loading one grammar
rather than that probe's dynamic import of a separate module; this comparison
is between two different programs, so it measures the pair rather than a change
in Tree-sitter.

Document parsing had no recorded maximum, and it is the operation the pager
runs when a file opens and when typing pauses. It costs 7.67 ms more than
complete highlighting at the 95th percentile, which is the structure walk.

## Why an update colors the whole document

The 5 ms maximum was recorded for an "incremental edit and changed-line
highlight": edit the warm tree, re-parse from it, and re-run the highlight
query over the lines `Tree.getChangedRanges` reports. The shipped
implementation edits and re-parses the same way, and then colors the whole
document rather than those lines.

The reason is that the report does not bound which lines' colors changed. It
describes where the tree's shape differs, while a highlight query reads the
tree's shape *around* a node to decide that node's class. A node that keeps its
own type while its parent changes is not in the report, and its class changes
anyway. A single line break, inserted in a file of 15 lines, moved a name into
call position:

```python
    store = Sto
re()
```

Splitting `Sto` from `re()` makes `re` the function of a call rather than a
bare identifier, and `getChangedRanges` returned no ranges for that edit. An
implementation that trusted it drew `re` with the class it had before, and kept
drawing it that way until the next keystroke on that line or the pager's
150-millisecond deferred re-parse, whichever came first. A sweep of every
single-character insertion and deletion at every offset of a 15-line Python
sample, comparing each update against a complete highlight of the same text,
found 47 such disagreements; coloring the whole document takes that to none.

The incremental parse is still worth its complexity: at 100 kilobytes a fresh
parse took 11.07 ms at the 95th percentile and an incremental one 0.76 ms, so
the re-parse contributes under a millisecond of the 15.07 ms an update costs.
The rest is the highlight query, which was 11.21 ms, and the spans built from
it.

One disagreement remains, and it is the parser's rather than the adapter's. On
source carrying several layers of error recovery — a fuzz of twelve random
edits, including stray quote characters, starting from the same sample — one
run in about 1,500 produced an incremental tree that differed from a fresh
parse of the same text. Incremental and fresh parses agree on well-formed
source and on source with a single incomplete construct; they can differ once
error recovery nests. The pager's deferred re-parse is a fresh parse, so the
difference lasts at most until typing pauses, and the text drawn is unaffected
either way.

## Dependency and binary size

The complete npm package contents occupied 12,536,740 bytes, counted by summing
every file under the cached `web-tree-sitter`, `tree-sitter-python`,
`node-addon-api`, and `node-gyp-build` package directories. That is 11.95 MiB,
inside the 14 MiB maximum, and equals the August count exactly: the shipped
change adds no package the measurement did not already carry.

The compiled measurement built `dist/cf` twice with `deno task build-binaries
cf`: once from this change, and once from a worktree of its merge base. The
binary grew from 742,159,986 bytes to 754,775,154 bytes. The 12,615,168-byte
increase is 12.03 MiB, inside the 14 MiB maximum. Nothing about the build
changed to produce it: the task compiled the binary with no parser-specific
step, and running that binary against a `.py` file colored it, so the grammar
the adapter reads at run time is inside the compiled package. Parser-specific
build and deployment steps therefore remain at zero, which is the maximum.

## Owned source

| File | Physical lines |
| --- | ---: |
| `packages/cli/lib/view/languages/treesitter/adapter.ts` | 457 |
| `packages/cli/lib/view/languages/python/python.ts` | 127 |
| Total | 584 |

The accepted maximum for the common adapter and the first language's loader
together is 500 lines, so this exceeds it by 84. Under the plan's own rule that
overrun starts a measured comparison against a focused implementation. The
comparison is recorded in the plan beside the parser decision it belongs to.

The count is of physical lines, as the August report's was. The
`packages/cli/lib/view/languages/python/language.ts` descriptor is not counted:
it is the language's registration in the pager, which every language has and
which the focused implementation had as well.

## The focused Python scanner, measured

The implementation this replaced is the 863-line Python scanner at the change's
merge base. Restoring that file beside the new one and driving both over the
same 100-kilobyte source and middle edit gave:

| Operation | Scanner median | Scanner 95th | Tree-sitter median | Tree-sitter 95th |
| --- | ---: | ---: | ---: | ---: |
| Complete highlight | 4.12 ms | 5.87 ms | 23.44 ms | 25.19 ms |
| Re-color after one edit | 4.46 ms | 7.26 ms | 14.43 ms | 17.44 ms |

(These four figures come from a separate paired run, so they do not match the
table above sample for sample.)

The scanner is the faster colorer, by about four times on a complete highlight.
It produced no structure tree and no definition index, so the pager's outline,
definition peeks and diff-hunk ownership were empty for Python; it covered one
language in 863 lines where the Python-specific part of the new implementation
is 127; and the plan's later stages need three more languages.
