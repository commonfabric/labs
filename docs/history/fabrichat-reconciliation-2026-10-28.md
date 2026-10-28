---
status: historical
created: 2026-10-28
archived: 2026-10-28
reason: "Compatibility-path audit for PR 8235's adoption of current upstream FabriChat contracts."
---

# FabriChat reconciliation with main, October 28

Dan requested another merge of current `main` into PR 8235, reconciling the
independent implementation with upstream progress. The merge target was
`fcc5fbd8b1`. This record covers the historical contract exceptions needed by
that reconciliation; it introduces no additional storage migration or new
decision to break a published contract.

## Why the registry needed more paths

Commit `71ed556a5d` (#9239) changed the pattern-update proof from reporting
the first issue in each role to reporting every issue. Its
[decision record](pattern-compat-every-issue-paths.md) explains the accepted
breaks updated on upstream. The code confirms that mechanism:
`patternSchemaIncompatibilities()` passes `everyIssue: true` for both roles,
and `checkPattern()` records each returned issue.

The independent branch's entries still named the paths reported by the earlier
proof. Checking the merged contracts exposed 3,206 additional findings across
54 pattern/baseline pairs: 48 in FabriChat and six in Home. Every baseline in
those pairs was verified absent from the merge target's baseline tree with
`git ls-tree`. Fifty-two pairs were already named by the branch's October 13
and October 19 reconciliation entries. The other two are the independent
room and starter snapshots recorded on October 19.

## Tracing the findings

The audit ran the current `checkPattern()` over each failing baseline against
the latest recorded contract of that pattern preceding October 20. This uses
the repository's proof and baseline decoder, including its schema handling;
it does not infer compatibility from field names. These were the comparison
contracts:

| Pattern | Baseline label |
| --- | --- |
| `fabrichat/adapter.tsx` | `20261015T201314Z-TR5TLvdbxAVDCGs6` |
| `fabrichat/main.tsx` | `20261019T214004Z-iJsFUOiqI0Xu7gYU` |
| `fabrichat/manager.tsx` | `20261018T181023Z-H3M1K82AIA1y33AS` |
| `fabrichat/placement.tsx` | `20261015T201316Z-Gxmw-PP95cYaf4iF` |
| `fabrichat/room.tsx` | `20261019T231845Z-Vj5dqYA2toFthDOE` |
| `system/home.tsx` | `20261019T231846Z-a4jCOmx9encoFZ6S` |

Of the added findings, 2,694 already blamed the same paths against those
contracts: 2,228 in FabriChat and 466 in Home. They are the additional paths
of the changes accepted in the
[October 13 reconciliation](fabrichat-reconciliation-2026-10-13.md) and
[October 19 reconciliation](fabrichat-reconciliation-2026-10-19.md):

* Narrow placement, adapter, manager, and Home room projections; optional
  creation metadata; the upstream request-outcome and room-reference shapes;
  and the independent starter's retired direct outputs.
* Pushed message and reaction policies; retired message versions and request
  IDs; removed message windows, request outcomes, and activity outputs; and
  the same fields inside stream events and nested room projections. These
  follow the [pushed-message decision](fabrichat-pushed-messages-break.md).

The remaining 512 findings are exclusively the following already-recorded
upstream changes. No other newly reported path remained after the comparison:

* Removal of `replyTo.message`, at each published message and event position,
  follows the [split-reply decision](fabrichat-reply-split-break.md). The
  independent starter exposes the room directly and as a view, so the same
  removal appears under both projections.
* Changes to the room's `participantEntries` and `participantPrincipals`
  scopes, including their starter projections, follow the
  [per-user view decision](fabrichat-view-scopes-per-user-break.md).
* Changes to manager `outgoingNotices`, both directly and through its chat
  view, and the same fields under Home's `chatManager`, follow the
  [outgoing-notice scope decision](fabrichat-outgoing-notices-per-user-break.md).

## Bounds of the accepted paths

The registry preserves the earlier decision references and supplements their
reasons with this record. It splits entries whose baselines blame different
path sets, so each pair names only its reported paths. The six Home snapshots
retain the existing October 13 required-pattern override; no new override
accepts a break against a published Home contract.

The two newly named October 19 snapshots accept only the reply and participant
scope changes: 34 paths for `fabrichat/room.tsx` baseline
`20261019T214006Z-m9tZWT1Hv_VqoyvL`, and 51 for `fabrichat/main.tsx`
baseline `20261019T214004Z-iJsFUOiqI0Xu7gYU`.

Every historical baseline and existing historical document remains intact.
No exception names a new snapshot recorded by this reconciliation. Such
snapshots remain subject to the ordinary compatibility gate on the next
change, and an unlisted path against any older snapshot still fails.
