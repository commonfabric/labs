---
status: historical
created: 2026-11-13
archived: 2026-11-13
reason: "Point-in-time measurements of the shipped cf view Go path, and of its coverage of the Go source, module, and checksum files in the organization's repositories."
---

# `cf view` Go: shipped measurements

This report records what the `cf view` Go language costs, measured against the
operating maximums in the
[`cf view` language coverage plan](../../../plans/cf-view-language-coverage.md),
and how well it and the two Go manifest languages cover the Go files in the
organization's repositories. Go runs on the shared Tree-sitter adapter with the
official Go grammar, `tree-sitter-go` 0.25.0. Go module and workspace files
(`go.mod`, `go.work`) and Go checksum files (`go.sum`, `go.work.sum`) use
focused scanners.

Go is inside the maximums for compiled bytes, unpacked bytes, the source it adds
on its own, and build steps. The timings were taken on a machine whose load
average stood between 125 and 278, where wall-clock time measured how long the
process waited for a processor more than how long it worked. The probe
therefore recorded each sample's processor time as well. Scaled against a TOML
control run beside each Go run, every processor-time figure is inside its
maximum, the re-color after one edit closest at an estimated 21.5 ms against 25.
"Timings" gives the method and both measures.

The cumulative owned-source maximum that binds the adapter and the Python, Go,
Bash, and HTML grammars was already exceeded before Go; "Size, source, and
build" gives the figures.

## Environment and method

The measurements ran on a MacBook Pro identified as `Mac17,6`, with an Apple M5
Max, 18 cores and 128 GB of memory, running arm64 macOS 26.6.2 with Deno 2.9.8,
V8 15.0.245.2-rusty, and TypeScript 6.0.3. They used `web-tree-sitter` 0.26.12
and `tree-sitter-go` 0.25.0. The dependency cache was warm.

The adjacent retained [probe](cf-view-go-2026-11-probe.ts) is the
[October 2026 HCL probe](cf-view-hcl-2026-10-probe.ts) with a Go source unit,
module and checksum file units, and a processor-time measurement beside each
wall-clock one. It runs from `runtime/cli`:

```sh
cd runtime/cli
deno run --allow-read --allow-env --allow-run \
  ../../docs/history/packages/cli/cf-view-go-2026-11-probe.ts go
```

The Go source repeats a unit after a line of non-ASCII comment and a package
clause, to exactly 100,009 UTF-8 bytes. The unit is a nine-line function with a
numbered name that declares a variable, ranges over a slice with a short
variable declaration, tests and breaks inside the loop, calls a qualified
function with a string holding an escape, and returns two values. The edit
renames the first `renderItem` after the middle of the source to `renderUnit`.
Sample counts and the operations timed are the HCL probe's: 40 fresh-process
initialization samples, and 50 each of a complete highlight, a document parse
with structure, and a re-color after one edit. No deadline, retry, or sleep
participated. Each of six rounds ran the TOML probe, then the Go probe, then the
TOML probe again, from a copy of the source at one commit that nothing edited
while they ran. The adjacent raw [results](cf-view-go-2026-11-results.json)
contain every sample of every run, both measures, and the load averages before
each run.

A sample's processor time is the processor time the whole process spent during
the operation, user and system, summed over its threads, as `node:process`
reports it. An initialization sample's processor time runs from the probe
module's first statement to the empty highlight, so it includes the threads
that compile the code it loads.

The code measured is the commit before three later changes to it: the pattern
that colors comment directives tests a different regular expression, an
embedded field's structure label is cut at its tag rather than by searching for
the tag's text, and the module file scanner reads its tokens differently. None
of them changes how much work a highlight, a parse, or an edit does.

## Timings

Wall-clock medians for Go ran from 294 to 1,144 ms, and its 95th percentiles
were 14 to 59 times the maximums. The TOML runs' wall-clock medians were 9.6 to
56 times the medians the Android formats report recorded for TOML. The raw
results give every figure. They measure the machine's queue for processors
rather than the language.

Processor time follows the work more closely. Each cell gives the median, then
the 95th percentile, in milliseconds of processor time:

| Round | Lazy initialization | Full highlighting | Document parse | Re-color after one edit |
| --- | ---: | ---: | ---: | ---: |
| 1 | 71.10 / 87.07 | 52.22 / 63.14 | 51.65 / 69.56 | 37.99 / 54.38 |
| 2 | 67.32 / 83.44 | 56.10 / 86.17 | 51.60 / 78.11 | 43.10 / 77.25 |
| 3 | 69.09 / 85.00 | 48.25 / 79.16 | 49.96 / 74.98 | 37.48 / 63.64 |
| 4 | 72.64 / 82.49 | 47.90 / 67.61 | 50.11 / 77.32 | 34.41 / 56.60 |
| 5 | 71.13 / 89.84 | 49.39 / 77.42 | 54.39 / 81.61 | 40.38 / 76.45 |
| 6 | 71.05 / 90.61 | 48.18 / 73.52 | 48.24 / 61.91 | 40.37 / 81.78 |
| Accepted maximum | 75 | 50 | 50 | 25 |

The TOML runs measured these processor-time medians, the run before and the run
after the Go run of each round separated by a slash:

| Round | Lazy initialization | Full highlighting | Document parse | Re-color after one edit |
| --- | ---: | ---: | ---: | ---: |
| 1 | 39.32 / 41.21 | 32.30 / 36.09 | 51.43 / 60.52 | 19.84 / 22.48 |
| 2 | 44.20 / 44.02 | 32.11 / 40.84 | 48.51 / 61.59 | 25.63 / 27.33 |
| 3 | 43.54 / 43.86 | 35.89 / 31.02 | 44.40 / 48.23 | 21.45 / 26.47 |
| 4 | 42.62 / 44.28 | 32.67 / 32.06 | 56.20 / 54.28 | 25.56 / 24.40 |
| 5 | 44.19 / 44.37 | 35.73 / 34.30 | 58.15 / 53.64 | 21.03 / 28.10 |
| 6 | 45.05 / 42.88 | 32.65 / 33.60 | 54.03 / 56.46 | 26.69 / 24.19 |
| Recorded in the Android formats report, wall clock | 22.55 | 17.49 | 26.97 | 10.89 |

The TOML processor-time medians stayed between 1.65 and 2.58 times the
wall-clock medians the Android formats report recorded for TOML on a quiet
machine, so processor time on this machine is itself inflated, and no round can
be compared with the maximums directly. I'd guess the inflation comes from the
process running on the M5 Max's efficiency cores and sharing caches with the
other work, since processor time excludes waiting for a processor; this is
unverified. It was steady enough to calibrate against: over the six rounds, the
ratio of the Go median to the mean of the two TOML medians around it ranges
from 1.53 to 1.77 for initialization, 1.41 to 1.54 for the complete highlight,
0.87 to 1.08 for the document parse, and 1.38 to 1.80 for the re-color.
Multiplying the TOML 95th percentiles the Android formats report recorded by
the largest of those ratios gives an estimate for an unloaded machine: 41.4 ms
for initialization, 30.4 ms for the complete highlight, 31.9 ms for the
document parse, and 21.5 ms for the re-color. This is an inference from the
control, and assumes Go and TOML slow down alike, as the earlier shell and HCL
reports assumed of wall-clock time. Each estimate is inside its maximum.

The Go document parse costs less than TOML's although its complete highlight
costs more. The Go grammar names the node types a structure entry can be found
inside, as HCL's does, so the structure walk does not descend into function
bodies or expressions. The check below, given `--edits` and a file, inserts
each of `(`, `{`, `"`, and `}` at every offset of the file, and compares the
restricted walk with one that descends into every node and leaves out the
declarations inside a block, as the restriction does by design. On the gVisor
fixture's earlier source, the two listed the same entries after 11,007 of the
11,036 insertions. The other 29 fall in the import clause, the comment above
the source's type declaration, and that declaration's first line. After each,
error recovery no longer reads the declaration as one: in the case examined, it
reads it as an expression holding a struct type. The unrestricted walk then
lists the struct's four fields with no type declaring them, and the restricted
walk lists neither.

The module and checksum file scanners, measured the same way on 100,009 bytes
of `require` block lines and of checksum lines, took these processor-time
medians and 95th percentiles in milliseconds:

| Language | Lazy initialization | Full highlighting | Document parse | Re-color after one edit |
| --- | ---: | ---: | ---: | ---: |
| Go module files | 14.79 / 18.06 | 2.06 / 13.45 | 3.72 / 7.79 | 1.90 / 6.14 |
| Go checksum files | 15.25 / 16.77 | 2.22 / 9.92 | 2.72 / 6.12 | 1.50 / 3.38 |

Their initialization is the probe's own start-up, since neither loads a parser.
Even unscaled, each figure is inside the maximum for a parser-backed language.

## Size, source, and build

| Dimension | Go | Accepted maximum |
| --- | ---: | ---: |
| Compiled `cf` increase | 0.38 MiB | 10 MiB for a later grammar |
| Unpacked dependencies | 3.66 MiB | 10 MiB for a later grammar |
| Owned source | 192 lines | 200 lines for a later grammar |
| Parser-specific build and deployment steps | 0 | 0 |

Built with `deno task build-binaries cf`, the binary was 187,574,882 bytes at
the merge base and 187,971,170 bytes with Go, an increase of 396,288 bytes. The
build leaves out the package's generated C source and native builds, as it does
for every grammar, so what Go adds is its 217,182-byte WebAssembly grammar and
the code of the three languages. The binary built with Go colored a `.go`
file.

The unpacked figure is the sum of every file in the cached package directory,
3,842,053 bytes, of which the WebAssembly grammar is 217,182. The package's two
dependencies are the ones `tree-sitter-python` already brings. Owned source is
`runtime/cli/lib/view/languages/go/go.ts`; the language descriptors beside it
are not counted, as those of the earlier grammars were not, and neither are the
two focused scanners, `mod.ts` and `sum.ts`, which do not use the adapter. Go
needed no change to the adapter.

The plan also bounds the common runtime and the Python, Go, Bash, and HTML host
grammars at 1,000 owned source lines together. At the merge base, before Go,
those already measured 1,153 lines: the adapter's `treesitter/adapter.ts` 654
and the `classes.ts` split out of it 103, `python/python.ts` 126, and
`shell/shell.ts` 270. With Go they measure 1,345. Python and shell, with Go,
occupy 34.95 MiB of the 40 MiB those grammars and the runtime may occupy
unpacked.

## Coverage

A read of the local checkouts of the organization's repositories found Go
source in seven of them. The adjacent retained
[coverage check](cf-view-go-2026-11-coverage.ts) read every file that `cf view`
selects as Go, as a Go module file, or as a Go checksum file, at the tip of each
default branch and of gVisor's active `cfc_v2` branch: Bay at `c94ac40`, Common
Cluster at `4bf904b`, gVisor at `dc7baff57`, Infra at `d17b6041`, Loom Scripts at
`6b1f0ec`, Raia at `a9998da`, and Run Orchestrator at `e72dff3`.

```sh
cd runtime/cli
deno run --allow-read --allow-env --allow-run \
  ../../docs/history/packages/cli/cf-view-go-2026-11-coverage.ts \
  REPOSITORY=COMMIT ...
```

The check read 2,954 Go files, 9 module files, and 8 checksum files, and found
no `go.work` or `go.work.sum` file. Every file reconstructed exactly from its
colored spans.

The Go files hold 921,183 lines and 26,091,131 characters other than white
space, of which 2 have no token class. Comments take 32.95 percent of those
characters, identifiers 13.55 percent, strings 13.14 percent, called names 8.14
percent, and property names 5.85 percent. The grammar could not parse part of 2
files, 3 of their 1,125 lines: gVisor's `runsc/cgroup/cgroup.go` and Loom
Scripts' `gmessages-client/internal/handoff/handoff_test.go`. Each declares a
function of its own named `new` or `make`, which Go allows, and the grammar
reads a call's first argument as the type the built-in function of that name
takes, as in `new("self", cgroupsPath, useSystemd)`. Coloring continues inside
those regions.

Every character other than white space in the module and checksum files has a
token class. In the 10,563 of the module files, identifiers take 54.15 percent,
versions 24.66 percent, and comments 16.14 percent; in the 155,869 of the
checksum files, hashes take 49.66 percent, module paths 26.13 percent, versions
18.15 percent, and the `/go.mod` suffix 6.06 percent.
