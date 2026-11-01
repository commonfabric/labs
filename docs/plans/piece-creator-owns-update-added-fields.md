# A piece's creator owns the fields an update adds

## Why

A pattern release can add a field whose schema declares
`ownerPrincipal: CurrentPrincipal`. The agent queue's `agentRunner` is one.
When a piece follows its origin to that release, setup re-stages the piece and
projects the new field. Today that projection binds no owner. The field's
owner is whoever first writes it through its writer, and if the first start
after the update also instantiates a child the store does not hold, the
transaction-wide attribution mark binds every re-staged owner field to whoever
performed that start. Both routes hand a default to a principal who did not
choose it, which is the shape of an earlier bug: a piece set up but not fully
launched, whose defaults the first launcher endorsed.

The update itself is unattended. The piece's creator chose the origin, and
with it delegated every later release to the code that performs updates. A
field that release adds is therefore the creator's, not the updater's, not
the first writer's, and not the service's. Nothing durable records who the
creator is, so nothing can bind the field to them. This plan records the
creator on the piece and binds an update-added owner field to that record.

The rapids failure of 2026-10-30 is the same machinery seen from the serving
side: a served start of Home re-staged `agentRunner` in a transaction the
attribution mark covered, the run acted for no one, and CFC refused it
(`ownerPrincipal requires the run's actor at /agentRunner`). Scoping the mark
is a companion change below.

## What the documents say today

[`cfc-protected-initialization.md`](../specs/cfc-protected-initialization.md),
"Attribution of an initialized value", states the rule this plan changes:

> No owner is bound by such an initialization: the field's `ownerPrincipal`
> binding is established by the first write an acting principal makes through
> the field's writer, and that write mints the claim for its actor as every
> handler write does.

The same section says that the transaction bringing a piece into being outside
any action is the acting principal's act, and that what its setup initializes
is attributed to them. `currentPrincipalIntegrityReason` in
`runtime/runner/src/cfc/prepare.ts` implements both sentences: an
initialization on nobody's behalf at a placeholder owner "leaves the stored
owner as it is", and the first attributed write binds its actor.
[`current-principal.md`](../features/current-principal.md) describes the
served-run cases, under the pending ruling in specs pull request 64.

What exists around it:

- The result document's meta fields (`runtime/runner/src/meta-seam.ts`) hold
  the pattern pointer, the setup markers, the source origin and the revision
  history. None names a principal. The `create` revision in
  `pieceSourceHistory` records the pattern, the source and the origin, and no
  one.
- The meta seam refuses a write without the runtime's own authorization
  value. That stops pattern code. It does not stop a modified client, whose
  meta writes are admitted on the strength of its space grant.
- A `setsrc` or a repoint needs a first-party request proof and a WRITE or
  OWNER grant on the space (`runtime/toolshed/routes/pattern-lifecycle/`). The
  transition's writes are a release of the piece's stores under the runtime's
  authorization, and the module-update delegation inherits write authority
  from module to module. No step consults a principal recorded on the piece.
- `#setupInternal` (`runtime/runner/src/runner.ts`) marks the whole
  transaction `attributedInitialization` when it sets up a piece with no
  stored pattern pointer outside a scheduled action. The mark disables the
  "initialization on nobody's behalf" admission for every path the
  transaction writes, not only the new piece's.
- CFC's existing "creator" is the `User(CurrentPrincipal)` confidentiality
  binding at document creation (`creatorBinding` in `prepare.ts`). It folds
  into the readers and is not stored as a principal.

## Classification

Under [the correspondence procedure](../development/cfc-spec-correspondence.md).
This plan was written without access to the specification; the sections below
cite the labs documents and the code, and a reviewer with access verifies the
classification.

1. **Binding an update-added owner field to the creator is a semantic gap.**
   The labs document states the opposite with normative force, so the sentence
   quoted above is spec text, and the specs pull request carries the change.
   The ruling form is in "The ruling" below.
2. **Recording the creator is spec text too.** The field is only worth having
   if a write to it is admitted once, by the runtime, in the transaction that
   creates the piece, and refused afterward. That admission rule has MUST
   force, so it rides the same pull request. The bytes, the field name and
   the read path are host arrangement.
3. **A child taking its parent's creator** is part of the same ruling: it
   decides which principal the record names.
4. **Scoping the attribution mark to the new piece's own documents is a
   conforming implementation.** The sentence says "what its setup
   initializes is attributed to them". The new piece's initialization is what
   its setup initializes; a re-staged projection of a piece that already
   existed is not. The change narrows what the mark covers and persists
   nothing new, so it may land ahead of the ruling.
5. **Which runtime follows an origin** (the serving runtime, the browser)
   is a host arrangement and is not decided here. Once the binding rule holds,
   an update performed by the service principal on nobody's behalf binds the
   new field to the creator, which is what makes server-side following safe
   for owner fields.

## The ruling

The body of the specs pull request, in the form the procedure requires.

**Question.** When a source update installs a new field whose schema declares
a placeholder `ownerPrincipal`, which principal does the field belong to?

**Why the text leaves it open.** The current sentence binds the owner on the
first write through the field's writer. It was written for a field a piece
has from creation, where the creating transaction is attributed and the
creator's own setup mints the claim. An update is nobody's act by the same
section, so the field has no owner until someone writes it. The text does not
say who that someone may be.

**Options.**

- **A. As today.** No owner is bound; the first attributed write through the
  writer binds its actor. Any principal who can reach the writer can claim
  the field.
- **B. The piece's creator.** The runtime records the principal the piece was
  created for, once, in the creating transaction. An initialization on
  nobody's behalf at a placeholder owner mints `represents-principal` for the
  recorded creator and binds them. A later write by any other principal is a
  mismatch, as it is for a field created with the piece.
- **C. The updater.** The principal whose runtime performed the update binds.
  An unattended update then hands fields to whichever browser opened the
  piece first, or to the service.
- **D. The service.** The service principal binds. The field's writer is then
  usable by no user.

**Applied.** B. It is the only option under which the field's owner is the
principal who authorized the code that installed it. A and C are the two
routes described in "Why". D makes the field unusable.

**Conformance statement.** The runtime conforms to the current text: it binds
no owner on an update's initialization and binds the first writer. It errs in
neither direction against the text; against option B it under-protects, by
admitting a first writer who is not the creator. A labs code change follows,
staged below.

**Cases.**

- A release of the agent queue adds `agentRunner`. The user who created Home
  owns it after the update, before any runner has registered. Their runner's
  registration is admitted; another member's is refused.
- A piece in a shared space, created by U, is updated when V opens it. The
  new field is U's. V's write through the writer is a mismatch.
- The serving runtime performs the update for no one. The field is bound to
  U, whom the record names; the service minted a claim about U on the strength
  of the record, not of its own snapshot.
- A child that Home's release instantiates for the first time, during a
  served start, takes Home's creator, so the owner fields the child projects
  are the Home owner's.
- A piece created before this rule holds no record. Its update-added fields
  stay unowned, as today, until "Legacy pieces" below records one.

**Decision record.** Left for the CFC owner.

## Design

### The record

A meta field on the result document, `creator`, holding the DID of the
principal the piece was created for. It joins `META_FIELDS` in
`runtime/runner/src/meta-seam.ts`, so the raw meta seam addresses it and
pattern code cannot reach it. One field on the one document every argument
and internal document already links back to through `result` is the cheapest
thing for commit preparation to read, which is why the record does not live
in the `create` revision of `pieceSourceHistory` instead. The revision may
repeat it for the history panel; the meta field is the authority.

### Who the record names

`#setupInternal` writes it where it sets the attribution mark today: a piece
with no stored pattern pointer, set up from a pattern or module. The value is
decided by how the piece came to be:

- A creation outside any scheduled action, such as a deploy or a served
  creation, names the acting principal of the transaction's trust snapshot.
  That is the principal every attributed claim in the same transaction names,
  so the record and the labels cannot disagree. The space root a serving
  runtime's ensure creates names the owner the ensure resolved.
- A piece a handler creates names the run's actor.
- A child a pattern body instantiates, a sub-pattern or a collection
  builtin's per-entry piece, names its parent's creator, read from the
  parent's record. The actor whose run happened to instantiate it is not the
  creator of what the parent's code made. `parentPieceRootId` and the
  instantiating piece's result cell are already in hand at that site.
- A piece a builtin instantiates from a continuation of its action
  (`attributeInitialization: false`) names the instantiating piece's creator
  by the same rule.
- A serving run that acts for no one and has no parent to inherit from
  creates nothing today, since a piece without a stored pointer is never
  demanded. The record is not written, and the admission below refuses a
  record that names the service.

### Admission at commit preparation

A write to `creator` is admitted only when the transaction creates the result
document, meaning the document holds no stored value and no stored envelope,
and the write carries the runtime's write-policy authorization. The value
must be a well-formed DID and must not be the serving runtime's identity.
Every other write to the field is refused. This is what makes the record
worth more than a space grant: a client that can write the space can still
not rename a creator. The gate for runtime-minted integrity atoms
(`gateRuntimeMintedIntegrity`, the `cf-compiled-by` attestation) is the
precedent for a fact only the runtime asserts.

### Binding on an update

In `currentPrincipalIntegrityReason`, the branch that today "leaves the stored
owner as it is" changes. When the target position declares a placeholder
`ownerPrincipal`, the write is an initialization on nobody's behalf, and the
stored label names no owner, the check resolves the owning piece and reads its
`creator`:

- for a setup projection, the structural-provenance input's `target` is the
  result document;
- for a seed, a default or a projection into an argument or internal
  document, the `result` meta link of the document being written names it.

With a creator in hand, the label persisted at the path mints
`represents-principal` for the creator, and the stored owner is bound. The
served-run refusal (`servedRunActsForNoOne`) does not apply: the claim names
the recorded creator, not a principal the run acts for. With no creator
recorded, the branch behaves as today.

Once bound, nothing else changes: a write through the writer by the creator
matches, any other principal's is `ownerPrincipal mismatch`, and the stored
claim is carried forward by every unattributed re-stage.

### Scoping the attribution mark

`markCfcAttributedInitialization` becomes a mark on the new piece's own
documents: its result document, its argument document and the internal
documents its setup creates. `pathHoldsUnattributedInitialization` consults
the mark only for a target among them. A re-staged projection of a piece that
already existed in the same transaction is judged as the unattributed
initialization it is. This is the rapids fix, and it also removes a client
failure the same shape produces: a principal who is not the owner starts a
piece whose release adds a child and re-stages an owner-bound projection, and
is refused with a mismatch.

### Legacy pieces

A piece created before the record exists holds none. The runtime may record
one later, under a second admission that applies only where the field is
absent: the principal the piece's existing owner-protected fields unanimously
name; for a space root, the owner `resolveSpaceOwner` returns; otherwise
nothing. The write happens on the piece's next source transition, in the same
transaction, so the field it installs can bind. A piece that offers no
evidence stays as it is and its update-added fields stay first-writer-bound,
which is the current behavior and not a regression.

### What this plan does not change

Who may `setsrc` or repoint a piece. That is a space grant today and stays
one. A later plan may consult the record to require the creator's act for a
repoint; this one gives it something to consult.

## Stages

Stages 1, 3, 4, 5 and 6 are built, behind the `pieceCreatorRecord`
experimental option where they persist something new. Stage 2, the ruling,
is open: the two `SPEC-PENDING` markers name no pull request yet. Three
things differ from the design below. The binding is made where the label is
persisted (`labelMintOptionsAt` and `derivePersistedLabel` in `prepare.ts`),
which resolves the owning piece through the setup provenance that names an
argument or internal document for it or through the `result` back-link, rather
than inside `currentPrincipalIntegrityReason`, which keeps admitting the
initialization as before. A deferred piece start no longer marks its own
transaction: it carries the marks of the transaction it was deferred from, so
a start of a piece found set up attributes nothing, and a served run acting
for no one is admitted the result document's staged binding to the new field.
The legacy record is written from owner-field evidence only; resolving the
space owner for a legacy root whose fields name no owner is not built, since
the runner has no view of the ACL, and such a root stays without a record.

1. **Scope the attribution mark.** Conforming implementation; lands first and
   alone. Regression test as described under "Tests", item 5. Update the
   labs document's sentence on the mark to say which documents it covers.
2. **File the ruling.** A developer with specs access files the pull request
   from "The ruling" above and links it here. Until it merges, stages 3 and 4
   land behind a `SPEC-PENDING` marker naming it, and behind an experimental
   flag defaulting to the current behavior, since both persist something new.
   The flag is registered in
   [`EXPERIMENTAL_OPTIONS.md`](../development/EXPERIMENTAL_OPTIONS.md) when
   stage 3 lands and deleted when the ruling merges.
3. **Record the creator.** The meta field, the write site in `#setupInternal`
   with the inheritance rule, and the admission rule in `prepare.ts`.
4. **Bind on an update.** The branch change in `currentPrincipalIntegrityReason`
   and the owning-piece resolution.
5. **Legacy pieces.** The second admission and the write at the next source
   transition.
6. **Documents.** `cfc-protected-initialization.md` "Attribution of an
   initialized value" and `current-principal.md` describe the new rule;
   `piece-source-lifecycle.md` names the record among what a piece carries;
   `meta-seam.ts`'s field list documents the field.

## Tests

1. Creation records the creator: a client deploy, a handler-created piece, a
   served creation carrying the requester's snapshot, and a space root the
   serving ensure creates. Each record equals the principal the labels minted
   in the same transaction name.
2. A sub-pattern child and a collection builtin's per-entry piece record the
   parent's creator, not the run's actor, when a second principal's run
   instantiates them.
3. A source update installing a new placeholder-owner field binds it to the
   recorded creator, with the update performed by the creator's runtime, by
   another member's runtime, and by a serving runtime acting for no one.
   Afterward the creator's write through the writer is admitted and another
   member's is refused.
4. A write to `creator` outside the creating transaction is refused, with and
   without the runtime's authorization; a creating write naming the serving
   identity is refused.
5. The rapids shape, with no rapids data: a pattern with an owner-protected
   projection field; a release that adds a sub-pattern child; setup staged by
   a client that does not start the piece; the stored projection link's
   schema reference rewritten to stand in for the build change; then a
   serving start, which commits.
6. A legacy piece with a unanimous existing owner gains the record at its next
   source transition, and the field that transition installs is bound; one
   with no evidence stays unowned.

## Open questions

- Whether the `create` revision in `pieceSourceHistory` should repeat the
  principal for the history panel, or the panel reads the meta field.
- Whether a repoint or `setsrc` by a principal other than the creator should
  need the creator's act, or should at least be recorded against the record.
  Out of scope here; noted so the record is designed to support it.
- Whether the serving runtime should perform all origin follows once the
  binding rule holds. The investigation of 2026-10-31 recommends it; this
  plan removes the owner-binding objection to it and decides nothing else.
