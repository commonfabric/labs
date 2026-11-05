---
status: historical
created: 2026-09-14
archived: 2026-09-14
reason: "Measured JSON Pointer encoding and Map lookup before and after guarded escaping."
---

# JSON Pointer encoding with guarded escaping

The optional encoder follow-up from
[issue #7179](https://github.com/commontoolsinc/labs/issues/7179#issuecomment-5668537208)
showed a repeatable leaf-level improvement. Encoding ordinary short paths and
looking them up as Map keys ran about 1.7 times as fast in adjacent paired
samples. Long segments improved 1.54x; paths containing both escape characters
in every segment were at parity. No deployed-pane speedup was measured.

## Work and mechanism

The maintained `packages/memory/test/v2-path.bench.ts` benchmark was written and
run against the unchanged encoder first. Each batch encodes 256 distinct paths
and consumes each resulting string through a prebuilt Map lookup. The checksum
is checked outside timing. This consumption includes hashing or flattening a
concatenated string, so deferred string construction cannot disappear from the
measurement. Fixture construction is also outside timing.

Depths 1, 4, and 12 contain 256, 1,024, and 3,072 segments per batch. At depth
4, the encoder is called 256 times on both sides: the count is unchanged, and
the cost per call moves. The baseline executes 2,048 `replaceAll` calls and
builds 256 intermediate arrays. The change uses two presence checks per segment
and builds the pointer in a loop. For plain paths it executes zero replacements;
for the fully escaped control it still executes 2,048. This measures the loop
and guards together, not their separate contributions or allocated heap bytes.

Short segments use `subject` followed by a level and row number. The long arm
repeats `subject` 16 times before those suffixes. The escaped arm uses
`subject~/` before the suffixes. These are synthetic distributions, not a
capture of deployed path frequencies. The size sweep asks about traversal and
character scanning; it does not recreate consumed-source counts or nested array
shapes.

## Measurement

Baseline: `a769e6d67708ef119f7a0bb41230f6831398a236`. Fixed: the same tree with
only `packages/memory/v2/path.ts` changed for the measured operation. Both arms
use identical benchmark bodies. Machine: Apple M3 Max, macOS aarch64, Deno
2.9.4. Other work was active on the host; this task ran no concurrent tests
during measurement. One-minute load during the ten Deno benchmark invocations
ranged from 9.19 to 12.05 at their starts. These absolute measurements are
diagnostic, not quiet-machine release numbers.

First, five fresh-process pairs ran in B/F, F/B, B/F, F/B, B/F order using:

```sh
deno bench --no-lock --json packages/memory/test/v2-path.bench.ts \
  packages/dashboard/machine-calibration.bench.ts
```

The median paired p75 speedups were 1.68x, 1.82x, and 2.00x for plain depths 1,
4, and 12; 1.28x for long segments; and 1.14x for escaped segments. The latter
two were inconsistent across pairs. The unchanged calibration bodies also moved
substantially between runs. Calibration at a different point in the process
cannot correct that phase-local contention, so normalized figures are not used
as the conclusion.

A second diagnostic reused the maintained benchmark bodies and their exact
start/end boundaries, registering each arm in one process. Each case warmed both
bodies 500 times, then ran 20 adjacent pairs of 25 batches per arm, alternating
B/F and F/B. Five fresh processes repeated that procedure, with no sleeps. Each
recorded sample is the average of 25 timed batches, in milliseconds. Each batch
still makes 256 encodings and lookups. This is a custom paired driver, not the
scheduled Deno p75 reporter.

Below, times are microseconds per batch, B / F. “Minimum” is the minimum of five
process means. “Trimmed” discards the lowest and highest process means on each
side, not individual inner samples. The ratio is the median of the five process
median paired ratios; parentheses show their range.

| Paths           | Minimum         | Mean            | Trimmed mean    | Paired speedup    |
| --------------- | --------------- | --------------- | --------------- | ----------------- |
| plain depth 1   | 38.09 / 23.04   | 77.14 / 46.25   | 84.82 / 50.58   | 1.67x (1.64–1.69) |
| plain depth 4   | 94.22 / 55.30   | 168.11 / 96.60  | 181.91 / 105.23 | 1.72x (1.69–1.75) |
| plain depth 12  | 247.99 / 146.15 | 356.97 / 208.92 | 372.79 / 218.72 | 1.72x (1.70–1.76) |
| long depth 4    | 206.68 / 134.41 | 227.58 / 146.90 | 224.13 / 146.13 | 1.54x (1.54–1.56) |
| escaped depth 4 | 288.71 / 292.01 | 374.96 / 374.63 | 383.67 / 385.00 | 1.00x (0.97–1.02) |

The paired ratios stay much tighter than the absolute means. Trimming does not
erase the short-path benefit, and the escaped control's 0.97–1.02x range
supports parity rather than a general speedup claim. The full Deno reports
retain `n`, `min`, `max`, mean and percentiles, including stalls; they are not
replaced by these summaries.

[Raw measurements](2026-09-14-encode-pointer.results.json) include both
measurement sets, initial smoke runs, load before/after each process, source
text and SHA-256 hashes for both encoders and the benchmark, and the original
capture scripts. Their absolute paths are capture provenance. The
[portable paired replay](2026-09-14-encode-pointer-replay.py) accepts checkout
and output paths at runtime. From a checkout containing the fixed encoder:

```sh
git worktree add --detach /tmp/pointer-baseline a769e6d67708ef119f7a0bb41230f6831398a236
cp packages/memory/test/v2-path.bench.ts /tmp/pointer-baseline/packages/memory/test/
python3 docs/history/development/performance/2026-09-14-encode-pointer-replay.py \
  /tmp/pointer-baseline . /tmp/pointer-pairs.json
```

Choose any unused baseline directory and output file; the driver resolves the
paths and requires identical benchmark bodies. Its transient driver lives
outside both checkouts; results go only to the requested output file. It
requires Python 3, Deno, and a Unix host with load averages. It preserves the
capture's five processes, warmup, pair ordering, batch counts, and timer
boundaries; it does not replay the separate Deno p75 runs. The two timing
methods have different harness overhead and must not be compared as an absolute
before/after pair.

## Semantics and remaining questions

The function remains the shared encoder for Memory wire paths and CFC logical
path keys. Tildes are escaped before slashes. Regression cases pin empty root
versus empty segments, literal escape tokens, repeated escapes, ordinary and
Unicode characters, and distinct Map keys; frozen inputs verify no mutation. The
CI benchmark lane includes the new file.

This does not settle the nested-array arm's remaining 5.9s versus 3.5s in Loom.
The earlier source-dedup fix removed a quadratic number of encoder calls; this
change reduces the cost of each remaining call. Its impact on current pane
startup requires a new deployed measurement.

The original profile's `isPrefix` frame also remains only partially attributed.
PR #7412 already indexed concrete dereference-trace coverage queries. The
consumed-label metadata index in PR #7460 removes full label-map scans for
concrete narrow reads. Wildcard metadata or wildcard queries still use the
shared prefix predicate over a scan, and broad reads can legitimately overlap
many entries. Other callers in `prepare.ts` use that predicate too. A fresh
profile and caller counts are needed before assigning the remaining deployed
frame to any of them; this encoder change makes no prefix-policy change.
