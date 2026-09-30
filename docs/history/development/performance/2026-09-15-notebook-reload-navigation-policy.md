---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Notebook reload test diagnosis against the existing speculative-navigation contract."
---

# Notebook reload and speculative navigation

This follow-up to the [reload diagnosis](2026-09-15-lazy-reload-diagnosis.md)
records an additional default-on failure and the policy that explains why a
reload test cannot assume the final Create leaves the notebook selected.
The baseline remained `8fbf93d524b1be62144c9adb60575627bdfbbc84`, with the
identity diagnostics at `72bd0b171f9e8053bf18b2476bee858d90b07908`.
All observations used synthetic local spaces; no live data was accessed.

## Evidence and contract

A default-on served run selected notebook
`fid1:GUqPNjoCcjwvovEMTolOSY8DlLoYrALMufZ_yuNWR8k`, then selected
`fid1:Kbpzv3BHyXBuQZTZ5R78Lo_GDpIyDV4a5mEZSqKXQLU` before the
source-state condition completed. It failed at that condition's five-minute
backstop. That condition read the current selection through notebook
accessors. This establishes that the wrong-selection failure also occurs with
lazy materialization enabled, independently of eager nullable-read errors.

Read-only inspection of the earlier eager run's synthetic store found the
notebook's `usedCreateAnotherNote` revisions false, true, then false, at
sequences 13, 28, and 49. Its session effects document had revisions only at
sequences 13, 15, and 16: the initial navigation, acknowledgement, and
retirement. It had no later authoritative navigation intent for the final
Create. The selected note existed in the durable store. These observations
are consistent with a divergent speculative navigation; they do not identify
the exact client read basis or establish that every earlier stall had this
cause. Temporary optimistic-navigation logging in another default-on run
observed the initial notebook navigation and a passing reload, not the
intermittent final-Create divergence. Runtime logging was restored afterward.

The governing [speculation contract](../../../specs/server-side-execution/speculation.md#2-what-may-speculate)
explicitly permits an optimistic navigation to stand when the authoritative
branch computes no navigation. It provides no withdrawal mechanism. The
existing notebook scenario in `packages/patterns/integration/default-app.test.ts`
already reads the captured notebook ID for this reason. The separate reload
scenario still followed the selected piece, which is not necessarily that
notebook.

## Test correction and boundaries

The reload scenario reads its source-state condition by the captured notebook
ID, waits for synchronization, selects that notebook, and waits for its seven
note chips before starting the reload measurement. After reload it still
requires the same notebook identity and all seven rendered notes. Selection
changes during setup therefore cannot redirect a notebook-data assertion to
a note, while missing source data, missing rendered notes, and a wrong reload
destination still fail.

This follows the existing navigation policy. Changing that policy would require
separate design work for speculative effect withdrawal. Disabling speculation,
weakening note-count assertions, or treating eager TypeErrors as expected test
success were not used. Timing collected with diagnostic logging is not a
performance comparison.

## Validation

The corrected served default-on scenario passed one test / one step in 24
seconds. A temporary diagnostic variant deliberately selected the space root
before the source-state wait; it also passed, in 18 seconds. The variant was
restored, so it does not change the checked-in scenario.

The corrected served eager scenario completed its seven-note render assertions
and printed its reload summary, then failed on the same `splitDefinitions`
browser errors in 20 seconds. Its temporary constructor default and environment
override were restored. The navigation setup correction does not make the eager
posture equivalent or suppress its errors.

An intermediate test setup used `app.setView`, which changes the selected view
without updating the URL. It rendered the notebook before reload but reopened
the note from that unchanged URL. The final setup uses the canonical shell
navigation event, which updates both URL and view. This failed attempt is
separate from the passing validation above.

The eager nullable-read failure and its rollback implications remain as recorded
in the earlier diagnosis. The flag-owner decision and the remaining matched
acceptance measurements stay open in the
[fast-follow plan](../../plans/lazy-materialization-fast-follow.md).
