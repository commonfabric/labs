---
status: historical
created: 2026-11-13
archived: 2026-11-13
reason: "Point-in-time measurements of the shipped cf view CSS path, its coverage of the organization's CSS files, and a comparison with the Lezer CSS parser the UI package pins."
---

# `cf view` CSS: shipped measurements

This report records what the `cf view` CSS language costs, measured against
the operating maximums in the
[`cf view` language coverage plan](../../../plans/cf-view-language-coverage.md),
how well it covers the CSS files in the organization's repositories, and how
the Lezer CSS parser that the UI package pins compares. CSS runs on the shared
Tree-sitter adapter with the official grammar from `tree-sitter-css` 0.25.0. It
is held to the maximums for a later grammar.

CSS is inside the maximums for compiled bytes, unpacked bytes, owned source, and
build steps. The machine was so loaded that the TOML control's medians took 2 to
24 times their recorded figures, so the timings are estimates, scaled against
that control as the [October 2026 HCL report](cf-view-hcl-2026-10.md) scaled its
timings. Every estimate is inside its maximum, the re-color after one edit
closest at an estimated 19.6 ms against 25. "Timings" gives the figures measured
directly as well.

## Environment and method

The measurements ran on a MacBook Pro identified as `Mac17,6`, with an Apple M5
Max, 18 cores and 128 GB of memory, running arm64 macOS 26.6.2 with Deno 2.9.8,
V8 15.0.245.2-rusty, and TypeScript 6.0.3. They used `web-tree-sitter` 0.26.12
and `tree-sitter-css` 0.25.0. The dependency cache was warm.

The adjacent retained [probe](cf-view-css-2026-11-probe.ts) is derived from the
[October 2026 HCL probe](cf-view-hcl-2026-10-probe.ts). It has a CSS source unit
in place of HCL's, and it measures CSS and the TOML control in one run, in the
way described below. It runs from `runtime/cli`:

```sh
cd runtime/cli
deno run --allow-read --allow-env --allow-run \
  ../../docs/history/packages/cli/cf-view-css-2026-11-probe.ts css toml
```

The source repeats a unit after one line of non-ASCII comment, and ends with a
comment of filler, to exactly 100,009 UTF-8 bytes. The unit is a seven-line rule
set whose selector list holds a class, a child combinator, a pseudo-class, an
ID, and an attribute selector. The rule declares a numbered custom property and
uses it through `var()`, beside `calc()`, a color, and an unquoted `url()`. The
edit renames the first `render-item` after the middle of the source to
`render-unit`. The TOML control source is the HCL probe's, byte for byte.
Sample counts and the operations timed are the HCL probe's: 40 fresh-process
initialization samples, and 50 each of a complete highlight, a document parse
with structure, and a re-color after one edit, for each language. No deadline,
retry, or sleep participated.

The HCL probe measured one language in each process, and a round ran TOML,
then HCL, then TOML again. Eight rounds made that way on this machine, with
one-minute load averages between 127 and 270, gave ratios of a CSS median to
the TOML medians around it that ranged from 0.67 to 2.15 for a single
operation, and their samples are not retained. This probe instead takes each
sample of CSS and then of TOML in turn: the two alternate in one process for
the complete highlight, the document parse, and the re-color, and alternate
fresh processes for initialization. The two languages then share the load of
each moment. The adjacent raw [results](cf-view-css-2026-11-results.json)
contain every sample of every round, the output of the coverage check and the
Lezer comparison below, and the counts of changes to CSS paths.

## Timings

Other work shared the machine throughout. Each cell gives the median, then the
95th percentile, in milliseconds; the maximums are 95th percentiles. The load
column is the one-minute load average at the start of the round.

| Round | Load | Lazy initialization | Full highlighting | Document parse | Re-color after one edit |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 103 | 321.47 / 607.23 | 385.75 / 616.71 | 402.28 / 603.97 | 262.24 / 553.21 |
| 2 | 110 | 389.07 / 633.72 | 308.66 / 502.25 | 305.03 / 549.85 | 246.53 / 402.63 |
| 3 | 124 | 249.65 / 501.24 | 476.50 / 720.94 | 538.31 / 804.84 | 283.60 / 507.97 |
| 4 | 125 | 205.79 / 773.66 | 210.37 / 450.30 | 238.91 / 564.36 | 224.60 / 419.27 |
| 5 | 131 | 97.11 / 580.61 | 461.38 / 744.27 | 380.43 / 611.22 | 123.04 / 327.80 |
| 6 | 99 | 52.96 / 312.53 | 98.49 / 275.31 | 91.56 / 161.40 | 91.72 / 284.88 |
| Accepted maximum | | 75 | 50 | 50 | 25 |

The TOML control, measured beside CSS in each round, gave these figures:

| Round | Lazy initialization | Full highlighting | Document parse | Re-color after one edit |
| --- | ---: | ---: | ---: | ---: |
| 1 | 353.38 / 570.95 | 280.44 / 615.74 | 525.56 / 776.28 | 187.17 / 427.31 |
| 2 | 233.16 / 656.60 | 216.00 / 499.38 | 362.94 / 570.85 | 230.79 / 404.23 |
| 3 | 123.36 / 355.25 | 338.89 / 594.84 | 642.95 / 972.40 | 239.37 / 435.45 |
| 4 | 182.22 / 473.63 | 184.07 / 315.01 | 270.10 / 658.63 | 159.49 / 386.98 |
| 5 | 64.13 / 373.04 | 359.57 / 528.51 | 426.17 / 698.70 | 132.60 / 290.48 |
| 6 | 46.69 / 198.93 | 56.88 / 242.59 | 125.78 / 185.74 | 55.88 / 157.16 |
| Recorded in the Android formats report | 22.55 / 23.42 | 17.49 / 19.79 | 26.97 / 29.61 | 10.89 / 11.96 |

The HCL report left out the rounds whose controls were furthest from the
recorded figures. Here every round's control was far from them, so all six
rounds are kept. Over the six rounds, the ratio
of the CSS median to the TOML median ranges from 0.91 to 2.02 for
initialization, 1.14 to 1.73 for the complete highlight, 0.73 to 0.89 for the
document parse, and 0.93 to 1.64 for the re-color. Multiplying the TOML 95th
percentiles the Android formats report recorded by the largest of those ratios
gives an estimate for an unloaded machine: 47.4 ms for initialization, 34.3 ms
for the complete highlight, 26.4 ms for the document parse, and 19.6 ms for the
re-color. This is an inference from the control. It assumes that CSS and TOML
slow down alike under load, and that TOML's figures are not changed by sharing
a process with CSS, which they did not when the Android formats report recorded
them. At loads this high, those assumptions carry more weight than they did for
HCL. Each estimate is inside its maximum.

## Size, source, and build

| Dimension | CSS | Accepted maximum |
| --- | ---: | ---: |
| Compiled `cf` increase | 0.19 MiB | 10 MiB for a later grammar |
| Unpacked dependencies | 1.88 MiB | 10 MiB for a later grammar |
| Owned source | 186 lines | 200 lines for a later grammar |
| Parser-specific build and deployment steps | 0 | 0 |

Built with `deno task build-binaries cf`, the binary was 187,574,882 bytes at
the merge base and 187,773,026 bytes with CSS, an increase of 198,144 bytes. The
build leaves out the package's generated C source and native builds, as it does
for every grammar. The binary built with CSS colored a `.css` file. It was built
before the review changes to `css.ts`, which made that file 1,360 bytes longer.

The unpacked figure is the sum of every file in the cached package directory,
1,970,877 bytes, of which the WebAssembly grammar is 128,668. The package's two
dependencies are the ones `tree-sitter-python` already brings. Owned source is
`runtime/cli/lib/view/languages/css/css.ts`; the language descriptor beside it
is not counted, as those of the earlier grammars were not. The adapter is
unchanged.

## Coverage

The adjacent retained [coverage check](cf-view-css-2026-11-coverage.ts) read
every file that `cf view` selects as CSS in the local checkouts of the
organization's repositories, from each repository's default branch as it stood
on November 13, 2026:

```sh
cd runtime/cli
deno run --allow-read --allow-env --allow-run=git \
  ../../docs/history/packages/cli/cf-view-css-2026-11-coverage.ts \
  DIR:COMMIT...
```

| Repository | Commit | Files |
| --- | --- | ---: |
| `commonfabric-weaver` | `2c36770b9` | 64 |
| `common-tools-website` | `69b40c9` | 1 |
| `commonfabric-website` | `570699a` | 3 |
| `dynabook` | `b8f03d7` | 83 |
| `labs` | `9e66fbf2d9` | 5 |
| `loom` | `3f94e7c902` | 5 |
| `pond` | `b812bb0` | 1 |
| `specs` | `c313c1e5` | 49 |
| `wants-sim` | `565cf27` | 2 |
| `web-weaver` | `9093869` | 64 |

Of the 277 files, 241 are build output or copies: the Loom style system's built
themes in Dynabook's `loom-style/dist`, the copies of them in the two Weaver
repositories, 45 files in a Specs directory named for generated prompts, and a
website's built bundle. The other 36 are in 9 repositories; the one in Web
Weaver that is not a copy is its `public/styles.css`.

For the six months from May 13 to November 13, 2026, `git log --name-only` on
the same branches lists 1,641 changes to paths ending in `.css`, in 11
repositories; Fabric Mobile holds no CSS file now, but 2 of the changes were in
it. 501 of the changes are to build output and copies, and 1,140 to the other
paths. 823 of those are to Loom's web UI style sheet: 744 at
`.ops/services/local-loom-ui/app.css`, where it was before Loom moved its source
tree to `src`, and 79 at `src/services/local-loom-ui/app.css`. The raw results
give the counts for each repository, and for each of Loom's paths.

Every file reconstructed exactly from its colored spans. Of the 14,300,560
characters other than white space, 0.005 percent have no token class, and none
of those is on a line outside the regions the grammar could not parse. Strings
take 64.27 percent of the characters, most of them inline SVG images in the
built themes' `data:` URLs. Property names take 10.78 percent, comments 4.39
percent, and numbers 3.99 percent.

The grammar could not parse part of 10 files, covering 32 of the 147,390 lines.
It does not parse:

- a container style query, such as `@container style(--x: y)`, which accounts
  for 30 of the lines, in Dynabook's Loom style system sources, tools, and test
  fixtures, its built press style sheet and the Weaver's copy of it, and Loom's
  copy of the style system's `warp.css`;
- a fragment in a URL, as in `marker-end: url(#arrow)`, in one Specs file;
- a custom property whose value is empty, as in `--lightningcss-light: ;`, in
  one website bundle.

Coloring continues around each region. A container query whose condition names
a size feature with a colon, such as `@container card (min-width: 40em)`,
parses.

The structure walk visits only the node types a structure entry can be found
inside, as HCL's does. A walk restricted that way listed the same entries as an
unrestricted one after each of the 7,695 and 15,745 single-character insertions
of `(`, `{`, `"`, `}`, and `;` at every offset of the two fixtures' earlier
sources. The coverage check makes that comparison when given `--edits` and a
file.

Four more limits of the grammar were found by trying constructs the files might
hold. No surveyed file holds any of them: each would leave an error region, or
for the second a line comment, and the coverage check counts none beyond those
listed above.

- A comparison in a media or container condition, as in
  `@media (width >= 600px)`, `@container sidebar (width > 400px)`, or
  `@media (400px <= width <= 700px)`, is not parsed. In the last form the
  structure tree lists no `@media` entry, and lists its rule sets at the top
  level.
- The grammar reads `//` and the rest of its line as a comment, which a browser
  does not, so the language leaves that text uncolored. A closing brace later on
  the line is read as part of it, and the rule sets after it list inside the
  rule set the brace closed.
- A selector holding a character above U+00FF, such as `.名前`, leaves its whole
  rule set unparsed.
- An `@import` with a `layer()` or `supports()` condition, such as
  `@import "a.css" layer(base) supports(display: grid)`, is misread, and can
  color the `or` in `supports` as a keyword.

## Comparison with Lezer CSS

The UI package's CSS parser is Lezer's, through `@codemirror/lang-css`, which
the lock file resolves to `@lezer/css` 1.3.0, with `@lezer/lr` 1.4.3,
`@lezer/highlight` 1.2.3, and `@lezer/common` 1.5.2. The adjacent retained
[comparison](cf-view-css-2026-11-lezer.ts) parses the probe's source with each
parser in alternation in one process, times each parser's load and an empty
parse in fresh processes, and counts the lines each cannot parse in the same
277 files. It reads a copy of the lock file, so the Lezer packages resolve to
those versions:

```sh
cd runtime/cli
export LEZER_LOCK="$TMPDIR/lezer.lock"
cp ../../deno.lock "$LEZER_LOCK"
deno run --lock="$LEZER_LOCK" --allow-read --allow-env --allow-run \
  ../../docs/history/packages/cli/cf-view-css-2026-11-lezer.ts DIR:COMMIT...
```

It ran on the same loaded machine as the timings above, without a control, so
only the ratios between its two columns carry meaning. Each cell gives the
median, then the 95th percentile, in milliseconds.

| Measure | Lezer CSS | Tree-sitter CSS |
| --- | ---: | ---: |
| Load and parse an empty source | 22.96 / 77.28 | 57.90 / 181.03 |
| Parse the 100,009-byte source | 97.23 / 294.37 | 36.01 / 248.73 |
| Files with a region it cannot parse | 2 | 10 |
| Lines in such regions | 10 | 32 |
| Unpacked packages | 0.57 MiB | 1.88 MiB |

The two line counts are not measured alike. For Tree-sitter, a region is an
error node or the innermost node holding an error, which can be a whole rule
set; for Lezer, it is an error node, which is often one token or empty. Lezer's
count is therefore the narrower of the two. Both parse figures are a parse
alone, with no coloring or structure walk. The Lezer packages' unpacked figure
is the four packages, 595,068 bytes; the Tree-sitter runtime is not counted,
since the pager already ships it.

Lezer parses container style queries. It reads an ID selector whose name starts
with letters that are hexadecimal digits, such as `#fabricSectionHeader` or
`#addEventOverlay`, as a color, and fails there; those are all 10 of its lines,
9 in Loom's web UI style sheet and 1 in Pond's.

On these figures Lezer is ahead in loading, in unpacked bytes, and in lines it
can parse, and Tree-sitter parses faster, though that measure was taken without
a control. Neither is ahead in every dimension. What decides the choice is what
the table leaves out: using Lezer would put a second parser runtime in the
pager, with an adapter of its own for coloring, editing, and structure, beside
the shared Tree-sitter adapter that every other parser-backed language uses. The
parser decision in the plan rules that out, so CSS uses Tree-sitter.
