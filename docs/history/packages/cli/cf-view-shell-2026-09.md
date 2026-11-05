---
status: historical
created: 2026-09-29
archived: 2026-09-29
reason: "Point-in-time measurements of the shipped cf view shell path, and of leaving grammar sources out of the cf binary."
---

# `cf view` shell: shipped measurements

This report records what the `cf view` shell language costs, measured against
the operating maximums in the
[`cf view` language coverage plan](../../../plans/cf-view-language-coverage.md),
and how well it covers the shell scripts in the organization's repositories.
Shell runs on the shared Tree-sitter adapter with the official Bash grammar,
`tree-sitter-bash` 0.25.1, which also parses POSIX shell.

Shell is inside the maximums for compiled bytes, owned source, and build steps.
Its unpacked dependency is 19.34 MiB, over the 10 MiB maximum for a later
grammar. The timings were taken on a heavily loaded machine. Measured directly,
the document parse and the re-color after an edit were over their maximums in
some rounds. Scaled against a TOML control run beside each round, every timing
is inside its maximum. "Timings" gives both.

## Environment and method

The measurements ran on a MacBook Pro identified as `Mac17,6`, with an Apple M5
Max, 18 cores and 128 GB of memory, running arm64 macOS 26.6.2 with Deno 2.9.4,
V8 15.0.245.2-rusty, and TypeScript 6.0.3. They used `web-tree-sitter` 0.26.12
and `tree-sitter-bash` 0.25.1. The dependency cache was warm.

The adjacent retained [probe](cf-view-shell-2026-09-probe.ts) is the
[September 2026 Android formats probe](cf-view-android-formats-2026-09-probe.ts)
with a shell source unit, so the runs compare directly. It runs from
`packages/cli`:

```sh
cd packages/cli
deno run --allow-read --allow-env --allow-run \
  ../../docs/history/packages/cli/cf-view-shell-2026-09-probe.ts shell
```

The source repeats a unit after one line of non-ASCII comment, to exactly
100,009 UTF-8 bytes. The unit is a seven-line function that declares a local
holding a default-value expansion and a command substitution inside a string,
tests it with `[[ … ]]` and a regular expression, and prints it with a
redirection. The edit renames the first `render_item` after the middle of the
source to `render_unit`. Sample counts and the operations timed are the Swift
probe's: 40 fresh-process initialization samples, and 50 each of a complete
highlight, a document parse with structure, and a re-color after one edit. No
deadline, retry, or sleep participated. The adjacent raw
[results](cf-view-shell-2026-09-results.json) contain every sample, including
the TOML runs made alongside.

## Timings

Other work shared the machine throughout, with one-minute load averages between
18 and 30 and fifteen-minute averages between 42 and 46 during the rounds that
recorded them. The Android formats report calibrated its rounds with a control
language whose figures stayed close to its own report's. No round here met
that test: the TOML probe ran before each shell run, and after it from round 3
on, and its medians were 1.2 to 2.2 times the medians the Android formats
report recorded for it.

Each cell gives the median, then the 95th percentile, in milliseconds; the
maximums are 95th percentiles.

| Round | Lazy initialization | Full highlighting | Document parse | Re-color after one edit |
| --- | ---: | ---: | ---: | ---: |
| 1 | 54.96 / 63.15 | 36.21 / 46.46 | 48.75 / 54.09 | 25.79 / 34.95 |
| 2 | 47.84 / 51.09 | 33.09 / 41.72 | 43.36 / 49.49 | 20.87 / 23.80 |
| 3 | 59.09 / 63.55 | 34.04 / 46.30 | 50.67 / 55.77 | 22.93 / 27.40 |
| 4 | 53.15 / 60.01 | 37.60 / 43.23 | 44.12 / 47.31 | 22.73 / 24.76 |
| 5 | 55.60 / 64.40 | 36.12 / 39.56 | 48.46 / 53.43 | 23.68 / 25.85 |
| 6 | 66.62 / 105.29 | 37.31 / 42.38 | 49.20 / 52.38 | 28.00 / 94.26 |
| Accepted maximum | 75 | 50 | 50 | 25 |

The TOML run before each shell run measured these medians:

| Round | Lazy initialization | Full highlighting | Document parse | Re-color after one edit |
| --- | ---: | ---: | ---: | ---: |
| 1 | 32.79 | 24.29 | 38.18 | 16.15 |
| 2 | 35.83 | 22.44 | 58.53 | 17.01 |
| 3 | 33.08 | 26.35 | 40.21 | 17.38 |
| 4 | 31.56 | 24.70 | 40.27 | 15.40 |
| 5 | 30.52 | 22.23 | 40.14 | 13.34 |
| 6 | 27.55 | 22.60 | 36.65 | 14.01 |
| Recorded in the Android formats report | 22.55 | 17.49 | 26.97 | 10.89 |

The ratio of shell's median to that TOML median ranges, over the six rounds,
from 1.34 to 2.42 for initialization, 1.29 to 1.65 for full highlighting, 1.10
to 1.34 for the document parse (leaving out round 2, whose TOML parse was
disturbed), and 1.23 to 2.00 for the re-color. Multiplying the TOML 95th
percentiles the Android formats report recorded by the largest of those ratios
gives an estimate for an unloaded machine: 56.6 ms for initialization, 32.7 ms
for full highlighting, 39.7 ms for the document parse, and 23.9 ms for the
re-color. This is an inference from the control, and assumes shell and TOML
slow down alike under load. Each estimate is inside its maximum; the re-color
is the closest.

On one parse of the source, the grammar produced 44,874 nodes, and the
highlight query 27,177 captures. The query's one pattern that tests a node's
text, which colors `break`, `continue`, `exit`, and `return` as control
keywords, added under 1 ms to a query run of about 39 ms.

## Size, source, and build

| Dimension | Shell | Accepted maximum |
| --- | ---: | ---: |
| Compiled `cf` increase | 1.32 MiB | 10 MiB for a later grammar |
| Unpacked dependencies | 19.34 MiB | 10 MiB for a later grammar |
| Owned source | 91 lines | 200 lines for a later grammar |
| Parser-specific build and deployment steps | 0 | 0 |

`deno compile` embeds each npm package the binary uses in full. Besides its
1.30 MiB WebAssembly grammar, `tree-sitter-bash` ships 9.7 MiB of generated C
source and 8.3 MiB of native builds, which the pager never reads. Built with
`deno task build-binaries cf`, the binary was 176,789,106 bytes at the merge
base, and 197,263,986 bytes with shell added, an increase of 19.53 MiB.

The same change makes the build leave out every directory of each grammar
package except the one holding its WebAssembly grammar. With that in place the
binary is 170,448,498 bytes. Built from the merge base with the exclusion alone,
it is 169,061,490 bytes. Shell's increase is therefore 1,387,008 bytes, or 1.32
MiB, and the exclusion alone removes 7.37 MiB of Python and TOML grammar
sources and native builds from the binary. The binary built with both colored a
`.sh`, a `.py`, a `.kt`, a `.toml`, and a `.swift` file.

The exclusion is computed by the existing build from each grammar's
WebAssembly location, so no one performs a step for it.

The unpacked figure is the sum of every file in the cached package directory,
20,282,555 bytes. The package's two dependencies are the ones
`tree-sitter-python` already brings. Owned source is
`packages/cli/lib/view/languages/shell/shell.ts`, 91 lines; the language
descriptor beside it is not counted, as those of the earlier grammars were not.

## Coverage

A check read every file in the local checkouts of the organization's
repositories that `cf view` selects as shell: 391 files in 20 repositories, by
name or by shebang. Every file reconstructed exactly from its colored spans.
135,376 of the 2,955,226 characters other than white space, 4.58 percent, have
no token class. They are almost all command arguments, which the grammar reads
as plain words: the most frequent are `\` line continuations, `/dev/null`, and
option flags.

The grammar could not parse part of 20 files. Its error regions cover 10,993 of
the 86,631 lines, 12.69 percent. Two files hold 10,782 of those lines: Loom's
`src/bin/wish-dispatch.sh`, where the region is the whole file, and the Weaver
app's `apple/scripts/bench-weaver.sh`. Coloring continues inside the regions:
in `wish-dispatch.sh`, 4.04 percent of characters other than white space have
no token class, against 4.58 percent over all the files. The structure tree
loses the functions the grammar could not place: it lists 149 of the 161
function definitions in `wish-dispatch.sh`, and 40 of the 44 in
`bench-weaver.sh`.

Both large regions start at a `]` inside the pattern of an expansion that
removes a prefix or a suffix. The smallest source that shows it is
`x=${h%]}`; the two files escape the bracket, as in `${page%%\]*}`. Replacing
those escaped brackets in `wish-dispatch.sh` leaves one more failure, a case
pattern holding a quoted `[` and then a quoted `]`, whose smallest form is
`case $x in *"[a"*"]"*) ;; esac`. That failure's region is one line, and the
structure tree then lists all 161 functions. The other constructs that start
an error region, each covering a line or a few, include:

- zsh parameter flags, such as `${(%):-%x}`, in Loom libraries that test
  whether zsh is sourcing them;
- an arithmetic base prefix, `$((10#$PORT))`;
- `for arg do`, which omits `in` and the separator;
- a heredoc whose command line ends with `&`;
- a read-write redirection, `exec 9<> "$FILE"`;
- parentheses or a semicolon inside an alternate-value expansion, such as
  `${slug:+ (slug $slug)}`.

One grammar failure starts no error region. A second heredoc on the same
command line, as in `cat <<A <<B`, is read as two `<` redirections, so its
body is colored as commands rather than as a string.

The same local checkouts recorded 1,839 path changes to those 391 files in the
six months before the check, most in Loom (862), `commonfabric-weaver` (300),
and Labs (273).
