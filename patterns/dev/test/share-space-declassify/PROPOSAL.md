# Proposal: `reclassify`, a lift that releases its installer's own data under a policy

## Why

People share looms that show their connector data: location, calendar. Connector
rows are labeled `User{owner}`, so a loom member who can read the loom's space
still cannot read them, and nothing a pattern can write today changes that
(README, finding 2).

Berni's direction (top/3599, comments 4 and 10) is the design this proposal
implements. A pattern the owner installed as trusted reads the owner's `User(A)`
data and derives new data labeled `anyOf(User(A), PolicyOf<rules>)`. Any pattern
code may do it, `lift`s included, not only handlers. A confirming gesture is the
pattern's own optional choice. No grants, and connector labels stay as they are.

What is missing is the syntax for that derivation, and a rule for whose clause a
computation with no acting user may release.

## The shape

One builder, `reclassify(rules, fn)`: a `lift` whose output carries
`anyOf(User(creator), PolicyOf<rules>)` in place of each clause that is the
piece creator's alone to release.

```tsx
// share-policy.tsx (exists): readers of the space the value is labeled in.
export const shareSpaceRules = exchangeRules([releaseToSpaceReader]);

// share-live.tsx: the owner installs this piece into the loom.
const sharedWindow = reclassify(
  shareSpaceRules,
  ({ fixes, now }: RecentInput): Fix[] => fixesWithin(fixes ?? [], now ?? 0),
);

export default pattern<ShareInput, ShareOutput>(({ fixes, now }) => ({
  [NAME]: "Shared location, last five minutes",
  window: sharedWindow({ fixes, now }),
}));
```

End to end:

1. `fixes` links to the owner's connector data in home space A, labeled
   `User(A)`.
2. The piece runs in loom B. `window` is stored in B labeled
   `anyOf(User(A), PolicyOf<shareSpaceRules>{subject: B})`, with the lift's
   `TransformedBy`. It recomputes when `fixes` or `now` changes.
3. A member R opens the loom. The display mints `HasRole(R, B, reader)` from B's
   access list (`runtime/runner/src/cfc/space-membership.ts:14-19`), the rule
   adds `User(R)`, and the window fits R's display. Removing R from B's access
   list ends that at the next read: the fact is minted per access.

## Semantics

**Authority: the piece's recorded creator.** A lift has no acting user:
`currentPrincipal()` throws outside a handler
(`runtime/runner/src/builder/current-principal.ts:26-36`), and a served
derivation "acts for no one" (`servedRunActsForNoOne`,
`runtime/runner/src/cfc/prepare.ts:6794`). The durable fact that matches "the
user installed a trusted pattern" is the `creator` meta field on the piece's
result document (`runtime/runner/src/meta-seam.ts:70`), written once by the
setup that creates the piece (`runtime/runner/src/runner.ts:5395-5418`,
`5690-5712`) and read for any of the piece's documents by
`pieceCreatorOfDocument` (`prepare.ts:2346`). It already binds an owner for a
run that acts for no one (`updateAddedOwnerCreator`, `prepare.ts:2320`). The
same principal is the authority in a handler, so a member who fires a handler of
the owner's piece releases nothing of their own.

**Which clauses.** The `User(creator)` clauses among those
`clauseReleasableBy(clause, creator)` admits
(`runtime/memory/v2/cfc-release-authority.ts:204`): every alternative stands for
the creator alone, with a cross-space `{digestOf}` commitment read as the DID.
This is §8.12.7's `canReleaseStoredClause`, unchanged.

**The transform.** At commit preparation, for a written target whose result
schema declares the reclassification, each such clause of the flow join becomes
`{anyOf: [User(creator), P]}`, the clause form the reviewed snapshot writes
(`runtime/runner/src/cfc/share-snapshot.ts:315-317`). `P` is the
compiler-lowered `PolicyOf` atom with its subject resolved to the target's space
by `resolvePolicyOfValue` (`prepare.ts:9409`), which also installs the manifest
there.

**The output is a copy.** A lift that keeps items of its input returns the
input's own values, which a write stores as references into the input, each
carrying the input's label. A read of such an item would follow the reference
and still be the creator's alone, so the reclassification would release the
container and not its contents. The runner therefore stores the result of a lift
whose result schema declares a reclassification as a snapshot of its value
(`snapshotQueryResult`), whatever the dial, and the transformed join labels
every path of it. A reference cannot be reclassified: the document it names
keeps its own label, which this rule never changes. A handler that `set`s input
values into a reclassified store gets no copy, so its references keep their
source labels and release nothing.

**What is kept.** Every other clause, as stored: another principal's, another
space's, a policy's, an `Expires`, a `Caveat` (§5.3.3). All integrity, including
the `TransformedBy` mint (`prepare.ts:6210-6228`). The source documents and
their labels.

**When nothing is released.** Dial off, no recorded creator, or no clause the
creator may release: the output keeps the plain flow join, as today, and a
diagnostic says why.

**Rules add readers.** Under `anyOf(User(A), P)` the policy's rules use
`addAlternatives`. `dropClause` removes only the matched alternative (§4.4.5)
and leaves `User(A)`.

**Optional gesture.** User-land, as Berni says. The pattern keeps a confirmation
in a store that only a trusted gesture writes, and types the reclassifier's
input for it with `RequiresIntegrity<…>`, or has `fn` return nothing until it is
set. Unsharing is clearing it or removing the piece.

## How it fits existing idioms

- **Owner release** (`cf cell set-label`, §8.12.7 route 2c): the same authority
  predicate, applied in place, once, by a host command. `reclassify` applies it
  to a new value (route 3), every time the lift runs.
- **Reviewed snapshot copy** (`share-snapshot.ts`): the same output clause. It
  avoids the source label by copying a value the host reviewed, so only its
  clause check (`:186-194`) and clause form are reusable, not a write hook. It
  adds a review of the exact value and a receipt, which `reclassify` does not. A
  snapshot could later be a gesture-gated `reclassify`; not proposed here.
- **Custody seal**: the other direction. It moves a value into a policy's
  custody so that only blessed outputs leave. Not absorbed.
- **Replica shared copies** (top/3483): they write
  `anyOf(User{owner}, Space(loom))` from outside the pattern language.
  `reclassify` produces the same audience from inside it and could replace that
  labeling step. It does not replace the transport that brings rows off the
  owner's machine.
- **Exchange rules, `PolicyOf`, `lift`**: unchanged. The policy is an ordinary
  module policy. `THIS_POLICY.subject` is the loom, so "readers of B" needs no
  `Space(B)` syntax.

## Implementation plan

Classification under `docs/development/cfc-spec-correspondence.md`: a semantic
gap. §3.1.8 requirement 1 forbids an authored clause from substituting for an
input-derived one, and §5.3.2 limits an owner-self rule to an attested
deployment. The specs pull request states the rule as a route 3 derivation in
§8.12.7, with pseudocode reusing `canReleaseStoredClause` and the Lean delta.
Code lands behind a dial and one marker.

1. **API** (`base/api/cfc.ts`, `base/api/index.ts`, mirrored in
   `base/static/assets/types/`): `reclassify(rules, fn)` beside `lift`, and a
   result alias `Reclassified<T, Rules>` added to `CFC_CANONICAL_ALIAS_NAMES`
   (`base/api/cfc.ts:893`). The function is exported from `commonfabric`, not
   `commonfabric/cfc`: that module holds inert declarations
   (`base/api/cfc.ts:422`), and this builds a node.
2. **Transformer**
   (`base/ts-transformers/src/core/commonfabric-runtime-registry.ts`): a
   `builder` entry, and a pass that rewrites the call to `lift(fn)` with the
   result type wrapped in `Reclassified<R, typeof rules>`, the way `assert` is
   lowered onto `computed` (`:66-74`). Later stages then see an ordinary lift.
   The schema generator emits `ifc.reclassify` holding the `PolicyOf` marker it
   already emits
   (`base/schema-generator/src/formatters/common-fabric-formatter.ts:4402`).
3. **Admission** (`runtime/runner/src/cfc/prepare.ts`): one substitution on the
   flow join, after `deriveFlowJoin` (`:12928-12945`) and before writer-fit and
   the stamps, per target that declares `ifc.reclassify`. `// SPEC-PENDING` sits
   here.
4. **Dial**: `cfcPatternReclassification`, `"off"` by default, in
   `RuntimeOptions` beside `cfcPolicyEvaluation`
   (`runtime/runner/src/runtime.ts:862`) and in
   `docs/development/EXPERIMENTAL_OPTIONS.md`. It needs `pieceCreatorRecord` on,
   which is itself off by default pending specs pull request 87.
5. **Creator record, two repairs.**
   - A child names its parent's creator, but the parent's record is read in the
     child's space (`runner.ts:5400-5407`). A share placed with `inSpace()`
     therefore records none. Read the parent where it lives. (Read from the
     code, not run.)
   - The record is checked only at commit preparation
     (`pieceCreatorRecordReasons`, `prepare.ts:6983`); nothing under
     `runtime/memory/` checks it. The store must admit a `creator` only when it
     names the commit's authenticated actor. See Risks.
6. **Tests.**
   - `runtime/runner/test/cfc-reclassify.test.ts`: dial off stores `User(A)`;
     dial on stores the `anyOf` clause; another principal's clause is kept; a
     piece with no creator, or another creator, releases nothing.
   - Fixture: a `share-live.tsx` case in `main.test.tsx`. The connector source,
     today refused, lands in a store whose ceiling is
     `anyOf(User(owner), PolicyOf<shareSpaceRules>)` with the dial on, and is
     still refused with it off.
   - A two-identity browser test for the reader's display. `cf test` runs one
     identity (`runtime/cli/lib/test-runner.ts:1419`), so owner, installer and
     reader have been the same principal in every result so far; the three DIDs
     the fixture checks are spaces.
7. **Docs**: a section in `docs/specs/cfc-persisted-declassification.md` citing
   the ruled section.

## Dropped from earlier plans

- `ShareGrant` and any use of `cfc/grants.ts`.
- A gesture-gated handler builtin as the only route.
- `PolicyOf` in connector labels, the pinned system policy, and policy
  resolution in SQLite row rules. README finding 6 stays as a record that such a
  row rule is inert.
- Host-reviewed surfaces for this flow.

## Decisions

Taken from Berni's comments 4 and 10, choosing the narrower reading where they
leave room:

1. **Authority is the piece's recorded creator**, for lifts and handlers alike:
   "the user installed a trusted pattern".
2. **Only `User(creator)` clauses are released**, not the rest of
   `standsForActor` (`Context`, `Resource`, the home `Space`, `PersonalSpace`).
   Connector data needs only `User`, and widening later breaks nothing.
3. **Across a source update, the authority follows the creator record** as that
   record already defines it; this proposal adds no rule of its own.
4. **The record is enforced at commit preparation and at the store.** The store
   (repair 5b) admits a session's record only when it names the principal the
   session authenticated, and refuses a change or removal of a stored one
   (`runtime/memory/v2/cfc-creator-record.ts`).
5. **A release is honored only where its creator alone may write, in a run
   acting for no one or for the creator.** Whoever can write a piece's space can
   change its pattern, its argument and anything it reads, and so choose what is
   released in the creator's name. Until the store can attest that the creator
   chose a release's inputs, a reclassification is honored only where the access
   list of the piece's space, and of the written document's space, lets the
   creator and no one else write (`writableOnlyBy` in
   `runtime/runner/src/cfc/space-membership.ts`): readers may hold READ, as the
   share in this fixture grants. A missing or malformed list fails closed, since
   the transport treats a populated space without one as public. A run acting
   for anyone but the creator releases nothing, so a handler a reader fires does
   not choose what is released. A space that gains a second writer stops
   releasing from then on; values already released stay, as they do on
   unsharing. A multi-writer share space, where a member may write and the
   creator's release must still resist them, is not supported: an earlier
   prototype that pinned a piece's pattern and inputs against such a member
   (labs branch `claude/reclassify-hardening-9fc6a8`, tag
   `prototype/reclassify-creator-pin`) needed more machinery than the case
   justifies before the store can attest who chose an input, and is kept as a
   catalogue of the attacks a principled answer must refuse.

## CFC debt

This is a prototype: the condition under which a reclassification is honored is
ordinary runtime logic, not a label the store checks.

**The intended policy.** Alice's data, labeled `User(alice)`, stays hers. A
piece Alice creates in a share space may release to that space's readers what
its pattern computes from inputs Alice chose, and only those. No one else can
change what is released in her name: not the pattern, the argument, anything the
release reads, or the event that runs it.

**The cut corner.** "Inputs Alice chose" is approximated by "no one but Alice
can write where the release happens", read from the space's access list on the
runtime that releases, together with the run's acting principal. Principled CFC
would carry the creator's integrity on whatever selects a release (§3.8.4,
robust declassification), or a store-checked endorsement that the creator chose
each input link (§3.7.2's `LinkedBy`), so that a release could be honored in a
space others also write.

**The semantics CFC appears to lack.** §3.8.4 requires that low-integrity values
not choose which data is released, but no integrity the store holds can tell a
co-writer's write from the creator's: the store admits integrity as the writing
client states it, and `TransformedBy` names code, not the piece or principal
that ran it. A store-attested "chosen by" or "last written by" fact is what a
multi-writer release needs.

## Risks

- **A forged creator.** A serving runtime reads any space's space-scoped
  documents as that space's owner
  (`docs/specs/server-side-execution/protocol.md`, §2b, "read a foreign doc").
  So a lift in loom B reads A's home with nobody online, and labels are the only
  thing holding the data. A modified client with WRITE on B that wrote a piece
  with `creator: A` would release A's data to B's readers. The store now refuses
  that record: a session records only its own principal, every session of the
  deployment's own identity included, and only the server's own commits, which
  carry a serving runtime's writes, record anyone else, such as a child's
  parent's creator. So a child that a member's client places under A's piece
  records no creator, and its outputs release nothing. The record is still only
  as strong as the act that writes it; the next four risks are the ways around
  it that remain. The store's check is a stopgap against this one forgery rather
  than a fix for the class: a creator bound into the piece's identity, which the
  store can check against the id itself, would close all five.
- **An honest owner's runtime can record itself as the creator of a piece it did
  not choose.** A piece from before the record gains one at its next source
  transition, from the principal its owner-protected fields' stored labels name,
  or the space's owner for the space's root. A member with WRITE can make a
  record-less piece whose argument and internal manifest point at A's
  owner-labeled documents, or point the space's `defaultPattern` at it. When A
  opens it and A's runtime reconciles its source, A's runtime records A, and the
  store admits it, since A's session wrote it. The legacy record wants an
  explicit act of the principal it names, or evidence the store can check.
  Closed for a reclassification by decision 5, since no one but the creator
  writes where one is honored.
- **A `result` link is followed as written.** Commit preparation finds a
  document's piece through the document's `result` meta link
  (`pieceResultOfDocument` in `runtime/runner/src/cfc/prepare.ts`), which a
  writer can point at A's real piece. A field such a document adds then binds A
  as its owner. Following the link only where the piece names the document back
  would close it. Closed for a reclassification by decision 5, since no one but
  the creator writes where one is honored.
- **A piece deleted and made again keeps its documents.** A member can delete
  A's piece result and recreate it under the same id recording themselves, since
  a delete is not judged and the new record names its session's principal. That
  releases only the member's own data, but A's argument and internal documents
  still link the result, so fields they add bind the member. Closed for a
  reclassification by decision 5, since no one but the creator writes where one
  is honored.
- **A served child takes its parent's creator, whatever chose its pattern.** A
  handler's result pattern is instantiated with its producing piece's creator,
  and the pattern can come from data another member wrote. The serving host's
  commit is not judged by the store. For a reclassification, decision 5 narrows
  this to data the creator alone writes, and a handler a reader fires releases
  nothing.
- **The access list is read where the release happens.** The releasing runtime
  decides from the access list it holds, so a grant it has not yet synced does
  not stop a release, and the store does not check the condition. It rests on
  the store enforcing access lists, which a deployment must turn on.
- **No per-value review.** Whatever `fn` returns is released, live. The trust is
  in the installed pattern.
- **Unsharing does not reach values already derived** from the window. Access to
  B does.
- **The reader's display tests a committed policy subject against the spaces the
  label was read from.** The window's flow join is cross-space, so
  label-metadata protection commits the policy's subject (spec §4.6.4.1). Spec
  §4.9.3 nominates membership candidates only from a label's `Space(...)` atoms,
  and SC-44 adds a plaintext module-policy subject. The display now also
  nominates a space the label was read from whose digest a committed subject is,
  and point-queries its ACL. That is a case the spec lacks, so it needs a ruling
  and carries a `SPEC-PENDING` marker naming specs#110. It is on by default
  under its own flag, `cfcCommittedSubjectCandidates`, whose off restores the
  current text. It opens no commitment and tells the display nothing it could
  not compute. A value stored in one space whose committed subject names another
  stays sealed: no candidate exists without a reverse index, and releasing it
  needs the `reference` representation class.
- **Whether `RequiresIntegrity` on a lift's input stops the run** is not yet
  shown in a test.
- **Anyone with WRITE on the piece's space can change who releases.** The
  runtime honors a reclassification only when every writer at the declared path
  is the module the piece's `patternIdentity` names. `setsrc` is a space grant,
  not the creator's act (`docs/plans/piece-creator-owns-update-added-fields.md`,
  "What this plan does not change"). So a member of B with WRITE can point A's
  piece at a pattern whose lift reclassifies A's data under any policy, and its
  new outputs are new documents, which the stored-envelope refusal does not
  reach. Requiring the creator's act for a source change of a piece that records
  one would close this. Closed for a reclassification by decision 5, since no
  one but the creator writes where one is honored.
- **A document created before the dial keeps its existence A's.** SC-4 freezes a
  path's existence (shape) entry at creation. A value first written with the
  dial off, or before its piece recorded a creator, keeps `User(A)` on that
  entry when it is rewritten with the dial on, while its value entry becomes
  `anyOf(User(A), P)`. A read of the value joins the shape, so B's readers still
  cannot read it. The window must be created with the dial on, or its shape
  re-minted.
- **Only the module the pattern is defined in releases.** A lift defined in a
  module the pattern imports is not the module `patternIdentity` names, so its
  declaration is ignored and a diagnostic says so. That fails closed. Admitting
  it needs the module set of the piece's program to be readable at commit.
- **A writer can rewire what the creator's pattern reads.** Pinning the code the
  creator installed does not pin its inputs. A member of B with WRITE can change
  the piece's argument to link other data of A's, and the unchanged lift reads
  it, a serving runtime reading as A, and releases it to `P`. A handler's event
  payload naming a document does the same. The inputs of a reclassified
  derivation need to be fixed by the creator, or carry integrity from the
  creator's act, before the dial is on. Closed for a reclassification by
  decision 5, since no one but the creator writes where one is honored.
- **Authority names a module, not a piece.** The writer check admits any writer
  whose module is the piece's pattern, and the piece is found from the written
  document's `result` link. A piece of the same pattern created by someone else,
  writing a document that links to A's piece, would be counted as A's. Whether
  pattern code can set that link is unverified; the check should name the piece
  itself. Closed for a reclassification by decision 5, since no one but the
  creator writes where one is honored.
- **One writer's schema can be attributed to another in one transaction.**
  Authoring identities are recorded per path from the first schema input, so in
  a transaction with two writers a schemaless write beneath a declaration takes
  the declaring writer's identity. Whether one transaction carries two writers
  in practice is unverified; every identity per path should be kept.
- **The owner's data includes other people's.** Connector data labeled `User(A)`
  holds content others sent A, such as received mail or invites, and a
  reclassification releases it as A's.
- **A link write can store a declaration on an existing document.** A write that
  stores a link to a share's result in an existing record brings the share's
  declaration at that path, which the record then stores. The write is not
  refused, since refusing it would refuse keeping a share in any existing
  record. A later write there is honored only with its own declaration, from the
  piece's own pattern, under its recorded creator.
- **A reclassification must cover every path the transaction writes.** The flow
  join is stamped on the whole document, so a declaration on one field is
  honored only when the transaction writes nothing else there.
