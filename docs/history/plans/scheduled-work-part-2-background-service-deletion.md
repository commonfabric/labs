---
status: historical
created: 2026-09-02
archived: 2026-09-24
reason: "Executed plan; Part 2 of docs/plans/scheduled-work-in-the-server.md, the deletion of the background piece service, landed with <cf-updater> retired as an inert element rather than deleted."
---

# Scheduled Work in the Server

## Part 2 — Deleting the background piece service

The inventory and the ordering constraints, so that the deletion can be scoped
as its own change.

### 2.1 This has been done once already

The v1 arc executed this deletion. The service was disabled under the flag in
`f945d1ed0` and deleted in `9c9513317`, a change of −6754 and +282 lines,
reachable locally on `upstream/codex/server-execution-flags-on`.

That branch is a v1 archive and is marked "do not merge", so the commit is not
a patch to apply. It is a worked inventory, and reading it saves rediscovering
the parts of the deletion that are not obvious. Two of its decisions are
recorded below because they were arrived at by finding out the hard way.

### 2.2 The ordering, and the premise to re-check

The ruling put the sunset before the flip. The flip landed first, with the
service still present, so the deletion is now a cleanup behind a shipped change
rather than a step ahead of one. What survives of the ruling is the half that
was never about ordering: the sunset does not wait for a replacement, because
the owner ruled the capability may lapse.

That makes one question live rather than hypothetical. A runtime under the flag
that is not the serving runtime — which is what the background service's worker
is — defaults to the speculation overlay and "thereby loses the
derivation-commit path by construction"
([`runtime.ts:538`](../../../packages/runner/src/runtime.ts:538)). The service
depends on that path when it starts a piece. It now resolves the default ON in
any ordinary deployment, so whatever that costs it, it costs it today.

The flip PR discharged the review finding that no gate exercised these binaries
in the ON arm. There is now a deployed-topology posture gate that runs the real
`bg-piece-service` binary against a serving toolshed
([`posture-gate.test.ts`](https://github.com/commonfabric/labs/blob/2b64d057adaf18bd283e0151656206b81e55cc06/packages/background-piece-service/integration/posture-gate.test.ts)),
and the service logs the posture it resolved. Read what that gate claims,
though: the binary starts, opens a session, reads and watches the registry,
reports ON, and shuts down cleanly on SIGTERM. It does not run a piece. Whether
a poll can still drive a `bgUpdater` handler to a durable commit under the
default arm is not covered by it, and is the open question above.

v1 did not rely on that structural loss. It added an explicit bail gated on the
flag, and the reason was specific to v1: a live background registration made
the memory engine refuse to acquire or renew an execution lease, so the service
structurally locked the executor out of every space it served. That machinery
does not exist in v2 — there are no references to it on main — so the v2
deletion does not inherit that reason, only the ordering.

**The premise holds, and nothing needs re-checking to confirm it.** The ruling
rests on "bgUpdater is not in practical use today", and there is no production
deployment for that to have stopped being true of. The v1 commit worried that
the registered set "is not derivable from this repo (it accrues as users
connect accounts)". Nothing has accrued, so the set is empty and the concern is
moot.

What remains is source-level. One pattern on main declares a `bgUpdater`
stream, a test pattern that exists to exercise the service. It is code
referring to a mechanism being removed, not users depending on it.

Note also that a `bgUpdater` stream is not only a polling target. A pattern can
wire its own `bgUpdater` to a button's `onClick`, so the same stream serves as
the manual refresh path. Deleting the service does not require deleting the
streams, and v1 did not delete them.

### 2.3 The servability oracle is empty

The ruling names a use for the service that expires when it does. Every piece
it runs today is a piece the executor must be able to run tomorrow, so its
workload would be a ready-made coverage list for the serving gap.

That instruction assumes a running deployment with a workload. There is none,
so the oracle has nothing in it and this step cannot be performed as written.

The pattern in §2.2 is the repository's own statement of what wanted background
execution, so it is the coverage list by default, and a weaker one — it is the
test pattern that exists to exercise the service. What it cannot tell you is
whether anyone actually ran it, or whether it ran successfully — a question the
service could not have answered reliably either, since its README records that
an updater doing asynchronous work returns while that work is still in flight,
so failures go unobserved. The oracle was going to over-report even when it had
something in it.

### 2.4 Inventory

The `packages/background-piece-service` package, including its worker,
worker-controller, and space-manager machinery, and the `bg-piece-service`
binary target in `tasks/build-binaries.ts`.

The `--bg-updater` arm of the local development scripts, the corresponding
sections of the local development documentation, and the package's entry in
`tasks/check.sh`.

The `gideon-tests/test-background-manual-trigger.tsx` pattern, which exists to
exercise the service.

**v1 kept two things this deletion can take.** Both were kept for reasons that
depended on a running deployment, and neither reason survives without one.

v1 kept the registry write side, moving `setBGPiece` out of the deleted package
into a new `packages/toolshed/routes/integrations/bg-registry.ts`, because
`POST /api/integrations/bg` had a live caller in the `cf-updater` element and
no-oping the write would have left that button reporting success while
registering nothing. With nothing calling it, the honest move is to delete the
route and the element together rather than to relocate a writer for a reader
that is also going.

v1 kept the registry data, because "the set of pieces that asked for background
execution is not derivable from this repo" and "a replacement
standing-registration mechanism will want it". Nothing accrued, so there is no
data to preserve and Part 1 inherits no registrations. It starts from the
declarations in the patterns themselves, which is where it should start anyway.

### 2.5 What the deletion buys

The deletion now retires machinery the flip had to build. The deployed-topology
posture gate exists to prove this binary resolves the right arm; a binary that
no longer ships needs no such proof, so the gate, the integration test, and the
startup posture log line go with it.

It also settles the §2.2 question by removing its subject. Deciding whether the
service can still commit under the default arm is only worth the investigation
if the service has a future, and it does not.
