---
status: historical
created: 2026-10-02
archived: 2026-10-02
reason: "Decision record for reconciling the two FabriChat implementations after PR 8412."
---

# FabriChat revised-spec reconciliation

Dan directed PR 8235 to merge PR 8412 and match its revised specification. He
explicitly distinguished that specification from the implementation merged
alongside it, confirmed that the latter falls short of the retained work, and
instructed the agent to retain system support needed for correctness.

The reconciliation retains PR 8235's protected internal manager state,
reviewed creation intents, resumable registration, separate authored message
and reaction documents, and scoped room references. It adopts creator-attested
metadata documents, optional direct-acceptance counterparts, explicit group
link sharing, and the manager's Home page-path hookup from the revised spec.

These implementations have different storage contracts. PR 8412's manager
accepts writable index and request state as inputs; the retained manager owns
protected state internally. Its room supplies metadata explicitly rather than
constructing default metadata without a reviewed creation event. Its placement
and adapter retain scoped cell references and offer optional linked facts when
a viewer cannot read the room. Room protocol mutations require request IDs.
The agent interprets the authorized implementation replacement as including
these FabriChat contract changes, rather than introducing an unprotected state
input or silently inventing creation metadata to satisfy the old signatures.

The accepted-break registry names only PR 8412's four FabriChat baselines and
the exact schema paths the compatibility proof reports. It does not exempt
Home's new baseline. All recorded baselines remain intact. There is no automatic
migration between the two storage layouts: an existing standalone piece needs
an explicit forced update or recreation, with its prior data retained for a
separate migration. The implementation does not delete old stored documents.

Correct stream-input variance also changes which removed membership field the
proof encounters first in snapshots from PR 8235. Their existing exceptions
continue to cover only the earlier decision to move membership into the
system; the exact reported paths are updated without extending the decision
to another baseline or to Home's published PR 8412 contract.
