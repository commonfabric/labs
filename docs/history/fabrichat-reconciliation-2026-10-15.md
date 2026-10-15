---
status: historical
created: 2026-10-15
archived: 2026-10-15
reason: "Decisions and removal probes for PR 8235's reconciliation with main."
---

# FabriChat reconciliation with main

Dan directed another merge of `main` into the independent implementation in
PR 8235, accepting settled specification decisions, preserving meaningful
implementation differences, and reducing support changes outside FabriChat.
The branch started at `44ef95e21a`; the merge target was `96eb8d379f`.

The reconciliation adopted upstream private request outcomes, configurable
owner obliteration, title changes, thread summaries, container discovery and
membership, and separate manager-notification events. The manager, public
schemas, placement, and adapter implementations remained upstream's.

Authenticated message ownership, reaction-removal authority, exact submitted
text, refused-draft retention, profile-independent deletion and obliteration,
lifetime request and timestamp reservations, roster convergence, and the
independent fixed-window selector remained. Field-level message writes and an
explicit obliteration marker preserved writer boundaries and distinguished an
unreadable profile from a permanently removed author.

Upstream's shared message-rights helper was adapted to authenticated authorship
while retaining its moderation policy. Only the author edits or deletes;
the author can obliterate in a direct room; an owner can obliterate when that
room's policy allows it. A moderator's tombstone carries the moderator's
attribution and retains no author profile or history.

Two outcome gaps were addressed: refused requests remain terminal when replayed
with valid input, and a fresh request to obliterate an existing tombstone
completes without appending activity. The tests exercise these cases. The
moderation test uses distinct authenticated principals; the independent
same-profile impersonation test lives alongside upstream's direct-room test.
UI fixtures attest their profiles, and tombstone assertions inspect cleared
cell contents rather than mistaking an optional cell handle for a live author.

## Support changes removed

The handler reader-schema preflight patch was removed after the room-space and
participant convergence integration suites passed without it under both client
and server execution. Its isolated regression still exposed a general runtime
gap: a readable cell argument's selected field was absent from the preflight
read log. That gap was not established as a dependency of this FabriChat
implementation, so its patch, regression, and documentation were removed from
the branch together. The earlier merge commit preserves the extraction source.

Client-executed named-start stale-read recovery was also removed. The room-space
integration suite passed under both execution modes without it, and the
FabriChat suite exercised room creation and joining without requiring that
broader retry policy. Its dedicated regression and specification changes were
removed; upstream's recovery policy and tests were restored.

Four support mechanisms remained: synchronous builtin identity restoration,
cold access-list readiness with withdrawal lineage bookkeeping, embedded render
producer activation, and controlled submit-input retention. These arrange host
execution or restore the caller's existing implementation identity; no CFC
kernel function or decision changed.

## Remaining boundaries

The authenticated principal is available only inside handlers. Display rights
use the selected profile's attestation, so selecting another person's attested
profile can offer a control the authenticated handler refuses. An unattested
profile withholds author controls. The implementation documents this limitation
instead of claiming that display rights prove the viewer's identity.

Reaction removal still requires a readable profile to find its profile-keyed
record. The specification's profile-independent removal rule remains a gap.
Request expiration likewise needs a finite runtime redelivery guarantee, which
was not established; the branch retains lifetime reservations.

All existing compatibility baselines remain. The updated contracts passed the
existing compatibility rules without adding accepted-break exceptions. This
merge supplies no migration between the independent implementations' earlier
stored layouts.

## Validation

The final FabriChat pool passed all 39 files and 299 assertions. Untouched main
passed its 35 files and 270 assertions with the same shuffle seed, `20261013`.
An earlier branch pool reported a startup schema-rejection diagnostic in
`offers.test.tsx` despite passing its assertions. Focused runs on both trees
and the final full pools passed; the transient diagnostic was not explained.

The three-person browser messaging and reaction scenario passed with server
execution both disabled and enabled. Room-space and participant convergence
integration passed in both modes, including the removal probes described above.
The UI, HTML, runtime-client, and patterns package suites passed. Workspace
formatting, lint, type checking, FabriChat/Home pattern checking, 639
documentation code blocks, and history-index, conflict-marker, control-character,
CFC, append-only baseline, and test-alias gates passed.

Served cross-runtime runs continued to emit foreign-write refusal diagnostics
while passing their assertions. The earlier reconciliation established this
warning class on untouched main; this session did not repeat that comparison.

The full runner package suite passed 1,695 tests and 14,818 steps with zero
failures. The run reported one ignored step.
