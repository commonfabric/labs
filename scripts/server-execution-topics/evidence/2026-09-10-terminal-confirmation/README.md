# Terminal confirmation evidence

This snapshot verifies recommendation 1 against
`8814af62a7ddfd50262f3f2f98421f66519a3c95`, the head of prerequisite PR #7232.
The baseline and candidate ran the identical three workload files, adjacently,
on fresh real memory stores. The candidate applies `candidate.patch` to that
base. The manifest records source hashes, commands, Deno version, posture, cache
state, machine load, and exit codes. These are correctness and work-count
controls with the fake clock, not end-to-end latency trials. No shell runs in
these controls.

To reproduce, create two disposable checkouts at the recorded base. Apply
`candidate.patch` in the candidate checkout. In each checkout, copy the three
`.test.ts.txt` files to the paths in `manifest.json`, removing `.txt`. From
`packages/runner`, run the manifest's command with `ENV=test`. Deno 2.9.4 is the
recorded pin. Baseline must fail, and candidate must pass; inspect the
individual failures rather than treating any nonzero exit as reproduction.

The cold space chain has three actual addresses: baseline makes nine sync calls,
candidate six, and both retain three watches. The user chain with an absent
space-scope fallback makes fourteen versus eight calls, and retains six versus
four watches. Counts include both traversals. The eliminated middle loop
combined observed IDs with both scopes, adding two unrelated space-scope
interests in the latter fixture. Repeated covered syncs reuse subscriptions; the
six saved calls are not six saved watch requests.

The runnable creation fixture holds the second traversal after its actual root
sync, admits creation through a client runtime, and explicitly releases
publication through the real server. At every covering wave commit it reads the
durable root and derived document directly from the engine. It requires the
derived total to be 10. Baseline records `undefined` at watermark 2 for creation
during confirmation, across a deadline, and through a changed owning backlink.
Candidate passes these assertions. Separate sealed-root and unrelated
sealed-write cases pin shadow clamping and deadline liveness. A held native seal
is withdrawn in cleanup, including failed assertions.

The remaining controls cover actual traversal-sync failures, success and failure
after teardown, successor lease holders, terminal demand departure and return,
and same-ID backlinks across scopes under OFF/client and ON/serving postures.
True same-scope cycles remain rejected. Failure injection targets immediate read
transactions, so the removed middle sync loop is not mistaken for the second
traversal.

`baseline-output.json` and `candidate-output.json` preserve each complete UTF-8
output in `text`, with its decoded-byte SHA-256 in `rawSha256`. This keeps
terminal control characters escaped in tracked files. `SHA256SUMS` covers the
archive files themselves; verify with `shasum -a 256 -c SHA256SUMS` in this
directory.

## Mutation controls

Apply one patch from `mutations/` to the candidate checkout at a time, run the
corresponding command in `mutations/manifest.json`, inspect the named assertion,
and reverse that mutation before the next case. The first two mutations omit
intervening-write invalidation or move required retries after settle; their
creation controls fail because a covering watermark has no durable total.
Scope-blind cycle detection rejects the same-ID cross-scope chain. Omitting a
cancelled settle span fails the existing serving-loop timing-count assertion.
The before and after controls pass. The timing test observes the actual logger
completion event after teardown; it retains all original count assertions.

`final-source.json` identifies the reviewed source. `candidate.patch` and the
original pair remain a record of the initial implementation. The review
follow-up adds tenure cancellation while a structure loader is awaiting pattern
resolution; its separate patch and red/green outputs preserve that distinction.
The original baked runs do not validate this additional behavior.

## Baked integration controls

`integration-off` and `integration-on` record fresh-store runs of the same six
integration files: topic fixture and child contracts, onscreen creation, event
semantics, two-user voting, and cross-session chained-event gates. Each passed
seven suites and 27 steps. The unchanged OFF condition reports that the ON-only
event-consequence primitive does not run in that arm. The runner verified server
configuration, the client flag, and the baked shell define before each workload.
These runs are correctness evidence. Their load samples exceed the quiet
threshold, so neither is eligible latency evidence.

To replay, use a disposable checkout at the recorded base with `candidate.patch`
and copy `run-arm.ts.txt` and `seed-check.ts.txt` into
`tools/server-execution-topics/` without `.txt`. Build each posture with its
command from `integration-builds.json`, preserving each `dist/toolshed` output
at `.ci-cache/binaries/toolshed-baked-default` or
`.ci-cache/binaries/toolshed-baked-opposite`. The embedded build head names the
base; the manifest's production hashes identify the compiled patch.

Invoke `deno run -A tools/server-execution-topics/run-arm.ts` with the role
(`default` or `opposite`), a fresh absolute output directory, `correctness`, and
the Deno test arguments in that run's manifest. Substitute your checkout and
output directory for recorded absolute provenance paths. The helper chooses
ports, verifies posture, and closes its own server. The seed helper is captured
as supporting source but is not executed by this invocation. Complete statistics
remain at each summary's `sourceDirectory` with byte hashes; the summaries and
recoverable workload output are included here. Statistics from one scheduling
outcome are observations, not invariant cycle counts.

Earlier diagnostic probes, their narrower claims, invalid fixture attempts, full
validation logs, and the campaign ledger are retained under
`/Users/berni/.codex/artifacts/server-execution-topics-2026-09-09/`. The
portable files here replay the final controls without that machine. Quiet
three-pair latency verification remains outstanding. The separate historical
#7193 loader change has not had its marginal performance effect isolated.

## Replay helper contract

`recorded-source/run-arm.ts.txt` preserves the helper that captured the original
integration runs. Those OFF workloads explicitly set the client flag to `false`;
they establish OFF behavior, but do not establish client default resolution. The
top-level replay helper selects the lane's exact environment for both setup and
workload children with `clearEnv`, so a parent process's flag cannot leak into
the default lane. It rejects failed HTTP responses before reading metadata or
statistics. Full child environments are never written to manifests; only the
selected workload settings are recorded.

`integration-builds.json` uses paths relative to the checkout and retains the
original capture locations in `recorded-source/integration-builds.json`.
Generated binaries remain external artifacts. Each mutation row carries its
expected exit; the named assertion in its full output establishes why it failed.

The review controls live in `review-followup/`. Apply `review-followup.patch` to
its recorded base for the cancellation regression. For the red arm, apply only
the test-file hunk; the active-tenure case passes and the parked case must fail
because `runtime.start()` was called once. The green arm applies the whole
patch. Both use real compiled, durably stored patterns and the fake clock. The
existing successor-tenure and sync-failure controls remain enabled.

Run `python3 review-followup/verify-replay.py.txt . OUTPUT.json` from this
evidence directory to replay the 16 source-fragment controls. They execute real
child processes to check environment inheritance and synthetic HTTP responses to
check statistics rejection. They are harness controls, not pattern workloads.

The follow-up baked OFF/ON runs each pass seven suites and 27 steps using the
cancellation patch. Their matrix records deliberately conflicting parent flags:
ON for the default OFF run and OFF for the opposite ON run. Child posture
remains correct. The default client flag is absent; the opposite flag is `true`.
These fresh-store correctness runs are ineligible for latency claims. Build
commands, source hashes and binary hashes are in
`review-followup/integration-builds.json`.
