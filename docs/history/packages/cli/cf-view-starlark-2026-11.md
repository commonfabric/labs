---
status: historical
created: 2026-11-13
archived: 2026-11-13
reason: "Point-in-time measurements of the shipped cf view Starlark and Bazel rc paths, and of their coverage of the gVisor repository's Bazel files."
---

# `cf view` Starlark and Bazel rc: shipped measurements

This report records what the `cf view` Starlark and Bazel rc languages cost,
measured against the operating maximums in the
[`cf view` language coverage plan](../../../plans/cf-view-language-coverage.md),
and how well they cover the Bazel files in the organization's repositories.
Starlark runs on the shared Tree-sitter adapter with the Python grammar from
`tree-sitter-python` 0.25.0, which the pager already ships. Bazel rc files use
a focused scanner.

Starlark adds no dependency, and is inside the maximums for compiled bytes,
unpacked bytes, owned source, and build steps. The timings were taken on a
machine so loaded that elapsed times were 5 to 43 times the TOML figures
recorded in the
[September 2026 Android formats report](cf-view-android-formats-2026-09.md),
and they varied too much between runs to scale. Processor times were steady.
Scaled against a TOML control run beside each round, they put every Starlark
timing inside its maximum, initialization closest at an estimated 50.8 ms
against 75. The Bazel rc scanner takes about a tenth of TOML's processor time.
"Timings" gives the figures and the method.

## The grammar

Starlark's syntax is a subset of Python's. The separately maintained
[`tree-sitter-grammars/tree-sitter-starlark`](https://github.com/tree-sitter-grammars/tree-sitter-starlark)
grammar is defined by extending the Python grammar, and its npm package,
`tree-sitter-starlark` 1.3.0, ships a 329,934-byte WebAssembly build. The
package is 5,555,460 bytes unpacked, and it declares `tree-sitter-python`
`^0.23.5` as a runtime dependency, which the CLI's exact pin of 0.25.0 does not
satisfy. Depending on it would therefore add a second copy of the Python
package, `tree-sitter-python` 0.23.6 at 7,440,137 bytes: 12,995,597 bytes, or
12.39 MiB, in all, over the 10 MiB maximum for a later grammar. The figures are
the `unpackedSize` values the npm registry records for the two versions.

The Python grammar parsed every Starlark file in the organization's
repositories without an error, as "Coverage" records, so Starlark uses it. It
adds no package. Starlark's highlight query is Python's with one pattern
before it, which colors a call to `load` as a keyword. The adapter compiles a
grammar file once however many languages use it, so a view that shows both
Python and Starlark compiles the Python grammar once.

## Environment and method

The measurements ran on a MacBook Pro identified as `Mac17,6`, with an Apple M5
Max, 18 cores and 128 GB of memory, running arm64 macOS 26.6.2 with Deno 2.9.8,
V8 15.0.245.2-rusty, and TypeScript 6.0.3. They used `web-tree-sitter` 0.26.12
and `tree-sitter-python` 0.25.0. The dependency cache was warm.

The adjacent retained [probe](cf-view-starlark-2026-11-probe.ts) is the
[October 2026 HCL probe](cf-view-hcl-2026-10-probe.ts) with three source units
in place of the HCL one, and with the same TOML control. It runs from
`runtime/cli`:

```sh
cd runtime/cli
deno run --allow-read --allow-env --allow-run \
  ../../docs/history/packages/cli/cf-view-starlark-2026-11-probe.ts starlark
```

Each source repeats a unit after one line of non-ASCII comment, to exactly
100,009 UTF-8 bytes. The Starlark unit is a seven-line `go_library` call with a
numbered `name`, a `glob` call added to a list with a `%` format, a `select`
call over a dictionary, a boolean, and a list. The `bazelrc` unit is one line
defining a numbered configuration with four options, one of them quoted, and a
trailing comment. The `bazelrc-bare` unit is one line of four options none of
which has a value, the shape that made an earlier form of the scanner search to
the end of the file for each option's `=`. Each edit renames the first
`render_item` after the middle of the source to `render_unit`. Sample counts
and the operations timed are the HCL probe's: 40 fresh-process initialization
samples, and 50 each of a complete highlight, a document parse with structure,
and a re-color after one edit. No deadline, retry, or sleep participated.

The probe records two times for each sample: the elapsed time, as the earlier
probes did, and the processor time the whole process spent, user and system,
from `process.cpuUsage`. For initialization, both run from the child process's
first statement. Each round ran the TOML probe, then the measured language,
then the TOML probe again. Starlark ran three rounds. The two rc subjects ran
three rounds each, numbered 2 to 4: their first round began before the
scanner's final change and is left out. The adjacent raw
[results](cf-view-starlark-2026-11-results.json) contain every sample of every
run reported here.

## Timings

The machine was shared with other agent sessions running tests and builds.
One-minute load averages were between 114 and 239 at the start of
each round. Each cell gives the median, then the 95th percentile, in
milliseconds; the maximums are 95th percentiles.

### Elapsed time

The TOML control runs measured elapsed medians between 5.1 and 42.9 times the
medians the Android formats report recorded, and the ratio of a measured
language to the TOML runs beside it moved by a factor of three between rounds
of the same subject. These figures cannot be scaled to an unloaded machine, so
this report does not estimate from them. Starlark measured:

| Round | Lazy initialization | Full highlighting | Document parse | Re-color after one edit |
| --- | ---: | ---: | ---: | ---: |
| 1 | 687.59 / 1016.97 | 840.31 / 1143.12 | 909.65 / 1376.41 | 532.53 / 1018.52 |
| 2 | 1010.06 / 1471.41 | 278.59 / 1017.56 | 422.38 / 894.02 | 305.52 / 821.54 |
| 3 | 1006.00 / 1383.53 | 783.00 / 1707.31 | 592.91 / 1309.41 | 421.74 / 934.64 |

### Processor time

Processor times were steady. Starlark measured:

| Round | Lazy initialization | Full highlighting | Document parse | Re-color after one edit |
| --- | ---: | ---: | ---: | ---: |
| 1 | 85.66 / 90.33 | 49.93 / 66.61 | 53.13 / 60.96 | 35.31 / 50.23 |
| 2 | 91.34 / 101.07 | 45.00 / 74.71 | 48.68 / 84.33 | 34.19 / 60.02 |
| 3 | 90.41 / 101.75 | 51.65 / 92.01 | 51.95 / 74.09 | 36.17 / 64.39 |

The TOML runs beside them measured these processor-time medians, the run
before and the run after separated by a slash:

| Round | Lazy initialization | Full highlighting | Document parse | Re-color after one edit |
| --- | ---: | ---: | ---: | ---: |
| 1 | 37.83 / 41.08 | 35.27 / 32.35 | 54.07 / 49.72 | 26.97 / 24.53 |
| 2 | 43.91 / 42.45 | 34.50 / 31.72 | 47.27 / 49.41 | 27.38 / 23.55 |
| 3 | 42.44 / 43.18 | 36.62 / 32.67 | 47.58 / 51.46 | 29.43 / 22.21 |
| Recorded elapsed medians | 22.55 | 17.49 | 26.97 | 10.89 |

Across the eighteen TOML runs beside every subject, the processor-time medians
were between 1.67 and 2.44 times the elapsed medians the Android formats report
recorded. For each operation, the largest median was 1.18 to 1.53 times the
smallest, against 1.8 to 10.8 times for the elapsed medians. I'd
guess that processor time exceeds unloaded elapsed time because `cpuUsage`
counts the time of every thread, including the threads where V8 compiles
WebAssembly and collects garbage, and because each thread runs slower on a
loaded processor; this is an inference, not measured.

The ratio of the Starlark median to the mean of the two TOML medians around it
ranges from 2.11 to 2.17 for initialization, 1.36 to 1.49 for the complete
highlight, 1.01 to 1.05 for the document parse, and 1.34 to 1.40 for the
re-color. Multiplying the TOML 95th percentiles the Android formats report
recorded by the largest of those ratios gives an estimate for an unloaded
machine: 50.8 ms for initialization, 29.5 ms for the complete highlight,
31.1 ms for the document parse, and 16.8 ms for the re-color. This is an
inference from the control, and assumes Starlark and TOML spend processor time
in the same proportion to elapsed time. Each estimate is inside its maximum.

The initialization estimate is probably high. Initialization compiles the
Python grammar, which at 457,883 bytes is larger than TOML's, and I'd guess
more of that compilation runs on helper threads, whose time processor time
counts and elapsed time does not. The
[September 2026 Python measurement](cf-view-python-treesitter-2026-09.md)
recorded 29.41 ms for initializing the same grammar on an unloaded machine.

### Bazel rc

The rc scanner measured these processor times, with TOML runs beside each
round as for Starlark:

| Round | Subject | Lazy initialization | Full highlighting | Document parse | Re-color after one edit |
| --- | --- | ---: | ---: | ---: | ---: |
| 2 | `bazelrc` | 4.75 / 6.27 | 4.55 / 19.99 | 5.21 / 8.71 | 4.14 / 8.73 |
| 3 | `bazelrc` | 4.75 / 6.52 | 4.74 / 20.23 | 4.98 / 7.62 | 4.32 / 13.10 |
| 4 | `bazelrc` | 4.55 / 5.72 | 4.56 / 12.54 | 5.18 / 9.01 | 4.09 / 8.65 |
| 2 | `bazelrc-bare` | 4.48 / 5.46 | 4.17 / 16.31 | 3.74 / 5.74 | 3.94 / 10.03 |
| 3 | `bazelrc-bare` | 4.82 / 6.31 | 3.94 / 16.60 | 3.57 / 6.39 | 3.77 / 10.60 |
| 4 | `bazelrc-bare` | 4.24 / 5.63 | 3.79 / 15.29 | 3.49 / 5.49 | 3.82 / 11.99 |

Its medians were between 0.07 and 0.18 times the TOML medians around them, and
scaling as for Starlark gives at most 2.6 ms for initialization, 3.0 ms for the
complete highlight, 3.4 ms for the document parse, and 2.1 ms for the re-color.
The values with no `=` take no longer than the others. Measured directly, every
processor-time 95th percentile is inside the maximums too.

## Size, source, and build

| Dimension | Starlark | Accepted maximum |
| --- | ---: | ---: |
| Compiled `cf` increase | 0.13 MiB | 10 MiB for a later grammar |
| Unpacked dependencies | 0 MiB | 10 MiB for a later grammar |
| Owned source | 91 lines | 200 lines for a later grammar |
| Parser-specific build and deployment steps | 0 | 0 |

Built with `deno task build-binaries cf` from a clean checkout of this change,
the binary was 187,706,978 bytes. Two builds of the merge base, made on the
same machine from clean checkouts for other work in the same hour, both
measured 187,574,882 bytes, so Starlark and the rc scanner add 132,096 bytes.
The binary built with them colored a `BUILD` file and a `.bazelrc` file.

Starlark adds no package, so the unpacked figure is nothing. Owned source is
`runtime/cli/lib/view/languages/starlark/starlark.ts`; the language descriptor
beside it is not counted, as those of the earlier grammars were not. The
adapter gained 13 lines to compile a grammar file once however many grammars
use it, and the Python module exports its highlight query. The binary build,
which leaves out every directory of a grammar package but the one holding its
WebAssembly grammar, lists each such directory once now that two grammars share
a package. The rc scanner is 267 lines in
`runtime/cli/lib/view/languages/bazelrc/bazelrc.ts`; it is not parser-backed,
so the owned-source maximum does not bind it.

## Coverage

The local checkouts of the organization's repositories hold Starlark and Bazel
files in the gVisor repository alone. The adjacent retained
[coverage check](cf-view-starlark-2026-11-coverage.ts) read every file that
`cf view` selects as Starlark or Bazel rc at gVisor's `5e59860` commit:

```sh
cd runtime/cli
deno run --allow-read --allow-env \
  ../../docs/history/packages/cli/cf-view-starlark-2026-11-coverage.ts DIR
```

Starlark selected 537 files: 502 `BUILD` files, 33 `.bzl` files,
`MODULE.bazel`, and `external/tools/plugin-stack/plugin-stack.BUILD`. These
are the 537 files the
[July 2026 coverage survey](cf-view-language-coverage-2026-07.md) counted as
Starlark and Bazel. The grammar parsed every file without an error, and every
file reconstructed exactly from its colored spans. Of the 642,116 characters
other than white space, none is left without a token class. Strings take 63.94
percent of them, property names 12.24 percent, call names 5.57 percent, and
comments 4.73 percent. The structure trees hold 1,926 entries.

Starlark names the node types a structure entry can be found inside, as HCL
does, which keeps the structure walk out of argument lists. A walk restricted
that way listed the same entries as an unrestricted one for each of the 537
files, and after each of 6,556 single-character insertions into the Starlark
fixture's earlier source and 5,296 into gVisor's `pkg/sync/locking/locking.bzl`,
of `(`, `[`, `"`, and `)` at every offset. The coverage check makes that
comparison when given `--edits` and a file.

The rc scanner read gVisor's `.bazelrc`, 1,861 characters other than white
space, and reconstructed it exactly with every one of them given a token class;
its structure tree lists four configurations. gVisor also holds
`.bazelversion`, which is plain text by name, and `.bazelignore`, which the
coverage plan leaves to the work on ignore files.
