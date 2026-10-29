---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Recommendation 3 event visibility and watermark observations during the server-execution topics campaign."
---

# Event visibility before deferral: recommendation 3

The admitted-entry visibility gap was reproduced on the current serving path.
It also exposed a correctness defect: a wave could durably advance the space
watermark over events it had deferred before queuing. An ordered publication
and replica response barrier recovered the tested entries in the first wave.
A retained visibility floor prevented overclaim when synchronization failed or
a sealed write still hid an entry. No end-to-end latency improvement was
established.

The source investigation was reviewed at
`8b34d4dab7ff064ef4d62fb79b0408472c3bf862`. Shared verification is recorded in
[PR #7229](https://github.com/commontoolsinc/labs/pull/7229). This implementation
started from `a5ed830f06827ce1b9bc0dfbe0b6a023315f3268`, after recommendation 5
reached green in [PR #7231](https://github.com/commontoolsinc/labs/pull/7231).
The branches were independent; this change did not incorporate recommendation
5's different caller-demand workload.

## Matched mechanism observation

Both arms used the same test source, Deno 2.9.4, a fresh in-memory store, two
raw scheduler handlers, and real memory sessions over the loopback transport.
The serving replica had already watched two absent sidecars. Manual fan-out
held admitted entries A and B out of that replica, at store sequences 2 and 3,
with initial watermark 1. A repeated admission of A was deduplicated. Both
admission notices were then delivered to the serving loop. The test clock
drained zero-delay transport and scheduler work while positive-delay timers
stayed fixed. Every durable wave was recorded before asserting coverage.

| Observation before any backstop fired | Baseline | Fixed |
| --- | --- | --- |
| Durable wave commits | 2 | 1 |
| First committed watermark | 3 | 3 |
| First wave's durable handler log | Empty | A, B |
| Events still pending under that watermark | A and B | None |
| Backstops armed / fired | 1 / 0 | 0 / 0 |
| Visibility barriers / recovered entries | Unimplemented | 1 / 1 |
| Budget-exhausted cycles | 0 | 0 |

These are the recorded outcomes of this controlled scheduling case, not
machine-load invariants for topic-board benchmarks. The fixed barrier covered
both queued streams with one response; the recovery counter named the first
entry that triggered it. The second entry was already visible when examined.
The baseline's second wave committed both consequences exactly once without
the backstop firing. Thus this control established an avoided deferral and
commit, but zero avoided elapsed 250 ms waits. The historical 17–22 deferrals
could explain roughly 4.25–5.5 seconds only if each avoided a distinct full
wait; they did not explain the entire noisy ablation difference.

The complete sources, exact patches, run manifests, raw observations, and
recoverable test outputs are in the
[portable evidence directory](../../../../scripts/server-execution-topics/evidence/2026-09-10-event-visibility/README.md).
The workload source hash is identical across the adjacent baseline/fixed arms.
The runs exceeded the benchmark quiet-machine threshold and make no latency
claim. No quiet three-pair latency series was completed for this recommendation.

## Contract and controls

The co-hosted server published the affected space's frames, then the serving
provider used its existing unconditional empty-root graph-query response.
Loopback frames were delivered in connection order, one per event-loop turn;
the replica consumed each preceding sync frame synchronously before the
following response. This was an application boundary, not a durability wait.
Pending local overlays could still hide a value, so the drain re-read the
store, recomputed the index by `(eventId, seq)`, and revalidated that identity
in the replica. It attempted this barrier at most once per drain pass.

On a remaining mismatch or failed sidecar sync, the earliest deferred
sequence constrained both input-head and derived-tail watermark advancement.
Arrival ordering remained a barrier across streams. A fresh scan recomputed
the floor, and parking cleared it. A visibility wait that outlived its runtime
returned a cancellation outcome to its wave. An initial broader cancellation
check also changed the unrelated root-source teardown path; the existing
root-ensure regression caught it, and the implementation narrowed cancellation
to the drain's own waits without changing that test.

Nine deterministic cases covered delayed application, two queued streams,
duplicate admission, publication failure, response failure, compaction during
the response, teardown during the response, an already-consumed entry, and
sealed unrelated/absent-entry/wrong-sequence writes. Some cases covered more
than one property. The shadow controls kept the watermark below the event
through repeated scans and recovered after withdrawing the overlay. The
unrelated sealed-write control completed while that write's verdict remained
pending.

Six exact mutations removed the barrier, watermark floor, sequence validation,
index recheck, or consumed-entry recheck, or replaced the response barrier with
a full durability wait. Each broke its corresponding regression; unchanged
controls passed before and after. No deadline, grace constant, test threshold,
execution lane, or server-execution default changed.

Both baked integration arms passed seven suites and 27 steps over identical
test files, with fresh stores and verified server/client/shell posture. They
covered topic fixtures, child citations and comments, rendered versus
unrendered creation, duplicate and rapid-fire events, two-browser voting, and
cross-session event gating. The ON-only event-consequence primitive retained
its existing explicit OFF skip. The ON run processed all 48 admitted events;
18 visibility barriers recovered 18 first-blocking entries, with zero
remaining visibility deferrals and zero backstops armed or fired. These were
run observations under load, not scheduling-invariant expectations or a
comparison against a matched baseline's elapsed waits.

## Measurement limits

The new event counters separated barrier attempts, recovered identities,
remaining visibility deferrals, scheduled backstops, and callbacks that
actually fired. Timer arms were not counted as elapsed waits. `waves` counted
wave closures, while `wavesBudgetExhausted` could include zero-commit cycles;
their ratio was not interpreted as a fraction of committed waves.

Cold board rendering, seeding, durable topic/citation correctness, and
cumulative performance remained separate campaign gates. This mechanism
control contained no topic fixture or browser and could not establish those
outcomes. The 30-topic and 100-topic fixtures retained their distinct citation
shapes; no size-only comparison was inferred from them.
