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
4. **The record is enforced at commit preparation while the dial is off.**
   Store-side admission (repair 5b) is a precondition for turning it on.

## Risks

- **A forged creator.** A serving runtime reads any space's space-scoped
  documents as that space's owner
  (`docs/specs/server-side-execution/protocol.md`, §2b, "read a foreign doc").
  So a lift in loom B reads A's home with nobody online, and labels are the only
  thing holding the data. A modified client with WRITE on B that writes a piece
  with `creator: A` would release A's data to B's readers. Repair 5b closes it
  and gates any deployment of the dial.
- **No per-value review.** Whatever `fn` returns is released, live. The trust is
  in the installed pattern.
- **Unsharing does not reach values already derived** from the window. Access to
  B does.
- **The reader's display is unverified** until the browser test exists.
- **Whether `RequiresIntegrity` on a lift's input stops the run** is not yet
  shown in a test.
