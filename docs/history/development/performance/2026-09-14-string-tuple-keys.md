---
status: historical
created: 2026-09-14
archived: 2026-09-14
reason: "Compared opaque string-tuple keys with JSON serialization at internal lookup sites."
---

# String tuple keys for internal lookup

Length-prefix encoding preserves each string and tuple boundary while reducing
work in two consumed-label keys. At 2,668 consumed sources, the shared helper
measured 1.25x faster with root labels and 1.20x with field labels. These are
synthetic collector results; neither a Loom startup improvement nor the remaining
nested-array shape gap was measured.

## Contract and migration

`@commonfabric/utils/string-tuple-key` accepts `readonly string[]` and returns
an opaque internal key. Each string contributes its UTF-16 length, a colon, and
its contents. This is injective for string tuples, including empty tuples, empty
strings, NULs, colons, and lone surrogates. The helper performs no nullable or
structured-value coercion. Caller types establish that every component is a
string. Key domains remain separate.

Nine sites were reviewed and converted:

- Two consumed-label source/metadata keys in `cfc/prepare.ts`.
- Document grouping in `data-updating.ts`.
- Compile-cache write coordination and recovery in `pattern-manager.ts`.
- Source resolution cache identity in `source-reconciler.ts`.
- Both shared link-chain keys in `stored-argument-validation.ts`.
- Pending invalid causes in `scheduler/invalidation.ts`.

The last three keys have exactly three address fields followed by one path.
Spreading that sole trailing path preserves its boundary because the prefix
width is fixed. Scheduler scope normalization stays `scope ?? "space"`. First
encounter order remains the insertion order of existing Maps and Sets. The
source cache charges key characters to its LRU budget, so its accounting changes
slightly with encoded length.

The review excluded `link-types.addressKey`, whose bytes affect externally
visible harness handles, and the collection-member key that contributes to
durable child IDs. Keys carrying clauses, objects, numbers, nullable identities,
or multiple variable-length arrays retain their existing encoding.

## Measurements

Baseline: `2953c5057f5cdc14b59bef74d2dd66ea1118c16d`. Apple M3 Max, macOS arm64, Deno
2.9.4 / V8 15.0.245.2-rusty. One-minute load readings at process boundaries
ranged from 11.72 to 15.16. No local test or type-check suite ran during the
paired measurements. Ratios carry the conclusion; absolutes include shared-host
contention.

The new maintained utility benchmark was run against a JSON implementation
before the helper changed. It encodes 256 distinct preconstructed tuples and
looks each up in a prebuilt Map, consuming hashing and deferred flattening.
Checksums and fixture construction are outside timing. The source case carries
a four-segment read pointer and an empty root-label pointer. This differs from
the exploratory 2,668-key fixture with two nonempty pointers, so their leaf
ratios are not interchangeable.

Five fresh processes compared the same maintained bodies with baseline and
candidate imports in one isolated baseline workspace. Each process alternated
arm order over 20 adjacent pairs. Utility cases warmed 500 batches per arm and
timed 25 batches per sample; collector cases warmed 20 calls and timed three;
scheduler cases warmed 100 calls and timed ten. The existing collector timer
boundaries and assertions were retained. Scheduler timing covers the complete
benchmark body, including taking and clearing the recorded causes.

Collector and scheduler comparisons substitute their respective candidate
modules plus the utility; other dependencies stay at baseline. They do not
measure the aggregate effect of every migrated site.

At 1,334 reads / 2,668 sources, source collection constructs 4,002 keys: one
metadata key per read and one key per source. Both arms do the same work count.
The scheduler constructs one key per incoming cause, including duplicate
restoration attempts. The change reduces per-key work rather than call counts.

Median of five process medians of paired baseline/candidate ratios:

| Case | Speedup | Range of process medians |
| --- | ---: | ---: |
| document | 1.285x | 1.265–1.298x |
| cache slot | 1.206x | 1.178–1.217x |
| source | 1.064x | 1.043–1.093x |
| escaped | 1.147x | 1.115–1.175x |
| unicode | 1.092x | 1.048–1.104x |
| root label 128 | 1.311x | 1.284–1.509x |
| field labels 128 | 1.258x | 1.218–1.268x |
| root label 458 | 1.333x | 1.286–1.381x |
| field labels 458 | 1.262x | 1.239–1.277x |
| root label 916 | 1.333x | 1.262–1.413x |
| field labels 916 | 1.293x | 1.241–1.321x |
| root label 1832 | 1.300x | 1.239–1.363x |
| field labels 1832 | 1.238x | 1.158–1.277x |
| root label 2668 | 1.254x | 1.210–1.357x |
| field labels 2668 | 1.202x | 1.158–1.232x |
| record 64 distinct causes on one node | 1.027x | 1.005–1.066x |
| record 64 causes, then the same 64 again | 1.058x | 1.036–1.066x |
| record 512 distinct causes on one node | 1.058x | 1.042–1.083x |
| record 512 causes, then the same 512 again | 1.056x | 1.053–1.092x |
| record 2048 distinct causes on one node | 1.026x | 1.010–1.034x |
| record 2048 causes, then the same 2048 again | 1.020x | 0.991–1.061x |

A separate diagnostic checked the short enumeration tuple made from two surfaces,
three scopes, and two modes: 12 identities, encoded and looked up 1,000 times
per batch. Five processes warmed 100 batches per arm and alternated 30 pairs.
Median paired speedup was 0.860x (process medians 0.858–0.885x), a regression,
so that conversion was excluded. This diagnostic ran concurrently with local
runner tests and is not part of the headline measurements. Its consistent
negative result supports retaining JSON at that site; it is not a general
threshold for choosing an encoder.

The scheduler is close to parity; these runs do not establish a substantial
scheduler improvement. Utility cases improve by different amounts depending
on tuple width and string contents. No single leaf multiplier describes them.

## Means, trimming, and minimum of five

Milliseconds per operation. Each process mean covers its 20 samples; trimmed
means remove the highest and lowest process mean. Minimum of five is the lowest
process mean, not the fastest individual sample.

| Case / arm | Mean | Trimmed mean | Minimum of five |
| --- | ---: | ---: | ---: |
| root label 2668 / JSON | 3.126 | 2.878 | 2.180 |
| root label 2668 / tuple | 2.466 | 2.315 | 1.752 |
| field labels 2668 / JSON | 5.168 | 4.487 | 3.606 |
| field labels 2668 / tuple | 4.291 | 3.719 | 3.088 |
| record 2048 distinct causes on one node / JSON | 0.585 | 0.585 | 0.418 |
| record 2048 distinct causes on one node / tuple | 0.593 | 0.596 | 0.453 |
| record 2048 causes, then the same 2048 again / JSON | 1.316 | 0.925 | 0.779 |
| record 2048 causes, then the same 2048 again / tuple | 1.222 | 0.904 | 0.770 |

The unchanged machine calibration accompanied the final Deno smoke run. That
smoke is only a benchmark validity check; it is not used to normalize the
adjacent-pair results. The raw Deno reports and all paired samples are retained.

## Reproduction and evidence

[Raw measurements](2026-09-14-string-tuple-keys.results.json) include the earlier
raw-join/guarded-join/length-prefix exploration, final paired samples, smoke
reports, capture scripts, source hashes, and the migration patch. Capture paths
are provenance. The [portable replay](2026-09-14-string-tuple-keys-replay.py)
accepts a baseline checkout, the fixed checkout, and an output file. It creates
a temporary baseline worktree, applies the recorded key patch to candidate
module copies, installs the captured utility from the fixed checkout, runs five
processes, and removes that worktree. The input checkouts stay unchanged.
The patch keeps dependency changes on later main revisions out of the replay.

The baseline must be at the commit above, and both checkouts must have identical
maintained collector and scheduler benchmark bodies. Git, Python 3, and Deno
are required. Run with user-chosen checkout paths:

```sh
python3 docs/history/development/performance/2026-09-14-string-tuple-keys-replay.py \
  /path/to/baseline /path/to/fixed /path/to/results.json
```

Unit tests exercise tuple collisions, copied/frozen inputs, and a corpus of
1,885 tuples spanning delimiters and UTF-16 edge cases. Scheduler regressions
check empty paths, embedded delimiters, duplicate suppression, and encounter
order. Existing consumed-label tests retain source identity and refusal order.

Local validation passed: the full runner suite (1,410 tests / 9,934 steps), the
full utils suite (103 tests / 893 steps), repository type-checking, formatting,
lint, documentation checks, and history-index checks. One existing runner step
was ignored. The portable replay completed five processes with 21 cases each;
that validation run is not used as additional performance evidence.
