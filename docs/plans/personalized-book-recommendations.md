# Personalized book recommendations

This is the final demonstration stage following the
[agent-requests implementation](../history/plans/agent-requests-implementation.md).
It adds a personal reading shelf and a shared invitation asking visitors to
recommend books to its originator.

## Contract

- The shelf's agent suggests books its reader likely read and favorite authors.
  The reader can add books and authors manually.
- Creating an invitation allocates a new space. The reader reviews the exact
  shelf snapshot before publishing it and shares the invitation's space.
- Each visitor sees the originator's collapsed book list and a few authors. An
  agent uses the visitor's own context to propose private suggestions. The
  invitation filters books already on the originator's shelf and ranks matches
  to favorite authors first without revealing shelf contents to the model.
- The visitor selects books or enters a title and author manually, then reviews
  the exact recommendation before sharing it.
- A submission appears in the visitor's `PerUser` history and the originator's
  confidential `PerSpace` inbox. Each book is readable only by its sender and
  originator. The originator sees all received recommendations.

## Implementation boundaries

The shared invitation stores its originator attestation, published shelf
pointer, and inbox. A user-scoped child holds visitor computations and
presentation. Scopes select storage instances; confidentiality labels constrain
data flow and bounded runtime reads. The inbox append must not consume existing
entries.

The trusted native sharing surface displays the entire JSON snapshot and a
runtime-verified audience. A real confirmation creates an immutable copy and a
receipt. It does not relabel the private source or confer standing authority
over future values. Its host requires an authenticated, bounded runtime read
ceiling; an unbounded host is refused before preview. Other principals'
restrictions cannot be removed. The operation does not claim a hostile-host
intent proof.

`User(CurrentPrincipal)` on a fresh private store must become the creator's
concrete identity. Reusing an authored schema, copying a held reference, or
appending as another user must preserve that identity, including through schema
references. Ambiguous stored restrictions must not be dropped.

## Deployment limitation

The normal shell configures a display ceiling but no runtime read ceiling. The
memory server's space ACL grants read access to writers and does not enforce
per-cell confidentiality labels on raw reads. Therefore, strict tests using
explicit reader ceilings do not establish the requested privacy in the default
shared-space deployment.

The existing open profile inbox is suitable for delivery pointers, not private
payloads. A separate open space does not protect this demo's private books.
Sealed pairwise delivery spaces would require fresh random identities and exact
genesis ACLs. They would also need a delivery/aggregation mechanism: a sender
cannot receive write access to one private aggregate without receiving read
access under the current ACL model.

The demonstration uses bounded client runtimes while this server-side reader
authorization gap remains open. It does not claim to protect private books
from a shared-space member using a client that bypasses the runtime ceiling.
Closing this gap is gated on server-side execution and reader authorization.

The visitor agent's runner resolves an observation ceiling from the
authenticated requester and the invitation space's declared ACL at run start.
A verified reader may observe `Space(invitation)` alongside
`User(requester)`. An authored literal ceiling can narrow that host ceiling
but cannot prove membership or widen it. An absent or denied ACL leaves the
run personal-only. Revocation during a running model session does not narrow
that session; the next run sees the new ACL. Deployment restrictions, the D5
limit, and harness retrieval enforcement limits remain unchanged.

The owner view uses a native host predicate that compares the runtime's acting
principal with the originator's stored root attestation. Profile selection does
not control it. The result selects presentation; the inbox's CFC label still
enforces its reader boundary.

## Completion checklist

- [x] Build the shelf and invitation displays, including selection and manual
      entry.
- [x] Exercise the compiled views in a real shell on desktop and mobile.
- [x] Verify native confirmation with genuine mouse and keyboard gestures and
      reject synthetic clicks.
- [x] Cover view behavior with authored tests and executable-line coverage.
- [x] Reproduce and fix blind append and creator-label persistence defects with
      focused runtime tests.
- [x] Verify the complete compiled pair, including its native result bindings,
      from agent seeding through publication and recommendation delivery.
- [x] Verify owner, sender, and third-reader access in independent bounded
      runtimes.
- [x] Document the accepted server-to-client confidentiality limitation for
      this demonstration; server-side reader authorization remains open.
- [x] Derive the visitor agent's shelf observation ceiling from the declared
      space ACL at run start.
- [x] Identify the owner through an authenticated predicate independent of
      profile selection.
- [x] Run a visitor request against a disposable toolshed with real ACL genesis,
      a visitor WRITE grant, a home queue, and a scripted model; verify shelf
      filtering and private result visibility.
- [ ] Complete full package tests, repository gates, coverage, and self-review.
- [ ] Open a ready PR, answer review comments, and obtain green CI.
