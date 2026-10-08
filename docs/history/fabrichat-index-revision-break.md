---
status: historical
created: 2026-10-08
archived: 2026-10-08
reason: "Record of the deliberate contract break taken when a FabriChat manager's index entry gained `revision`, as the manager came to list the rooms Home's shared-space catalog keeps."
---

# FabriChat: the manager lists the rooms the catalog keeps

A FabriChat manager's `rooms` is now a view over the user's shared-space
catalog, Home's: each saved `fabrichat-room` entry whose space's root is a room.
The manager keeps no list of its own. Forgetting a room archives its catalog
entry, at the revision the list the request came from showed, so a request to
forget names that revision, and each listed entry, a `ChatIndexEntry`, carries
it as `revision`.

## What the gate reports

The manager's `requests` argument holds each request's outcome, and a `done`
outcome holds the index entry it produced. The recorded entry left its extra
fields open, so a stored outcome's entry admitted a `revision` of any type. The
candidate types it as a string, which `deno task pattern-compat` reports as
`argument.requests.*` no longer accepting what it did, against the manager's
recorded baselines. No stored outcome holds a `revision`: nothing wrote one
before this change.

The manager's argument also no longer has `rooms`, its own list, which the gate
does not report, since an argument the candidate drops is one it doesn't read.

## What happens to what exists

- **Stored request outcomes.** Each still reads as it did. None holds a
  `revision`, so the typed field admits every one.
- **A manager's own list of rooms.** It is no longer read. A room listed only
  there, and not in the catalog, is not listed any more. Every room a manager
  created or accepted since it began registering rooms in the catalog is in
  both, and a room created earlier is listed again once the person opens its
  direct chat again or accepts it.
- **A forgotten room.** One forgotten before stays out of the list only if its
  catalog entry is archived. Forgetting did not archive it before, so such a
  room is listed again. Forgetting it now archives its entry.

## The decision

@danfuzz, 2026-10-05: "in general it's okay to break compatibility with
pre-existing fabrichat stuff. this system has not yet been deployed
'for realsies'". @danfuzz approved the sequence of changes bringing FabriChat
into Home's catalog, of which this is the last, on 2026-10-08.
