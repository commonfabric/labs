---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Recommendation 4 source-work verification and lifecycle regression snapshot."
---

# Sidecar source sharing verification

Recommendation 4's repeated source-resolution mechanism was reproduced on main
`e5298815118c7983a4b632336d0d8ded0e2d4405`. The candidate shares resolved source
for missing runtime-supplied pieces within one reconciler, keyed by destination
DID, full resolved source URL, and freshly advertised identity. Every piece
continues through its own open/reconciliation and compile/persistence path.
Existing pieces keep their owner-selected origin. This is a source-work
reduction; neither four compile entry calls nor the timings in this capture
mean four cold compilations.

The source snapshot is the recorded base plus `candidate.patch` with SHA-256
`248edfc03f42ecef4a83208b7d37231e0fc1ea7795757419f9d0dc9913a4ac36`. The compact
[evidence archive](../../../../scripts/server-execution-topics/evidence/2026-09-10-sidecar-source/README.md)
contains exact patches, manifests, per-slot results, hashes, and reproduction
instructions. Its external artifact index identifies the durable full logs and
original orchestration scripts. Nothing relies on session scratch.

## Controlled workload and results

Each variant ran the real `profile-create.tsx` source route in a fresh emulated
store and runtime for OFF, then another fresh store/runtime for ON. Actual
`experimental.serverExecution` and `servingPosture` were asserted in each arm.
There was no toolshed binary or browser in this probe. Deno was 2.9.4, matching
`mise.toml` in a fresh login shell. The route's identity endpoint was prewarmed;
compiler/storage state was fresh per arm and the dependency cache was retained.

Four distinct slots opened the same two-file source closure: three slots in one
space and one in a second space. Each slot was reopened to verify its existing
slot cache. Every destination's source closure was read after persistence. Both
variants used the identical probe, fixture and completion conditions. Full
source status and helper hashes were checked before and after each probe.

| Per execution arm | Baseline | Candidate |
| --- | ---: | ---: |
| Advertised identity requests | 4 | 4 |
| Source file requests | 8 | 4 |
| Source response bytes | 220,344 | 110,172 |
| `compilePattern` entry calls | 4 | 4 |
| Compiler cache misses | 2 | 2 |
| Compiler cache hits | 2 | 2 |
| Destination closure checks passed | 4 | 4 |
| Same-slot reopens doing no work | 4 | 4 |

OFF and ON gave the same counts. Each cold destination fetched 11,777 bytes for
profile-create and 43,309 bytes for profile-home. The candidate avoided both
same-space repeat downloads while retaining the second space's own resolution
and persistence. Identity checks still observe deployment changes. The request
and byte reduction was 50% for this four-slot workload; the three slots within
one space resolved their source once instead of three times. This is not a
size-scaling comparison between different board/citation fixtures.

## Correctness evidence and implementation decision

A bounded raw-source cache is justified by the reproduced redundant downloads.
It holds at most 32 entries and 4 Mi UTF-16 string code units, including keys and
program metadata; this unit is not retained heap bytes. Oversized programs are
served to current callers without retention. Source containers are copied for
compiler ownership; source strings are shared. No compiled pattern or schema
registry object is retained in this cache, and no per-runtime global registry
listener is added.

The red regression patch on the baseline failed 14 targeted assertions: repeated
and concurrent downloads, deployment revalidation combined with source reuse,
failure/retry reuse, identity mismatch eviction, late failure ownership,
container isolation combined with reuse, target/LRU and string-budget behavior,
persistence retry reuse, registry-epoch reuse, and three disposal cases. The
failures were the expected extra work or returned pattern after disposal.
Existing regression assertions remained enabled. The oversized-program and
shared-download cancellation controls passed on both implementations.

The candidate's source-reconciliation suite passed 94 steps, including an
additional warm-cache owner-origin control. The preceding combined source and
wish run passed six suites / 228 steps. Controls use explicit entry/release
signals and real runtime/storage/compilation. They cover:

- Fresh identities across deployment changes and distinct destination/URL keys.
- Concurrent source loads, download failure, identity mismatch, and retry.
- A failed old compilation completing after a new successful source load.
- Destination persistence failure, refusal, successful retry, and later reuse.
- Registry last-lease release while a real sidecar open is in flight; the
  replacement still compiles and persists while reusing source bytes.
- Disposal during initial sync, compilation, and a shared source download, plus
  synchronous disposal initiated by a caller-supplied fetch.
- Owner-selected origins with an already populated supplied-source cache.
- Entry-count and total-string limits, oversized bypass, and metadata ownership.

The initial persistence test assumed compilation returned before a failed
write-back; current compilation awaits persistence. That test premise was
corrected to require refusal, retry and durable readback. No persistence failure
was converted into a successful open. A child-name Deno filter selected zero
suites and was excluded from validation; the full suite supplied the red proof.

## Limits

Load was roughly 44–53 before/after these runs, far above the campaign's
one-minute-load threshold of 5. Source response counting also instruments the
request path. No elapsed-time claim is made, no quiet paired latency gate is
satisfied, and these counts do not establish a rendering or seeding speedup.
Full runner/package checks and baked ON/OFF integration lanes are separate
campaign gates; their current state belongs in the campaign ledger and PR.

Both variants emitted memory-client-closed pending-load diagnostics during
teardown. Their successful source and durable-closure assertions do not imply
an error-free shutdown. This probe does not measure event admission, replica
visibility, handler consequences, watermark coverage, multi-user fairness,
terminal confirmation, watch maintenance, or the flush deadline/grace. Those
remain separate controls in the campaign. It also does not quantify retained
heap cost or aggregate source traffic across a long-lived multi-space server.
