# Finishing the piece source lifecycle

**Status:** proposed. Nothing here is built. This is a comparison of
[`../specs/piece-source-lifecycle.md`](../specs/piece-source-lifecycle.md)
against the repository as of `8991acc2a8` (2026-08-28), and a build order for
the remainder.

## The short version

A substantial part of the lifecycle spec is built. One mechanism follows an
origin when a user opens a piece. Every accepted transition appends a guarded
revision. Reconciliation records what it concluded as durable state, and the
source panel reads it, distinguishes up-to-date from could-not-reach from
refused from detached from an origin nothing can follow, offers to ask an
origin on demand, offers to take a refused candidate anyway, and accepts an
origin a person types.

An arbitrary `https://` endpoint is no longer an origin. The whitelist is a
`system:` ref and a fabric `cf:` URL, which is what removed the network policy
this plan used to carry — schemes, redirects, address ranges, response and
closure limits — along with a whole trust model that authenticated nothing
beyond the transport.

What is missing falls into two groups that barely touch each other:

1. **A revision retains the reachable import closure, not the authored
   program.** There is no manifest, no public-subpath map, no runtime
   fingerprint, and no runtime-neutral digest. Revert restores what the entry
   could reach rather than what the author wrote, and the manifest is what
   [hosted pattern authoring](hosted-pattern-authoring.md) waits on.
2. **A learned space route is not persisted.** Routing accepts a host hint and
   hydrates durable ones, but nothing appends a route with commit
   acknowledgment.

The build order below, summarized in the [plan index](README.md), is **four pull
requests in two tracks**, which can run concurrently. The count is held down by
grouping each pull request around one guarantee rather than one file, and the
tracks are separated along the lines where two authors would otherwise be
editing `piece-controller.ts`, `source-reconciler.ts`, and `runner.ts` at the
same time.

## Findings

Everything in this section was checked against the source at `8991acc2a8`. A
claim that is an inference rather than something read from the tree is marked
as one, and sits with the recommendations below rather than here.

### What is built end to end

- **One reconciliation mechanism, on one trigger.**
  [`SourceReconciler`](../../packages/runner/src/source-reconciler.ts)
  resolves a piece's origin and adopts what it names, and it is called from
  three places in
  [`PiecesController`](../../packages/piece/src/ops/pieces-controller.ts)
  — `getPiece` when it is going to run, `openPiece`, and the space-root ensure
  — all of which are a user opening something. No serving path calls it.
- **A closed origin vocabulary.**
  [`classifyPieceOriginString`](../../packages/runner/src/piece-origin-kind.ts)
  returns exactly one kind for any recorded string, and both the reconciler and
  [`piece-origin.ts`](../../packages/piece/src/ops/piece-origin.ts) dispatch on
  that enumeration rather than re-deriving it, so what the product says about
  an origin and what the runtime does with it cannot drift apart. A test holds
  the two classifiers to the same boundary and the same reasons.
- **A piece says whether it is following its origin.** Reconciliation records
  its outcome, when it reached it, the pattern the origin offered, and why it
  refused, as durable state cleared by any accepted transition. The panel
  distinguishes up-to-date, unknown, could-not-reach, refused, detached, and an
  origin nothing can follow, and offers only the actions each state earns.
- **A person can name an origin.** **Follow another source…** raises a dialog,
  and `changeSource({ kind: "repoint" })` classifies what is entered, refuses
  credentials, refuses a piece that names itself, resolves before storing
  anything, and applies the source with a repoint revision. A detached piece
  gains an origin the same way.
- **A refusal can be overruled, except the one that cannot.** A contract
  mismatch offers to take the candidate anyway through the one-use
  confirmation. A candidate the piece's own stored data cannot satisfy is
  refused outright and says why there is no button.
- **Guarded, append-only revisions.** `pieceSourceHistory` in
  [`runner.ts`](../../packages/runner/src/runner.ts) carries a revision
  identifier, timestamp, pattern, retaining source link, origin, the recorded
  origin when normalization changed it, an operation, and the selected
  revision. `applyPieceSourceTransition` compares the expected revision head,
  current pattern, and active origin inside the transaction.
- **The stored argument is guarded across an automatic update.**
  `SourceReconciler.#adopt` calls `runtime.syncStoredSetupArgument` and
  re-checks it inside the commit callback, so a transition cannot stage a value
  written after the candidate was prepared.
- **A refusal costs a running piece nothing.** `#adopt` stages the candidate
  inside the transition whether or not the piece is running, so setup that
  cannot take the piece's data fails the whole transaction. A refusal never
  strands the pointer on a candidate the graph did not run, which is what makes
  the panel's states exhaustive.
- **Authored declaration files are retained and identified.**
  `persistableSourceFiles` keeps every rooted `.d.ts`, both engine compile paths
  build the persisted module set from that list, and `.d.ts` is among the
  module resolution suffixes, so a type-only import edge folds a declaration
  file into its importer's identity. Ambient, non-rooted declaration files are
  dropped.
- **Cross-space source copies fail closed on labels.**
  `sourceCfcMetadataProhibitsCrossSpaceCopy` in
  [`pattern-manager.ts`](../../packages/runner/src/pattern-manager.ts) refuses
  to replicate a closure whose stored confidentiality or integrity labels the
  destination cannot preserve.
- **Late host hints, and hydration from the site table.**
  `StorageManager.registerSpaceHost`, the runtime processor's site-table
  watcher, and provisional-replica replacement all behave as the spec's routing
  table says.

### What is missing

Seven gaps, ordered by how much each one costs a person using the product.

**1. A revision retains the reachable closure, not the authored program.**
There is no `cf/authored-program-manifest/v1` anywhere in the tree, no
`publicSubpaths` on the compiler's `Program`
([`interface.ts:29`](../../packages/js-compiler/interface.ts)), and no
enumeration hook on `ProgramResolver`, which exposes only `main()` and
`resolveSource()`. A revision's `source` field is a link to the
`pattern:<identity>` closure. So revert restores what the entry could reach; an
unreachable authored sibling is not part of the revision, and neither is an
exports map. This is also what
[hosted pattern authoring](hosted-pattern-authoring.md) waits on: it disables
its **Request a change** item for a piece with no complete retained authored
program.

**2. There is no runtime fingerprint or program digest.** `computeModuleHashes`
accepts `runtimeFingerprint` and every production caller leaves it empty
([`pattern-manager.ts:631`](../../packages/runner/src/pattern-manager.ts),
[`cell-cache.ts:554`](../../packages/runner/src/compilation-cache/cell-cache.ts)).
`getExecutableRuntimeFingerprint()` does not exist. Neither does
`cf/runtime-neutral-program-digest/v1`. A revision therefore cannot record why
an executable identity changed, cannot distinguish a runtime rebuild from an
authored-source change, and cannot tell a revert whether it may reuse a
historical identity. `pieceSourceCellSchema` in
[`schemas.ts:281`](../../packages/runner/src/schemas.ts) still declares a
`lineage` array that nothing outside a `cf-harness` test fixture reads.

**3. Fork, detach-and-rebuild, and baseline migration do not exist.** There is
no `forkedFrom`, `rebuiltFrom`, or `revertedFrom` anywhere in the tree.
`cloneTo` follows an upstream source and is explicitly not a fork. No path
creates a baseline revision for a piece that predates the history, so an
existing piece has no restorable first revision.

**4. The pinned-origin export selector is not stored.** A pin fixes the pattern
identity, not the export, and the origin string carries only the identity, so
following a pinned origin reuses the export the piece already runs and can
never move it to another export of the same source. The `TODO(hixie)` in
`#followFabric` names it. Encoding the selector as the URL's fragment would
cost no schema change; that question is open and worth settling before the code
is written.

**5. Roots are still special in two places.** `defaultAppUrl` lives on the
mutable home root ([`home.ts:16`](../../packages/home-schemas/home.ts),
[`pieces-controller.ts:1587`](../../packages/piece/src/ops/pieces-controller.ts)),
and nothing validates a root-interface contract when `defaultPattern` is
created or relinked.

**6. Routing stops at the live registry.** `registerSpaceHost` makes a hint
effective in the session and returns a boolean, and `registerSpaceHostDetailed`
returns the reason for a refusal; nothing appends the hint to the site table
with commit acknowledgment, and the spec is explicit that the optimistic
`CellHandle` paths cannot be used for it. A `known-different-host` refusal
carries the host the space is routed to. `Runtime.hostForSpace` returns the
effective host inside the worker, and no runtime-client request exposes it, so
that refusal is the only route an embedder is told. Common Fabric browser-link
receipt remains a dormant concept in the specification and is not work ordered
by this plan.

**7. There is no data migration across a contract change.** The spec names it
as required work and describes the refusal it replaces. Nothing in the tree
attempts it.

## How the work divides

The tension in this plan is between two things: pull requests small enough to
review, and few enough of them to be worth a reviewer's calendar. Two
observations settle where the cuts go.

**The revision record grows cheaply; the retention root does not.** Adding a
field to a `PieceSourceRevision` is additive and backward compatible —
`recordedOrigin` was added that way already, and `getPieceSourceRevisions`
validates each entry and skips what it cannot read. Introducing an immutable
authored-program manifest is not additive: it changes what a revision retains,
what revert reads, what a follower copies across a space boundary, and what the
storage retention roots are. So gaps 1 and 2 do not have to land together, even
though the manifest's identity covers the digest. Fingerprint and digest first,
then the manifest that binds them.

**Three files are the contention.** `runner.ts`, `source-reconciler.ts`, and
`piece-controller.ts` carry every transition. Any two pull requests that both
edit the transition path will conflict, and rebasing a change to a guarded
transaction is exactly the kind of rebase that silently loses a guard. The
tracks below are drawn so that at most one in-flight pull request is editing the
transition path.

**Routing touches none of it.** Gap 6 lives in `StorageManager`,
`runtime-processor.ts`, and the runtime-client protocol. It shares no file with
the source lifecycle apart from the one place a host-qualified `cf://` origin
registers a route. That makes it a genuinely parallel track for a second author.

## The sequence

Four pull requests. The two tracks are independent and can run concurrently.

```
Track A   A1 ──> A2 ──> A3     what a revision records
Track B   B1                    how a learned route persists
```

### A1 — What a revision records

Everything additive, so that A2 has somewhere to put the manifest.

- Implement `getExecutableRuntimeFingerprint()` as
  [`module-loading.md`](../specs/module-loading.md) defines it, and make
  an unavailable production fingerprint an error rather than a fall back
  to the empty value. The empty fingerprint stays only as the canonical
  interpretation of source documents published before this.
- Implement `cf/runtime-neutral-program-digest/v1` over the canonical
  main filename, every authored file's runtime-neutral module identity,
  and the public-subpath map. A2 supplies the map; until then it is
  canonically empty.
- Widen `PieceSourceRevision` with the accepted fingerprint, the digest,
  a `cause` separate from the existing `operation`, the origin revision
  accepted from a followed piece, and the compatibility descriptors a
  later replacement needs without executing the old pattern. Compute the
  cause from the comparisons the spec specifies rather than from the
  caller's intent.
- Add detach-and-rebuild, which compiles the current revision's retained
  program under the current fingerprint, clears the origin, and records
  `rebuiltFrom`. Add the cross-runtime revert path, which rebuilds under
  the current fingerprint when it cannot reuse the historical identity
  and records `revertedFrom` and a runtime-rebuild cause either way.
- Remove `pieceSourceCellSchema`'s dead `lineage` declaration.
- Store the export selector a pinned fabric origin chose, so following one is
  not confined to the export the piece already runs. Settle the fragment
  question first: if the selector is the URL's fragment, this costs no schema
  change and the panel, the repoint dialog, and the command line all inherit
  it.

*Reviewer's check:* recompiling unchanged source under a changed
fingerprint appends a revision whose cause is a runtime rebuild and whose
digest is unchanged, and the revert preview says whether it can reuse the
historical identity.

*Files:* `module-identity.ts`, `pattern-manager.ts`, `cell-cache.ts`,
`runner.ts`, `piece-controller.ts`, `schemas.ts`.

### A2 — The authored-program manifest

This is the heaviest change in the plan. It should land on its own.

- Add `publicSubpaths` to the compiler's `Program` and a normalized
  public-subpath map to lifecycle ingestion. Reject duplicate canonical
  filenames, invalid public names, and targets outside the authored file
  set.
- Add complete program enumeration before import-closure resolution, for
  directory input, generated output, indexed web programs, and retained
  manifests. A resolver that cannot enumerate defines its authored
  program as the reachable closure it returns and may never later report
  an unenumerated sibling as an update.
- Define `cf/authored-program-manifest/v1` — canonical main, a
  filename-sorted list of every authored file with its verified source
  identity, and the key-sorted public map — and make each revision's
  retention reference name one. The manifest retains its source documents
  and the complete transitive graph of pinned fabric dependencies,
  deduplicated, parsed out of pinned specifiers because source documents
  omit fabric links.
- Make fork, follow, revert, and cross-space replication read the
  manifest rather than walking the entry document's synthetic retention
  links.
- Add fork: create a piece from the selected piece's current source,
  detached, recording `forkedFrom` and copying no history.

*Reviewer's check:* a revision that changes only an unreachable sibling
appends a revision with a new digest and an unchanged executable
identity, a follower adopts it, and a revert restores the sibling.

*Files:* `packages/js-compiler`, `packages/runner/src/harness`,
`pattern-manager.ts`, `runner.ts`, `piece-controller.ts`,
`cf-piece-menu.ts`.

### A3 — Roots become ordinary, and legacy pieces get a baseline

- Baseline migration on the first lifecycle-aware load or mutation of an
  existing piece: verify and retain the current closure first, and if
  that fails leave the piece legacy and report that history migration is
  blocked rather than inventing an unrestorable revision. Record the
  canonical empty fingerprint for an affected legacy identity rather than
  relabeling it.
- Materialize a durable tracked-or-detached choice. Do not infer update
  authority from the `patternSource` string, from rollout flags, or from
  the root role. Migrate detached when no durable active choice can be
  established, keeping the locator as inactive historical provenance.
- Move `defaultAppUrl` off the mutable home root into space-creation
  configuration, and make space creation resolve that default through the
  ordinary create transition and then link the resulting piece as the
  root.
- Validate the root-interface contract when `defaultPattern` is created
  or relinked and after every later source transition on a root,
  including after an explicit incompatibility override.

*Reviewer's check:* an existing piece that has never had a revision gains
a restorable baseline the first time it is opened, and a piece that
cannot be baselined says so rather than gaining a broken one.

*Files:* `runner.ts`, `pieces-controller.ts`, `ensure-space-root.ts`,
`packages/home-schemas`.

### B1 — One route operation that can fail

Independent of Track A apart from its consumer.

- A dedicated runtime operation, exposed through the runtime-client
  protocol, that revalidates the DID and normalized origin in the worker,
  synchronizes the home site table before reading it, applies the
  synchronized table's last valid candidate for that DID to the live
  registry before evaluating the supplied hint, returns a conflict
  without writing when the hint is rejected, transactionally appends the
  accepted entry with the synchronized read as a commit precondition,
  awaits the commit, and propagates a resolved `ConflictError` or
  `StoreError` as well as a thrown failure. No retries. Not built on
  `CellHandle.set()` or `CellHandle.push()`.
- Expose a space's effective host through runtime IPC.
- Apply `normalizeSpaceHost` to the default host and to effective-host
  results, reject an invalid default during initialization, and add the
  deployment-level local-development policy before any caller other than
  the loopback case selects HTTP.
- Make host-qualified `cf://` origin ingestion persist its route through
  this operation before committing a hostless canonical origin, and fail
  the transition without changing the piece when persistence fails.

*Reviewer's check:* a receipt whose site-table append loses a
precondition race reports a real `ConflictError` to its caller and writes
nothing.

*Files:* `packages/runner/src/storage`, `runtime-processor.ts`, the
runtime-client protocol, `piece-origin.ts`.

## Tests

Each pull request carries its own cases. Item 11 under the specification's
*Work required* is not a pull request of its own, because a fixture written
after the behavior it covers is a fixture written against the implementation
rather than against the design. Its general version-to-version golden replay
fixtures ride with A1. That is where a fingerprint and a digest first make
"the previous version" a thing a fixture can name. The existing synthetic
home-shaped and default-app-shaped replays in `packages/piece/test` are the
template.

The transition matrix — every transition, concurrent source and origin
races, failed and incompatible updates, self-follow, concurrent
reciprocal follows where at most one commits, subscription cancellation,
authorization loss — belongs to the pull request that introduces each
transition. `packages/piece/test/piece-source-lifecycle.test.ts` and
`packages/runner/test/source-reconciler.test.ts` are where those already
live.

## What this plan defers, and why

**Data migration across a contract change** (gap 7) is named as required work
by the spec and is not scheduled above. It is a feature in its own right — the
spec's own text says what a refusal really wants is a migration and that
building one is required work, without specifying it — and everything else on
this list is finishable without it. The panel already makes its absence visible
and actionable rather than silent, which was the part that could be done
first.

**Following an arbitrary external endpoint** is not deferred, it is out of
scope: an `https://` string names no origin, and a piece recording one carries
something a person can read and repair. The whitelist is what keeps a piece
from compiling whatever a location happens to answer with, and the two kinds it
admits are the two that authenticate, content-verify, and carry provenance.

**The reader-side result contract check** is likewise unscheduled. The
spec is explicit that only a reader's own check can catch outputs it was
not built for, because the piece being updated cannot see who reads it.
That is a change to how a reader declares what it consumes, not to the
source lifecycle, and it should be designed where readers are designed.

**Reliable route discovery** — host unavailability, replicated hosts,
failover, stale site-table entries, authenticated replacement of an
explicit route — is called open design work by the spec and stays open.
B1 supplies only the durable route-ingestion operation needed by a
host-qualified fabric origin.

**Asking for a change in words** — a menu item on a piece that takes a
description, runs an agent session to author the update, and publishes it
— is specified in full by
[hosted pattern authoring](../specs/hosted-pattern-authoring.md), with its
own build order in [the matching plan](hosted-pattern-authoring.md). That
spec owns the **Request a change** menu item, the `cf piece change` and
`cf space create` commands, the server-hosted session, and a publication
step that ends in one direct-edit transition which clears the active
origin and appends a detached revision naming the authoring session as its
cause. It is not deferred here so much as owned there.

The dependency runs one way and is worth stating: that spec disables its
menu item when a piece has no complete retained authored program, so **A2
gates hosted authoring**. Its own status section says as much. Nothing
else in this plan blocks it.

## Related

- [`../specs/piece-source-lifecycle.md`](../specs/piece-source-lifecycle.md)
  — the design of record.
- [`../specs/module-loading.md`](../specs/module-loading.md) — the
  fingerprint and digest definitions A1 implements.
- [`../specs/pattern-update-testing.md`](../specs/pattern-update-testing.md)
  — the release gate whose existence is why a `system:` candidate is
  adopted as it stands.
- [`../specs/pattern-imports/pattern-updates.md`](../specs/pattern-imports/pattern-updates.md)
  — the narrower same-toolshed mechanism this lifecycle absorbed.
- [`../specs/hosted-pattern-authoring.md`](../specs/hosted-pattern-authoring.md)
  and [`hosted-pattern-authoring.md`](hosted-pattern-authoring.md) — asking
  for a change in words, and publishing what an agent authors through this
  lifecycle. A2 gates it.
- [`../features/piece-bulk-operations.md`](../features/piece-bulk-operations.md)
  — the batch lane. Nothing in this plan moves a piece nobody opened.
