---
status: historical
created: 2026-11-13
archived: 2026-11-13
reason: "Point-in-time measurements of the shipped cf view C, C++, CUDA, and header paths, and of their coverage of the organization's C-family files."
---

# `cf view` C, C++, CUDA, and headers: shipped measurements

This report records what the `cf view` C-family languages cost, measured
against the operating maximums in the
[`cf view` language coverage plan](../../../plans/cf-view-language-coverage.md),
and how well they cover the C-family files in the organization's repositories.
C runs on the shared Tree-sitter adapter with the official `tree-sitter-c`
0.23.6 grammar. C++, CUDA, and headers whose dialect is not known run on it
with the official `tree-sitter-cpp` 0.23.4 grammar.

The timings below were taken on a machine whose other work had fallen to
one-minute load averages of 60 and then 20, on 18 cores, where
the TOML control ran at 0.8 to 1.5 times its recorded figures. The complete
highlight is inside its maximum for both languages, and so are C's
initialization and document parse. C++ is over two maximums and at a third.
Its initialization measured 73 and 86 ms at the 95th percentile in two rounds,
against 75, and an estimated 84.7 ms scaled against the TOML control; in the
same session its median was 83 ms, 4 percent longer than Swift's. Its re-color
after one edit measured 28 and 34 ms at the 95th percentile, against 25, and
an estimated 22.5 ms. Its document parse measured 60 and 49 ms at the 95th
percentile, against 50, and an estimated 38.5 ms. C's re-color measured 25 and
26 ms at the 95th percentile, against 25, and an estimated 19.8 ms, in rounds
whose TOML control re-colored 1.2 to 1.8 times as slowly as recorded. The
compiled binary and the build steps are inside their maximums. The two grammar
packages are over the unpacked-dependency maximum, as shell's was, and the
owned source is over its maximum even for two grammars. The plan records the
comparisons these overruns start.

## Environment and method

The measurements ran on a MacBook Pro identified as `Mac17,6`, with an Apple M5
Max, 18 cores and 128 GB of memory, running arm64 macOS 26.6.2 with Deno 2.9.8,
V8 15.0.245.2-rusty, and TypeScript 6.0.3. They used `web-tree-sitter`
0.26.12, `tree-sitter-c` 0.23.6, and `tree-sitter-cpp` 0.23.4. The dependency
cache was warm.

The adjacent retained [probe](cf-view-c-family-2026-11-probe.ts) is the
[October 2026 HCL probe](cf-view-hcl-2026-10-probe.ts) with a C and a C++
source unit in place of the HCL one, keeping the TOML unit as a control. It
runs from `runtime/cli`:

```sh
cd runtime/cli
deno run --allow-read --allow-env --allow-run \
  ../../docs/history/packages/cli/cf-view-c-family-2026-11-probe.ts cpp
```

Each source repeats a unit after one line of non-ASCII comment, to exactly
100,009 UTF-8 bytes. The C unit is a five-line function with a numbered name.
It holds a condition over a structure's fields, a `for` loop with a cast, a
`sizeof`, a conditional expression, and a trailing comment. The C++ unit is a
seven-line class with a numbered name, a base class, an access specifier, and
an overriding method that takes a reference, loops over a structured binding,
calls a cast, and returns a call through a namespace. The edit renames the
first `render_item` or `RenderItem` after the middle of the source to
`render_unit` or `RenderUnit`. Sample counts and the operations timed are the
HCL probe's: 40 fresh-process initialization samples, and 50 each of a complete
highlight, a document parse with structure, and a re-color after one edit. No
deadline, retry, or sleep participated.

The probe also records, for each sample, the processor time the process spent on
it, which is new in this probe, for comparing runs on a loaded machine; the
results keep it beside the elapsed times. CUDA and headers use the C++
language's grammar and query, so the C++ figures are theirs too.

## Timings

Each round ran the TOML probe, then the C++ probe, then the C probe, then the
TOML probe again. The adjacent raw [results](cf-view-c-family-2026-11-results.json)
contain every sample of every run. Each cell gives the elapsed median, then the
95th percentile, in milliseconds:

| Round | Language | Lazy initialization | Full highlighting | Document parse | Re-color after one edit |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | TOML | 25 / 32 | 24 / 40 | 37 / 43 | 16 / 21 |
| 1 | C++ | 79 / 86 | 41 / 47 | 49 / 60 | 28 / 34 |
| 1 | C | 33 / 36 | 38 / 41 | 37 / 46 | 22 / 25 |
| 1 | TOML | 19 / 26 | 20 / 23 | 30 / 32 | 12 / 17 |
| 2 | TOML | 19 / 21 | 19 / 22 | 29 / 31 | 12 / 14 |
| 2 | C++ | 69 / 73 | 36 / 40 | 40 / 49 | 25 / 28 |
| 2 | C | 32 / 37 | 34 / 37 | 36 / 38 | 22 / 26 |
| 2 | TOML | 19 / 22 | 21 / 24 | 32 / 38 | 14 / 18 |
| Recorded TOML | | 22.55 / 23.42 | 17.49 / 19.79 | 26.97 / 29.61 | 10.89 / 11.96 |
| Accepted maximum | | 75 | 50 | 50 | 25 |

The load was still falling during the first round, whose first TOML run is
slower than the rest. In the second round, the TOML medians were 0.84 to 1.29
times the medians the
[September 2026 Android formats report](cf-view-android-formats-2026-09.md)
recorded. Over that round, the ratio of the C++ median to the mean of the two
TOML medians around it is 3.61 for initialization, 1.78 for the complete
highlight, 1.30 for the document parse, and 1.88 for the re-color; for C it is
1.68, 1.73, 1.16, and 1.66. Multiplying the TOML 95th percentiles that report
recorded by those ratios, as the
[October 2026 HCL report](cf-view-hcl-2026-10.md) did, gives an estimate for
the recorded conditions: 84.7 ms for C++'s initialization, 35.3 for its
complete highlight, 38.5 for its document parse, and 22.5 for its re-color, and
39.3, 34.2, 34.3, and 19.8 ms for C's. This assumes the C-family languages and
TOML vary alike between conditions.

Initialization has the widest spread between methods. The adjacent retained
[startup script](cf-view-c-family-2026-11-startup.ts) measured ten fresh
processes for each Tree-sitter language whose initialization an earlier report
recorded, apart from shell, interleaved with C and C++, just before the rounds
above, and its
samples are in the results under `startupCalibration`:

| Language | Elapsed median | Elapsed 95th percentile | Recorded 95th percentile |
| --- | ---: | ---: | ---: |
| TOML | 23.6 | 57.4 | 23.42 |
| HCL | 23.2 | 42.1 | 26.1, estimated |
| Python | 28.3 | 40.7 | 29.41 |
| C | 42.8 | 56.1 | |
| Kotlin | 56.8 | 66.2 | 65.31 |
| C++ | 83.0 | 115.5 | |
| Swift | 79.9 | 120.8 | 71.98 |

C++ initializes 4 percent more slowly than Swift in the same session, and
Swift's own median there is above the 95th percentile its report recorded, so
these conditions are slower than Swift's were. Interpolating C++'s processor
time between Kotlin's and Swift's recorded figures, as earlier rounds on a
loaded machine did, gives 71 ms. The estimates from these methods run from 71
to 85 ms, the direct measurements from 73 to 86 ms at the 95th percentile, and
this calibration's from 83 ms at the median to 116 ms at the 95th percentile,
against a 75 ms maximum, so C++ initializes over its maximum.

A third round on the final code, at load averages between 12 and 18, with TOML
medians 1.01 to 1.43 times the recorded ones, gives ratios of 3.35, 2.01, 1.49,
and 2.13 for C++ and 1.83, 1.77, 1.25, and 1.82 for C. They put C++'s
initialization at an estimated 78.5 ms, its complete highlight at 39.8, its
document parse at 44.1, and its re-color at 25.4, and C's at 42.9, 35.0, 37.0,
and 21.8. Its samples are in the results under `finalCodeRound`, and its
coverage check gave the figures under "Coverage" below.

Four earlier sets of rounds, taken on a heavily loaded machine on forms of the
languages that review then changed, estimated these figures from processor
time; they put C++'s initialization at 69 to 72 ms, its re-color at 20.9 to
24.4 ms, and its document parse at 31.7 to 45.2 ms. Their samples are not
retained.

## Size, source, and build

| Dimension | C and C++ together | Accepted maximum |
| --- | ---: | ---: |
| Compiled `cf` increase | 4.03 MiB | 10 MiB for a later grammar |
| Unpacked dependencies | 48.98 MiB | 10 MiB for a later grammar |
| Owned source | 532 lines | 200 lines for each later grammar |
| Parser-specific build and deployment steps | 0 | 0 |

Built with `deno task build-binaries cf`, the binary was 187,640,930 bytes at
the merge base and 191,868,002 bytes with the C-family languages, an increase of
4,227,072 bytes, about the size of the two WebAssembly grammars. The build
leaves out the packages' generated C source and native builds, as it does for
every grammar. The binary built with the C-family languages colored a `.c` and a
`.cu` file. It was built before review changed the languages' queries and
structure rules, which are a few kilobytes of source text. The structure rule
changed after the two rounds below, to find each of a declaration's names in
constant time and to keep a field's default value out of its names; a third
round on the final code is reported after them.

The unpacked figure is the sum of every file in the two cached package
directories: 8,967,502 bytes for `tree-sitter-c` and 42,392,814 bytes for
`tree-sitter-cpp`. Their WebAssembly grammars are 620,090 and 3,434,931 bytes;
the rest is generated C source, native builds, and bindings that the pager never
reads. `tree-sitter-cpp` depends on `tree-sitter-c` through the range `^0.23.1`,
and the CLI pins `tree-sitter-c` at 0.23.6 inside it, so the lockfile resolves
one copy of it. A probe that is not retained found that the newer
`tree-sitter-c` 0.24.1 left the same 60 lines of the surveyed C files unparsed
as 0.23.6 does. The two packages are over the
unpacked maximum for a later grammar, as shell's was, for the same reason.

Owned source is `runtime/cli/lib/view/languages/c-family/c-family.ts`, which
holds both grammars' highlight queries and their shared structure rule; the
language descriptors beside it are not counted, as those of the earlier
grammars were not. Its 532 lines serve two grammars, the C grammar and the C++
grammar, and are over the maximum even counted as two later grammars of 200
lines each; 159 of them are the two highlight queries. The adapter is
unchanged.

## Highlight query cost

Compiling a highlight query costs the C++ grammar far more than it costs the
others, as the [September 2026 Swift report](cf-view-swift-treesitter-2026-09.md)
found for Swift. The query's patterns are compiled each time a process loads
the grammar, so this cost is part of initialization. Measured as processor
time, the minimum of five compilations in one process, the first form of the C++
query, with 74 patterns, took 66 to 76 ms. The same 33 patterns that match a
node without reference to its parent took 9 ms on their own. A pattern that
constrains a node's parent cost little when compiled alone, but such patterns
cost more together than apart, and those whose parent was a qualified name
cost the most.

The shipped query shares parents and alternatives among its patterns. One
pattern with a wildcard parent colors any name a declarator binds, behind any
number of pointers and arrays, in place of three patterns for each of two
parents. One more colors the name of every named type that has a body. The
adjacent retained [query script](cf-view-c-family-2026-11-query.ts) measures
every shipped grammar's query on the same measure in one run, and its figures
are in the results under `queryCompileCpuMilliseconds`: the shipped C++ query
compiles in 37.0 ms of processor time, the C query on the C grammar in 6.8,
and the queries of the shipped Python, Kotlin, and Swift grammars in 3.8, 18.4,
and 27.6. Python, Kotlin, and Swift initialize in 29.41, 65.31, and 71.98 ms at
the 95th percentile in their reports, so query compilation is one of the costs
that separate them, and it is the main part of the difference between C and
C++. The shipped query colors a defined or called name qualified by one or two
scopes, such as `std::chrono::now`; one qualified by three or more is an
identifier, because each further level is another such pattern.

## Coverage

The adjacent retained [coverage check](cf-view-c-family-2026-11-coverage.ts)
read every C-family file in the local checkouts of the organization's
repositories: gVisor's `cfc_v2` branch at its `dc7baff` commit, and Labs,
Loom, Infra, and the `commonfabric-weaver` repository at the commits checked
out on November 13, 2026. It ran once, over a directory holding a copy of each
repository's C-family files under the repository's name.

```sh
cd runtime/cli
deno run --allow-read --allow-env \
  ../../docs/history/packages/cli/cf-view-c-family-2026-11-coverage.ts DIR
```

| Language | Files | Lines | Files with an unparsed region | Unparsed lines | Structure entries |
| --- | ---: | ---: | ---: | ---: | ---: |
| C | 26 | 3,233 | 11 | 60 (1.86%) | 256 |
| C++ | 353 | 131,301 | 50 | 576 (0.44%) | 7,177 |
| CUDA | 4 | 542 | 2 | 8 (1.48%) | 12 |
| Header | 86 | 8,312 | 8 | 21 (0.25%) | 1,765 |

Every file reconstructed exactly from its colored spans. The figures are in the
results under `coverage`. Of the 4,087,256 characters other than white space,
0.22 percent have no token class: 2.14 percent in headers, 0.63 in C, 0.09 in
C++, and none in CUDA. Almost all of
them are in macro bodies, which both grammars leave as one unparsed token.

The unparsed regions are mostly at macros that a compiler expands and a grammar
cannot: eBPF programs' `section("maps")` annotations, register variables bound
to a named register with `asm("x1")`, variadic macro parameters named as in
`x...`, and classes declared through annotation macros such as
`class ABSL_MUST_USE_RESULT PosixError`, which the structure tree then lists as
a variable without its members. In CUDA, the grammar reads a kernel
launch's `<<<` and `>>>` as shift operators around a region it could not
parse, which is all 8 CUDA lines. The CUDA grammar would parse them, but it
ships its WebAssembly build only as a release asset, of 6.73 MiB.

The coverage check also parses each file with the other C-family grammar, and
reports the lines it leaves unparsed as `otherGrammarErrorLines`. For the header
mode, the same 86 headers parsed with the C grammar leave 1,689 lines, 20.32
percent, unparsed, because 74 of the headers are C++. Parsed with the C++
grammar, the 26 C files leave 33 lines unparsed, fewer than the C grammar's 60.
The C grammar stays for C because the C++ grammar cannot parse C that uses a C++
keyword as a name, as in `int template = 1;`, `this->next`, or `int private =
2;`, although none of the surveyed C files does, and because it initializes in
about half the time, as the timings above show.