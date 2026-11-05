---
status: historical
created: 2026-09-18
archived: 2026-09-18
reason: "Fresh-store follow-up to the default-on browser timing observations."
---

# Fresh-store browser timing follow-up

The [initial browser matrix](../2026-09-18-default-on-browser/README.md) showed
a large timing gap between same-space and cross-space profiles at 1,184 votes
despite identical reactive read counts. Two additional benchmark runs used
independent fresh stores, reversed that pair's order, and retained the same
revision, client-execution posture, fixture, machine, and benchmark.

## Procedure

At revision `f3494fe9547d6589dad8e382e2392f14b8e0cebf`, run the matrix's
reproduction command with the `1184 votes` filter. Run `cross-space` first. Stop
the local servers, select a different empty memory directory, restart with the
same port offset and explicit client execution, then run `same-space`. No
repository validation or other benchmark was deliberately run concurrently.
Other machine activity was not controlled. The two runs remain ordered blocks,
not a randomized or repeatedly interleaved experiment.

Each run produced five diagnostic samples and four timed samples. Server
metadata and raw samples are preserved in [results.json](results.json). The
benchmark verified served-shell posture and voter-link location. These were
synthetic spaces; no live data was written.

## Results

| Profile location | Minimum (ms) | Mean (ms) | Maximum (ms) |
| ---------------- | ------------ | --------- | ------------ |
| Cross space      | 1,464.3      | 1,990.2   | 3,343.7      |
| Same space       | 1,366.3      | 1,499.2   | 1,724.4      |

All ten diagnostic samples exactly matched the original 1,184-vote counts: 70
completed reactive bodies, 2,409 proxy accesses, a largest body of 1,190
accesses, 2,620 stored-link traversal attempts, two successful event-commit
markers, and zero failed event commits. Both benchmark processes completed
without browser-error failures.

The cross-space minimum remained near its original observation, while the
same-space minimum rose from 474.5 ms to 1,366.3 ms. A growing shared store
cannot be the only explanation for slow observations: each of these runs used an
independent fresh store. Equally, the original timing gap cannot be attributed
to profile location from this evidence. The default-on path has stable reactive
read counts in these fixtures, but those counters do not explain the variation
in wall-clock time.

## Limits and next measurement

This pair narrows one possible confound; it does not isolate the root cause or
establish a latency distribution. Before publishing a comparative latency claim,
repeat interleaved arms with fresh stores and an unchanged control, and capture
separate interaction, event processing, commit, and rendering phases. Retain the
accounting boundary: reactive-body counts exclude handler reads and commit
preparation, and the timed interval includes browser/protocol overhead. Neither
this record nor the initial matrix qualifies eager-mode rollback or measures a
switch-retirement benefit.
