---
status: historical
created: 2026-10-20
archived: 2026-10-20
reason: "Point-in-time measurements of the shipped cf view HCL path, and of its coverage of the Infra repository's OpenTofu files."
---

# `cf view` HCL: shipped measurements

This report records what the `cf view` HCL language costs, measured against
the operating maximums in the
[`cf view` language coverage plan](../../../plans/cf-view-language-coverage.md),
and how well it covers the OpenTofu files in the organization's repositories.
HCL runs on the shared Tree-sitter adapter with the HCL grammar from
`@tree-sitter-grammars/tree-sitter-hcl` 1.2.0.

HCL is inside the maximums for compiled bytes, unpacked bytes, owned source, and
build steps. The timings were taken on a loaded machine. Measured directly, the
complete highlight and the document parse were over their 50 ms maximums in
some rounds. Scaled against a TOML control run beside each round, as the
[September 2026 shell report](cf-view-shell-2026-09.md) scaled its timings,
every timing is inside its maximum, the document parse closest at an estimated
47.5 ms against 50. "Timings" gives both.

## Environment and method

The measurements ran on a MacBook Pro identified as `Mac17,6`, with an Apple M5
Max, 18 cores and 128 GB of memory, running arm64 macOS 26.6.2 with Deno 2.9.4,
V8 15.0.245.2-rusty, and TypeScript 6.0.3. They used `web-tree-sitter` 0.26.12
and `@tree-sitter-grammars/tree-sitter-hcl` 1.2.0. The dependency cache was
warm.

The adjacent retained [probe](cf-view-hcl-2026-10-probe.ts) is the
[September 2026 shell probe](cf-view-shell-2026-09-probe.ts) with an HCL source
unit, and with the TOML unit of the
[September 2026 Android formats probe](cf-view-android-formats-2026-09-probe.ts)
as a control. It runs from `packages/cli`:

```sh
cd packages/cli
deno run --allow-read --allow-env --allow-run \
  ../../docs/history/packages/cli/cf-view-hcl-2026-10-probe.ts hcl
```

The source repeats a unit after one line of non-ASCII comment, to exactly
100,009 UTF-8 bytes. The unit is a six-line `resource` block with a numbered
name label. It holds a conditional, a string with two interpolations, a `for`
expression with a condition that calls a function, and an object. The edit
renames the first `render_item` after the middle of the source to
`render_unit`. Sample counts and the operations timed are the shell probe's: 40
fresh-process initialization samples, and 50 each of a complete highlight, a
document parse with structure, and a re-color after one edit. No deadline,
retry, or sleep participated. Each round ran the TOML probe, then the HCL
probe, then the TOML probe again. The adjacent raw
[results](cf-view-hcl-2026-10-results.json) contain every sample of every run.

## Timings

Other work shared the machine throughout, with one-minute load averages between
13 and 25 at the start of each round. Each cell gives the median, then the 95th
percentile, in milliseconds; the maximums are 95th percentiles.

| Round | Lazy initialization | Full highlighting | Document parse | Re-color after one edit |
| --- | ---: | ---: | ---: | ---: |
| 1 | 24.98 / 26.85 | 42.91 / 47.48 | 42.38 / 45.58 | 21.11 / 26.13 |
| 2 | 25.22 / 29.81 | 42.24 / 52.57 | 42.60 / 50.67 | 20.30 / 24.43 |
| 3 | 24.43 / 27.48 | 40.12 / 42.74 | 41.44 / 45.07 | 20.25 / 24.04 |
| 4 | 36.09 / 46.12 | 69.54 / 106.85 | 89.56 / 134.73 | 46.04 / 75.19 |
| 5 | 30.95 / 35.17 | 48.88 / 53.55 | 53.95 / 59.37 | 24.24 / 29.48 |
| 6 | 24.76 / 27.03 | 44.40 / 47.51 | 45.11 / 50.64 | 21.12 / 26.94 |
| 7 | 24.26 / 25.14 | 41.82 / 46.99 | 44.41 / 47.68 | 20.81 / 25.52 |
| 8 | 24.06 / 25.12 | 39.83 / 42.65 | 41.53 / 43.71 | 20.36 / 24.41 |
| Accepted maximum | 75 | 50 | 50 | 25 |

The TOML runs measured these medians, the run before and the run after the HCL
run of each round separated by a slash:

| Round | Lazy initialization | Full highlighting | Document parse | Re-color after one edit |
| --- | ---: | ---: | ---: | ---: |
| 1 | 25.40 / 23.18 | 19.53 / 18.35 | 31.18 / 29.04 | 13.19 / 11.65 |
| 2 | 23.07 / 22.11 | 18.42 / 18.15 | 28.60 / 27.49 | 11.56 / 11.49 |
| 3 | 22.67 / 27.54 | 18.20 / 17.65 | 27.90 / 28.84 | 11.08 / 12.65 |
| 4 | 28.04 / 36.07 | 19.12 / 29.55 | 31.00 / 58.05 | 13.93 / 22.38 |
| 5 | 33.44 / 26.01 | 38.53 / 21.77 | 51.13 / 31.85 | 18.18 / 13.29 |
| 6 | 25.39 / 22.61 | 20.58 / 18.08 | 31.50 / 26.96 | 13.28 / 11.84 |
| 7 | 23.02 / 22.47 | 17.83 / 17.39 | 27.09 / 28.22 | 11.89 / 11.65 |
| 8 | 23.23 / 22.58 | 17.74 / 17.47 | 27.28 / 26.69 | 11.50 / 11.24 |
| Recorded in the Android formats report | 22.55 | 17.49 | 26.97 | 10.89 |

In rounds 4 and 5, a TOML run's medians reached 2.15 and 2.20 times the
medians the Android formats report recorded, and those rounds are left out of
what follows. In the other six, the TOML medians were at most 1.22 times the
recorded ones. Over those six rounds, the ratio of the HCL median to the mean
of the two TOML medians around it ranges from 0.97 to 1.12 for initialization,
2.24 to 2.37 for the complete highlight, 1.41 to 1.61 for the document parse,
and 1.68 to 1.79 for the re-color. Multiplying the TOML 95th percentiles the
Android formats report recorded by the largest of those ratios gives an
estimate for an unloaded machine: 26.1 ms for initialization, 47.0 ms for the
complete highlight, 47.5 ms for the document parse, and 21.4 ms for the
re-color. This is an inference from the control, and assumes HCL and TOML slow
down alike under load. Each estimate is inside its maximum.

On one parse of the source, the grammar produced 58,125 nodes, and the
highlight query 32,777 captures. The HCL tree holds more nodes for its size than
the other grammars, because the grammar wraps every expression, literal, and
collection in a node of its own. Walking all of them to find structure entries
took about 8 ms. Three earlier rounds, made before the change below with the
same probe, measured the document parse's 95th percentile at 52.36 to 63.58 ms,
over its 50 ms maximum; their raw samples are not retained, and neither are
those of four rounds on a quiet machine, with TOML controls within 0.88 to 1.05
times their recorded medians, that measured an earlier form of the final query.
That form lacked only the pattern for the fixed namespaces, and its highest
95th percentiles were 41.08 ms for initialization, 40.50 ms for the complete
highlight, 42.40 ms for the document parse, and 23.79 ms for the re-color. HCL therefore names
the node types a structure entry can be found inside, which are files, bodies,
blocks, and the error nodes that recovery from a syntax error can put a block
inside. On this source the walk then visits 4,811 nodes. A walk restricted that
way listed the same entries as an unrestricted one after each of 9,244
single-character insertions into the fixture's earlier source, of `(`, `{`,
`"`, and `}` at every offset. The coverage check below makes that comparison
when given `--edits` and a file.

## Size, source, and build

| Dimension | HCL | Accepted maximum |
| --- | ---: | ---: |
| Compiled `cf` increase | 0.19 MiB | 10 MiB for a later grammar |
| Unpacked dependencies | 1.91 MiB | 10 MiB for a later grammar |
| Owned source | 146 lines | 200 lines for a later grammar |
| Parser-specific build and deployment steps | 0 | 0 |

Built with `deno task build-binaries cf`, the binary was 178,902,642 bytes at
the merge base and 179,100,786 bytes with HCL, an increase of 198,144 bytes.
The package holds two WebAssembly grammars of about 90 KiB each, for HCL and
for a Terraform dialect with the same rules; the build leaves out the package's
generated C source and native builds, as it does for every grammar. The binary
built with HCL colored a `.tf` file.

The unpacked figure is the sum of every file in the cached package directory,
2,002,136 bytes. The package's two dependencies are the ones
`tree-sitter-python` already brings. Owned source is
`packages/cli/lib/view/languages/hcl/hcl.ts`; the language descriptor beside it
is not counted, as those of the earlier grammars were not. The adapter gained
the optional set of node types a structure entry can be found inside, in five
lines.

## Coverage

The local checkouts of the organization's repositories hold files that `cf view`
selects as HCL in the Infra repository alone. The adjacent retained
[coverage check](cf-view-hcl-2026-10-coverage.ts) read every one of them at
Infra's `0ed1d57` commit, 153 files:

```sh
cd packages/cli
deno run --allow-read --allow-env \
  ../../docs/history/packages/cli/cf-view-hcl-2026-10-coverage.ts DIR
```

 They are 130 `.tf` files, 19 `.tfvars`
files, and 4 `.terraform.lock.hcl` files. The grammar parsed every file without
an error, and every file reconstructed exactly from its colored spans. Of the
391,084 characters other than white space, none is left without a token class.
Strings take 29.12 percent of them, comments 27.18 percent, property names
13.40 percent, and identifiers 12.37 percent.

The Infra repository also holds 3 `.tftpl` templates, which the coverage plan
leaves to a later item, and no `.tofu`, `.tfbackend`, or `.tf.json` files.
