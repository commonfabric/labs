# Sharing one email message with another person

A person whose mail Loom has synced into a space they control lets one other
person read one message from it. The reader is named by key or, once the
server can vouch for the binding, by email address; the release is revocable,
expires, and leaves the rest of the mailbox closed. This plan says what the
message's label is today, which two gates a reader has to pass, and what is
built in which order.

The shape chosen here shares the result of a query rather than the mail store.
Loom's mail lives in a msgvault SQLite file reached through an injected handle
and a `db.query`, and a reader admitted to that handle's space can run any
read-only statement over the whole file, with only labels standing between
them and every other row. Sharing one row's result document instead keeps the
store closed and works on the labels the rows carry now. Sharing the handle,
which needs a per-row rule Loom has not landed for Gmail, is recorded under
"Later" so that the two are not confused.

**Owner.** The Contextual Flow Control runtime, with the toolshed route for
the attestation.

**Retirement.** This plan is done when a person can issue a grant over one
message's row document to another person's key, that person sees the message
and nothing else from the mailbox, and the grant can be revoked or expire.

## What exists today

Four mechanisms this plan composes are in the tree, and two gaps are not.

**The message's label.** Loom registers each Gmail connection's msgvault home
as an injected SQLite handle whose `tables` contract is built by Loom's
`label_profile` for that connector. The `messages` table declares no row
rule. Every column carries the owner's DID as a bare string, and free-text
columns such as `subject` and `snippet` add the unscreened prompt-injection
caveat, sourced to the connection; every column's integrity is a Loom
connector-observed atom. For `subject`:

```json
{
  "confidentiality": [
    "did:key:z6MkOwnerOfTheMailStore",
    {
      "type": "https://commonfabric.org/cfc/atom/Caveat",
      "kind": "https://commonfabric.org/cfc/concepts/prompt-injection-risk-unscreened",
      "source": {
        "type": "https://loom.commonfabric.org/cfc/atom/ConnectorObserved",
        "connector": "google.gmail-calendar.snapshot",
        "connection": "gm-1",
        "provider": "gmail.com"
      }
    }
  ]
}
```

That is two conjunctive clauses. The default display ceiling admits the whole
prompt-caveat family
([default-display-ceiling.ts](../../runtime/runner/src/cfc/default-display-ceiling.ts)),
so the owner clause is the only one a reader other than the owner fails. No
sender or recipient appears anywhere in the label, and no `did:mailto:` atom
exists for Gmail. The `any(sender, recipients, dbOwner())` rule of
[06-cfc.md](../specs/sqlite-builtin/06-cfc.md) is the label a message row
should carry; it is Loom's participants-row-rule work, which has reached
Signal's `dbOwner()` clause and no further, and does not list msgvault.

**A query's result rows.** Each row a query returns is written as an
immutable document of its own under the result cell, keyed on the row's
content, its label, the database, the projection, the handle's declaration,
and the space's row salt
([05-reactivity.md](../specs/sqlite-builtin/05-reactivity.md)). A reference
to it reads the same content whatever the query selects later. The document's
root entry carries the row's label; the result array's membership carries the
join of every row's label, so a reader released on one row is still refused
the array and its length. A result document lives at the result's scope, and
the runtime never reads across scope keys
([scoped-cell-instances.md](../specs/scoped-cell-instances.md)): a user-scoped
or session-scoped result is addressable by one principal only.

**Grant records.** A `CfcGrant`
([grants.ts](../../runtime/runner/src/cfc/grants.ts)) is a document in the
owner's identity space at an address derived from its release scope, holding
an audience, a grant time, an optional expiry, and an optional revocation. It
is written only through `writeCfcGrant`, which refuses a caller that is not a
trusted builtin implementation, and read by a resolver that recomputes the
address and refuses a document that does not hash to where it sits. An
exchange rule with a `policyState` guard consults it at evaluation and adds
the audience as alternatives to the clause the rule matched; the stored label
never changes. Single-use grants are built. Nothing in production writes or
consumes a grant: the render ceiling's grant resolver is threaded through and
inert, because the standard display rule carries no `policyState` guard
([render-ceiling.ts](../../runtime/runner/src/cfc/render-ceiling.ts)).

**Mailbox proof at the server.** The ingest-channel mint
([ingest-channels.utils.ts](../../runtime/toolshed/routes/ingest-channels/ingest-channels.utils.ts))
takes a request signed by the caller's key, authorized against OWNER on a
space, carrying a Google ID token verified against
`INGEST_GMAIL_OAUTH_CLIENT_IDS` or an access token used for one profile
lookup. It learns that the signing key holds a credential for a mailbox, binds
a channel to a hash of the address, and keeps nothing else.

**Space admission.** A reader's session is admitted to a space by the access
list, or by a UCAN chain rooted at a principal the list grants
([profile-delegation.md](../specs/profile-delegation.md)). The server resolves
a chain's capability for its root issuer and refuses a non-empty policy, so a
chain from an owner is "act as me, as OWNER, over the whole space" until the
policy phase lands.

The two gaps: nothing turns a `did:mailto:` principal into a reader's key, and
nothing records the server's mailbox proof in a form the owner or a verifier
can use later.

## Design

### The row to share

The owner's share piece runs in the space that holds the msgvault handle and
issues one query, at space scope, selecting the message by id and the columns
the owner means to share. Space scope is what makes the result readable by
another principal; a session-scoped query, which the mailbox atoms use, writes
an instance only its one reader can address. A query against a handle in
another space is forced to at least user scope, so the piece and the handle
are in one space.

The piece exposes the row document's reference, not the result array. The
array's membership label joins every row the query returned, and even a
one-row result carries a label the reader may not satisfy after the owner's
next refresh. The row document is the unit of release: immutable, keyed
without the row's content being recoverable from its id, and labeled at its
root with the row's own clauses.

### The grant

A trusted builtin writes a grant through `writeCfcGrant`:

```json
{
  "kind": "ShareGrant",
  "owner": "did:key:z6MkOwnerOfTheMailStore",
  "resource": { "ref": "<the row document's reference>" },
  "audience": [
    { "type": "https://commonfabric.org/cfc/atom/User", "subject": "did:key:z6MkAlice" }
  ],
  "expiresAt": 1763000000000
}
```

The owner is the principal whose release authority the grant spends, which is
the one the row's owner clause names. The resource is the row document. The
audience is the reader as a `User` atom, because that is the form the
reader's display ceiling carries. The grant lives in the owner's identity
space, so a verified document at the derived address carries the owner's
release authority by where it sits, and revoking it or extending it is an
edit to the same document.

Whether the grant is single-use is an owner's choice at issue time. A standing
grant lets the reader return to the message; a single-use one is consumed at
the first release and refused after.

### The rule

A display-profile exchange rule applies to the owner clause and adds the
reader:

```json
{
  "id": "share-owner-row",
  "appliesTo": { "var": "$owner" },
  "preCondition": {
    "policyState": [{
      "kind": "ShareGrant",
      "owner": { "var": "$owner" },
      "audience": { "type": "https://commonfabric.org/cfc/atom/User", "subject": { "var": "$reader" } }
    }]
  },
  "post": {
    "addAlternatives": [
      { "type": "https://commonfabric.org/cfc/atom/User", "subject": { "var": "$reader" } }
    ]
  }
}
```

Two points decide its shape. The owner clause on a Loom row is the bare DID
string, not a `User` object, and `atomEntails` is structural equality, so the
rule's `appliesTo` has to match the string form; the test rule in
[cfc-grant-records.test.ts](../../runtime/runner/test/cfc-grant-records.test.ts)
matches `User` and would never fire on a Loom label. And the resolver point
queries the grant at an address derived from `{space, kind, owner, resource}`,
so `owner` is bound from the clause and `resource` from the document under
evaluation; the audience is what resolves, and is not in the address. How the
rule binds the resource from the evaluation's location is the one piece of
the `policyState` guard this plan has to settle, since the shipped guard binds
fields from the label's atoms and the resource here is the document itself.

The rule runs where the render ceiling runs, so the render ceiling's grant
resolver stops being inert. The sink gate resolves grants through the same
context field already.

### Getting the reader to the document

The reader's session has to hold the document. Two routes, and the plan
builds the second:

- **READ on the owner's space.** An access-list entry admits the reader to
  every document there; labels withhold what the grant does not release. The
  mail space holds the whole mailbox's result documents and the handle, so
  this admits the reader to query the store.
- **A link from a space the reader already reads.** The owner's share piece
  writes a link to the row document into a space the reader belongs to, such
  as a social space the two share or the reader's inbox. The link crossing
  carries the row's label with it, so the reader's runtime holds a document
  labeled by the owner's clause, and the grant releases it at display. The
  mail space stays closed.

### The mailbox attestation

A toolshed route with the mint's authentication shape: a request signed by
the caller's key, carrying a Google token, verified as `proveMailbox` verifies
one. It keeps the fact in two forms.

- **A verified-identity cell in the caller's Home**, written as a
  builtin-authored write carrying a new system atom registered beside
  `loom-verified-external-identity` in `CFC_SYSTEM_STRING_ATOMS`
  ([cfc.ts](../../base/api/cfc.ts)). The cell has the shape the profile's
  `verifiedIdentities` list collects, `{type: "email", value, verifiedAt}`,
  so it reaches the profile and People merging unchanged. The difference from
  Loom's atom is who verified: the server checked Google's signature itself.
- **A portable statement signed by the toolshed service identity**: a DAG-CBOR
  envelope through the codec in
  [delegation.ts](../../base/identity/src/delegation.ts), under a tag of its
  own, with payload `{iss, sub, mailto, iat, exp}` where `sub` is the caller's
  key. This is what a verifier outside the caller's runtime consumes: the
  memory server at a session open, or a peer checking a chain.

The attestation binds the caller's core identity, since a profile's key is
destroyed at genesis and every request is signed by the core key under the
profile's delegation. It is stored in Home, which the owner alone reads, and
a profile publishes it only on the owner's choice: a mailbox attested on two
profiles links them, which the profile split exists to prevent. It carries an
expiry of days, is renewed by authenticating again, and every consumer fails
closed once it lapses.

### Naming the reader by address

With the attestation in place, a grant's audience may be a `did:mailto:`
atom. A second rule applies to that atom and adds `User($reader)`, guarded by
a runtime-minted fact that `$reader` is attested for the address, minted from
the Home cell the way `HasRole` facts are minted from a space's access list
([space-membership.ts](../../runtime/runner/src/cfc/space-membership.ts)).
The owner can then issue the grant before the reader holds a key, the key
resolves at the reader's display, and the release ends with the attestation.

The same bridge is what a message row's own `did:mailto:` participants need
once Loom's participants rule reaches Gmail: a recipient reads a message they
were on without any grant, through their attested address. That use is
"Later" below.

## What this plan does not change

- The msgvault contract, Loom's label profiles, and the participants rule are
  Loom's. This plan reads the labels they produce and writes none.
- The stored label of a row never changes. A grant is an input to
  evaluation, consulted at access time; revocation is the grant's lifecycle.
- The access-list rules, the chain verification at session open, and the
  profile delegation design are unchanged. The attestation is a new object
  the server issues, not a change to what a chain proves.
- The display ceiling's static entries are unchanged. The rule adds an
  alternative to one clause of one label at evaluation; nothing widens the
  ceiling.

## Stages

1. **The grant surface.** A trusted builtin that writes a `ShareGrant` over a
   document reference to a `User` audience, with expiry and single-use as
   options, and revokes one. Unit tests against `writeCfcGrant` and the
   resolver. No rule consumes it yet.
2. **The rule, and the render ceiling's resolver.** The `share-owner-row` rule
   in the display profile, matching the bare-DID owner clause, with the
   resource bound from the document under evaluation. The render ceiling's
   `grantResolver` is wired for real. A test releases a row document labeled
   with a bare DID to a second principal through a grant, and refuses it after
   revocation and after expiry.
3. **The share piece.** A pattern in the mail space that queries one message
   at space scope, exposes its row document reference, writes the grant
   through the builtin, and links the document into a space the reader reads.
   An integration test with two principals: the reader sees the message's
   columns and is refused the result array, the handle, and any other row.
4. **The mailbox attestation.** The toolshed route, the Home cell under the
   new system atom, the signed envelope, and `cf` commands to request one and
   to show what Home holds. Route tests against a stub Google verifier, as the
   ingest-channel tests do.
5. **Audience by address.** The `did:mailto:` grant audience, the attested
   fact minted from Home, and the bridge rule. A test issues a grant to an
   address before the reader's key exists, attests the key, and sees the
   release.

Stages 1, 3, and 4 are independent of each other and may run in parallel.
Stage 2 needs 1. Stage 5 needs 2 and 4.

### Specification work

- The `ShareGrant` kind and the two rules are a conforming implementation of
  §8.12.7 route 2a and §13.4.3, recorded in
  [cfc-persisted-declassification.md](../specs/cfc-persisted-declassification.md)
  as the end-to-end build-order item it names.
- The bridge rule changes what the runtime decides for a `did:mailto:`
  principal, which is a semantic change under
  [cfc-spec-correspondence.md](../development/cfc-spec-correspondence.md): it
  goes to the specification first, or lands under a `SPEC-PENDING` marker.
- The attestation's envelope and its use at a session open go into
  [profile-delegation.md](../specs/profile-delegation.md) and
  [04-protocol.md](../specs/memory-v2/04-protocol.md) §4.5.1 when a chain
  first names a `did:mailto:` audience.

## Later

**Sharing the handle.** A reader admitted to the handle's space runs their own
queries. For them to see one message and no other, the `messages` table needs
a participants row rule, `allowReadClearance` on, and the reader's query to
pass `readClearance`. The clearance check compares bare strings against the
acting principal
([row-label-read.ts](../../runtime/runner/src/builtins/sqlite/row-label-read.ts)),
so `did:mailto:` alternatives never match a `did:key` reader; the attestation
would feed that check directly, by letting the reader's attested addresses
count as reader strings, rather than through a rule. All of it waits on Loom's
participants rule reaching msgvault, which Loom's plan does not schedule, and
on the custody-seal question that plan records.

**A narrow chain.** The policy phase of
[profile-delegation.md](../specs/profile-delegation.md) lets a chain cover
one command and name the documents a query may root at. A grant and a chain
with a policy over the row document would then be one signed object a reader
presents, portable past this server. Nothing here has to be redone for that:
the grant's resource and audience are the policy's terms.

## Open questions

- **Binding the resource in the guard.** The shipped `policyState` guard binds
  its fields from the label's atoms. The row document's own reference is the
  resource here, and whether the guard takes it from the evaluation's location
  or the rule names it another way is settled in stage 2.
- **Which space the share piece runs in.** Loom registers the handle into the
  space its panel registration names. The share piece has to run there to
  query at space scope, and whether that space is one the owner's shell shows
  pieces from is a Loom question.
- **The link crossing's label.** The plan assumes a link written from the mail
  space into the reader's space carries the row's label to the reader's
  runtime unchanged, as the link-crossing marking does for other cross-space
  links. Stage 3's test states it.
- **Expiry on the attestation versus the grant.** A grant to an address
  outlives the attestation that resolves it. The bridge fails closed when the
  attestation lapses, and whether the owner is told that a standing grant has
  gone dark is a surface question for stage 5.
