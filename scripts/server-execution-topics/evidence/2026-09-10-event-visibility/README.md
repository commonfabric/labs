# Event visibility evidence

These are clock-controlled correctness and mechanism observations from
recommendation 3 of the server-execution topics campaign. They are not latency
trials. The matched and mutation cases use fresh in-memory stores,
server-execution ON, and real serving runtimes over the memory loopback
transport. No browser shell participates in those cases. Dependency/compiler
disk caches remain populated. Manifests record commands, runtime, load, source
hashes, and exit codes; load exceeded the quiet-machine threshold in these
observations.

`baseline` and `fixed` use identical `matched-workload.ts.txt` bytes. Both start
from `a5ed830f06827ce1b9bc0dfbe0b6a023315f3268`; each `implementation.patch` is
relative to that commit. The baseline patch adds observation counters and their
types only. The baseline fails the watermark assertion after recording two
durable waves. The fixed arm records one wave containing both consequences and
passes. Neither arm fires a backstop before those observations.

To reproduce an arm, create a disposable worktree at the recorded base, apply
that arm's `implementation.patch`, create `packages/runner/test/executor`, and
copy `matched-workload.ts.txt` there as `visibility-matched.probe.ts`. From the
worktree's `packages/runner` directory, run the manifest's command with
`ENV=test`. Deno 2.9.4 is the repository pin for this snapshot. The expected
exit codes are 1 for baseline and 0 for fixed. The JSON observation printed
before the assertion is also saved as `results.json`.

`mutations` starts from the fixed patch. Each named mutation patch is relative
to that fixed source. Apply one in a fresh disposable checkout with the fixed
patch, copy `recorded-source/mutation-workload.ts.txt` to
`packages/runner/test/executor/visibility-mutations.probe.ts`, and run that
case's manifest command from `packages/runner`. Its final argument selects the
documented control case; the ordinary committed test suite runs every case. All
six mutations fail with an assertion, while `control-before` and `control-after`
run all nine cases and pass. `mutation-results.json` records those outcomes. A
mutation that passes has not reproduced this evidence.

`output.json` preserves each complete UTF-8 output stream in its `text` field,
including escaped terminal control characters. Its `rawSha256` hashes those
decoded UTF-8 bytes. This keeps the original output recoverable without literal
control bytes in tracked files. `SHA256SUMS` hashes the archive files
themselves; run `shasum -a 256 -c SHA256SUMS` from this directory to verify
them.

The full runner and integration logs, build provenance, and campaign ledger are
retained under
`/Users/berni/.codex/artifacts/server-execution-topics-2026-09-09/`. The compact
evidence here is sufficient to replay these mechanism controls without that
machine. The mechanism fixtures contain synthetic identities and empty event
payloads; integration payloads come from the checked-in test fixtures.

`integration-off` and `integration-on` record separate fresh-store runs through
the repository's baked-toolshed CI capabilities. Both ran the same six test
files (seven suites, 27 steps), including two-browser voting and cross-session
event gating. The manifests include server, client, and baked-shell posture. On
the OFF arm, the chained-event test reports that its event-consequence primitive
runs only under ON. This is an existing test condition.

To reproduce those integration runs, apply the fixed patch to the recorded base
and copy `run-arm.ts.txt` and `seed-check.ts.txt` into
`tools/server-execution-topics/` without the `.txt` suffix. The second file is
captured as supporting source by the runner; this invocation does not execute
it. Run the build commands in `integration-builds.json` from that checkout,
moving each `dist/toolshed` output into
`.ci-cache/binaries/toolshed-baked-default` or
`.ci-cache/binaries/toolshed-baked-opposite` before the next build. The build
metadata names the base commit; the recorded production-file hashes identify the
uncommitted implementation compiled over it.

Invoke the runner with the corresponding role, a new absolute artifact
directory, `correctness`, and the Deno workload arguments listed in the run
manifest. It chooses its own ports, verifies all three postures, and closes its
own server. The captured manifests' absolute paths describe the recording
machine; substitute the disposable checkout and fresh output directory when
replaying. The replay runner writes artifact locations relative to its manifest
and keeps resolved checkout paths, commands, and environment under `provenance`.
The collected statistics summarize that run, not a marginal latency effect. The
complete pre/post statistics remain in the named durable directories with hashes
in `stats-summary.json`; recoverable workload output is included here.

## Replay validation controls

`recorded-source` preserves the exact scripts used by the original manifests.
The top-level replay scripts reject a nonpositive or noninteger topic count, an
unsuccessful health-statistics response, and a selector that matches no mutation
case. The teardown control asserts that the response began after transport
settlement; it does not wait indefinitely on an unobserved response. The normal
fake clock holds positive-delay timers while `clock.settle()` drains transport
work, and the rescan cases explicitly tick their timer boundary.

`review-controls.json` records the top-level ten-case workload, all six original
mutations, two additional mutations, and an unknown selector. The legacy control
retains a consequenced, sequence-less entry, then admits the same ID through the
real server, which stamps a new sequence. Both new handlers run. Dropping the
numeric-sequence qualification from the separate twin-deduplication check makes
that control fail. The early consumed-entry checks instead match the exact ID
and sequence; they remain necessary when a consequence arrives during the
visibility response. The no-response teardown mutation fails its named assertion
without a timeout. Copy the top-level `mutation-workload.ts.txt` to the probe
path above to replay these cases, using the command and selector in each row.

`review-input-controls.json` evaluates the topic-count and statistics-handling
source fragments from both recorded and replay scripts with controlled inputs.
The 503 response is accepted and written by the recorded script; the replay
script rejects it before writing. This is a helper validation control and does
not seed a board or establish runtime correctness. Run
`deno run --allow-read --allow-write verify-replay-inputs.ts EVIDENCE_DIR OUTPUT`
to repeat it after copying the verifier to a `.ts` filename. The verifier reads
exact fragments from the archived source files, so the recorded source hashes
identify the code evaluated.

`review-manifest-control.json` records a fresh ON baked-server run of a trivial
Deno command to verify relative artifact addressing and provenance retention. It
tests the capture helper, not the topics workload or client rendering.

## CI discovery and complete teardown controls

The runner CI collector recursively includes `*.test.ts` files below the package
test directory. Relative paths distinguish equal basenames in separate
subdirectories. `runner-discovery.patch` includes the collector change and its
nested-file regression; apply it with `git apply --unidiff-zero` to the recorded
base with the fixed runtime patch. Run
`deno test -A tasks/select-runner-test-files.test.ts` from the root. The
discovery regression fails with the original collector and passes with the
patch. Existing shard weighting and exactly-once selection controls also pass.

`coverage-controls.ts.txt` contains fifteen event-visibility cases. Copy it to
`packages/runner/test/executor/space-server-event-visibility.test.ts` after
applying the fixed runtime patch. It extends teardown coverage to sidecar sync,
publication, and response boundaries, with success and failure after tenure
ends. Run the same focused Deno command used by the matched controls, naming
this test file instead of the probe. Every case asserts durable outcomes.

`coverage-discovery.json` contains the discovery red/green output, focused
coverage output, and the comparison against CI run 34454889755. The expanded
suite covers 25 lines omitted from that CI report. Merging its local LCOV with
the downloaded report yields runner debt 5,484, equal to that run's baseline;
the recorded CI report alone measured 5,509. This is a coverage diagnosis, not a
replacement for a successful CI run.

`verifier-path-controls.json` records relative-directory and absolute-directory
with spaces controls for the verifier captured at
6292fa2ba60d1ab3a4c92682cd7b90c63e91ddb4. A source mutation that accepts only
topic count 5 passes the earlier verifier from
6ac3f8a2624463be00a14eea4b22ca0fc17c6ccc but fails that captured verifier on
count 1. Commands and the verifier hash preserve the capture provenance.

`helper-review-controls.json` records the subsequent helper fixes, their exact
source hashes, synthetic LCOV inputs, commands, and outcomes. The count verifier
checks both acceptance and the returned count for default, 1, 2, and 5, and
rejects a missing replay declaration. A mutation that increments valid counts
passes the 6292 verifier and fails this verifier. Unchanged inputs pass with
relative paths and absolute paths containing spaces. LCOV controls cover UTF-8
paths under an ASCII locale, checkout ancestors named `tasks` or `packages`, and
unrelated source paths. Each control reproduces the earlier helper's failure and
passes with the recorded fix. These are helper controls, not latency trials.

`path-boundary-controls.json` records a further relocation guard. A captured
suffix containing `..` or beginning with `/` fails explicitly before either
report is written. Ordinary relative paths and redundant separators within a
relative path remain valid. The record names the earlier helper at f198bc7 and
both tested source hashes; the earlier helper controls retain their own hashes.

The LCOV inputs remain in the durable archive named in
`coverage-discovery.json`, with its SHA-256 and retrieval/normalization/scoring
commands. `coverage-inputs.sha256` lists every extracted input. The archive
contains all 228 CI reports and the focused report, so replay does not depend on
GitHub artifact retention. `merge-coverage-inputs.py.txt` reads and writes UTF-8
and relocates only paths under explicitly supplied capture roots. Pass both
`/home/runner/work/labs/labs` and
`/Users/berni/.codex/worktrees/topics-campaign-events/labs` after the
destination checkout argument, as shown in the manifest. Unrelated paths remain
unchanged; a matched source escaping its capture root is an error. The helper
produces both joined reports. The scorer is the repository's
`collectCoverageDebtMetricsFromLcov`, invoked by the exact JavaScript recorded
in the manifest. Report byte hashes depend on the checkout path; the expected
metric values do not.
