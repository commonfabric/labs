# Profile Delegation

## Status

Design sketch. Nothing here is implemented. The sketch is written against the
session authentication and access-list rules in
[`memory-v2/04-protocol.md`](memory-v2/04-protocol.md) §4.5 and the profile
creation path in [`shared-profile-space.md`](shared-profile-space.md), and is
the first slice of the UCAN-authorized memory commands that §4.5.2 of the
protocol spec names as the target.

## The problem

A profile is a space. Its DID is a random key that signs the genesis commit
and is then destroyed, as [random space identities](random-space-identities.md)
requires of every ordinary space. The access list the genesis writes names
the creating user's identity as the space's one concrete owner, beside a
wildcard WRITE grant for visitors. So a profile has no identity of its own
that persists past genesis, and the only principal that can administer it is
the user identity that created it: the identity the runtime acts as in every
space, which this document calls the **core identity** (the storage manager's
identity, surfaced to patterns as `userIdentityDID`).

That is enough to make profiles work, and it has two costs:

- **The core identity is written into the profile.** The access list names
  it, every commit to the profile records it as the committing principal, and
  the owner-integrity labels on the profile's fields name it as the owner
  ([`HOME_SPACE.md`](../common/conventions/HOME_SPACE.md), "Profile"). Anyone
  who can read two profile spaces can see that one identity owns both, which
  is the opposite of what a Work / Personal split is for.
- **Access is an edit to the space.** Letting a second key act on the profile
  (a new device, an agent, a rotated core identity) means a commit that
  replaces the access-list document, by an owner, while that owner's key is
  at hand. Taking the access away is another such commit.

## The design in one paragraph

Make the profile space its own concrete owner: the key that signs its
genesis is the one principal its access list grants OWNER. Before that key
is destroyed, it signs one more thing, a UCAN delegation to the core identity
over the space. The runtime stores the delegation beside the profile link in
the Home space. When the runtime opens a session to the profile space, it
signs the open as the core identity and presents the delegation as proof. The
server verifies the proof chain, takes the capability from the access list's
grant to the chain's root issuer, the profile, and admits the session as the
core identity. Everything after the open is unchanged: the session's
principal is the core identity, so scoped cells, commit attribution, and the
rest of the runtime keep the one-identity model they have. The profile key
is destroyed once genesis and the delegation have landed, so the profile's
authority exists afterwards only as the delegation and whatever is chained
from it.

The rest of this document says what that takes, piece by piece, and where
each piece lives.

## Terms

- **Core identity**: the identity a runtime acts as. One per runtime; the
  signer the storage manager was constructed with.
- **Profile identity**: the key whose DID is the profile space's DID. It
  exists for the length of the profile's creation and is destroyed after.
- **Delegation**: a signed statement by an issuer that an audience may
  exercise some of the issuer's authority over a subject, under stated
  limits. The shape is UCAN's.
- **Proof chain**: an ordered list of delegations, the first issued by the
  principal the access list grants, each next one issued by the previous
  one's audience, the last one's audience being the principal that signs the
  request.

## Profile identity

### What the key is

The profile key is a random key, generated as every ordinary space's key is
generated: fresh entropy from the platform's random source, used for the
space's genesis commit, and destroyed. The one difference is what it signs
before it is destroyed: the genesis commit, as today, and one delegation to
the core identity, which is new.

The key is never stored, exported, derived, or recomputed. After creation,
nothing holds it, and nothing can sign as the profile again. The profile's
authority over its own space exists only as the delegation it issued and
whatever is later chained from that delegation. That is the design's central
trade: it keeps profile spaces identical to every other space in how their
key is handled, and it gives up the profile as a signer. "What destroying the
key rules out" below says what that costs.

### How the profile space is born

Profile creation today runs through `PatternFactory.inSpace()` with no name,
which allocates a space with a random key, writes a genesis with the creator
as owner, and destroys the key. Profile creation under this design runs a
distinct path:

1. Generate the profile key.
2. Sign the genesis commit with it. The access list is
   `{ [profileDID]: "OWNER", "*": "WRITE" }`. The core identity is not in it.
   The genesis declares `spaceKind: "profile"` and reserves the profile as
   the space's root, as today.
3. Sign the delegation (next section) with the profile key.
4. Record the delegation beside the profile link in the Home space, in the
   same commit that records the link.
5. Destroy the profile key once both the genesis and the Home-space commit
   are confirmed.

The ordering matters at one point. The key survives until the delegation is
durably recorded, not only until genesis lands, because a profile whose
genesis landed and whose delegation was lost is a space nobody can open with
more than visitor access: it is owned by a key no one holds and delegated to
no one. A process that stops before step 5 abandons the space, exactly as a
process that stops mid-creation abandons a space today; it costs one
access-control document and is reachable by nobody, and the creation is
started again.

Steps 2 and 3 are the design's departure from the random-space-identities
rules: the key signs two things rather than one, and the space's listed
owner is a principal nobody holds. The second is already how the protocol
treats a space DID after genesis ("it holds what the ACL grants it, like any
other principal"), so the server needs no new rule for it. What the access
list says is that the profile owns itself; what the delegation says is who
may act on that.

The genesis commit must be submitted through a session opened as the profile
key, because genesis is admitted only from the space identity or a service
identity. That session is short-lived and is closed once genesis has landed,
so the ordinary sessions a runtime opens to the profile are never signed by
the profile key.

### What destroying the key rules out

- **Renewing or reissuing the root delegation.** The delegation the profile
  issues at creation is the only one it ever issues. It therefore carries no
  expiry, and it is the single capability over the space: losing it loses
  the profile. It is recorded in the Home space, which is also where the
  profile's link lives, so this is the loss class profiles already have.
- **Revoking the root delegation on its own.** UCAN revocation is by the
  issuer or a principal above it in the chain, and nothing is above the
  profile. "Rotation and revocation" below says what stands in for it.
- **The profile signing anything else.** Verified-identity assertions, roster
  membership, or any later "the profile says" claim would have to be signed
  by the core identity under the delegation, as everything is today.

## The delegation

### Shape

The delegation is a UCAN 1.0 delegation, encoded as the UCAN specification
requires and identified as it requires: a DAG-CBOR envelope, identified by a
CIDv1 over the encoded envelope with the DAG-CBOR codec and a SHA-256
multihash. It is not a fabric value and is not hashed with the repository's
content hash. The runtime and the server carry it as opaque bytes, decode it
to verify it, and refer to it by its CID.

The reason is that a delegation is the one object in this design whose
format cannot change later. The profile key signs it once and is destroyed,
so a root delegation issued in a private encoding is a root delegation that
can never be reissued in the standard one. Encoding it as a real UCAN from
the start is what lets anything other than this server verify it: an agent
holding a chained delegation, a daemon, or the verifiable-execution log.

The envelope is UCAN's: a two-element array of the issuer's signature and
the signed payload, where the signed payload is a map holding the varsig
header for the signature algorithm and the delegation payload under the tag
`ucan/dlg@1.0.0`. The signature is over the DAG-CBOR encoding of the signed
payload, not over a fabric hash of it; the `Identity` signer signs bytes, so
nothing new is needed on the signing side. The payload's fields are UCAN's,
with UCAN's types:

```typescript
// Shown at module scope.
type DID = string;

/** A UCAN delegation payload, as the delegation specification defines it. */
interface DelegationPayload {
  /** The issuer: the principal handing authority down. */
  iss: DID;
  /** The audience: the principal receiving it. */
  aud: DID;
  /**
   * The subject: the space the authority is over. The root delegation of a
   * chain has `iss === sub` when the space is its own owner, which is every
   * profile space; it has an `iss` the access list grants otherwise. UCAN
   * allows `null` here for a powerline delegation; this design never issues
   * one and the server refuses one.
   */
  sub: DID | null;
  /**
   * The command the authority covers, as a path. `/memory` covers every
   * memory command; `/memory/session.open` covers opening a session only,
   * which under the current protocol admits every command on the session
   * and is therefore the same thing until per-command authorization lands.
   */
  cmd: string;
  /** Caveats, in UCAN's policy language. Empty means none. */
  pol: unknown[];
  /** Random bytes, unique per delegation. */
  nonce: Uint8Array;
  /** Unix seconds, or `null` for a delegation that does not expire. */
  exp: number | null;
  /** Unix seconds. Absent means valid from issue. */
  nbf?: number;
}
```

The codec's payload type carries every field above as UCAN defines it, `sub`
nullable and `pol` an array included, so an issuer sets `pol` to `[]` and
the verifier refuses anything else; the shape stays closed while the type
stays UCAN's. The delegation a profile issues at creation has `iss` and
`sub` both the profile DID, `aud` the core identity, `cmd` of `/memory`, an
empty `pol`, and `exp` of `null`. It has no expiry because the key that could renew it is
destroyed. It is the one delegation most users ever hold for a profile, and
it is what makes "open the profile as myself" work.

Encoding and decoding DAG-CBOR, constructing a CID, and producing the
varsig header are new to the repository, and the first slice does them
in-house rather than through a dependency. With `pol` fixed at the empty
array, every delegation is one closed shape: an array of two, a byte string
and a map; the map holds a byte string under `h` and a map under the
delegation tag; and that map holds text strings, one byte string, one
integer or `null`, an optional integer, and an empty array. The DAG-CBOR
rules that shape needs are few and mechanical: definite lengths everywhere,
minimal-width integers, map keys ordered by length and then bytewise, text
as UTF-8 text strings, and no tags, floats, or indefinite forms. The CID is
a fixed prefix (version 1, the DAG-CBOR codec, the SHA-256 multihash header)
over the digest of the envelope bytes, in base58btc. The varsig header for
ed25519 over DAG-CBOR is a constant.

The decoder is as strict as the encoder: it accepts the closed shape and
refuses anything else, an unknown key, a non-empty `pol`, a tag, or an
indefinite length among them. That is a safety property as much as a
simplification, since the verifier never has to reason about a delegation
it did not expect.

Interoperability rests on test vectors, not on reasoning: delegations
produced by a reference UCAN implementation are checked in, and the encoder
must reproduce their bytes and their CIDs exactly, and the decoder must
accept them. The day `pol` carries a real policy, the shape stops being
closed, and that slice brings a general DAG-CBOR codec with it.

### Where it is stored

Beside the profile link, in the Home space's profile list, which is already
the durable record of which profiles a user has. The Home space is readable
by its owner alone, so the delegation is as private as the profile list
itself, and it is the only record of the profile's authority anywhere. The
runtime reads the list at startup, as it does for `#profile` resolution, and
keeps the delegations keyed by space DID. Each is stored as its encoded
bytes beside its CID, so the runtime presents it without re-encoding it, and
the CID the server checks is the one the issuer produced.

A delegation whose audience is a key other than the one the runtime acts as
is no use to that runtime and is skipped. A delegation whose subject is not
the space being opened is skipped. This makes the store a plain lookup: for
the space being opened, the chain whose last audience is the runtime's
identity, if there is one.

### Chains

The design verifies a chain, not a single delegation, because the single
delegation is a chain of length one and the chain costs nothing extra to
verify. A chain is what makes the design reach the cases the profile alone
does not:

- **A device or agent key.** The core identity issues
  `{ iss: coreDID, aud: agentDID, sub: profileDID, cmd: "/memory", pol: [...] }`
  and hands the agent both delegations. The agent opens the profile as its
  own key with a chain of two. The agent's delegation can expire, can carry
  caveats, and can be withheld from the next agent, none of which touches the
  profile's access list.
- **Any space, not only profiles.** Nothing in the chain rule is specific to
  profiles. An owner of any space can delegate to any key the same way, and
  the server verifies it the same way. A profile is the case where the owner
  is the space DID itself.

Caveat evaluation (`pol`) is out of scope for the first slice: the server
accepts an empty policy and refuses a non-empty one. A later slice evaluates
read-only caveats, which map onto the access list's READ < WRITE < OWNER
ordering, and command restriction, once the protocol authorizes commands
individually.

## Opening a session with a delegation

### Wire shape

A signed `session.open` gains one signed field, `prf`, the CIDs of the
proofs in chain order, and one unsigned field beside the signature, the
proofs themselves as encoded bytes:

```typescript
// Shown at module scope.
type DID = string;
/** A CIDv1 in its base58btc text form, as UCAN requires. */
type CID = string;
/** One delegation's DAG-CBOR envelope, exactly as its issuer encoded it. */
type DelegationBytes = Uint8Array;

interface SessionOpenInvocationWithProofs {
  iss: DID;
  cmd: "session.open";
  sub: DID;
  aud: DID;
  args: { protocol: "memory"; session: unknown };
  challenge: string;
  iat: number;
  exp: number;
  /** CIDs of `authorization.proofs`, in chain order. */
  prf?: CID[];
}

interface SessionOpenAuthorizationWithProofs {
  signature: Uint8Array;
  /** The delegations `prf` names, in the same order. */
  proofs?: DelegationBytes[];
}
```

The invocation itself is unchanged in kind: it is the fabric-hashed object
the runtime signs today, with one more field. The CIDs inside it are
strings, so the fabric hash covers them like any other field. The invocation
becomes a UCAN invocation in its own right only when the protocol's §4.5.2
cutover lands; nothing in this design depends on that, and nothing in it
has to be redone then, since the delegations are already in their final
form.

`prf` is inside the signed invocation, so the proof set is bound to the
signature: a relay cannot add, drop, or reorder proofs without invalidating
the open. The proofs travel outside the signature because they are signed by
their own issuers, and because the same chain is presented on every open and
reopen, so the server will usually already hold it.

An open that names a connection-authenticated `principal` in place of a
signature carries `proofs` on the open as well, since proofs are per space
and connection authentication is per key. The chain's last audience must
equal the named principal, exactly as it must equal `iss` on a signed open.

### Verification

The server's `session.open` verifier (`packages/memory/v2/session-open-auth.ts`)
verifies the signature as it does now, then, when `prf` is present:

1. `proofs.length === prf.length`, and the CID of `proofs[i]`, computed
   over the bytes as received, equals `prf[i]` for each `i`.
2. Each proof decodes as a UCAN delegation envelope with the delegation
   tag, its `sub` is not `null`, and its signature verifies against its own
   `iss` over the DAG-CBOR encoding of the signed payload.
3. Each proof's `sub` is the requested space.
4. Each proof's `cmd` covers `/memory/session.open`: it is `/`, `/memory`, or
   `/memory/session.open`.
5. Each proof is within `nbf` and `exp`, to the second, with no clock-skew
   grace.
6. Each proof's `pol` is empty (first slice).
7. The chain links: `proofs[i].aud === proofs[i + 1].iss` for each `i`, and
   `proofs[last].aud === invocation.iss`.

A chain that fails any of these is refused with a permanent
`AuthorizationError` naming the step. An expired proof is not retriable: a
fresh handshake does not heal it. The open then stands or falls on `iss`'s
own access, so a user whose delegation has lapsed but who is still named in
the access list keeps working.

The verifier returns what it returns today, the verified issuer DID, plus the
chain's **root issuer**, `proofs[0].iss`, when a chain was presented and
verified. That is the one new output.

### Capability

The server resolves the session's capability from the access list for the
root issuer rather than for the verified issuer, where a chain was presented.
The existing capability cache keys by space and principal; the lookup is for
the root issuer, and the result is applied to the session. A space whose
access list does not grant the root issuer admits nothing through the chain:
the chain proves the root issuer said so, and the access list says the root
issuer has nothing to say.

The capability resolved this way feeds every check the session's capability
feeds, the access-list mutation check included. A session holding OWNER
through a chain may replace the access list, under the same whole-document
and retained-concrete-owner rules as any owner. This is not an optional
extra: with the profile key destroyed, a chain is the only way an owner-class
act ever reaches a profile space, and the emergency exit below depends on it.

Capability resolution is the one point where the chain changes the server's
behavior, and it is deliberately the same point `actingAs: "space-owner"`
uses today (`packages/memory/v2/server.ts`, the OW31 binding), where the
server already resolves a capability for a principal other than the one that
signed the open. The difference is in what authorizes the substitution: the
binding is admitted by operator configuration (the delegating-principal
list), the chain by the signatures in it.

### The session's principal

The session's principal is the verified issuer: the core identity. Nothing
about scope partitions, commit attribution, the `principal` column, presence,
or `session/admissible` changes. A commit made on the session is made by the
core identity, as it is today. This is the "act as our core identity" half of
the design, and it is what keeps the runtime at one identity per process.

The server records the chain with the open: the `authorization` table already
holds the open's authorization by reference, and the proofs are part of it.
That is the audit trail the verifiable-execution spec asks for ("if UCANs are
present, verify them and ensure consistency with ACL",
[`verifiable-execution/05-log-and-authorization.md`](verifiable-execution/05-log-and-authorization.md)
§9.5).

## Client side

The runtime's storage manager opens a session to a space with a
`SessionPrincipal`, whose `authorizeSessionOpen` builds the signed invocation
(`packages/runner/src/storage/v2-remote-session.ts`,
`createSignedSessionOpenAuth`). The pieces are:

- The remote session factory holds a delegation store
  (`delegation-store.ts`), fed through `StorageManager.addDelegationChain`
  with whole chains, root first, as a holder is handed them; the store
  checks each link and that the links meet, and keeps the chain under the
  space it is over. Asked for the chain to open a space as a key, it hands
  back one it holds that ends at that key and whose links all hold at that
  moment and cover a session open: one the space itself rooted if there is
  one, and otherwise the chain added last. It assembles nothing from loose
  delegations, since which root the access list grants is the server's to
  know; the holder's latest addition is taken as its intent.
- The `SessionPrincipal` the factory hands the memory client carries a
  `proofs` function rather than a chain. The client calls it once per open
  or reopen, so each presents the chain as the store holds it then: a
  delegation added since is presented, and one that has expired is left out.
  The same snapshot feeds the client's capability check and the open it
  admits.
- A signed open receives that chain through its context, names each proof's
  CID in `prf`, and carries the bytes; an open naming a
  connection-authenticated principal carries the bytes alone. A space with
  no chain opens as it does today.
- A client holding a chain refuses a server that does not advertise
  `sessionOpenProofs` before opening, rather than open under the key's own
  grant and be refused there.
- The store is fed programmatically until profile creation records
  delegations in the Home space; later, whatever hands a runtime a
  delegation it did not create (an agent given one by a user, for instance)
  feeds it the same way.

## Attribution and unlinkability

With the design as written, the profile's access list no longer names the
core identity, and the server admits the core identity to the profile on the
strength of a delegation that only the server and the user ever see. The
link between the profile and the core identity is then visible to:

- the server operator, who sees the proof on every open and holds it in the
  authorization table;
- anyone who can read the profile space's commits, which record the core
  identity as the committing principal;
- anyone who reads the owner-integrity labels on the profile's fields, which
  name the core identity as the field's owner.

The first is inherent: the server must see the proof to honor it. The second
and third are the status quo, and the design leaves them alone: the core
identity signs commits and is the principal they record, because acting
under its own name is what keeps the runtime at one identity.

The step that would take the core identity out of the log is known and is
not part of this design. The runtime would hold an intermediate key, chained
from the core identity, and sign commits with it; the server, having verified
the chain, would record that the intermediate key committed under a
delegation rooted at the profile, and attest that record itself rather than
store the chain. A reader of the space would then see the intermediate key
and the server's attestation, and the core identity would appear in neither.
That is a change to what a commit records and to what a scoped cell is keyed
by, and it is deferred until unlinkability from readers of the space becomes
a requirement.

## Rotation and revocation

- **Adding a key** (a device, an agent): the core identity issues a
  delegation to it over the space. No commit to the space.
- **Removing a key the core delegated to**: the core identity revokes its own
  delegation. Per-delegation revocation is a later slice; until it lands, the
  delegation is issued with an expiry, and removing the key is waiting for
  it. The server's existing per-space capability cache and
  `session/admissible` machinery are where a revocation list would hook in.
- **Rotating the core identity**: the old core, holding OWNER through the
  root delegation, issues a delegation to the new core over the space, and
  the new core presents the chain of two: profile to old core, old core to
  new core. The profile's access list does not change. Each rotation adds a
  link, and every link stays in the chain for the life of the profile, since
  the root cannot be reissued to shorten it. A chain is small and verified
  in one pass, so the length is a cost in bytes per open, not in trust: a
  link whose issuer is later compromised is a problem for revocation, not
  for verification.
- **Revoking the root, or a compromised link**: the one lever is the access
  list. A session holding OWNER through the chain replaces the list with one
  that no longer grants the profile DID, which refuses every chain rooted
  there at once. The replacement must retain a concrete owner, and the only
  candidate is a core or successor key, so this exit puts an identity the
  user holds back into the access list, as it is today. That is the right
  shape for an emergency: it trades the profile's self-ownership for a clean
  break, and the user can create a new profile with its own identity when
  they want the property back.

## Existing profiles

A profile created before this design has a destroyed key and a core-owned
access list. It cannot gain a profile identity, since its DID is a key no one
holds. It keeps working exactly as it does: the core identity is in its
access list, so it opens without a chain. The profile list in the Home space
distinguishes the two by the presence of a delegation.

A user who wants a profile with its own identity creates a new one. Moving a
profile's contents to a new space is an ordinary data migration and is not
part of this design.

## Phases

1. **Server verifies proofs.** Implemented. The identity package holds the
   codec for the closed delegation shape (`delegation.ts` over
   `dag-cbor.ts`): envelope encoding and decoding, CID computation, and
   signature verification, pinned to a vector byte for byte.
   `session-open-auth.ts` verifies a chain with it and reports the root
   issuer, and `server.ts` resolves the capability for the root issuer. The
   server advertises `sessionOpenProofs` when its policy admits delegations,
   registered in
   [`EXPERIMENTAL_OPTIONS.md`](../development/EXPERIMENTAL_OPTIONS.md) and
   off by default until the client ships.
2. **Client presents proofs.** Implemented. The remote session factory holds
   a delegation store (`delegation-store.ts`), fed whole chains through
   `StorageManager.addDelegationChain`, and every session it opens presents
   the chain the store holds for the space and the opening key: a signed open
   names the CIDs in `prf` and carries the bytes, and an open naming a
   connection-authenticated principal carries the bytes alone. A reopen
   presents the same chain, since it rides on the session's principal. A
   client holding a chain refuses a server that does not advertise
   `sessionOpenProofs` rather than opening under the key's own grant. The
   store is fed programmatically until the next phase records delegations in
   the Home space.
3. **Profile identity at creation.** The profile creation path signs
   genesis as the profile key, issues the delegation, records it beside the
   link, and destroys the key once both have landed. `HOME_SPACE.md` and
   `shared-profile-space.md` change in the same commit to describe the new
   access list and the Home-space record.
4. **Chains beyond the profile.** A `cf` command and a Home-space affordance
   to issue a delegation from the core identity to another key; agent and
   daemon identities use it.
5. **Caveats and revocation.** Read-only caveats, expiry on issued
   delegations, and per-delegation revocation.

## Open questions

- **When does the intermediate key land?** "Attribution and unlinkability"
  says how a commit would stop naming the core identity. The open part is
  what a scoped cell in the profile space is keyed by once the committing
  key is not the user's, and whether the owner-integrity labels on the
  profile's fields follow the same change. Neither is decided, and neither
  is needed until unlinkability from readers of the space is a requirement.
- **A serving runtime keeps its full rights, and the server must stop
  reading "home" off self-ownership.** The serving runtime acts as the
  service identity, whose authority is deployment policy rather than
  anything a space grants, and the server admits a service principal as
  OWNER before it reads the access list. It needs no delegation to open a
  profile, and a delegation it verified itself would narrow nothing against
  it; the on-behalf-of record it keeps for authored commits (the originating
  actor and the capability admitted under) already says whom it acted for.
  The delegation store is therefore a client-side thing only. What this
  design does change for the server is owner resolution: it resolves a
  space's owner from the access list and returns the space DID whenever the
  list grants the space DID OWNER, and two things read that as "this is a
  home space": the server-side root ensure's home predicate, and the
  acting-as binding with the trust snapshot the ensure runs under. A
  profile space grants its own DID OWNER, so both must take the kind the
  genesis declares as their home predicate rather than self-ownership. The
  acting-as binding resolves no user in a profile space, since the access
  list names none; in the first slice that is fine, since the profile's
  root is reserved at genesis and placed by the creator's own session, so
  the server ensure does not run for a profile. Whether the service should
  later learn the core identity from the proofs it has seen, to act for the
  user in a profile space, is the part left open.
- **Is giving up the profile as a signer the right trade?** This design
  destroys the key, so a profile never signs a verified-identity assertion,
  a roster membership, or anything else. The alternative is a key derived
  from the core identity with a stored nonce, which is recomputable rather
  than stored and so has nothing to destroy, but which moves with the core
  key and makes the profile's key handling differ from every other space's.
  The destroy-the-key variant is chosen here for its simplicity; revisit it
  if a profile-signed claim becomes a requirement, since a destroyed key
  cannot be recovered into that variant later.
- **The delegation is a real UCAN; the invocation is not yet.** The
  repository's content hash is SHA-256 over a tag-byte structural encoding
  of a fabric value, named as `fid1`; a UCAN's identifier is a CIDv1 over
  its DAG-CBOR encoding. The same logical object produces different digests
  under the two, and the signature is computed over different bytes. This
  design resolves that by putting the standard encoding on the one object
  whose format cannot change afterwards, the delegation, and leaving the
  `session.open` invocation as the fabric-hashed object it is until the
  protocol's §4.5.2 cutover makes it a UCAN invocation. Decided; recorded
  here so the split is not read as an oversight.

## Touch points

| Concern | Where |
| --- | --- |
| Delegation codec: DAG-CBOR envelope, CID, varsig; issue and verify | a new module in `packages/identity`, in-house for the closed shape, with reference test vectors |
| Verify a signed open; add chain verification and root-issuer output | `packages/memory/v2/session-open-auth.ts` |
| Resolve the session capability for the root issuer | `packages/memory/v2/server.ts`, session.open admission beside the `actingAs` binding |
| Persist the proofs with the open's authorization | `packages/memory/v2/engine.ts`, `authorization` table |
| Home predicate by declared kind, not self-ownership | `resolveSpaceOwnerOf` in `packages/memory/v2/server.ts` and its readers: the acting-as binding there, and the root ensure's `isHomeSpace` in `packages/runner/src/executor/space-server.ts` |
| Build the signed open with `prf` and proofs | `packages/runner/src/storage/v2-remote-session.ts`, `createSignedSessionOpenAuth` |
| Keep the chain across reopens | `packages/memory/v2/client.ts`, the session's reopen descriptor |
| Delegation store, keyed by space DID | `packages/runner/src/storage/v2.ts`, storage manager mount |
| Sign genesis as the profile key; issue the delegation; destroy the key | the profile creation path (`profile-create.tsx`) and `StorageManager.createSpace` |
| Record the delegation beside the profile link | the Home default pattern's `profiles` entries |
| Protocol description | `memory-v2/04-protocol.md` §4.5 |
