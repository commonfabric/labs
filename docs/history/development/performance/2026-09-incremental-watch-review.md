---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Recommendation 2 external-review corrections and diagnostic controls."
---

# Incremental watch review follow-up

This supplements the [initial report](2026-09-incremental-watch-maintenance.md)
and qualifies its removal-workload wording and integration evidence. The first
PR head was `f6bc2af1e36b5a3d817be75c1d3632bc964e3e37`, based on
`27f10d2d4f02f125c0492e5d6288acb3f0da148b`. The
[portable evidence](../../../../scripts/server-execution-topics/evidence/2026-09-10-incremental-watch/README.md)
includes these controls under `review/` and retains the original captured bytes.
No quiet-machine latency claim is established.

## Runtime and coverage findings

`StagedMap.changedKeys()` yielded a key twice after deletion or clearing followed
by reinsertion. A direct regression failed before deduplication and passes
afterward. Filtering removed keys already present in the change map preserves
work proportional to the delta on ordinary updates; clearing still enumerates
the old keys. Current watch-add consumers already collect these keys into a Set,
so the finding did not establish incorrect publication or invalidate the
recorded addition counts.

The reported unbound callback failure does not occur. The canonical tracker
stage creates an arrow closure, which descriptors forward. A detached callback
assertion passes with both canonical hashing modes. The reported descendant
retirement change would violate the current protocol: topology shrink does not
automatically retract delivered entities. The unchanged real-server regression
asserts no immediate or delayed removal. Absent-target interests still retire
when their last owner departs, and explicit watch replacement reconciles the
complete delivered set.

The resumed-session test resolves its entry promise synchronously before waiting
for release. Skipping that hook and returning fails the other race arm; a thrown
error propagates. This in-process test uses manual refresh and a deterministic
engine-access boundary. A delivery timeout would not prove a stronger ordering
contract.

CI run `34520545523` passed tests and both integration postures but failed the
coverage ratchet: memory 630 to 641 uncovered lines, utilities 142 to 143.
Comparing its LCOV reports with baseline run `34519469994` identified nine
memory lines in an unused whole-list merge helper and two client intent branches.
The indexed implementation removed the helper's last callers; the unused helper
was removed. A regression now preserves the last duplicate addition when graph
and operation declarations share an ID. Direct delta tests cover the utility
line. Unsupported content types are also checked without hiding the stored JSON
document. No coverage threshold, test selection, or enabled lane was weakened.

## Capture and replay corrections

The raw profile's `remove-one` step removes one delivered entity by replacing
the watch list, dropping two declarations: the covered-root duplicate and the
new-root watch. It measures complete replacement, not incremental single-watch
removal. The original probe, labels, counts, and patches are preserved.

The current arm runner requires clean committed source with no untracked inputs,
builds the requested posture before each run, and verifies that source did not
change during the build. It publishes a replacement binary only after successful
compilation and source checks. Ten isolated controls cover dirty source,
untracked input, stale binaries, failed compilation, and changes during build
under both postures. Failed cases retain the prior binary. A latency run also
requires the quiet-machine condition after compilation before workload launch.

The seed checker resolves an unset flag through the actual first-party default.
An expression control using the real environment parser covers unset, false,
and true under both possible defaults; the original unset case fails and the
corrected cases pass. This control checks posture interpretation separately from
seeding and durable-read correctness.

Replay manifests use checkout-relative paths. Exact original paths and commands
remain capture provenance in `external-captures.json`. The archived Python build
controller is a command capture, not a retryable tool: its failed-build path
would require restoring the renamed prior binary. Recorded builds succeeded;
the current arm runner's failure controls verify preservation of the old binary.
The deliberately opposite parent flag tests environment replacement; it does
not describe the resolved child posture, which the run manifests verify.

## ON integration diagnostics

Both original baked lanes passed seven suites and 27 steps. The ON log was not
error-free. It records 40 foreign-write refusals paired with 40 failed wave seals,
two home-identity scheduler errors, two non-settling warnings, three session
remounts, and two dropped contributions. These are not characterized as benign
or proof of successful seals.

An identical ON workload on the recorded baseline, with fresh store and freshly
built binary, also passed seven suites and 27 steps. It reproduced all 40
foreign-write refusals and paired seal failures, two non-settling warnings, and
three remounts. The refusal logs describe attempted cross-space writes lacking
delegated carriage; they predate this watch optimization. The baseline did not
reproduce the two home-identity scheduler errors or dropped contributions. Their
marginal cause remains unclassified; these scheduling-dependent counts are not
assumed invariant.

The test pass establishes the conditions asserted by those suites. Failed-add
atomicity is established by the deterministic real-memory snapshots, separately
from browser log counts. Full logs and statistics have durable locations, lengths,
and hashes in the external capture metadata; `review/health-comparison.json`
contains the compact counts and run posture. Latest-head CI and review remain
required before this PR is considered complete.
