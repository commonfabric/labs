---
status: historical
created: 2026-11-13
archived: 2026-11-13
reason: "Point-in-time measurements of the shipped cf view Rust path, and of its coverage of the Rust files in the organization's repositories."
---

# `cf view` Rust: shipped measurements

This report records what the `cf view` Rust language costs, measured against the
operating maximums in the [`cf view` language coverage
plan](../../../plans/cf-view-language-coverage.md), and how well it covers the
Rust files in the organization's repositories. Rust runs on the shared
Tree-sitter adapter with the official Rust grammar from `tree-sitter-rust`
0.24.0.

Rust is inside the maximums for compiled bytes, owned source, and build steps.
Its package is 14.35 MiB unpacked, over the 10 MiB maximum for a later grammar.
The timings were taken on a machine so loaded that the TOML control ran 5 to 26
times slower than its recorded wall-clock figures. Scaled against either
control, initialization, the complete highlight, and the document parse are
inside their maximums, the document parse closest at an estimated 48.7 ms
against 50. The re-color after one edit is estimated at 23.4 to 29.5 ms against
a maximum of 25, depending on which control and which of its figures it is
scaled from; three of the four estimates are over the maximum. "Timings" gives
each, and why the controls disagree.

## Environment and method

The measurements ran on a MacBook Pro identified as `Mac17,6`, with an Apple M5
Max, 18 cores and 128 GB of memory, running arm64 macOS 26.6.2 with Deno 2.9.8,
V8 15.0.245.2-rusty, and TypeScript 6.0.3. They used `web-tree-sitter` 0.26.12,
`tree-sitter-rust` 0.24.0, `@tree-sitter-grammars/tree-sitter-toml` 0.7.0, and
`@tree-sitter-grammars/tree-sitter-hcl` 1.2.0. The dependency cache was warm.

The adjacent retained [probe](cf-view-rust-2026-11-probe.ts) runs from
`runtime/cli`:

```sh
cd runtime/cli
deno run --allow-read --allow-env --allow-run \
  ../../docs/history/packages/cli/cf-view-rust-2026-11-probe.ts
```

The Rust source repeats a unit after one line of non-ASCII comment, to exactly
100,009 UTF-8 bytes. The unit is a six-line `impl` block for a numbered type,
holding a method with a reference parameter, a `let` binding of a macro call,
and an `if` expression whose condition passes a closure to a method. The edit
renames the first `render_item` after the middle of the source to `render_unit`.
The TOML and HCL sources and edits are those of the [October 2026 HCL
probe](cf-view-hcl-2026-10-probe.ts). Sample counts and the operations timed are
those of the earlier probes: 40 fresh-process initialization samples, and 50
each of a complete highlight, a document parse with structure, and a re-color
after one edit.

The earlier probes measured one language per run, and a round ran the TOML probe
before and after the probe being measured. Three such rounds, run at this
machine's load with the HCL report's probe adapted to Rust and an earlier
revision of the Rust query, measured ratios of Rust's median to the mean of the
two TOML medians that moved from one round to the next, a few minutes apart:
from 1.20 to 2.76 for the re-color, and from 1.10 to 2.56 for the complete
highlight. This probe therefore takes each Rust sample and then the matching
TOML and HCL samples, so that the three see the same load. It also records the
processor time of each sample beside its wall-clock time. Processor time leaves
out the time the process waits to be scheduled, but counts every thread of the
process, including the runtime's helper threads, so it is not the wall-clock
time an idle machine would show; the TOML control's processor-time medians below
are 1.5 to 1.9 times its recorded wall-clock medians. No deadline, retry, or
sleep participated. The probe ran three times, on a revision of the Rust module
with the same highlight query as the one reported here. Its structure tree did
not yet list enumeration variants, and the probe's source declares no
enumeration. The adjacent raw [results](cf-view-rust-2026-11-results.json)
contain every sample of those runs and of the three earlier rounds, the load
average that the script running the probe read before each run, the coverage
check's output, and the size measurements.

## Timings

The one-minute load average was between 156 and 181 at the start of each run.
The TOML control's wall-clock medians were 5.2 to 25.7 times the medians the
[September 2026 Android formats report](cf-view-android-formats-2026-09.md)
recorded, and its processor-time medians 1.5 to 1.9 times those wall-clock
medians.

| Run | Clock | Lazy initialization | Full highlighting | Document parse | Re-color after one edit |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | wall | 1296.9 / 1936.8 | 171.9 / 977.8 | 171.3 / 776.8 | 182.4 / 543.8 |
| 1 | processor | 130.9 / 157.2 | 55.2 / 78.7 | 56.9 / 70.2 | 38.5 / 68.6 |
| 2 | wall | 1246.9 / 1637.1 | 448.1 / 886.2 | 462.1 / 996.1 | 272.9 / 1004.2 |
| 2 | processor | 126.3 / 140.2 | 52.9 / 73.5 | 57.1 / 79.9 | 38.5 / 85.9 |
| 3 | wall | 1358.8 / 1975.9 | 433.3 / 1038.3 | 222.7 / 599.7 | 387.0 / 975.5 |
| 3 | processor | 127.8 / 147.0 | 50.5 / 67.5 | 56.1 / 62.0 | 42.7 / 65.0 |
| Accepted maximum | | 75 | 50 | 50 | 25 |

Each cell gives Rust's median, then its 95th percentile, in milliseconds. These
are not the machine's idle costs, which the estimates below infer.

The ratio of Rust's median to a control's median in the same run, over the three
runs and both clocks, ranged as follows:

| Control | Lazy initialization | Full highlighting | Document parse | Re-color after one edit |
| --- | ---: | ---: | ---: | ---: |
| HCL | 1.96 to 2.27 | 0.56 to 0.82 | 0.87 to 1.03 | 0.82 to 1.09 |
| TOML | 2.24 to 3.02 | 1.41 to 2.18 | 0.71 to 1.60 | 1.97 to 2.44 |

Multiplying a control's recorded 95th percentiles by the largest of those ratios
gives an estimate for an unloaded machine, as the [October 2026 HCL
report](cf-view-hcl-2026-10.md) estimated its own timings from TOML's. Scaled
from HCL's recorded estimates, Rust's are 59.3 ms for initialization, 38.4 ms
for the complete highlight, 48.7 ms for the document parse, and 23.4 ms for the
re-color. Scaled from TOML's recorded figures, they are 70.6, 43.1, 47.4, and
29.2 ms.

The two controls disagree because the load does not slow the three languages
alike. When the HCL report was measured, HCL's medians were 1.68 to 1.79 times
TOML's for the re-color and 0.97 to 1.12 times for initialization. In these
runs, HCL's processor-time medians were 2.35 to 2.55 times TOML's for the
re-color and 1.33 to 1.46 times for initialization. Scaling from TOML under this
load would put HCL's own re-color well above the 21.4 ms its report estimated,
which suggests that the TOML-scaled figure overstates Rust's re-color. The
HCL-scaled figure has its own weakness: HCL's 21.4 ms is itself an estimate
scaled from TOML. The HCL report's quiet-machine rounds, with an earlier form of
its query, measured HCL's re-color at up to 23.79 ms at the 95th percentile, and
its retained rounds whose TOML controls stayed within 1.22 times their recorded
medians measured up to 26.94 ms. Scaled from those by the largest ratio of Rust
to HCL seen here, 1.09, Rust's re-color would be 26.0 and 29.5 ms. In the same
runs Rust and HCL re-colored within 0.82 to 1.09 times of each other. The
inference from these figures, which these runs cannot confirm, is that Rust's
re-color is close to HCL's and probably over the 25 ms maximum, by up to about a
fifth.

One-off measurements, whose scripts and samples are not retained, found the
following. The highlight query is most of the cost of a re-color. On one parse
of the Rust source, the grammar produced 44,727 nodes and the highlight query
36,784 captures; the TOML source produced 33,928 and 21,303. In processor time,
an incremental parse after the edit took under 1 ms, against about 28 ms for the
query over the whole document. Removing in turn the query's patterns that match
any parent, those with a predicate, the keyword-anchored ones, and the pattern
that colors every remaining identifier gave no improvement that held across two
runs. A structure walk that stays out of function bodies made no measurable
difference to the document parse either.

## Size, source, and build

| Dimension | Rust | Accepted maximum |
| --- | ---: | ---: |
| Compiled `cf` increase | 1.07 MiB | 10 MiB for a later grammar |
| Unpacked dependencies | 14.35 MiB | 10 MiB for a later grammar |
| Owned source | 200 lines | 200 lines for a later grammar |
| Parser-specific build and deployment steps | 0 | 0 |

Built with `deno task build-binaries cf`, the binary was 187,640,930 bytes at
the merge base and 188,763,746 bytes with Rust, an increase of 1,122,816 bytes.
The package's WebAssembly grammar is 1,102,547 bytes; the build leaves out the
package's generated C source and native builds, as it does for every grammar.

The unpacked figure is the sum of every file in the cached package directory,
15,049,205 bytes. Its `src` directory of generated C source holds 6.50 MiB of
it, and its `prebuilds` directory of native builds for six platforms 6.76 MiB.
The package's two dependencies are the ones `tree-sitter-python` already brings.
The npm package's WebAssembly grammar has the SHA-256 digest
`f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57`. The
`tree-sitter-rust.wasm` asset attached to the grammar's v0.24.0 GitHub release
has a different digest,
`44b8d1a2e307ee8933d7c0bcb6b0f30d56bc999999fd1d2d9608a7dcf6e8ce56`, so the two
are separate builds. The pager loads the npm package's. The grammar's GitHub
releases include 0.24.1 and 0.24.2, which no npm version carries. A search of
npm for packages holding only a Rust WebAssembly grammar found
`@plurnk/plurnk-mimetypes-grammar-rust`, `kibi-lang-rust`, and
`react-native-codepad-lang-rust`, none published by the grammar's maintainers.

Owned source is `runtime/cli/lib/view/languages/rust/rust.ts`; the language
descriptor beside it is not counted, as those of the earlier grammars were not.
The adapter is unchanged.

## Coverage

The local checkouts of the organization's repositories hold 33 files that `cf
view` selects as Rust: 28 in Infra's memory router at its `d17b604` commit, 4 in
danfuzz-land at `511a9d7`, and 1 in gVisor's `cfc_v2` branch at `dc7baff`. The
six months before November 13, 2026 hold 51 path-change events on the Infra
paths, 8 on danfuzz-land's, and none on gVisor's, counted with `git log
--since=2026-05-13 --name-only -- '*.rs'` on those branches. Fabric Mobile,
where the July survey found 10 of its 11 Rust files, removed them on July 30,
2026, after 22 path-change events in those six months. The adjacent retained
[coverage check](cf-view-rust-2026-11-coverage.ts) read every one of the 33:

```sh
cd runtime/cli
deno run --allow-read --allow-env \
  ../../docs/history/packages/cli/cf-view-rust-2026-11-coverage.ts DIR
```

The 33 files hold 19,240 lines. The grammar parsed every file without an error,
and every file reconstructed exactly from its colored spans. Of the 515,559
characters other than white space, including those inside comments and strings,
none is left without a token class. Identifiers take 19.06 percent of them,
called names 13.71 percent, strings 10.27 percent, and doc comments 8.93
percent.

The structure walk descends only into item lists, structure, union, and
enumeration bodies, function bodies' blocks and statements, and error nodes, so
it lists an item declared directly in a function body but not one declared
inside an expression, such as the block of an `if`. Over the 33 files, it listed
the same entries as a walk that descends into every node. Given `--edits` and a
file, the check inserts each of `(`, `{`, `"`, and `}` at every offset of the
file and makes the same comparison after each insertion. The walks listed the
same entries after each of the 4,720 insertions into the danfuzz-land fixture's
later source. They differed after 2 of the 8,908 insertions into the Infra
fixture's later source. The check reports only the count; a separate run, whose
output is not retained, found them at offsets 2000 and 2077, where each puts a
`{` after the first `/` of the `///` that opens a doc comment. After each, the
restricted walk lists one method fewer. Reading the parse tree after the first
showed that method parsed as part of an expression in the method before it,
which the restricted walk does not enter.
