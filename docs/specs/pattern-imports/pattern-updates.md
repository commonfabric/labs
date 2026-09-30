# System-source pattern updates — following a toolshed's own patterns

How a piece that follows a same-toolshed **system source** learns that source
has moved, and what the toolshed owes it so the answer can be trusted. Home and
default-app roots are ordinary pieces with such an origin; so is any other piece
that records one.

Following an origin is one mechanism for every piece and every origin kind, and
[`../piece-source-lifecycle.md`](../piece-source-lifecycle.md) is its design of
record. This document covers only what is particular to a `system:` origin: the
`?identity` route the toolshed serves, the identity check that route makes
possible, and the release gate that decides whether a new system pattern may
ship at all.

This document is also a companion to `README.md`, which covers static `cf:`
imports and publication through naming and placement. Static imports remain
pinned and do not adopt the live update behavior specified for piece origins.

## Status

Implemented. A piece follows its origin when it is opened — one mechanism for
every piece, with no path of its own for any kind of piece — and a `system:`
origin resolves to the patterns route of whichever host serves the piece's
space. A user opening a piece is what opens most of them; the runtime opens the
surfaces it instantiates for itself, which record the `system:` ref they were
made from and are followed the same way. Resolving an external `https://`
endpoint at open time is specified by the lifecycle and not built, so a piece
that records one keeps what it runs. The downloaded source and its import
closure must compile to the identity that route advertises before the persisted
pointer can change. What the piece runs is then replaced by what that origin
says, without comparing the two contracts: the check that makes a system-pattern
release safe to adopt is the release gate below, which is exactly why this
exemption is confined to origins this deployment serves.

No kind of piece has a path of its own, and nothing follows an origin on behalf
of a piece nobody opened. Tenure activation ensures the root exists without
following its source. The serving wish builtin explicitly opens its
runtime-supplied sidecars, so those origins are followed on the serving runtime;
ON clients reference the served sidecars. The executed root milestone map and
the corrections found
during that implementation are archived at
[`docs/history/specs/pattern-imports/system-pattern-updates-implementation-plan.md`](../../history/specs/pattern-imports/system-pattern-updates-implementation-plan.md).

## Last Updated

2026-08-27

## Motivation

- **System patterns must self-heal and roll forward.** `home.tsx` /
  `default-app.tsx` are the most critical patterns to keep current. A root is
  resolved without starting, follows its source, and is only then
  bootstrapped — the same sequence every piece takes when it is opened. The manual `recreateDefaultPattern`
  (shell Debugger button / CLI) remains a state-losing escape hatch: it mints a
  new piece and relinks it. URL-based recreation stamps the new root's source so
  the replacement remains eligible for future automatic repair.
- **The rest of the system source tree must move too.** A non-root pattern may
  have been compiled from any file served by the toolshed pattern route, and it
  follows that source on the same trigger and through the same path as a root.
  A piece nobody opens is never checked, so nothing pays for a source it is not
  looking at.
- **Two hazard cases to handle explicitly.** (1) We shipped a broken system
  pattern — once a fix ships, recovery must be automatic. (2) A
  schema-incompatible update slips through — the damage must be *bounded*
  (fast rollback), because the schema-valid-but-semantically-wrong case is not
  reliably detectable.
- **One mechanism.** "Resolve a source pointer to a current identity, then
  swap in place" is what every piece origin does, and a `system:` ref is one
  kind of pointer rather than a path of its own. What it still adds is the
  release gate below, which is why a candidate from it needs no comparison
  with what the piece runs.

## Non-goals (this doc / v1)

- **The rest of the lifecycle.** Web URL origins, fabric URLs that name pieces
  or content-addressed patterns, source history, detach, fork, revert, and
  repoint are specified in
  [`../piece-source-lifecycle.md`](../piece-source-lifecycle.md). This document
  covers only what a `system:` origin adds to it.
- **Lineage / fork detection.** No substrate exists today — `parents` was
  deleted with the pattern-id retirement, and `pieceLineageSchema`
  (`packages/runner/src/schemas.ts`) is dead code, referenced nowhere.
  Deferred; automatic system-source updates continue to track one exact source
  path and do not attempt to infer user fork relationships.
- **CFC provenance of fetched source.** Pattern source can carry private data;
  labeling fetched/replicated source is follow-up work (README § Security),
  not built here.
- **Cross-host published refs + persisted space→host discovery.** v1 system
  updates only ever read a space's *own* toolshed.
- **Semver / version ranges.** An update tracks a mutable pointer's *current
  identity*, never a version string.

## Background: what exists today

| Mechanism | Where | Role here |
|---|---|---|
| Pattern pointer `patternIdentity = {identity, symbol}` on the piece result cell | `runner.ts` (`applySetupState` / `getPatternIdentityRef`) | The thing an update rewrites |
| **In-place re-run watcher** — `setupPatternWatcher` sinks the `patternIdentity` meta; on change it cancels the old pattern's nodes and re-instantiates the new pattern **onto the same result cell** | `runner.ts` (enabled unless `doNotUpdateOnPatternChange`) | Applies a pointer move when the piece is already running; a piece that is not running has the new pattern staged over its document by the transition itself |
| `SourceReconciler` | `packages/runner/src/source-reconciler.ts` | Origin resolution, identity lookup, verified closure compile, and the guarded transition — one path for every piece |
| Space root: `spaceCell.defaultPattern` link → root piece → `patternIdentity` | `packages/piece/src/ops/pieces-controller.ts` (`linkDefaultPattern`/`getDefaultPattern`) | What a system update rewrites |
| `ensureDefaultPattern` (resolve → follow the origin → start) / `recreateDefaultPattern` (manual, **not** state-preserving) | `packages/piece/src/ops/pieces-controller.ts` | The root's open path and its repair ladder, and the state-losing escape hatch (recreate); both URL-based creation paths stamp `patternSource` |
| System patterns = **raw TSX served by path**, bundled via `deno compile --include`; **no name→identity manifest** | `packages/runner/src/harness/patterns-route.deno.ts` defines the route; `packages/toolshed/routes/patterns/patterns-server.ts` and `patterns.routes.ts` name this deployment's directories and wire it into the server | Where the current system source + its identity come from |
| Per-space host resolution: `mappedHostFor(space)` / `registerSpaceHost` (3-tier: seed `spaceHostMap` → learned site-table → default) | `Runtime.mappedHostFor` / `registerSpaceHost` in `packages/runner/src/runtime.ts`, `storage/v2-remote-session.ts` | Which toolshed a space's source is fetched from |
| Identity computation: `transformInjectHelperModule` + `computeModuleIdentities` | `harness/pretransform.ts`, `sandbox/module-record-compiler.ts` | What toolshed runs to answer `?identity` |
| Entry-doc `annotations` + `annotatePattern` | `pattern-manager.ts`, `cell-cache.ts` | **Rejected as the carrier** — see below |

**Why not the source-doc `annotations` field.** It exists (`annotatePattern`,
non-hashed, excluded from `verifySourceDocs`) and looks like a natural home for
"where updates live" — but it is **space-local**: `writeSourceDocs` preserves
the *destination* cell's annotations, and replication does not copy the
*source's* (`packages/runner/src/compilation-cache/cell-cache.ts`). An
`updatesAt` written in a publisher's space
would not appear on a consumer's replicated copy. The **piece** is the reliable
carrier: explicit source provenance travels with it. An unstamped piece follows
nothing, and nothing reconstructs an origin for it from the names of the modules
it happens to run — a module's name equals its route only for a program compiled
over HTTP, and an author controls it either way. Provenance is claimed, by
whoever instantiates the piece, at the moment they do.

## The model

Two decisions carry the whole design:

1. **A piece that follows a source records that source in a `patternSource`
   string.** (`patternSource`, *not* `source`: the latter is the doc-level
   producer annotation the server-primary work uses.) Roots stamp it at
   creation, from the configured system source for their space kind. So does
   every other piece the runtime brings into being from a pattern this
   deployment serves: the wish builtin's profile and suggestion surfaces are
   the ones that exist today, and they record the `system:` ref naming the file
   they were made from. A piece that records nothing follows nothing, whatever
   it is and wherever its modules happen to be named: being a root is not
   provenance, and neither is a filename that looks like a route.
2. **Following = resolve `patternSource` → current identity; if it differs from
   the persisted `patternIdentity.identity`, adopt the source it names.** This
   runs when the piece is OPENED, before it starts, so it never runs source
   its own origin has already replaced. A piece that is already running has its
   new pattern re-instantiated in place by the existing `patternIdentity`
   watcher; one that is not running has the new pattern staged over its
   document by the same transaction that records the transition.

`PiecesController.getDefaultPattern` — the resolution every registry listing,
CLI `piece ls`, FUSE mount, and shell list cell goes through — carries the
root's last rescue. A root that already followed its origin and still cannot
start, and that records no origin or the same official system source, is rolled
forward to that source and started once more. Without it an unopenable root
takes every listing down with it (the 2026-07-29 cf-cell-context retirement,
caught by the loom vendor gate).

That rescue is narrow on purpose:

- It is authorized only when a by-identity load resolves `undefined` — the
  artifact unavailable through every supported recovery path. A load that
  **throws** is a failed check, not evidence: the root stays pinned.
- The probe asks "loadable in the **current runtime**" (in-memory artifact
  index, live evaluated modules, then durable storage) — not "survives a cold
  restart". A warm artifact can only cause extra pinning, never extra
  replacement.
- Under `cfcEnforcementMode: "disabled"` the by-identity probe is unsupported
  (it returns `undefined` unconditionally), so the root stays pinned there.
- A root following anything else keeps what its owner chose. Replacing its
  source with the system default would discard that choice rather than repair
  anything.
- The replaced root records the displaced `{ identity, symbol, displacedAt }`
  under `displacedPattern` meta. This is an audit and forensic pointer — the
  displaced program's compiled artifacts remain content-addressed in the
  space — not (yet) an automated restoration mechanism.

Two different failures reach the rescue, and they part company when the
official source turns out to compile to the identity the root is already
pinned to:

- The root could not be **loaded**. Compiling the official source has just
  made that identity's artifact available, so there is nothing to swap and
  staging it over the document is the whole repair.
- The root loaded and could not be **run** — its setup was refused by the CFC
  migration, or it could not read its own stored argument. Staging the same
  entry again refuses identically, so the rescue stops and reports one clear
  error naming which check refused rather than looping.

A root that loads and starts can still be wrong in a quieter way: its document
was last staged by a different pattern version than the one it is pinned to, so
it reads through a stale result projection and fields the pinned version added
come back absent. Opening a root re-stages it when its setup completion marker
disagrees with its pinned identity — but only once following its origin has
CONFIRMED that pinned identity. A root the origin did not confirm may be pinned
to a pattern that is simply wrong for it, and re-staging that one buys nothing
the rescue above cannot do with a real failure in hand.

The 2026-07-21 estuary migration bricked every pre-provenance home root — no
explicit-migration tool can reach a private home whose owner key lives only in a
browser — and a loom vendor update then hit the same wall on a non-home space
root. That is the shape the rescue exists for.

### What a `patternSource` string can be

`patternSource` is a string meta on the piece result cell. For a space root it
is stored on the root piece. It is dispatched by its scheme:

- **`cf:` fabric ref** (published) → resolve via the fabric chase
  (`fabric-ref-resolution.ts`: slug → piece → `patternIdentity`). A
  `cf:pattern:<hash>` ref is **frozen** (resolves to a constant → never
  updates); a bare slug **tracks**. Immutability is just a pinned ref.
- **`system:` ref** (a pattern this deployment's toolshed serves from its
  patterns directory, addressed relative to that route, e.g.
  `system:system/default-app.tsx` → `/api/patterns/system/default-app.tsx`) →
  use `?identity` against the space's host, then fetch and compile whenever the
  persisted artifact needs an update or repair. The ref is host-relative, so it
  survives a space moving hosts; a ref that would climb out of the patterns
  route is refused.
- **Anything else** → no fetch. The scheme is a whitelist rather than a
  filter, because a bare path cannot be distinguished from an authored module
  name that merely looks like a route, and resolving such a name against the
  host reaches whatever the site serves for an unrouted path.
- **General source URL origins** use the discriminated active-origin and
  revision schemas defined by the piece source lifecycle spec. They must not
  overload the raw string with origin-kind-specific behavior. A fabric
  `cf://` URL that is unpinned and resolves to a mutable
  `patternIdentity`-bearing entity stores the stable entity rather than a slug
  and follows its current pattern. A fabric URL that resolves to
  `pattern:<hash>` or carries a trailing pin on an entity FID stores exact,
  immutable source and cannot update. The tentative piece-origin policy rejects
  slug-shaped URLs even when pinned. Static imports may still use pinned slugs.

Baseline migration preserves the current pattern independently from update
authority. It creates an active origin only when a durable tracking choice can
be established under the ordinary consent rule. Otherwise it keeps the legacy
locator only as inactive historical provenance and migrates the piece as
detached. Rollout flags are not durable per-piece consent.

Migration rewrites a pre-scheme system locator — the rooted patterns-route
path, and the absolute web URL that path resolves to under the space's own
accepted host — into the `system:` ref naming the same file. A locator on any
other host is left alone: re-pointing it at the local toolshed would be a
change of source, not a change of spelling. A query or fragment on a legacy
locator is dropped, since the patterns route serves a file by path and
revalidation is the `?identity` ETag's job; the rewrite is otherwise exact, and
a locator that cannot be spelled as a ref is left as authored rather than
rewritten into one that would not resolve. Re-spelling an origin is an origin
change like any other, so it appends a revision — and a piece with no history
yet gains a baseline revision for its pre-rewrite state first. That pair is
what a reader of the source panel sees once, per piece, and never again. If no accepted host can be
established, migration does not invent an active origin. Because the ref is
host-relative, a later host remapping needs no rewrite; changing which *file* a
piece tracks still requires an ordinary repoint.

A source-less legacy root does not gain an origin merely because it is a root.
An official candidate path can always be derived for a space, but a derived
path is not a choice anyone made: the root stays detached unless a durable
tracking choice explicitly supplies and authorizes an origin.

**Born-from determinism.** The system chooses a root's initial source when it
creates the space. In the target model, it passes that source through the same
creation transition used for any other piece. That transition writes the first
revision. It writes a normalized active origin only when creation also makes
the ordinary explicit choice to accept future updates from a mutable default.
The current implementation instead seeds a non-home root's `patternSource` from
the home root's `defaultAppUrl`, canonicalized to the ref naming the same file
so a root is born with the provenance it keeps rather than waiting on a
migration to become followable. A configured value that is a rooted path naming
no file under the patterns route is refused outright, because a piece cannot
record an origin nothing can follow. Editing that template later does **not**
change an existing root. Changing that root's source is an ordinary repoint,
edit, revert, or other lifecycle operation. Under the tentative identifier-only
URL policy, a template stores a canonical space DID with a stable entity FID,
or it stores a space-free content identity. Under the dormant
[Common Fabric URLs](../fabric-urls.md) concept, a registry would resolve a
browser name before the template reaches the lifecycle operation. No such
resolver is planned for deployment.

Today `defaultAppUrl` is output state on the home root. That is not a durable
home for creation configuration once the home root can be repointed or
relinked like any other piece. Root lifecycle unification moves the value into
space-creation configuration outside any root piece. It is never origin state
for an existing root.

### Grammar extension: host as a hint

`README.md`'s grammar gains the host authority as a **resolvable hint**, not
new per-ref storage:

```
cf:[[//toolshed.url]/space/][slug]
```

These are fabric-internal source URLs as well as import specifiers. When used
as a piece origin, an unpinned URL that resolves to a piece or another mutable
pattern-bearing entity follows its current `patternIdentity`. A URL that
resolves directly to a content-addressed pattern is immutable. A trailing pin
on an entity-FID URL makes that URL immutable, including when its unpinned ref
names a piece. The piece-origin validator rejects a slug-shaped form even when
it has a pin.

- The `//toolshed.url` host means *"this space lived at this URL at least at
  some point"* — a bootstrap hint for when the runtime does not already know
  where a space is hosted (we have not built host-discovery-without-hints yet;
  this is a first step toward it).
- **On ingest**, a host-bearing resolver input registers the host with
  `runtime.registerSpaceHost(space, host)`, which changes only the live runtime.
  The lifecycle operation separately writes the accepted space DID to host
  route into the home-space site table before it commits a canonical host-less
  target. A template may then keep the form `cf:/<space-did>/<ref>`. The
  revision also retains the supplied `cf://` URL. A lifecycle follow resolves
  and stores the piece named by a stable entity FID. Under the tentative
  identifier-only policy, a human-readable shortlink resolves before this
  operation. A pin on an entity-FID ref normalizes to exact pattern source. The
  host is routing, not identity; it is not copied into every canonical target.
- Host **hints belong to the space**, not to each cross-space link — a
  home-space site table is the current durable store and the seed of later host
  discovery. The runtime processor hydrates its entries on startup. Writing it
  from a host-qualified lifecycle operation remains required work.
- **Optional ref**: `cf://toolshed/space/` with no ref resolves that space's
  current root pattern through the space cell's `defaultPattern` and then its
  `patternIdentity`. Static resolution pins that result. Under the tentative
  identifier-only piece-origin policy, the lifecycle resolver rejects this
  root shorthand. An outer authoring layer may resolve it to the current root
  piece FID before invoking the lifecycle. Later relinking of the space root
  then does not redirect the follower.
- Space is a **DID**. The retained-source grammar rejects names in `cf:` URLs.
  Under the dormant [Common Fabric URLs](../fabric-urls.md) concept,
  human-readable browser aliases would resolve before the stable source
  reference is stored. No such resolver is planned for deployment.

## In-place apply

The apply is: ensure the new closure is loadable in the space
(`compilePattern(program, { space })` writes source + compiled docs), then use
the normal pattern setup path to install the new result schema, result
projection, `{ identity, symbol }`, and `patternSetupIdentity` completion marker
on the existing result cell. The completion marker is not a pattern pointer;
it records which identity had its complete setup staged. It is also what tells
an apply from a same-version replay when the pointer moved first — the
roll-forward materialize commits the new `{ identity, symbol }` and then runs
setup, and an identity moved with no setup at all leaves the same shape. The
pointer then reads as unchanged, while the marker still names the version that
staged the state.

Setup re-points the piece's stored argument at the incoming argument schema and
validates it in the same transaction, so an apply whose durable argument the new
schema cannot read is refused rather than committed. Two cases are deferred
rather than refused: a slot whose stored value is a link that cannot be
dereferenced in that transaction (a nested piece's argument lives in its host's
document, and "not yet synced" is not "invalid"), and a root carrying no
completion marker at all, which gets one unvalidated setup because absence
cannot be distinguished from a pending apply.

A refusal is a repair failure, not a silent one. The pointer has already moved
by the time setup runs, so re-running the same identity refuses identically;
the boot repair therefore classifies this failure and escalates it to the
roll-forward backstop — the same route a refused CFC migration takes — rather
than retrying a version that cannot read its own root.

During space open,
`ensureDefaultPattern` performs this transaction before calling `startPiece`,
and the updated root still takes the persisted-result dependency-sync path
before its first start. This lets an obsolete pattern that cannot load be
replaced before bootstrap without reading unsynchronized owned cells as their
schema defaults. If the piece is already running, the
watcher cancels its old reactive nodes and re-instantiates the new pattern onto
the **same result cell**.

- **Survives**: the result cell's entity and inbound links. State remains
  reachable when the new pattern reads it through the same stable keys and
  causes.
- **Can become unreachable**: data under keys the new pattern drops or
  renames. This continuity is a semantic contract. CI and golden replay tests
  must exercise representative prior state and verify that the proposed source
  still reads and preserves it. The deployment runtime does not try to infer
  stable-key or stable-cause compatibility.

An automatic update from a `system:` origin runs no structural comparison,
because the release gate below is a better check than the runtime could make
and repeating a weaker version of it would only refuse releases the gate
already cleared. That exemption is what this document buys; a candidate from
any other origin has to prove itself, today by leaving the piece's argument and
result schemas exactly as they are. A manual
source replacement compares either way, reports an incompatibility as a
warning, and can proceed only after explicit acceptance. Neither a structural
check nor the gate proves semantic state continuity on its own. The
root-interface contract remains mandatory in every case. See the
[`Compatibility policy`](../piece-source-lifecycle.md#compatibility-policy).

### The CI gate (`deno task pattern-compat`)

Because the updater applies without that comparison, an incompatible schema
that merges reaches every running piece. CI carries the check instead:
`tasks/pattern-compat.ts` compiles every authored pattern and proves its
argument/result contract against every contract recorded for it under
`packages/patterns/baselines/`, using the same
`assertPatternSchemasBackwardCompatible` that `cf piece setsrc` enforces — so
the two paths cannot drift apart on what "compatible" means.

- A baseline is a small JSON file holding only the two schemas. That is the
  whole input to the check, so no compiled artifact or old source is needed.
- **Every** baseline is checked, never just the newest: a piece rolls forward
  from whatever version it last opened at, and the evolution-policy allowances
  are not guaranteed to compose across steps.
- One refusal is policy, not shape drift: a baseline that describes a
  `FabricSpecialObject` structurally — an object schema whose `required` carries
  the `FabricSpecialObject` brand key, the emission of pre-vocabulary
  compilations — is not accepted against the `FabricPrimitive` type name (`{
  type: "FabricBytes" }` and friends) the same authored field compiles to
  today, even with the source unchanged. Stored values re-stage verbatim
  across an update, so a structural inhabitant of the wrong kind would
  survive it only to fail every prototype-matched read; updating such a piece
  takes redeployment or `dangerouslyAllowIncompatibleSchema`. The full
  argument lives with the check (`schemaSubsetIssue`,
  `packages/piece/src/schema-compatibility.ts`).
- Baselines are **never pruned**, and `deno task pattern-compat --update` can
  only add one. An author-run command that could remove a baseline could remove
  the one that would have caught the break.
- A pattern with baselines that no longer yields a contract — file deleted, or
  no longer exporting a pattern — is reported: pieces tracking that path are
  pinned to their current pattern forever, and nothing surfaces on the piece.

The gate is structural only. State continuity — data under keys the new pattern
drops or renames — needs the golden replay described above, against captured
prior state rather than a schema.

## System-source patterns — the loop

**Serving side (memoized per file for the process lifetime; patterns are fixed
for a host's lifetime).** The pattern route answers a `?identity` query param.
For a requested file: walk its authored import closure via single-file reads
(works in a compiled binary — no directory enumeration) → hash the **pristine**
authored bytes → return the entry identity. **No type-check, no emit** — the
light computation (`resolveEntryIdentity` in the runner). The worker
independently checks the result by compiling the downloaded closure and
comparing its compiler-produced entry identity.

Two implementation facts make the light identity equal what the worker stores as
`patternIdentity`, verified by a parity test against the real `default-app.tsx`
and `home.tsx`:

- **Hash pristine, not injected.** The engine restores each module's original
  pre-injection bytes (`pristineModuleSources`) before hashing, so the light
  path must hash the authored source, not the helper-injected pretransform
  output. Hashing the injected form silently diverges.
- **Name modules by their URL pathname.** A module's identity folds in its
  authored path (`computeModuleHashes`). The worker compiles system patterns
  over HTTP, where `HttpProgramResolver` names every module by its URL pathname
  (`/api/patterns/…`). The route therefore computes `?identity` over
  pathname-prefixed names — **not** patterns-root-relative names — or the two
  identities never match and the check re-updates forever. That computation is
  the runner's `PatternsRoute`, which every host mounts rather than reproduces,
  because a host whose answer differed by a byte would be one no runtime could
  adopt.

Both the `?identity` representation and every source-module representation use
strong checksum `ETag`s with `Cache-Control: public, no-cache`. The identity
itself is the `?identity` validator; a source module's validator is the SHA-256
of its exact response bytes. Clients therefore retain unchanged bytes but must
conditionally revalidate them before every update attempt.

**Runtime side (when the piece is opened).** Resolve the piece without starting
it, run this loop, re-resolve the cell after any metadata transaction, and only
then start it:

1. `url` = the patterns route the piece's stored `patternSource` ref expands
   to. A piece that records nothing follows nothing, and so does one whose
   source is not a `system:` ref. A rooted path from before the scheme existed
   is first re-stamped as the ref naming the same file. A surface the runtime
   instantiates for itself supplies the ref it was made from, so one that
   records none records it here and is followed from then on like any other
   piece; one that records another origin keeps what it records, because that
   is its owner's choice and not the runtime's. `host` =
   `mappedHostFor(space) ?? apiUrl`; the ref is host-relative, so the request is
   same-origin by construction.
2. `currentId` = a revalidating `GET {host}{url}?identity` for this attempt
   (`fetch` cache mode `no-cache`). A matching `ETag` may reuse the cached body
   after a `304`; the browser may not replay it without validation. An HTTP
   failure, empty response, or exception performs no metadata write; the
   subsequent start retains its normal loud failure.
3. If `currentId` equals the running `patternIdentity.identity`, probe that
   exact stored artifact. A successful load is done. A missing or unloadable
   artifact continues to compile from source rather than taking the fast path,
   which is what puts the artifact back.
4. Revalidate `{host}{url}` and every module in its complete authored import
   closure with the same `no-cache` fetch policy, then compile with the export
   symbol the piece already runs. Apply only when the compiler supplies an
   entry ref whose identity exactly equals `currentId`; never synthesize a ref
   or fall back around `?identity`. A fetch, compile, evaluation,
   missing-entry-ref, or identity-mismatch failure leaves the piece unchanged.
5. Synchronize the piece's stored argument, then write the transition. The
   captured identity and source must still match on every attempt, and so must
   that argument, so a concurrent edit, detach, repoint, or replacement wins.
   A piece that is not running has the candidate staged over its document in
   the same transaction; a running one has its pointer moved and is
   re-instantiated by the watcher already installed on it. Staging the candidate
   is also what refuses one the piece's stored data cannot satisfy: the setup
   rejects it, the transaction fails, and the piece stays as it was.
6. Start the piece. A piece compiled moments ago from the source it was created
   with is started directly: following that origin again would only fetch what
   it was just built from. A surface the runtime is instantiating for the first
   time reaches this loop with no piece to follow yet, so steps 2 and 4 resolve
   its supplied ref outright, and the run that brings the piece into being
   records that ref with its creation revision.

## End-to-end identity check

The safety condition is about the content used for this attempt, not the git
revision reported by either process. The toolshed advertises an authored-closure
identity through `?identity`; the worker then downloads the entry and every
import, compiles them locally, and accepts only the compiler-produced entry ref
with that exact identity.

This also fails closed across a rolling deployment. If `?identity`, the entry
source, or any import comes from a different revision, the assembled closure
normally hashes to a different entry identity and the pattern pointer is not
written. The same rule covers an identity-algorithm incompatibility between an
older worker and a newer toolshed: disagreement prevents the update. No
`/api/meta` request, git-SHA comparison, pattern response build header, or
worker-to-shell version-skew signal is part of the authorization path.

Authored identity deliberately does not fingerprint bare runtime imports or the
runtime's implementation. Local compilation and evaluation are a capability
check: a closure that needs an unavailable API, cannot be transformed, or does
not reproduce `currentId` leaves the root unchanged. They are not proof that two
API-compatible runtime builds assign identical semantics to the same closure;
that residual is bounded by system-pattern golden replay and fast redeploy, as
with other schema-valid but semantically wrong updates.

`COMMIT_SHA` remains build metadata only. A source-run toolshed may use it as
the fallback `gitSha` returned by `/api/meta`, matching the field a compiled
binary populates from baked build metadata; the updater does not consult it.

## Detecting and bounding bad updates

- **CI golden replay** against the short, controlled system list before
  shipping — the primary defense (feasible precisely because the list is short
  and we own the source). Synthetic home-shaped and default-app-shaped replays
  prove that the update mechanism preserves representative stable-key state.
  Broader release coverage still needs fixtures for each supported
  version-to-version transition.
- **Self-heal from a borked ship**: fix source → new identity → a root's next
  space open compiles and swaps it before bootstrap; an ordinary pattern's next
  instantiation starts its current graph and then rolls it forward in place.
- **Rollback = redeploy**: ship the prior source → toolshed serves the prior
  identity → the same swap rolls back. No per-piece rollback state needed.
- **Escape hatch**: manual `recreateDefaultPattern` remains (state-losing; last
  resort).
- **Residual**: schema-valid-but-semantically-wrong is not reliably detectable;
  it is *bounded* by fast rollback + golden replay, not gated on.

## Build sketch (seams)

- **Patterns route**: `?identity` handler + per-process `{ name → identity }`
  cache, and strong checksum `ETag` + mandatory revalidation for identity and
  source responses. All of it lives in the runner
  (`harness/patterns-route.deno.ts`), beside `computeModuleIdentities` and
  `transformInjectHelperModule`, because the identity it answers with is the
  one a worker computes from the same source. A host supplies the directories
  and mounts the route: toolshed at `patterns.routes.ts` /
  `patterns.handlers.ts` / `patterns-server.ts`, and a self-hosted test
  harness beside its own storage server.
- **Runtime worker**: `SourceReconciler` owns per-space host resolution,
  conditionally revalidated `?identity` and source-closure fetches, locally
  compiled source-closure verification, and the guarded transition. The piece
  controller awaits it whenever a piece is opened, before that piece starts.
- **Piece**: `patternSource` meta getter/setter; stamped by URL-based creation
  and recreation from the applicable source (system path, or a `cf:` ref derived
  from `defaultAppUrl`). Custom `RuntimeProgram` recreation remains unstamped;
  its optional repository locator is separate provenance.
- **Home root and creation configuration**: `defaultAppUrl` currently lives on
  the home root. Root lifecycle unification moves it into durable
  space-creation configuration outside any root piece. A per-space host-hint
  store is a later addition.
- **Grammar/resolver**: implement `cf://host/...` (register-on-ingest; today
  it throws "M3 not yet supported"); slug-optional = space root.

## Phasing

1. **Default (non-home) space root, always-update.** Least risky —
   `default-app.tsx` carries little durable state. `patternSource` field +
   in-place swap + toolshed `?identity` + local compiled-identity check.
2. **Home root.** Carries real user data (favorites/journal/spaces). A
   representative golden replay enabled its rollout with the other system
   roots. Broader version-to-version CI coverage remains release discipline,
   not a deployment-time semantic check.
3. **One path for every piece.** Following an origin runs when a piece is
   opened, whatever kind of piece it is and whatever kind of origin it records,
   with source history as specified in
   [`../piece-source-lifecycle.md`](../piece-source-lifecycle.md).
   Migrating a piece's data onto a candidate whose contract differs from the
   accepted one, saying on the piece's own source panel when it has stopped
   following its origin, and offering to take a refused candidate anyway, are
   the pieces of that path still missing.
4. **Creation configuration.** Move the home root's `defaultAppUrl` into
   creation configuration outside any root piece, and validate the
   root-interface contract whenever `defaultPattern` is created or relinked.
5. **Cross-host origins.** Validate and register the supplied space-to-host hint
   through the ordinary per-space storage manager before opening the origin
   space. After registration accepts it, persist it before committing a
   hostless canonical origin, and hydrate it before later resolution. Do not
   create a secondary session. A seeded route can only be confirmed. Once a
   late hint is accepted, a different hint is a conflict even before the space
   opens. After the space opens, only the hint already in effect can be
   confirmed. Any other route attempt fails the transition. Add ordinary
   authorization checks. Cross-host routing uses the same provenance checks as
   a source flow between spaces on one toolshed. Reliable recovery from an
   unavailable host or a moved space remains open design work.

## Resolved questions

1. **System-pattern identity query.** Keep the implemented `GET …?identity`
   application protocol. It returns the identity of the complete authored
   pattern closure, so neither a raw source-file `ETag` nor a `HEAD` request can
   replace it. Strong `ETag`s and conditional revalidation apply independently
   to each HTTP representation and complement the closure identity.
2. **Space-root lifecycle and migration.** A space root is an ordinary piece.
   The system chooses its initial source when creating the space. The configured
   default affects only future roots. Migration does not infer tracking consent
   from the root role. Update, detach, follow, fork, revert, and repoint use the
   ordinary piece rules. Assigning the root role separately requires
   root-interface compatibility.
3. **Home-data stable addressing.** `home-golden-replay.test.ts` pins
   representative favorites, journal, and spaces state across an in-place
   update. That evidence allowed the home root to follow its origin like every
   other piece. Future supported source transitions need CI fixtures using
   representative prior state.
4. **Compatibility checks and deployment boundary.** Publishing or uploading
   pattern source does not compare it with an existing piece. A manual
   replacement compares argument, result, and retained-input schemas, warns on
   a known incompatibility, and requires explicit acceptance to continue. An
   automatic origin update blocks the same known structural incompatibility
   because no user is present to accept it. The root-interface contract remains
   mandatory. Stable keys, stable causes, intended migration, and behavior are
   verified by CI audits and golden replays. The runtime does not try to infer
   those semantic contracts during deployment.
