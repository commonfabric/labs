# Server Execution by Consent

## Status

Design sketch. Nothing here is implemented. It is written against the serving
loop's lease ([`server-side-execution/serving-loop.md`](server-side-execution/serving-loop.md)
§2), the admission table and the `actingAs` binding
([`server-side-execution/protocol.md`](server-side-execution/protocol.md) §2
and §2b), and the proof chains of
[`profile-delegation.md`](profile-delegation.md) as
[`memory-v2/04-protocol.md`](memory-v2/04-protocol.md) §4.5.1 admits them.

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
the ASP that is to serve it, and writes it into the space's delegations
document. An executor opening a space may read the entries of that document
addressed to it without holding READ in the space, so it learns from the space
itself whether it may serve it. An executor serves a space only while such a
delegation stands: the memory server grants the space's lease, and admits the
executor's served reads and derived commits there, only to a holder whose
service identity a delegation in the document names. A space with no delegation
to an ASP is not served by it, and runs in its members' runtimes as it does with
server execution off. Removing the delegation ends the service. A person
delegates only to the ASP they choose to run their spaces, and only for the
spaces they choose.

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
| `exp` | `null` by default: consent stands while the delegations document holds it |

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

## The delegations document

A space holds its consent delegations in a document beside its access list and
its revocation document, `of:<space>/delegations`: a list of chains, each a list
of delegation envelopes exactly as their issuers encoded them, root first.

- **Writing it needs OWNER**, under the same whole-document rule as the access
  list (INV-12 in [`memory-v2/09-invariants.md`](memory-v2/09-invariants.md)).
  The genesis commit holds nothing but the access list (04-protocol.md), so the
  creator writes the delegations document in its first commit after genesis.
- **Reading it is an exception to READ, and a narrow one.** A principal the
  access list grants nothing may read the chains in the document whose final
  audience is that principal, and no others. An executor opening a space it
  does not yet serve learns from the space whether its owner consented, and goes
  on to open the space under the chain it read. The server holds back every
  other entry, so a reader without READ does not learn who owns the space or
  which other ASPs serve it. A reader with READ reads the document as it reads
  any other.

The document is what makes consent something the space says rather than
something the executor carries. The owner writes a delegation once, in the space
it is over; no runtime has to hand it to an executor; and an auditor with READ
sees which ASPs serve the space.

If the document is written only by an OWNER and consulted by the server, an
entry already shows that an owner consented. The signature adds what a document
write does not: the bytes alone are verifiable away from the store, by another
operator's memory server, an auditor, or the ASP itself, and they say which
owner consented and when, where the document's history says only who last
replaced it.

## Where it is enforced

The lease is the one place to check. Every served write rests on it: the memory
server admits a derived-class commit only from the live lease holder, and the
delegated carriage, the explicit scope keys a holder names, and cross-space
provisioning all rest on the same lease-holder trust (protocol.md §2 and §2b).
Checking consent at the session alone would leave those paths open.

So the memory server grants a space's lease, by the conditional write
serving-loop.md §2 describes, only to a holder whose service identity is the
final audience of a chain in the space's delegations document that verifies
now: its signatures and links hold, its root issuer holds OWNER in the access
list, and no link is listed in the space's revocation document. The server reads
the document itself, as it reads the access list, so a chain an executor kept
from an earlier read counts for nothing once the owner has removed it. The
derived-commit admission check, which already compares the commit's holder with
the live lease, then needs nothing further. A commit to the delegations
document, to the access list, or to the revocation document that leaves the
holder without a standing chain sweeps the lease as an access-list commit sweeps
the sessions it deauthorizes.

The executor's sessions present the chain they read from the document in place
of `actingAs: "space-owner"`. Capability then resolves for the chain's root
issuer, the space's owner, as the binding resolves it today, but on the
strength of the owner's signature, standing in the space, rather than the
operator's list of delegating principals.

## Reads stay read-only

The `actingAs` binding grants READ-class decisions only: write and owner checks
resolve against the envelope principal, and served writes go by the lease and
the carriage. A proof chain grants more. The capability a chain resolves "feeds
every check the session's capability feeds, the access-list mutation check
included" ([`profile-delegation.md`](profile-delegation.md), "Capability"), so
an owner-rooted chain on an executor's session would make that session an OWNER
for writes and for replacing the access list.

Consent delegations therefore carry a read-class command path, and the server
evaluates it: the command restriction of profile delegation's fifth phase
("Policy and command restriction"). Until that phase lands, the server applies
a chain on a session opened by an executor identity to READ-class decisions
only, the rule the binding follows today.

## Profiles

A profile's access list grants only the profile itself, and its key is
destroyed at creation, so the person holds the profile's authority through a
delegation. A consent chain built on that delegation, profile to person to
executor, would name the person as an issuer in the profile's delegations
document, and every reader with READ in the profile, which is every principal,
would read the link between the profile and the person.
[`profile-delegation.md`](profile-delegation.md), "Attribution and
unlinkability", keeps that link out of the space's documents; a consent chain
through the person would put it back.

So the profile's key issues the consent delegation itself, at creation, beside
the delegation it issues to the person and before it is destroyed: profile to
executor, with no person in the chain. That needs the ASP to be known when the
profile is created, which it is when the profile is created through that ASP's
shell. A profile created without one, or one that moves to another ASP, has no
key left to issue a new one; that is an open question below.

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
  delegations document holds no chain to the ASP serving S. Today it reads T as
  T's owner. Whether such a derivation fails visibly or runs in a client instead
  is an open question below.
- **Ownership changes end consent.** The binding resolves a space's owner again
  on every access-list change. A chain resolves its root issuer's current grant
  instead: when the owner who issued the delegation is demoted or removed, the
  space stops being served until a remaining owner writes another. A social
  space whose members are all owners, as a FabriChat room's are, is the case
  this reaches most.
- **Withdrawing consent is an edit to the space.** An owner takes a space away
  from an ASP by removing its chain from the delegations document, and the lease
  ends with the commit. The revocation document keeps its role for chains
  presented without being in the document, such as the delegations
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
- **How the read reaches the server.** A principal without READ cannot open a
  session, so it cannot query the delegations document as it queries other
  documents. The server can consult the document itself when an executor
  identity opens the space, and admit the open under the chain it finds there,
  so the executor presents nothing; or it can answer a read of the entries
  addressed to the opener before admission, which lets an executor learn which
  spaces it may serve without opening them.
- **The default for a new space.** Creating a space through an ASP's shell could
  write a consent delegation to that ASP as part of the creation, or ask, or
  write none until the owner opts in.
- **Home.** A served `wish` reads the demanding person's Home through the
  binding today. Without consent for Home, a served run cannot read it, so Home
  is the first delegation a person who wants server execution writes.