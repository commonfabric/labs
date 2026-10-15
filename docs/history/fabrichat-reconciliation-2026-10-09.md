---
status: historical
created: 2026-10-09
archived: 2026-10-09
reason: "Decision record for PR 8235's independent FabriChat implementation and its compatibility boundaries after merging main."
---

# FabriChat reconciliation with main

On October 9, 2026, Dan directed PR 8235 to merge `main`, preserve its independent
FabriChat implementation where reasonable, treat the revised FabriChat
specification as firm decisions except where it reveals a notable gap, and drop
unnecessary changes outside `packages/patterns/fabrichat`. The merge target was
`ff1994d664`, and the branch head before the merge was `a46723e32c`.

This record captures the compatibility decisions made for that reconciliation.
It does not describe an automatic migration between the independent
implementations.

## Retained room layout and request identity

The retained room consumes linked creation metadata and its own reviewed writer
policy. The other implementation's recorded contracts have a different `about`
cell shape or integrity policy. The acceptance registry names
`argument.about` only for the existing baselines that report those differences.
For three older branch baselines, the proof also reports the already-retired
`result.add` membership stream; those exact result paths remain accepted.

The retained room requires a sender-chosen `requestId` on protocol events, as
[the room output specification](../specs/fabrichat/ChatRoomOutput.md#streams)
requires. The implementation on the merge target permits omitted IDs and derives
an ID from the dispatch. That is a permissive implementation extension, and the
independent implementation retains the stricter specified protocol. Thirteen
room baselines report the newly required verb event field at
`result.$VIEWS.room.deleteMessage.requestId`, alongside the metadata difference.
The registry accepts those exact pairs and paths. It does not broadly waive
stream compatibility or authorize other new required event fields.

These differences already prevent an automatic update across the two room
storage layouts. An existing standalone piece needs an explicitly forced update
or recreation, with its prior data retained for a separately designed migration.
This reconciliation neither migrates nor deletes old stored documents.

## Narrow manager room references

The manager's index contains room references with the metadata needed to list
conversations. It does not project each linked room's rendering, writer streams,
or session windows through every index entry. This follows the accepted
[manager contract](../specs/fabrichat/ChatManagerOutput.md) and preserves each
reference's identity so a client can open the room under its own access.

Three branch-only manager baselines report removal of `$UI` or `$NAME` below
`result.$VIEWS.chats.direct.*.room`. The corresponding paths under Home's
`chatManager` affect only these four baselines:

* `20260930T023439Z-1pBKUK1T-dKGS4kd`.
* `20260930T194947Z-dvn-cmHzFRd8Igu0`.
* `20261001T015717Z-nO7yodw-u15L1y37`.
* `20261002T181229Z-HSDSXqacR5Zpy5Ks`.

All four were recorded only on the unmerged PR 8235 branch. None appears in the
merge target's Home baseline directory. The required-pattern override records
Dan's October 9 directive to adopt the current specification and its narrow
room-reference decision for these four branch contracts. It is not acceptance
of a new break against a published `main` Home contract.

## Bounds and evidence

Every old baseline is retained. New contracts are appended only after the
compatibility run has accounted for the reported breaks. Each new acceptance is
bounded by a pattern, an explicit list of old baseline labels, and the exact
schema paths reported by the proof. Obsolete entries for room policy and broad
index shapes are removed or replaced; unrelated accepted breaks remain intact.
The proof reports at most one issue per role, so the recorded paths identify the
reported boundary rather than exhaustively enumerating every difference between
two independent implementations.

Placement and adapter inputs keep the newer `addMember`, `addParticipant`, and
room `$NAME` capabilities optional at their consumption boundary. This avoids
requiring unrelated new fields merely to read or render an existing room. Their
producer contracts keep the capabilities required where implemented.

The focused verification command was:

```bash
mise exec -- deno task pattern-compat --only fabrichat --only system/home.tsx
```

The baseline-writing form adds `--update`; the final verification omits it so an
unrecorded contract remains a failure. The baseline append-only and historical
index gates check that evidence is retained and that this record is indexed.
