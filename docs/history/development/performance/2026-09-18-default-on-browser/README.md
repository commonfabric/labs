---
status: historical
created: 2026-09-18
archived: 2026-09-18
reason: "Pinned default-on browser and headless measurement evidence."
---

# Default-on lunch-poll browser measurements

Six mounted-browser cases completed at revision
`f3494fe9547d6589dad8e382e2392f14b8e0cebf`, with lazy materialization enabled
and client execution explicitly selected. At each vote-list size, same-space and
cross-space profiles produced identical reactive-body read counts in all five
diagnostic samples. This establishes a count baseline for the default-on path;
it does not establish an improvement over an earlier implementation.

## Setup and measurement boundary

The machine ran macOS on Apple silicon with Deno 2.9.4. The
[raw browser results](browser.results.json) preserve server metadata, resolved
CFC posture, five diagnostic samples per case, timing statistics in nanoseconds,
and the final artifact. CFC enforcement was `enforce-explicit`, with flow labels
off. The benchmark verified client execution in the toolshed, served shell, and
seeding process, and verified the space referenced by seeded voter links.

All fixtures were synthetic, with 14 options and 8, 24, or 87 voters for 74,
296, or 1,184 votes. No production space was written. One initially fresh local
store served the cases in this order: same-space 74, cross-space 74, same-space
296, cross-space 296, same-space 1,184, cross-space 1,184. The store accumulated
data across cases. Each case ran in a separate benchmark process.

Seeding, navigation, login, viewer selection, warmup, and diagnostic voting were
outside the timed interval. Diagnostic voting enabled read accounting; timed
voting disabled accounting and telemetry. Counts cover reactive bodies,
excluding handler reads and commit preparation. The timed interval includes
button interaction and rendered-update settlement, including browser/protocol
overhead. There were four timed samples per case.

## Reactive-body counts

Every diagnostic sample had two successful event-commit markers and zero failed
event commits. The benchmark completed without browser-error failures. Both
profile locations produced the following exact counts:

| Votes | Completed bodies | Proxy accesses | Largest body | Stored-link traversal attempts |
| ----- | ---------------- | -------------- | ------------ | ------------------------------ |
| 74    | 58               | 734            | 143          | 929                            |
| 296   | 52               | 1,062          | 302          | 1,249                          |
| 1,184 | 70               | 2,409          | 1,190        | 2,620                          |

The largest body still scales with vote-list size. These results do not claim
constant-time updates or elimination of whole-list work.

## Observed times

| Votes | Profile location | Minimum (ms) | Mean (ms) | Maximum (ms) |
| ----- | ---------------- | ------------ | --------- | ------------ |
| 74    | Same space       | 98.6         | 139.7     | 173.9        |
| 74    | Cross space      | 91.3         | 104.9     | 115.6        |
| 296   | Same space       | 133.1        | 140.2     | 155.3        |
| 296   | Cross space      | 141.9        | 152.7     | 164.3        |
| 1,184 | Same space       | 474.5        | 559.9     | 607.7        |
| 1,184 | Cross space      | 1,438.7      | 1,735.8   | 2,288.8      |

The largest cross-space case was slower despite matching reactive read counts.
The cause is not isolated: cases ran in ordered blocks against a growing store,
and unrelated documentation validation overlapped part of the measurement
session. These observations warrant investigation, but are not a controlled
estimate of the cost of cross-space links. Four samples do not establish a
latency distribution or a performance regression. A causal comparison needs
fresh stores and interleaved repetitions under otherwise matched conditions.

## Rendered artifacts

Screenshots capture the rendered state after the final timed vote of each case:

| Votes | Same space                  | Cross space                  |
| ----- | --------------------------- | ---------------------------- |
| 74    | [Screenshot](same-74.png)   | [Screenshot](cross-74.png)   |
| 296   | [Screenshot](same-296.png)  | [Screenshot](cross-296.png)  |
| 1,184 | [Screenshot](same-1184.png) | [Screenshot](cross-1184.png) |

## Separate headless evidence

On September 17, the same revision completed all nine headless fixture tests
with default-on lazy materialization and explicit client execution: nine passed,
zero failed, in 145,491 ms. The [headless results](headless.results.json) retain
the command and read windows. Those windows include render/rematerialization
work and are not equivalent to an update with the browser continuously mounted.
Do not compare the two sets of counts as measurements of the same operation.

## Reproduction

Check out the pinned revision and start an isolated local toolshed and shell
with a fresh memory directory and `EXPERIMENTAL_SERVER_EXECUTION=false`, using
[the local-server procedure](../../../../development/LOCAL_DEV_SERVERS.md). This
run used port offset 541, serving both API and frontend at port 8541. For each
size and profile location, invoke:

```sh
EXPERIMENTAL_SERVER_EXECUTION=false \
API_URL=http://localhost:8541 FRONTEND_URL=http://localhost:8541 \
CF_LOG_LEVEL=silent CF_READ_SCALE_PROFILE_LOCATION=same-space \
CF_READ_SCALE_ARTIFACT_DIR=/tmp/read-scale-artifacts \
deno bench --json -A --filter '74 votes' \
  packages/patterns/integration/lunch-poll-read-scale.bench.ts
```

Use `cross-space` for the other profile arm, and change the filter to
`296 votes` or `1184 votes`. Preserve stdout as benchmark JSON and stderr as
diagnostic records; use distinct artifact directories for each profile arm.

## Remaining evidence

This record covers default-on client execution at one pinned revision. It
contains no eager-mode comparison, server-execution timing, allocation or
retention measurement, or controlled before/after latency result. Switch
retirement remains an independent owner decision. The large cross-space timing
difference remains unexplained; read-count equality alone cannot close that
performance question.
