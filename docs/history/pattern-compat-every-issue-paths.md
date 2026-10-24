---
status: historical
created: 2026-10-24
archived: 2026-10-24
reason: "Decision record for the accepted-break paths the pattern-update proof reported once it reported every issue in each role: which recorded change each group comes from, and why none of them is a new break."
---

# Pattern-compat: the paths every-issue reporting revealed

The pattern-update proof (`deno task pattern-compat`) reported at most one
issue per role (argument, result) for each `(pattern, baseline)` pair. Behind
the issue it reported, a role could hold any number of others, and an
accepted-break entry in `tasks/pattern-compat-accepted-breaks.ts` named only
the ones that had been reported. Once the proof reported every issue, 236 of the
301 pairs the registry names reported more: 14,455 issues where there had been
430, and 890 paths across 36 entries that no entry named.

On 2026-10-24 Dan ruled that an entry names exactly the paths its pairs blame:
the proof fails on an issue an entry does not name, and on a named path that
none of the entry's pairs blames. Under that ruling, a path the entry's own
record names goes into the entry, and the paths no record of the entry names are
recorded here, each beside the recorded change it comes from. 382 of the 890
paths are of the first kind and 508 of the second.

None of the 890 is an unrecorded break: each traces to a change whose break a
record decides. Some were hidden from the change that made them. #9206's scope
changes are the plainest case: they landed on manager, home, and room baselines
whose entries already named other paths, so the one-issue proof reported none
of them there.

## How each path was traced to its change

For every path, and for every pair of its entry that blames it, the trace found
the first baseline of that pattern recorded after which the current contract
stops blaming the path. The commit that added that baseline file is the change
that gave the path its current shape (READ: the issue lists of every recorded
baseline against the current contract, and `git log --diff-filter=A` on the
baseline files). Every one of the 890 paths traces to a change whose break a
record in `docs/history/` decides (READ: the commit that added each record, or
for `topics-crossref-identity-break.md`, which a later change added, the
change it describes).

A path counts as named by its entry's records when one of them names the field
the path ends in and was written for the change the path traces to. Those
records are the entry's `record` and any record its `reason` cites. Every other
path is listed below.

## The groups this record covers

Each group names the entry it joins, by pattern, the record that names the
entry's other paths, and the number of baselines. It then names the recorded
change its paths trace to, and the evidence that they share that change's cause.

### FabriChat room messages as pushed elements

- **Joins:** the four `fabrichat/room.tsx` entries citing
  `fabrichat-pushed-messages-break.md` (4, 31, 7, and 29 baselines): 94, 94,
  100, and 108 paths, 396 in all. The registry lists 94, 98, 104, and 112
  paths under those entries' pointer to this record, because the three newer
  entries also carry the four participant scopes of the per-user group below.
- **Change:** #8998, which that record decides.
- **Paths:** the `requestId` and `version` of every send, edit, delete,
  obliterate, and reaction verb's event; the `earlierVersions` and `editedAt` of
  the messages those events and the room's `messages`, `messageRights`, and
  threads carry, and the `reactions` and nested `replyTo.message` of a quoted
  reply; `openWindow`; `recentActivityExpiredThrough`. Each appears at
  `result.<field>` and again under `result.$VIEWS.room`.
- **Evidence:** every path traces to #8998's baseline (READ). The record states
  the parts of the room that change retired: the request memory a send was
  found by, the activity log with its numbering, and the message windows. The
  paths are those parts' fields, and the keyed record's fields its pushed
  replacement does not carry (INFERRED from the field names; the record names
  none of them).

### FabriChat views per user

- **Joins:**
  - `fabrichat/manager.tsx`: the entries citing
    `fabrichat-room-link-messages-break.md`,
    `fabrichat-index-revision-break.md`,
    `fabrichat-room-link-roster-break.md`, `fabrichat-view-scopes-break.md`,
    `fabrichat-max-attachments-break.md`, and
    `fabrichat-add-member-offer-break.md`.
  - `system/home.tsx`: the entries citing `fabrichat-view-scopes-break.md` and
    `fabrichat-add-member-offer-break.md`.
  - `fabrichat/room.tsx`: the three newer pushed-messages entries.
- **Change:** #9206, which `fabrichat-view-scopes-per-user-break.md` decides.
- **Paths:** `scope changed` at the manager's `result.rooms`,
  `result.people`, and `result.$VIEWS.chats.rooms`; at the same three under
  home's `result.chatManager`; and at the room's `participantEntries` and
  `participantPrincipals`, at the top level and under `result.$VIEWS.room`.
  31 paths in all.
- **Evidence:**
  - Every path traces to #9206's baseline (READ).
  - `git log -S` names #9206 as the change that declared the manager's
    `rooms: PerUser<ChatIndexEntry[]>` and
    `people: PerUser<Record<string, ManagerProfileCell[]>>` and the room's
    `participantEntries: PerUser<…>` (READ).
  - The manager publishes `rooms: core.rooms` and `people: core.people` beside
    the view holding the same two values (READ: `fabrichat/manager.tsx`).
  - The per-user record names the change at
    `result.$VIEWS.chats.people` and `result.$VIEWS.room.participantEntries`
    and gives the cause for all of them.
- **Why the masking mattered:** these are the hidden issues that made the
  manager's `outgoingNotices` per-user declaration unsafe to land against the
  one-issue proof. A new issue reported in front of a named path left that
  entry forgiving nothing.

### FabriChat request outcomes gaining `delivery`

- **Joins:** the `fabrichat/manager.tsx` entries citing
  `fabrichat-room-link-roster-break.md` (4 baselines) and
  `fabrichat-view-scopes-break.md` (1), and the `system/home.tsx` entry citing
  `fabrichat-view-scopes-break.md` (1).
- **Change:** #8726, which `fabrichat-add-member-offer-break.md` decides.
- **Paths:** the alternative not accepted at the manager's `result.requests.*`
  and `result.$VIEWS.chats.requests.*`, and at the same two under home's
  `result.chatManager`.
- **Evidence:** every path traces to #8726's baseline (READ). The record names
  `result.$VIEWS.chats.requests.*`, and the manager publishes
  `requests: core.requests` beside the view holding the same value (READ).

### Topics: the rehearsed break

- **Joins:** the `topics/main.tsx` entry citing
  `topics-demand-narrowing-break.md` (15 baselines; 22 paths) and the
  `topics/topic.tsx` one (14 baselines; 10 paths).
- **Change:** #6143, which that record decides.
- **Paths:**
  - `topics/main.tsx`: the members the board's published `mentionable[]` and
    `topics[]` stopped carrying; `result.setMyName`;
    `result.addTopic.agentName`.
  - `topics/topic.tsx`: the `agentName` that `addComment`, `addLink`, and
    `setBody` newly require; `result.comments[].authorName`; the widened
    `kind` domains of `comments[].author`, `links[]`, `links[].addedBy`, and
    `linkKindDraft`; the author alternatives at `bodyUpdatedBy` and
    `titleUpdatedBy`.
- **Evidence:**
  - Every path traces to #6143's baseline (READ).
  - The record states that narrowing the board's demand narrows what it
    publishes.
  - The entries' own comments state the rest: "the unsigned caller retires:
    `agentName` is required on every verb", and the change "opens the link
    and author `kind` domains" (READ).

### Topics: references by cell identity

- **Joins:** the `topics/main.tsx` entry citing
  `topics-demand-narrowing-break.md`, whose `reason` also cites
  `topics-crossref-identity-break.md` (15 baselines; 11 paths).
- **Change:** #5921, which `topics-crossref-identity-break.md` describes.
- **Paths:** the `crossrefs[]` row's `referencedBy`, `refsOut`, their `…Links`
  forms, `createdAt`, `createdBy`, and `lastActivityAt`; the index row's
  `referencedBy` and `refsOut`, and its `commentCount` and `lastActivityAt`
  alternatives.
- **Evidence:** every path traces to #5921's baseline (READ). The record states
  that the prose reference-graph row is gone wholesale and that an index row is
  the topic it describes (READ).

### Topics: the mention universe as an index

- **Joins:** the `topics/main.tsx` entry citing
  `topics-demand-narrowing-break.md` (6 paths), and the one citing
  `topics-mentionable-index-break.md` (2 baselines; 4 paths).
- **Change:** #6637, which `topics-mentionable-index-break.md` decides.
- **Paths:** `body`, `commentCount`, `createdAt`, `createdBy`,
  `lastActivityAt`, and `mentions` of `result.mentionable[]`.
- **Evidence:** every path traces to #6637's baseline (READ). The record states
  that `mentionable` became a derived index of two-string rows (READ), and
  these are the fields a row stopped carrying. The demand-narrowing record
  names some of the same fields as members the board kept, which is why
  naming alone did not settle them.

### Parking coordinator: an admin role names a profile

- **Joins:** the `factory-outputs/parking-coordinator/main.tsx` entries citing
  `parking-admin-floor-contract-break.md` (2 baselines; `name`) and
  `parking-admin-profile-subject-break.md` (2 baselines; `newName`).
- **Change:** #6311, which `parking-admin-profile-subject-break.md` decides.
- **Paths:** the `name` and `newName` of `result.togglePersonAdmin`'s event.
- **Evidence:** both trace to #6311's baseline (READ). The record states that
  a role stopped naming a person by name (READ).

### Lunch poll: identity by profile cell

- **Joins:** the `lunch-poll/main.tsx` and
  `lunch-poll/participant-identity-card.tsx` entries citing
  `lunch-poll-identity-break.md` (1 baseline each).
- **Change:** #5744, which that record decides.
- **Paths:** `result.participantProfiles`, `result.recentVisits[].loggedBy`,
  and `result.recentVisits[].votes[].voterLink` in the poll;
  `result.profileName` in the card.
- **Evidence:** every path traces to #5744's baseline (READ). The record states
  that identity moved from display names to profile cells (READ). These are
  the name-keyed fields that went with it (INFERRED from the field names).

### Loom: a panel's attested adder

- **Joins:** the `loom/main.tsx` entries citing
  `loom-panel-added-by-break.md` (2 baselines; 2 paths) and
  `loom-panel-attested-adder-break.md` (1 baseline each; 7 paths each).
- **Change:** #8432, which `loom-panel-attested-adder-break.md` decides.
- **Paths:** the alternative not accepted at `presentation.focusedPanel` and
  `presentation.stagedPanels[]` in both roles, at the same two in
  `result.setPresentation`'s event, and at `result.viewerState.selectedPanel`.
- **Evidence:**
  - Every path traces to #8432's baseline (READ).
  - `loom/schemas.tsx` types `stagedPanels`, `focusedPanel`, and
    `selectedPanel` as `Writable<Panel>` (READ).
  - The record states that `Panel` compiles to an `anyOf` whose branches the
    change narrowed.

### Witnessed chain: two levels

- **Joins:** the `cfc-exchange-rules/witnessed-chain.tsx` entry citing
  `witnessed-chain-two-level-break.md` (1 baseline).
- **Change:** #8158, which that record decides.
- **Path:** `ifc changed` at `argument.committed`.
- **Evidence:**
  - The path traces to #8158's baseline (READ).
  - The handlers type `committed` as `Writable<Sealed<Committed>>` beside
    `briefs: Sealed<Brief>[]` (READ: `witnessed-chain.tsx`).
  - The record states that the module's policy digest changed with any edit
    to the file, and with it the `ifc` of `argument.briefs[]`.
  - `committed` declares the same module's policy (INFERRED).

## Paths no pair blames

Nine named paths are blamed by none of their entry's pairs, even with every
issue reported. Under the same ruling, they fail the run and are removed:

- `topics/main.tsx`: `argument.topics[]`, `argument.topics[].createdBy`,
  `result.crossrefs`.
- `topics/topic.tsx`: `argument.boardCrossrefs[].referencedBy`,
  `argument.bodyUpdatedBy.kind`, `argument.comments[]`,
  `argument.mentionable[]`, `result.mention`.
- `collection-naming/board.tsx`: `argument.items[]`.

None was blamed by the one-issue proof either: the first issue in each role is
the same under both proofs for all 301 pairs (READ), so a path the every-issue
proof does not report is one the one-issue proof did not report.
