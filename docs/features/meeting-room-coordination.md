# Shared meeting creation decisions

`packages/patterns/meeting-rooms/main.tsx` is a headless pattern that retains
one creator and one space allocation per calendar occurrence. Its handlers
make decisions in the directory's own space. A daemon prepares the selected
space and delivers invitations; Home records each person's membership.
This pattern alone does not enable calendar automation.

## Deployment and authority

All participating daemons must use the same configured host and pattern
instance. Deploy into an explicitly chosen space with an explicit access
list. Readers can see meeting-key/creator/space associations. Writers are
trusted to use the protocol: the handler's actor checks do not prevent a
space writer from modifying underlying cells directly. This is coordination
among cooperating alpha clients, not an adversarial election service.

The key is the lowercase SHA-256 of the canonical calendar occurrence
identity used by CFS: normalized organizer email, iCalUID, and normalized
original recurrence start (empty for a one-off). Account IDs, copy-local
event IDs, title, current start, roster and video URL do not select a room.
A hash is not a secret: someone with the event inputs can compute it.

Stored records contain `creator`, `attempt`, `state`, and optional
`allocation: { space, publicationSeed }`. The allocation uses the directory's
host. `publicationSeed` is a public stable root cause, not a signing key or
invitation secret. Calendar titles, rosters, account names, local paths and
bearer invitations stay outside both records and handler payloads.

## Protocol

1. Persist an opaque attempt identifier, then send `reserve` with `meeting`
   and `attempt`. A missing key becomes `reserved` under `currentPrincipal()`.
   An existing key returns `existing` and keeps its creator and attempt.
2. Await the handling transaction's committed receipt. Only the recorded
   creator proceeds, using the retained attempt even on another device.
   After an unknown outcome, retry or resolve committed state. A tentative
   handler result or reactive observation is not permission to provision.
3. Allocate a random space owned by that creator, reserving only the root
   **cause**, with no source. For CFS's root, the cause is the JSON encoding
   of `{ purpose: "loom-publication-root", publication: publicationSeed }`.
   A source-free reservation makes `ensureSpaceRootPattern` return
   `awaiting-creator`. Omitting the reservation can create a default app;
   including a source can create a Loom before the allocation is selected.
4. Send `allocate` with the retained attempt and candidate allocation. The
   first allocation commits as `allocated`; a matching replay is `existing`;
   another target is an `allocation` conflict. Read the committed winner.
   An unsuccessful candidate remains an empty space with a root reservation.
   Never provision it, add panels, register it in Home, or send invitations.
5. Provision and prepare only the selected space with its retained root
   cause. The client verifies its host, ownership, reservation and root.
   The pattern validates metadata; it does not verify remote space contents.
   Concurrent creator devices must use idempotent preparation operations.
6. The creator sends `publish` with the original attempt after preparation.
   `ready` means that creator reported readiness. Consumers independently
   validate access and Loom kind before adopting. Publication does not itself
   grant access or imply invitation delivery.

`reserve` replies with `reserved` or `existing`; `allocate` with `allocated`
or `existing`; `publish` with `published`. Conflict reasons are:

| Reason | Meaning |
| --- | --- |
| `missing` | No retained creation attempt exists. |
| `creator` | The authenticated actor is not the retained creator. |
| `attempt` | The request names another creation attempt. |
| `allocation` | A different allocation already exists, or readiness was requested before allocation. |
| `unsupported-state` | A valid record uses an unfamiliar lifecycle state. |
| `malformed-state` | Stored metadata cannot be interpreted safely. |

Conflicts preserve the record. Invalid request identifiers throw before
mutation. Additional stored fields survive transitions. Clients should read
with a broad schema and validate the result, so schema filtering cannot make
malformed occupied records look absent.

There is no release, lease expiry, automatic takeover or deletion handler.
Cancellation and disabling must keep the association. A lost creator or an
unusable selected space needs recovery; it does not authorize a replacement.
Coordinator unavailability holds new creation. Changing its address is an
explicit migration, including existing series rooms and old automatic
creators that do not participate in this protocol.

## Transaction boundary and verification

Fabric's cross-space transactions commit per space without rollback across
spaces. A pattern calling `Loom.inSpace(name, { root: true })` while claiming
a meeting can write a child before its directory commit conflicts. This
protocol keeps each decision in one space and defers all useful room content
until the chosen allocation is committed. It permits orphan genesis records,
not duplicate prepared meeting rooms.

The pattern test exercises lifecycle/replay behavior. The integration test
uses the real compiled pattern, authenticated independent runtimes and an
ACL-enforcing memory server. Its barrier makes both contenders evaluate
before either commits, for both creator and allocation races. It also checks
restart/replay, actor and attempt checks, future/malformed state preservation,
and source-free reservations under the server's root ensurer.

Run the authored test with `cf test packages/patterns/meeting-rooms/main.test.tsx`
and attach it with `--test packages/patterns/meeting-rooms/main.test.tsx` on
every `piece new` or `piece setsrc` deployment. Run the runtime contract tests
with `deno test --no-lock --shuffle=20261007 --no-check -A
packages/patterns/integration/meeting-rooms.test.ts`.
