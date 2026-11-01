# Server Execution by Consent

## Status

Design sketch. Nothing here is implemented. It is written against the serving
loop's lease
([`server-side-execution/serving-loop.md`](server-side-execution/serving-loop.md)
§2), the admission table and the `actingAs` binding
([`server-side-execution/protocol.md`](server-side-execution/protocol.md) §2
and §2b), and the proof chains of
[`profile-delegation.md`](profile-delegation.md) as
[`memory-v2/04-protocol.md`](memory-v2/04-protocol.md) §4.5.1 admits them. It
changes the shape of a space's access-list document, which "Rolling out the new
form" covers.

## The problem

Whether a space is served is the deployment's decision. With the
`serverExecution` flag on, a toolshed's process identity is a delegating
principal (`memoryAclPrincipalsFor` in
`runtime/toolshed/lib/server-execution-flag.ts`), its serving runtime takes the
lease on any space with demand, and its sessions carry
`actingAs: "space-owner"`, which the memory server resolves to each space's
access-list owner for every READ-class decision. The owner of a space is never
asked. A person who trusts one application service provider (ASP) to run their
spaces and not another has nowhere to say so, and an operator who serves a
space cannot show that its owner agreed.

## The design in one paragraph

A space's owner issues a delegation over the space to the execution identity of
the ASP that is to serve it, and records it in the space's access-list document,
beside the access list itself. The service identity already reads that document
in every space, so an executor learns from the space whether it may serve it.
An executor serves a space only while such a delegation stands: the memory
server grants the space's lease, and admits the executor's served reads and
derived commits there, only to a holder whose service identity a delegation in
the document names. A space with no delegation to an ASP is not served by it,
and runs in its members' runtimes as it does with server execution off.
Removing the delegation ends the service. A person delegates only to the ASP
they choose to run their spaces, and only for the spaces they choose.

## What it guarantees, and what it does not

The delegation does not keep a space's data from the operator holding its store.
That operator has the bytes, and the memory server it runs admits the principals
in `MEMORY_SERVICE_DIDS` as OWNER of every space before reading any access list.
Against that operator, the delegation is a record of consent, and an honest
operator's server enforces it.

It becomes a guarantee where storage and execution are run by different parties:
an ASP that does not hold a space's store cannot serve the space without the
owner's delegation, because the memory server that does hold it checks the
delegation before granting the lease. The routed memory work and the sharded
deployments it anticipates are that arrangement. The same delegation is where a
later encrypted store would decide whether an ASP receives keys.

In every arrangement it is an audit record: each served read and derived commit
traces to a delegation the owner issued, which the memory server already records
with the session's authorization.

One condition makes any of this hold: **an executor's identity is never a
service DID.** A principal in `MEMORY_SERVICE_DIDS` holds OWNER everywhere
without a delegation, so a delegation would narrow nothing against it. Today
the process identity is kept out of that list by default
(`server-side-execution/protocol.md` §2b); under this design that is a rule the
toolshed refuses to start without.

## Terms

- **ASP**: an application service provider, the party that runs executors for
  spaces whose owners chose it.
- **Executor identity**: the service identity an ASP's serving runtimes act as.
  It is the service-identity half of a lease holder (serving-loop.md §2, DR1);
  the per-process half is a name minted at process start, not a key.
- **Consent delegation**: a delegation from a space's owner to an executor
  identity, over that space, that authorizes the executor to serve it.

## The delegation

| Field | Value |
| --- | --- |
| `iss` | the space's owner, as its access list names it |
| `aud` | the ASP's executor identity |
| `sub` | the space |
| `cmd` | a read-class command path (see "Reads stay read-only") |
| `pol` | empty |
| `exp` | `null` by default: consent stands while the access-list document holds it |

Who issues it follows from who owns the space:

| Space | Issuer | Chain |
| --- | --- | --- |
| Home | the person, whose identity is Home's DID | person to executor |
| A space a person owns | that owner | owner to executor |
| A profile | the profile's key, at creation (see "Profiles") | profile to executor |
| A social space with several owners | any one owner (an open question below) | owner to executor |

The audience is the executor identity rather than a process, so a deployment
that rotates or adds processes changes nothing a space holds. If an ASP's
processes come to sign with keys of their own, the executor identity delegates
onward to each, attenuated and with an expiry, and the chain gains a link that
the ASP holds and the space does not.

## The access-list document

A space's access-list document is `of:<space>`, the id `aclDocId` in
`runtime/memory/acl.ts` builds. Its value today is the access list itself, a
map from a principal to its capability:

```json
{ "did:key:z6MkOwner": "OWNER", "*": "READ" }
```

Under this design the access list moves down a level, beside the space's
consent delegations and its revocation list:

```json
{
  "acl": { "did:key:z6MkOwner": "OWNER", "*": "READ" },
  "delegations": [["<envelope>", "..."]],
  "revocations": ["<cid>"]
}
```

`delegations` is a list of chains, each a list of delegation envelopes exactly
as their issuers encoded them, root first. A space with no consent delegations
holds an empty list or no `delegations` key. `revocations` holds the CIDs of
delegations the space refuses, and nothing else
([`profile-delegation.md`](profile-delegation.md), "Rotation and revocation");
a space that refuses none holds an empty list or no `revocations` key.

Both live in the value rather than in a sibling metadata field of the
document, beside `cfc` or `result`. Metadata fields are delivered and followed
by rules of their own
([`memory-v2/01-data-model.md`](memory-v2/01-data-model.md),
[`memory-v2/05-queries.md`](memory-v2/05-queries.md) §5.3.2), and consent is
access-list data: it takes the access list's validation and write rules, and
leaves the metadata rules as they are.

**The two forms are told apart by their keys.** Every key of a legacy list is
`"*"` or a DID (`isACLUser` in `runtime/memory/acl.ts`), and none of `acl`,
`delegations` and `revocations` is either. A value with an `acl` key is the new
form; a value whose keys are all principals is the legacy form, read as the
`acl` of a space with no consent delegations and no revocations. A value
holding a principal key beside any of those three is malformed, and fails
closed as a malformed list does today. A reader of the new form reads `acl`
exactly as it reads a legacy list and ignores keys it does not know, so a field
added later reaches readers that predate it without making them fail closed.
The server's validator for genesis and access-list commits knows every field
and refuses any other.

**Writing it is unchanged.** A change is an access-list commit: a single
whole-document `set`, by an OWNER, in a commit of its own (INV-12 in
[`memory-v2/09-invariants.md`](memory-v2/09-invariants.md)). The validator
additionally verifies that every chain in `delegations` is over this space,
with links that meet and signatures that hold, and that every entry of
`revocations` is a CID. A writer that changes membership replaces `acl` and
keeps `delegations` and `revocations` as they stand, as the writers already
keep the document's sibling fields (`writeAcl` in
`runtime/runner/src/acl-manager.ts`, and the served access-list change in
`runtime/memory/v2/server.ts`). A genesis commit may carry `delegations`, so a
space can be born with its consent, as a profile is (see "Profiles").

**Reading it needs nothing new.** The service identity may read a space's
access list and nothing else in its own name; every other served read runs as
the space's owner (the OW31 ruling, in
[`server-side-execution/verification-coverage.md`](server-side-execution/verification-coverage.md)).
The consent delegations are part of that document, so the ruling covers them:
the memory server reads them when it decides the lease, as it reads the access
list today, and the executor identity may read them under the same ruling to
learn whether it may serve the space. A principal with READ reads the document
as it reads any other, so it reads the chains too. They disclose the space's
owners, whom `acl` already names, and which executors serve the space.

If the document is written only by an OWNER and consulted by the server, an
entry already shows that an owner consented. The signature adds what a document
write does not: the bytes alone are verifiable away from the store, by another
operator's memory server, an auditor, or the ASP itself, and they say which
owner consented and when, where the document's history says only who last
replaced it.

## Why one document

The access-list document is the one place in a space that every layer already
treats specially: its write contract (INV-12, and the runner's write path,
which refuses value-surface writes to it), the service identity's read of it
(OW31), the capability cache it invalidates and the sessions it sweeps when it
changes, and the history compaction keeps of it. Consent and revocations are
access-list data, read by the same checks, so they take that one special case
rather than adding two more that every layer would have to handle and keep in
step.

One document also keeps three things together that the checks need together:

- **A change is atomic.** INV-12 holds an access-list change to a single
  whole-document `set` in a commit of its own, so replacing an owner and the
  consent that owner issued is one commit, with no window in which the space
  has its new owners and its old consent.
- **A read is consistent.** The lease check reads the list, the consent
  delegations and the revocations at one revision, and the server sweeps on a
  change to one document rather than three.
- **Genesis stays one `set`.** A space born with its consent, as a profile is,
  carries it in the commit that writes its list, without widening what a
  genesis commit may hold.

What it costs is the format change, once ("Rolling out the new form"), and the
document's size, which an open question below takes up.

## Rolling out the new form

A reader that predates the new form finds keys that are not principals, takes
the list for malformed, and fails closed, so the space admits no one. The new
form therefore reaches readers before any writer produces it. The sites below
are where the access-list helpers in `runtime/memory/acl.ts` are used today;
the change has to find every reader, not only these.

1. Every reader accepts both forms. The memory server goes first: its
   access-list classification (`readAclState`), genesis validation
   (`isSpaceKeyAclGenesis`), owner resolution (`resolveSpaceOwnerOf`), invites
   (`invites.ts`) and compaction (`compact.ts`). Then the runner's access-list
   writer (`acl-manager.ts`), its contextual flow control readers
   (`cfc/space-membership.ts`, `cfc/custody-seal.ts`), `space-access.ts` and
   the executor's wave; the toolshed's `space-authority.ts`, `meeting-rooms.ts`
   and pattern-lifecycle handlers; the piece operations `space-vetting.ts`,
   `private-inbox.ts` and `profile-space-root.ts`; `cf acl`; and the state
   inspector's compaction. The private inbox's vetting compares a list for
   exact equality (`sameAcl`), so it compares the `acl` of either form.
2. Writers produce the new form: the genesis of every space, self-owned ones
   included (`#createSpaceAs` in `runtime/runner/src/storage/v2.ts`),
   `writeAcl`, the served access-list change (`space-access-change.ts` and the
   memory server), and `cf acl` (`runtime/cli/lib/acl.ts`). A writer converts a
   legacy list on its next write. No reader needs the conversion; it only lets
   the legacy branch be retired eventually.
3. Where the document carries a persisted label map (its `cfc` field) keyed by
   value paths, a label under a principal's key moves with the list, from
   `value.<principal>` to `value.acl.<principal>`, in the commit that converts
   it.

## Where it is enforced

The lease is the one place to check. Every served write rests on it: the memory
server admits a derived-class commit only from the live lease holder, and the
delegated carriage, the explicit scope keys a holder names, and cross-space
provisioning all rest on the same lease-holder trust (protocol.md §2 and §2b).
Checking consent at the session alone would leave those paths open.

So the memory server grants a space's lease, by the conditional write
serving-loop.md §2 describes, only to a holder whose service identity is the
final audience of a chain in the space's `delegations` that verifies now: its
signatures and links hold, its root issuer holds OWNER in the space's `acl`,
and no link's CID is in the space's `revocations`. The server reads the
document itself, as it reads the access list, so a chain an executor kept from
an earlier read counts for nothing once the owner has removed it. The
derived-commit admission check, which already compares the commit's holder with
the live lease, then needs nothing further. Withdrawing consent and revoking a
link are both access-list commits, which already sweep the sessions they
deauthorize (`#revokeDeauthorizedSessions`); the same commit ends a lease whose
holder it leaves without a standing chain.

The executor's sessions present the chain they read from the document in place
of `actingAs: "space-owner"`. Capability then resolves for the chain's root
issuer, the space's owner, as the binding resolves it today, but on the
strength of the owner's signature, standing in the space, rather than the
operator's list of delegating principals.

## Reads stay read-only

The `actingAs` binding grants READ-class decisions only: `session.open`,
queries, and watches resolve as the space's owner, while write and owner checks
resolve against the envelope principal, and served writes go by the lease and
the carriage. A proof chain grants more. The capability a chain resolves "feeds
every check the session's capability feeds, the access-list mutation check
included" ([`profile-delegation.md`](profile-delegation.md), "Capability"), so
an owner-rooted chain on an executor's session would make that session an OWNER
for writes and for replacing the access list.

What limits a delegation to some operations is its command path, `cmd`, not its
policy: UCAN matches a command by prefix, and a policy (`pol`) is evaluated
over an invocation's arguments, which can say which documents but cannot tell a
query from a transaction. A command path can say read-only only once the
operations that name documents are invocations of their own, with `cmd` and
`args`, which is the protocol's target (`memory-v2/04-protocol.md` §4.5.2;
profile delegation's fifth phase, "Policy and command restriction"). Today the
open is the one invocation.

When those commands are named, the read-class ones, `session.open`, the query
and the watch, belong under one prefix that no write command shares, so that a
single consent delegation covers exactly what the binding covers today. A
delegation has one `cmd`, and `/memory/graph.query` does not cover
`/memory/session.open`. The alternative is a server rule that admits an open for
any chain covering some read command.

Until command restriction lands, the server applies a chain on a session opened
by an executor identity to READ-class decisions only, the rule the binding
follows today.

## Profiles

A profile's access list grants only the profile itself, and its key is
destroyed at creation, so the person holds the profile's authority through a
delegation. A consent chain built on that delegation, profile to person to
executor, would name the person as an issuer in the profile's access-list
document, and every reader of that document would read the link between the
profile and the person.
[`profile-delegation.md`](profile-delegation.md), "Attribution and
unlinkability", keeps that link out of the space's documents; a consent chain
through the person would put it back.

So the profile's key issues the consent delegation itself, beside the
delegation it issues to the person and before it is destroyed, and the genesis
commit carries it in `delegations`: profile to executor, with no person in the
chain, in place from the space's first commit. That needs the ASP to be known
when the profile is created, which it is when the profile is created through
that ASP's shell. A profile created without one, or one that moves to another
ASP, has no key left to issue a new one; that is an open question below.

The binding resolves no one in a profile space today, since a self-owned space
declaring a kind is not taken for a home, so a served read of a profile stands
on the envelope's own capability and the profile's wildcard grant. A consent
delegation from the profile serves it under the profile's own grant instead.

## What follows from it

- **Server execution is decided per space.** Today it is a deployment flag. A
  runtime then works beside spaces an ASP serves and spaces it runs itself, as
  with the flag off.
- **A cross-space read follows the consent of the space read.** A served
  derivation in space S that reads space T is refused that read when T's
  access-list document holds no chain to the ASP serving S. Today it reads T as
  T's owner. Whether such a derivation fails visibly or runs in a client
  instead is an open question below.
- **An ownership change carries its consent with it.** A chain resolves its
  root issuer's current grant, so when the owner who issued a delegation is
  demoted or removed, that chain stops standing. The commit that changes the
  owners can replace `delegations` in the same `set`, so a space whose owners
  change need not stop being served. A social space whose members are all
  owners, as a FabriChat room's are, is the case this reaches most.
- **Withdrawing consent is an edit to the space.** An owner takes a space away
  from an ASP by removing its chain from `delegations`, and the lease ends with
  the commit. The revocation list keeps its role for chains presented without
  being in the document, such as the delegations
  [`profile-delegation.md`](profile-delegation.md) describes.

## What stays as it is

- **The trust between co-hosted servers.** Handler writes carry their actor,
  and a lease holder names the scope key of each scoped instance it reads or
  writes (protocol.md §2, the LT5 and FP2 rulings). Consent decides whether an
  executor serves a space at all, not how it attributes what it does there;
  hardening that trust, by remote attestation, is a separate step.
- **Attribution.** A session's principal is the chain's verified issuer, the
  executor identity, as derived commits already are. Scoped addressing does not
  use the session's identity for a lease holder, so nothing resolves
  `user:<executor>`.
- **Contextual flow control.** Labels and the render ceiling remain what keeps a
  derived value from a reader who may not see what it was derived from.

## Open questions

- **Whose consent a social space needs.** One owner's delegation is enough under
  the rule above. A space whose owners disagree about an ASP may want every
  owner's consent, or a majority, which the lease check would then count.
- **A refused cross-space read.** A served derivation can fail, with the refusal
  visible to its readers, or hand the derivation to members' runtimes, which
  read under their own grants. The second keeps today's results for readers who
  hold READ on both spaces, at the cost of running the derivation in clients.
- **A profile without a consent delegation.** A profile whose key never issued
  one, every profile created before this design among them, can be served only
  through a chain through the person, which publishes the link this design
  keeps out of it, or not at all.
- **The default for a new space.** Creating a space through an ASP's shell could
  write a consent delegation to that ASP as part of the creation, or ask, or
  write none until the owner opts in.
- **Home.** A served `wish` reads the demanding person's Home through the
  binding today. Without consent for Home, a served run cannot read it, so Home
  is the first delegation a person who wants server execution writes.
- **The size of the access-list document.** The document is read on every
  capability check and cache refresh, rewritten whole on every change, and
  kept, revision by revision, by compaction. `delegations` grows with the
  executors a space consents to, and `revocations` only grows: it cannot be
  pruned, since it also refuses chains held outside the document, such as an
  agent's. Revocations should be rare, so the growth is likely small, but it is
  not bounded. If it matters, the document can hold the CIDs of
  content-addressed delegation documents in place of their bytes: a change
  stays atomic and the document stays small, at the cost of a fetch when the
  lease check verifies a chain. `revocations` is CIDs already.
