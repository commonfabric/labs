---
status: historical
created: 2026-10-13
archived: 2026-10-13
reason: "Contract and implementation decisions for PR 8235's reconciliation with main."
---

# FabriChat reconciliation with main

Dan directed PR 8235 to merge current `main`, accept the FabriChat specification's
settled decisions, preserve meaningful differences in the independent
implementation, and adopt upstream code where differences were incidental. The
branch started at `2db0012367`; the merge target was `e2b27bfdae`.

The reconciliation adopted upstream room controls, participant views, automatic
joining and offers, rendering, and narrow placement and adapter contracts. It
retained authenticated-principal ownership, lifetime request memory, exact
message text, refused-draft retention, and fixed-window selection. The room's
separate documents provide the storage boundaries the independent implementation
previously arranged differently.

The manager adopted upstream atomic creation. Its single transaction includes
the room, grants, catalog entry, and terminal outcome, so the independent
implementation's continuation, pending-direct map, and creation intents no
longer solve a separate failure boundary. A changed-payload replay regression
remains; the test that deliberately withheld the added continuation was dropped.

Two additional probes exposed concrete gaps. Message ownership must survive an
unreadable author profile; an explicit internal obliteration marker distinguishes
that state from permanent removal. Separately, untouched `main` reproduced a
roster projection loop between readers with different profile access. Preserving
the query-backed roster array, instead of copying its profile links, settled
both client and served execution without changing the public contract. The
integration regression checks that no remote echo breaker intervened.

## Compatibility boundary

All existing baselines remain. The acceptance registry names only the exact
baseline labels and reported schema paths for the older independent
implementation. Every newly accepted baseline was checked to be absent from the
merge target's baseline directory. No new exception covers a published `main`
Home contract.

The old room metadata cell and writer-policy shapes differ from upstream's
shapes. Upstream exposes reaction tallies through placements rather than the
independent room's additional output. Placements and adapters use upstream's
narrow read projections, including optional creation metadata for an existing
space's own chat. Manager and Home projections adopt the upstream room-reference
and request-outcome shapes.

Dan's directive to adopt those contracts applies to the six unmerged Home
snapshots as well as to the FabriChat entries. Their accepted paths are recorded
individually. This does not supply an automatic migration of stored rooms or
managers between the independent implementations, nor remove any stored data.

The standalone `main.tsx` entry remains available as a starter for a social
space's conversation. Its registration control uses the root's room registry;
it does not install another default app or alter the upstream root's behavior.

## Retained support changes

The support mechanisms remained absent from the merge target: handler reader
schema preservation, synchronous builtin identity restoration, client-executed
named-start stale-read recovery, handler access-list readiness, embedded render
producer activation, and controlled submit input retention. Each carries a
focused regression.

Access-list withdrawal also required marking the aborted attempt as a rerun
before discarding its speculative follow-ups. Without that marker, successful
acceptance produced a warning about an abandoned follow-up. The companion
scheduler change preserves warnings for one-shot failures and proves that only
the rerun's follow-up is delivered, both within a space and across spaces.

These changes arrange host execution or conform to existing authorization
semantics; no CFC kernel decision or specification ruling changes. The retained
request memory addresses a FabriChat specification gap: neither client offline
queues nor served execution provide a finite maximum event redelivery delay.

The stream-event compatibility change was dropped: the upstream checker made
the same pass/fail decisions over all 153 recorded contracts for the six
reconciled pattern entries. Its general variance improvement is independent of
this FabriChat implementation.
