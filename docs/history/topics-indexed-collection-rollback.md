---
status: historical
created: 2026-11-27
archived: 2026-11-27
reason: "Decision record for reverting the Topics board's move to an indexed collection (#10025) on the day it merged, so that it is rolled out after a test migration of the team's board."
---

# Topics indexed-collection rollback

#10025 moved the Topics board (`patterns/apps/topics/main.tsx`) from a list of
its topics to an indexed collection, and merged on 2026-11-27. It was reverted
the same day, at the owner's direction: the change has to roll out gradually,
starting with a test migration based on the team's real board on Estuary,
which had not been done.

## What the revert keeps

The pattern baselines #10025 recorded stay, as every baseline does
(`deno task check-baselines-append-only`). Five of them are contracts of the
collection board, which published two outputs the list-based board does not:
`board`, the collection's handle, and `adoptTopics`, the verb it carried while
in review. The accepted break in `tasks/pattern-compat-accepted-breaks.ts`
forgives those two paths over those five baselines, and nothing else.

## Disposition of deployed pieces

No board had been migrated to the collection board. The team's board on Estuary
was deployed and updated with `cf piece setsrc`, and its source log shows a
create and edits and no followed origin, so it ran the list-based board
throughout. A board that did roll forward to the collection board during the
hour it was on `main` holds a collection the list-based board does not read;
its topics, and the list it held them in, are where they were.
