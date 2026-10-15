---
status: historical
created: 2026-09-30
archived: 2026-09-30
reason: "Decision record for adopting system-owned membership in the unmerged FabriChat implementation."
---

# FabriChat membership belongs to the system

Dan directed PR 8235 to incorporate PRs 8326 and 8330, specifically the revised
scope in which shared-space group management is a system facility. He also
instructed the agent to preserve system changes needed for correctness and to
avoid awkward workarounds.

The implementation therefore removed room-local roster, membership, leave,
and notice handlers, plus membership activity. Rooms read participants from the
system default app and retain message-author profile links. The manager creates
spaces with their intended genesis grants, and the system owns subsequent
membership changes. The atomic ACL mutation extension became unnecessary and
was removed; read-only access checks remained.

These deliberate removals break schemas recorded during this same unmerged
PR. The accepted-break registry names only those snapshots and the paths the
compatibility proof reports. Existing baseline files remain unchanged, and new
snapshots gate subsequent edits. The proof reports one issue per role, so the
removed `add` path also represents the other removed room membership streams.

The room contract is nested in Home's newly added `chatManager` field. The two
affected Home baselines were created in PR 8235; Home on main has no such field.
The agent interpreted Dan's explicit instruction to adopt the revised scope as
also applying to this nested contract, rather than preserving obsolete room
administration streams through Home. The required-pattern override records that
instruction and this interpretation. No baseline already on main is newly
exempted by this decision.

A piece installed from an earlier intermediate version of this PR needs an
explicit forced update or recreation. No automatic migration of its removed
room membership records is supplied. Spaces' authoritative ACLs are unchanged
by the code update.
