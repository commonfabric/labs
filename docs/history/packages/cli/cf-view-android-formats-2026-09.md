---
status: historical
created: 2026-09-25
archived: 2026-09-25
reason: "Point-in-time measurements of the shipped cf view Kotlin, TOML, Java properties, ProGuard, and XML paths."
---

# `cf view` Android formats: shipped measurements

This report records what the `cf view` support for the Android port's file
formats costs, measured against the operating maximums in the
[`cf view` language coverage plan](../../../plans/cf-view-language-coverage.md),
and how well it covers the files in the organization's repositories. Kotlin
and TOML run on the shared Tree-sitter adapter. Java properties files,
ProGuard rules, and XML use focused scanners.

TOML is inside every recorded maximum. Kotlin is inside the maximums for
initialization, complete highlighting, compiled and unpacked bytes, owned
source, and build steps. On the probe's synthetic source it is over the
25-millisecond maximum for re-coloring after an edit in both measurement
rounds, and over the 50-millisecond maximum for a document parse in one of
them, at 54.36 ms. On 100 kilobytes of the Weaver app's own Kotlin it is inside
both. "Re-coloring after an edit" gives the causes and the comparison the plan
asks for when a maximum is exceeded.

## Environment and method

The measurements ran on the machine the
[September 2026 Swift measurement](cf-view-swift-treesitter-2026-09.md) used: a
MacBook Pro identified as `Mac17,6`, with an Apple M5 Max, 18 cores and 128 GB
of memory, running arm64 macOS 26.6.2 with Deno 2.9.4, V8 15.0.245.2-rusty,
and TypeScript 6.0.3. They used `web-tree-sitter` 0.26.12,
`@binclusive/tree-sitter-kotlin-wasm` 0.1.0, and
`@tree-sitter-grammars/tree-sitter-toml` 0.7.0. The dependency cache was warm.

Other work shared the machine throughout, with a one-minute load average
between 6 and 11 during the recorded runs. Each round therefore ran the Swift
probe beside the new ones, so that the shipped Swift path's recorded figures
calibrate the round: in both rounds Swift's median re-color and document parse
were within 2.4 ms of the Swift report, and its 95th percentiles within 8.6 ms.

The adjacent retained [probe](cf-view-android-formats-2026-09-probe.ts) is the
Swift probe with a language argument and a source unit for each language, so
the runs compare directly. It runs from `packages/cli`:

```sh
cd packages/cli
deno run --allow-read --allow-env --allow-run \
  ../../docs/history/packages/cli/cf-view-android-formats-2026-09-probe.ts \
  kotlin
```

Each source repeats a unit after one line of non-ASCII comment, to exactly
100,009 UTF-8 bytes. The Kotlin unit is a seven-line annotated generic class
holding a suspending function whose body interpolates a safe call and an elvis
expression into a string. The TOML unit is a four-line version-catalog table
with an inline table and an array; each unit names its table by its position,
so that the source defines every table once. The edit renames the first `renderItem`
after the middle of the source to `renderUnit`. Sample counts and the
operations timed are the Swift probe's: 40 fresh-process initialization
samples, and 50 each of a complete highlight, a document parse with structure,
and a re-color after one edit. No deadline, retry, or sleep participated. The
adjacent raw [results](cf-view-android-formats-2026-09-results.json) contain
every sample, including the Swift runs made alongside.

## Results

Two rounds were run. Each cell gives the median, then the 95th percentile, in
milliseconds; the maximums are 95th percentiles.

| Dimension | Kotlin, round 1 | Kotlin, round 2 | TOML, round 1 | TOML, round 2 | Accepted maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| Lazy initialization | 62.80 / 65.31 | 53.97 / 59.24 | 22.55 / 23.42 | 22.08 / 23.29 | 75 ms |
| Full highlighting | 33.56 / 39.86 | 34.97 / 44.66 | 17.49 / 19.79 | 17.07 / 19.66 | 50 ms |
| Document parse, with structure | 45.52 / 49.89 | 47.24 / 54.36 | 26.97 / 29.61 | 26.33 / 28.56 | 50 ms |
| Re-color after one edit | 26.10 / 31.67 | 26.61 / 32.76 | 10.89 / 11.96 | 11.22 / 11.76 | 25 ms |

The TOML rounds were run separately, after each TOML unit was given its own
table name. The Swift runs beside the Kotlin rounds measured 14.57 / 17.65 and
14.28 / 16.09 ms for the re-color, against the 14.59 / 15.36 ms its report
recorded, and 38.25 / 41.98 and 39.64 / 47.66 ms for the document parse,
against 37.24 / 39.08 ms. Those beside the TOML rounds measured 14.34 / 15.70
and 14.11 / 14.91 ms for the re-color, and 38.66 / 41.53 and 37.26 / 40.26 ms
for the document parse.

| Dimension | Kotlin | TOML | Accepted maximum |
| --- | ---: | ---: | ---: |
| Compiled `cf` increase | 4.09 MiB for both | | 10 MiB for a later grammar |
| Unpacked dependencies | 3.30 MiB | 0.72 MiB | 10 MiB for a later grammar |
| Owned source | 200 lines | 75 lines | 200 lines for a later grammar |
| Parser-specific build and deployment steps | 0 | 0 | 0 |

The unpacked dependency figures are the sums of every file in each cached
package directory: 3,460,051 bytes for Kotlin and 757,538 bytes for TOML. The
Kotlin package has no dependencies of its own. The TOML package depends on
`node-addon-api` and `node-gyp-build`, which `tree-sitter-python` already
brings. The compiled figure comes from building `dist/cf` with
`deno task build-binaries cf` from this change and from a worktree of its merge
base: 175,732,338 bytes against 171,439,218, an increase of 4,293,120 bytes,
or 4.09 MiB, for both grammars and the three scanners together. The build ran
with no step of its own for either grammar, and the binary it produced colored
a `.kt`, a `.toml`, and an `.xml` file.

Owned source is `packages/cli/lib/view/languages/kotlin/kotlin.ts`, 200 lines,
and `packages/cli/lib/view/languages/toml/toml.ts`, 75 lines. The language
descriptors beside them are not counted, as Python's and Swift's were not. The
adapter lost the code that turns token classes into lines and structure entries
into positioned nodes, which moved to `languages/classes.ts` and
`languages/structure.ts` so that the scanners use it too, and gained the
handling of line breaks that a grammar misreads, described under "The Kotlin
grammar".

## The Kotlin grammar

Two Tree-sitter grammars for Kotlin exist.
[`fwcd/tree-sitter-kotlin`](https://github.com/fwcd/tree-sitter-kotlin) is the
older and more widely used; its npm package, `tree-sitter-kotlin` 0.3.8, ships
no WebAssembly build, and its last release, which attaches one, was in August
2024.
[`tree-sitter-grammars/tree-sitter-kotlin`](https://github.com/tree-sitter-grammars/tree-sitter-kotlin)
1.1.0 ships its WebAssembly build in its npm package, beside 22.7 MB of
generated C source, 21.0 MB of native bindings, a development tool as a
runtime dependency, and an install script: 47.2 MB unpacked, over the 10 MiB a
later grammar may add. `@binclusive/tree-sitter-kotlin-wasm` 0.1.0 holds only
that WebAssembly build. Its `wasm/tree-sitter-kotlin.wasm`, the file in the
upstream npm package, and the asset attached to the upstream 1.1.0 release all
have the SHA-256
`7009d69453bc8735e438b2818a633efb21c88f99782769abba60dffedfab73f7`. The package
is pinned exactly, and the lockfile's integrity hash holds the installed
package to the bytes that were compared.

Both grammars were run over the 453 Kotlin files in the Weaver app at commit
`e7da3241abad4f80e29037356f9a3e239c442481`, 64,934 lines. The table counts the
lines inside a region the parser could not parse.

| Grammar | Files with such a region | Lines in such regions |
| --- | ---: | ---: |
| `fwcd` 0.3.8 release asset | 69 | 4,037 (6.22 percent) |
| `tree-sitter-grammars` 1.1.0 | 54 | 9,600 (14.78 percent) |
| `tree-sitter-grammars` 1.1.0, with the line breaks below read as spaces | 21 | 1,442 (2.22 percent) |

Most of the second grammar's regions come from one construct. The grammar ends
a statement at a line break between a catch block and a `catch` or `finally`
clause after it. It then reads a `catch` as a name and cannot parse the
declaration holding it, which in the Weaver app is often the whole file; it
reads a `finally` as a call with a trailing lambda. The upstream repository's
open issue 6 reports the `catch` case, and the repository has had no commit
since January 2025. The `fwcd` grammar fails on the same construct but confines
the failure to the clause.

Kotlin ignores those line breaks. A grammar can therefore name the stretches of
source whose line breaks the language ignores, and the adapter gives the parser
each line break in such a stretch as a space, which keeps every offset, while
coloring and structure use the source as written. Kotlin names a `}` followed
by white space and then `catch` or `finally`, unless a line comment, which
starts at a `//` outside the line's strings, holds the `}`, because the line
break is what ends that comment. With that handling the
packaged grammar covers the Weaver app better than the `fwcd` grammar does, as
the table shows.

The coverage check colored every file through the shipped language. Every
file's highlighted lines reconstructed its source exactly. Of the characters
other than white space, 1.35 percent carried no token class, against 9.50
percent without the line-break handling. Semicolons, which the grammar consumes
without a node a query can name, are 2,081 of the 38,949 such characters; the
rest are inside the 21 files' unparsed regions. The constructs behind those
regions include a property whose setter follows it after a semicolon, as in
`var x by mutableStateOf(1); private set`, and names that are also soft
keywords, such as a function named `open`. Their causes were not otherwise
isolated.

The grammar reads `true`, `false`, `null`, `break`, `continue`, and the `class`
of a `::class` reference as plain names, so the highlight query names those
spellings. A pattern that tests a name's text costs as much as capturing every
name, because each match reaches JavaScript before its text is compared:
merging two such patterns into one took 3.7 ms off the query on the measured
source. The query therefore names all six in one pattern, which colors `true` and `false` as keywords rather than
as the boolean class Python and Swift give them.

## Re-coloring after an edit

Swift re-colors the probe's source in about 15 ms and Kotlin in about 26 ms,
though the two sources are similarly dense: 22,365 and 24,418 leaf tokens, and
27,335 and 29,470 highlight captures. Timing the parts of one Kotlin update
separately gave 5.7 ms for the incremental parse, 16.9 ms for the highlight
query and the classes its captures set, and 1.9 ms for building lines. Swift's
incremental parse of the same edit takes 0.2 ms, and its query 11.0 ms against
Kotlin's 14.4 ms.

The incremental parse is the grammar's. It took 5.8, 6.3, and 6.5 ms for an
edit at 5, 50, and 95 percent of the source, and the `fwcd` grammar took 4.7,
5.0, and 4.8 ms for the same edits, so neither grammar reuses its previous tree
as cheaply as Swift's does, wherever the edit falls. A full Kotlin parse of the
source takes about 15 ms.

The query cost is marshaling: each capture becomes a JavaScript object, at
about 0.5 microseconds each. Two changes in this work reduced the costs around
it: merging the patterns that test a name's text, described above, and
testing white space by character code when building lines, which took line
building from 1.86 to 0.84 ms on this source. Capturing the whole file once as
an identifier, in place of each name, would save about 2 ms more, but a name
inside a string interpolation would then take the string's class, so it was not
done.

The plan asks that a maximum exceeded start a measured comparison. The `fwcd`
grammar pays the same incremental parse, ships its WebAssembly build only as a
GitHub release asset, which the plan's decision against checking WebAssembly
builds into the repository rules out, and leaves more of the Weaver app unparsed once the line breaks above are handled.
No focused Kotlin scanner exists, and one would give up the structure tree
that the grammar provides.

The probe's source is also denser than real Kotlin. The Weaver app's cleanly
parsing Kotlin files, with their `package` and `import` lines removed and
concatenated to 99,978 bytes, hold 17,452 leaf tokens and 21,875 captures. With
31 in-process samples at a load average near 9, the shipped language colored
that source in 31.27 / 38.44 ms, parsed it with structure in 37.77 / 45.99 ms,
and re-colored it after an edit, which upper-cases one name after the middle, in
15.45 / 20.67 ms. Swift, measured the same way over 99,981 bytes of the Weaver
app's Swift, took 27.57 / 37.32, 35.36 / 52.88, and 12.51 / 17.43 ms.

## Java properties

The Tree-sitter properties grammar, `tree-sitter-properties` 0.3.0, ships its
WebAssembly build in its npm package. It lexes keys and values one character
at a time. On a 100-kilobyte properties file it took 29 ms to parse and 23 ms
to parse again after a one-word edit, and the language built on it re-colored
after an edit in 35.29 ms at the median and 39.16 ms at the 95th percentile,
over the 25 ms maximum. That run shared the machine with a load average of
about 6. The format is a line-oriented data format, for which the plan's parser
decision keeps focused scanners suitable, so the shipped language is a 142-line
scanner. On the same kind of source it highlights in 1.97 / 3.23 ms, parses with
structure in 2.47 / 4.29 ms, and re-colors after an edit in 2.23 / 3.71 ms, with
50 samples at a load average near 9.

## ProGuard rules and XML

No npm package carries a Tree-sitter grammar for ProGuard rules, or the
WebAssembly build of the official Tree-sitter XML grammar, which attaches that
build only to its GitHub releases. Both use focused scanners. On
100-kilobyte sources, measured as the properties scanner was, the ProGuard
scanner highlights in 1.96 / 3.31 ms, parses in 1.92 / 2.84 ms, and re-colors
in 1.99 / 3.23 ms, and the XML scanner, which also builds the tree of elements,
takes 1.58 / 2.85, 2.90 / 4.83, and 1.67 / 3.37 ms.

The XML scanner colored all 88 XML, SVG, property list, entitlement, and
privacy manifest files in the local checkouts of the organization's
repositories, 11,085,147 characters other than white space, and every file's
lines reconstructed its source. The 0.08 percent of those characters without a
token class is element content, which the scanner leaves plain. The TOML
grammar colored every character other than white space in the 14 TOML files
in those checkouts.
