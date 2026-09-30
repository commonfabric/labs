# Content-Addressed Action Identity

Retiring `implementationRef`, the `unsafe_originalPattern`/`unsafe_parentPattern`
backrefs, and pattern-scoped function registries in favor of `{ identity,
symbol }` references and object-keyed (WeakMap/WeakSet) trust.

## Status

Phases 0–2 shipped: #3997 (ordinal-free `implementationRef` + legacy-alias
shim), #4006 (A: `unsafe_parentPattern` deleted), #4008 (B: derived-copy side
tables, `unsafe_originalPattern` deleted), #4009 (C: `$implRef` dual-write +
CFC provenance), #4013 (D: pattern-scoped registries deleted, provenance
recording in `Engine.#recordModuleProvenance`).

Phase 3 shipped in two PRs:

- **E1 (#4053, writer flip)**: writers emit `$implRef` only;
  `implementationRef` and the stringified body are no longer written where
  the reading runtime's engine proves the `$implRef` resolvable through its
  strong content-addressed implementation index
  (`ExecutableRegistry.registerVerifiedImplementation`, the resolution of
  open question 1 — see § Open questions). The legacy `implementationRef` is
  still written for exactly one category: registry-admitted artifacts the
  `$implRef` cannot cover — host-trusted values (`trustedHostFunctionIndex`,
  whose closures cannot survive a stringified round-trip) and dynamic
  in-action-created artifacts (no provenance symbol). `VerifiedProvenance`
  carries the evaluating load's `bundleId` so stored bundleId-only
  `writeAuthorizedBy` claims keep verifying without a `verifiedLoadId`.
- **E2 (legacy machinery deletion)**: every loadId surface is gone — frame
  threading, side tables, `seedVerifiedLoadIds`, per-load registry
  partitions and capture walks, the loadId-scoped `Engine` methods, the
  CFC `implementationRef`×`verifiedLoadId` arm (provenance is the only
  source of `kind: "verified"`), `FunctionCache`, and the prewarm walk. New
  `writeAuthorizedBy` claims are stamped with `moduleIdentity` only. What
  remains of the legacy machinery is exactly the gate-2 retained read path —
  `ensureImplementationRef` (+ ordinal shim) feeding ONE string-keyed global
  executable index behind `getExecutableFunction`, the bundleId-only
  verification arm for stored pre-#4009 claims, and the `unsafe-host:`
  minting that rides the same channel (the §5 synthetic-identity registrar is
  deferred to the cycle that retires this read path; decisions recorded in
  the implementation plan).

- **E3 (pattern JSON boundary, scoped to dual-write)**: `Pattern.toJSON()`
  emits the pattern's content-addressed `$patternRef: { identity, symbol }`
  ALONGSIDE the full graph; internal graph serialization
  (`serializePatternGraph`, the §7 escape hatch — used by builder-time node
  serialization and thus the `$opFallback` graphs) stays a bare graph, so the
  in-memory representation and the eviction fallback can never silently
  become refs. Readers dual-read: `resolveOpPattern` and llm-dialog's tool
  invocation (`resolveStoredPattern`) prefer the live canonical pattern by
  identity and fall back to the carried graph. Refs-ONLY emission was
  assessed and deferred (see §7 below and the implementation plan's E3
  gating record): there is no session-lifetime strong index for pattern
  artifacts — E1's implementation index is function-keyed, javascript
  modules only — so stored refs resolve solely through the FIFO-bounded
  artifact index (sync) or `loadPatternByIdentity` (async), neither of which
  covers the sync list builtins or cross-session llm-dialog reads.
  Canary: the stored-vintage canary pinned both graph vintages until E5
  retired them (now `test/stored-pattern-rehydration.test.ts`).
- **E4 (refs-only pattern JSON)**: the E3 blocker resolved —
  `addressableByIdentity` is session-lifetime (open question 1 extended to
  pattern artifacts; the FIFO eviction deleted), so sync resolution covers
  every module evaluated in the reading session. `Pattern.toJSON()` emits
  `{ $patternRef, argumentSchema, resultSchema }` with NO graph (patterns
  without an entry ref still serialize their graph); the op sentinel drops
  `$opFallback` (a sync miss is now a loud bug, not a recoverable state);
  llm-dialog adds the async storage-backed net (`resolveStoredPatternAsync`
  → `loadPatternByIdentity`; compiled artifacts persist in-space as an
  expected part of compilation). Stored graph vintages keep loading
  tolerantly; see §7's status block for the full record.

- **E5 (legacy read path retirement — MIGRATION COMPLETE)**: on the explicit
  data-wipe decision (no production data to preserve, so gate 2's stored-data
  evidence requirement dissolves), the entire legacy channel is gone:
  `ensureImplementationRef` + the ordinal shim, the ambient registrar, the
  string-keyed `verifiedFunctionIndex` + `getExecutableFunction`, the
  runner's legacy resolution arm, `Module.implementationRef` itself, the
  bundleId `writeAuthorizedBy` verification arm (+
  `ImplementationIdentity.bundleId`, `provenance.bundleId`), and the stored-
  vintage read tolerances. The two categories that still wrote legacy refs
  got their endgame designs: builder calls inside a running action THROW at
  creation time ("define the <kind> at module level", with a transformer-bug
  hint — CT-1644's hoisting makes this unreachable from authored source), and
  host-trusted values ride minted `host:<n>` PSEUDO-MODULES — registered as
  symbols in the session-lifetime implementation index, serialized as normal
  `$implRef`s, never granted CFC identity (§5, fail closed). A claim carrying
  a legacy bundleId stamp is recognized as stamped-but-unservable and fails
  closed rather than being re-bound to the next verified writer. Resolution
  gains the live-trusted arm: a module whose implementation carries
  trust-gated identity facts (provenance, or a host/artifact entry ref) runs
  that function directly — the in-memory path that used to flow through the
  legacy index.

Phase 4 is COMPLETE: there is one resolution model — content-addressed
`{ identity, symbol }`, by identity, everywhere.

The last parallel addressing scheme — the `pattern:<createRef>` patternId and
the pattern meta cell — is now also retired (patternId is the same content
address in a second, non-canonical encoding). See
[pattern-id-retirement](../history/specs/pattern-id-retirement.md): `{ identity, symbol }` is
the only pattern pointer; cold recovery recompiles from the `pattern:<identity>`
source docs.

The design assumes the shipped loader state: the ESM
module-record loader is the only loader, every module has a content-addressed
identity (`cf:module/<hash>`), and every module-scope builder artifact
(pattern / lift / handler) is addressable as `{ identity, symbol }` — authored
exports by export name, hoisted/non-exported artifacts by their `__cfReg` key
(see `docs/specs/module-loading.md` and the op-by-identity migration that
introduced the `$patternRef` sentinel, `builtins/op-pattern-ref.ts`).

Two updates supply the update-chain exception to strict hash equality, and
derive the same chain: an explicit `piece setsrc`, and an unattended update
from a `system:` origin — a release the deployment gated — through the source
reconciler. In both, the old and new entries match each other, the rest of their
recursive source closures are matched by canonical full filename — directly,
or under the root substitution the two entry names define — and successor
module documents accumulate the predecessor hashes they may act as. A loaded
successor can satisfy a `writeAuthorizedBy` claim stamped by one of those
predecessors only in the space whose authenticated module documents carry that
delegation, and only when the binding path still matches. Source file spelling
is diagnostic at verification; a renamed module below the entry grants no
authority because canonical filename matching derives no delegation for it.
Ordinary recompilation and unrelated or cross-space module loads grant no such
authority.

## Last Updated

2026-09-15

## Motivation

Three legacy identity mechanisms predate content addressing and now duplicate
it badly:

1. **`implementationRef`** (`builder/module.ts:ensureImplementationRef`) — an
   opaque per-function ref minted from `{ kind, source: fn.src, preview:
   fn.toString(), ordinal: frame.generatedIdCounter++ }`. The **ordinal makes
   it build-order-dependent**: it is not a content address, and cross-reload
   matching works only because pattern instantiation is deterministic. It keys
   four string-indexed maps in the `ExecutableRegistry`, the per-runner
   `FunctionCache`, the CFC verified-identity resolution, and rides along in
   serialized module JSON (`moduleToEncodableForm` spreads it via `...rest`).

2. **`unsafe_originalPattern` / `unsafe_parentPattern`** (symbols in
   `builder/types.ts`) — in-memory backrefs from serialized pattern copies to
   the live branded original. They exist so that (a) trust-chain walks
   (`isTrustedPattern` / `isTrustedBuilderArtifact`) can confer trust on
   copies, and (b) `getArtifactEntryRef` can resolve a copy to the registered
   `{ identity, symbol }`. Symbols never survive the storage round-trip, so
   every consumer already has a backref-less path; the symbols only serve the
   in-memory hop between build-time serialization and instantiation.
   `unsafe_parentPattern` is **write-only today** (set in
   `pattern-binding.ts:354`, read nowhere in `src/`) — it is already dead.

3. **`patternId`-scoped function registries**
   (`ExecutableRegistry.verifiedPatternFunctions` / `verifiedPatternLoadIds`,
   populated by `associatePattern`) — a session-scoped secondary index so a
   rehydrated pattern instance resolves *its* load's function objects. This
   exists to disambiguate equal `implementationRef`s across loads — a problem
   content addressing dissolves (below).

The scheduler is migrated to content addressing, with a fingerprint/id split:

- The durable implementation **fingerprint** keys on the per-**symbol** content
  address `impl:cf:module/<hash>:<symbol>` (`schedulerImplementationFingerprint`,
  `scheduler/run.ts`) — it identifies the implementation *code*, with no
  `implementationRef` dependence.
- The action **id** — the durable observation lookup key and the in-session
  `actionStats` key — must stay per-**instance**, so it appends a
  source-location-independent instance discriminator:
  `cf:module/<hash>:<symbol>:<instanceKey>`, where `instanceKey` is a
  reload-stable hash of the action's `{process, reads, writes}` links
  (`getSchedulerActionId`/`schedulerActionInstanceKey`, `scheduler/diagnostics.ts`
  + `runner.ts`). Without the instance key, N instances of one hoisted op (one
  `lift` called twice, a `map`, a repeated sub-pattern) would collide on a single
  id and observation.

Persisted-data compatibility: observations written under the previous
`fn.src`-derived id/fingerprint simply miss the new content-addressed lookup on
first resume, so the action re-runs once (the safe default) and re-persists under
the new key — no `SchedulerActionObservation.version` bump or re-key is required.

## The invariant this design stands on

**Every referenced pattern/handler/lift is addressable as `{ identity, symbol }`.**

- The builder-call-hoisting transformer
  (`ts-transformers/src/transformers/builder-call-hoisting.ts`) hoists every
  `lift(...)`/`handler(...)`/`pattern(...)` call to module scope
  (`__cfLift_N`/`__cfHandler_N`/`__cfPattern_N`) and emits a trailing
  `__cfReg({...})` registering every hoisted and non-exported module-scope
  builder artifact. Exports are addressable through the module namespace.
- `PatternManager.registerEvaluatedModules` indexes both channels into
  `addressableByIdentity` (identity → symbol → live value, FIFO-bounded) and
  `valueToEntryRef` (live value → `{identity, symbol}`), gated on
  `isTrustedBuilderArtifact`.
- Per-instance state does NOT live in function closures: handler/lift
  implementations are module-scope functions, and instance state is bound
  explicitly through node inputs (`$ctx`). Two `handler(...)` calls at the same
  source location are distinct hoisted symbols, not colliding closures.

**Soundness of content-addressed function resolution.** The per-module SES
verifier rejects top-level mutable bindings (`classifyModuleItems`: "Top-level
mutable bindings are not allowed in SES mode"). A verified module therefore has
no module-scope mutable state, so any two evaluations of the same module
identity produce **interchangeable** function objects. This is what makes it
sound to resolve a serialized node's implementation from *any* live evaluation
of that module identity — and what makes `patternId` scoping unnecessary.

For artifacts with no compiled module (host functions, in-test builders), a
synthetic-identity registration path covers the gap (§ Host and test
artifacts).

## Audit: where we make pattern copies, and whether we still need them

(The `unsafe_*` symbols only exist to ride on copies; if a copy site goes away
or stops needing identity-carry, the symbols die with it.)

| # | Copy site | What it does | Verdict |
|---|---|---|---|
| C1 | `createPattern` (`builder/pattern.ts` ~332, 368–373): build-time serialization of `result` + every node's `module`/`inputs`/`outputs` via `withAliasBindings` | Produces the `Pattern` object — the durable graph representation. Writes `unsafe_originalPattern` onto every nested pattern copy (`to-encodable-form.ts:183`) | **Copy stays in memory; stops crossing the serialization boundary.** The in-memory graph remains the instantiation representation; `toJSON` at the storage boundary emits refs (§7). The *backref* is replaced by registering the copy in a side table at copy time (§ Trust). |
| C2 | `moduleToEncodableForm` pattern-type implementation (`to-encodable-form.ts:387`, the CT-1230 workaround): sub-pattern passed as a module implementation (e.g. to `.map()`) | Serializes the nested pattern graph instead of stringifying it | **Subsumed by op-by-identity.** The op already travels as `$patternRef` + `$opFallback`; with `$opFallback` retained the embedded copy is only the fallback payload. When the fallback is dropped (Phase 4), this copy site disappears. |
| C3 | `traverseValue` (`traverse-utils.ts:54`): copies during build traversal (`collectCellsAndNodes`, `node-utils` connect) | Preserves the backref so a traversal copy still resolves `getArtifactEntryRef` | **Copy stays; backref replaced** by side-table registration at the same line. |
| C4 | `unwrapOneLevelAndBindToDoc` (`pattern-binding.ts:333–340`): instantiation-time rebinding copies | Propagates backref + the `verifiedLoadId` side-table entry to the bound copy | **Copy stays; backref replaced** by side-table registration; the `verifiedLoadId` propagation is deleted outright (CFC identity no longer flows through loadIds — § CFC). |
| C5 | `unsafe_noteParentOnPatterns` (`pattern-binding.ts:346–358`): writes `unsafe_parentPattern` | Nothing reads it | **Delete now.** Independent of the rest of this design. |

Net: the copies themselves are mostly load-bearing (the serialized graph is the
product); what dies is the *symbol-on-object identity-carry*. The replacement
is one explicit call at each copy site:

```ts
// Shown as interface or class members.
// pattern-manager (or a small trust module):
noteDerivedCopy(copy: object, original: object): void
//  - if isTrustedBuilderArtifact(original): brand `copy` as derived-trusted
//    (WeakSet add — same side-table family as brandTrustedPattern)
//  - if valueToEntryRef.has(original): valueToEntryRef.set(copy, ref)
```

This converts the *lazy backwalk* (follow symbols at lookup time) into an
*eager forward registration* (record at copy time). Lookup sites
(`isTrustedPattern`, `isTrustedBuilderArtifact`, `getArtifactEntryRef`,
`findOriginalPattern`) collapse to single WeakSet/WeakMap probes — no chain
walks, no cycle guards, no symbol declarations on `Pattern`.

Security note: the forged-value defense is unchanged in kind but simpler in
mechanism. Today a forger cannot reference the module-private symbol; tomorrow
there is nothing on the object at all — trust lives exclusively in runner-owned
WeakSets keyed by object identity, which `__cf_data`-forged values can never
enter (they are never passed to `noteDerivedCopy` with a trusted original).
`cfreg-security.test.ts`'s string-keyed-symbol forgery tests become "no
property on the object grants trust" tests.

## Target design

### 1. Serialized form: `$implRef` sentinel

A JavaScript module (handler/lift) in a serialized graph carries a plain-data
sentinel instead of `implementationRef` (+ conditionally stringified
`implementation`):

```jsonc
{
  "type": "javascript",
  "wrapper": "handler",
  "argumentSchema": { /* ... */ },
  "resultSchema": { /* ... */ },
  "$implRef": { "identity": "<module-hash>", "symbol": "__cfHandler_1" },
  "preview": "function (event, ctx) { ... }",   // debug only
  "location": "cf:module/<hash>/file.tsx:42:15" // debug only
}
```

- `identity` — prefix-free module content hash (same namespace as
  `$patternRef`, the compile cache, and `fn.src`).
- `symbol` — export name or `__cfReg` key of the **factory** the builder
  returned. The implementation function is reached as `factory.implementation`.
- Exactly the `$patternRef` precedent; same trust gate on resolution
  (`indexArtifact` only indexes `isTrustedBuilderArtifact` values, so whatever
  resolves is builder-made by construction).
- During the transition the stringified `implementation` is retained as the
  fallback payload (mirror of `$opFallback`); see Phases for when it drops.

`ensureImplementationRef` is deleted; nothing is minted at builder time. The
sentinel is stamped where the op sentinel is stamped today: at node
instantiation/serialization time, via `getArtifactEntryRef(factory)` —
generalizing `substituteOpPatternRefs` from `map/filter/flatMap` ops to **every
javascript-module node**.

### 2. Resolution (runner)

`resolveJavaScriptFunction(module, pattern)` becomes:

1. Live module object (fresh build): `module.implementation` is the function —
   use it (status quo; no lookup at all).
2. Rehydrated module with `$implRef`:
   `patternManager.artifactFromIdentitySync(identity, symbol)?.implementation`.
   This hits whenever the owning pattern is running — its module was evaluated,
   which is what populated the index. (Same liveness argument as ops; the
   bounded cache's eviction risk is covered by the fallback during transition,
   and by pinning the running pattern's modules — see Open questions.)
3. Fallback (transition only): stringified source via `getInvocation` (SES
   `evaluateCallback`) — runs sandboxed but **unverified**, so CFC identity is
   `unsupported` (fail-closed), exactly as registry misses behave today.

`FunctionCache` re-keys from `module.implementationRef` to the module object
(it already takes the module; a WeakMap keyed by module object also drops the
string indirection) — or is deleted if step 2 is cheap enough (two Map hits).

### 3. CFC implementation identity

Today (`cfc/implementation-identity.ts`): `kind: "verified"` is proven by
`getVerifiedFunctionInLoad(verifiedLoadId, implementationRef) ===
implementation` plus `isVerifiedSourceInLoad`, and reported as `{ bundleId,
sourceFile?, bindingPath?, sourceLocation, codeHash? }`. The `bundleId` is the
load's concatenated-script hash — load-scoped, not content-addressed.

Target: registration during verified evaluation records provenance keyed by
the **function object**:

```ts
// populated by registerEvaluatedModules / the __cfReg sink walk:
verifiedProvenance: WeakMap<Function, {
  identity: string;          // module content hash
  symbol: string;            // factory's export/__cfReg key
  bindingIdentity?: { sourceFile: string; bindingPath: string[] };
                             // from __cfVerifiedBindingIdentity (CT-1665),
                             // read off the factory annotation directly
}>
```

`resolvePolicyFacingImplementationIdentity` becomes: look the *function object*
up in `verifiedProvenance`; if present, emit

```ts
// Shown for illustration only.
{ kind: "verified",
  moduleIdentity,            // replaces bundleId — content-addressed, reload-stable
  symbol,                    // replaces codeHash for module-scope artifacts
  sourceFile?, bindingPath?, // unchanged semantics (writeAuthorizedBy)
  sourceLocation }           // from fn.src (already canonical cf:module/<hash>/…)
```

else `unsupported` (fail-closed). The WeakMap *is* the anti-spoof check — an
attacker-supplied function was never registered during a verified evaluation,
so it has no entry; there is no string key to collide and no loadId to scope.
This strictly strengthens the policy identity: `bundleId` varied per load and
per surrounding file set; `moduleIdentity` is stable for byte-identical code.

Consequences:
- `verifiedLoadId` threading through frames / `JavaScriptNodeContext` /
  `to-encodable-form` (`frame.verifiedLoadId` in `moduleToEncodableForm`'s
  `admittedImplementation` probe) is deleted. `setVerifiedLoadId` /
  `getVerifiedLoadId` side tables and `seedVerifiedLoadIds` /
  `annotateVerifiedPatterns` walks are deleted (their job — marking which load
  verified a pattern — is subsumed by `valueToEntryRef` + `verifiedProvenance`).
- `isVerifiedSourceInLoad` / `verifiedLoadSources` / `verifiedLoadBundleIds`:
  the source check becomes "does `fn.src`'s `cf:module/<identity>` prefix match
  the provenance identity" — a string comparison against the WeakMap entry, no
  per-load source sets.
- CFC label/policy storage that embeds identities: anything persisted that
  contains a `bundleId` is already load-scoped (unstable), so policy matching
  re-derives per session — switching to `moduleIdentity` is
  backward-compatible for enforcement (fail-closed on mismatch) but check
  `cfc/canonical.ts` digests for any persisted comparisons (Phase audit item).

### 4. ExecutableRegistry: what remains

Deleted: `verifiedFunctions`, `verifiedFunctionIndex`,
`verifiedFunctionLoadIds`, `verifiedBindingMetadata`,
`verifiedPatternFunctions`, `verifiedPatternLoadIds`,
`trustedHostFunctionIndex` + `unsafe-host:` ref minting, `beginVerifiedLoad`'s
cross-load index repair, `captureVerifiedValue`'s whole-namespace
`recordVerifiedFunctions` walk, `associatePattern`,
`setVerifiedFunctionRegistrar` and the builder-time
`registerVerifiedFunctionImplementation` channel.

Remaining (likely small enough to fold into PatternManager or a `trust.ts`):
- `verifiedProvenance` WeakMap (above) and its registration walk over
  `exportsByIdentity` + the `__cfReg` sink (today's
  `captureVerifiedBindingCandidates`, generalized).
- Host trust WeakSet (below).

`runner.discoverAndCacheFunctions` (prewarm walk keyed by ref) is deleted —
prewarming by `{identity, symbol}` is a single index probe if still wanted.

### 5. Host and test artifacts (the "pseudo module")

Some trusted callables have no compiled module: host-provided functions
(`runtime.unsafeTrustHostValue`, used for wish/builtin host capabilities) and
builder artifacts constructed directly in tests.

Design: a synthetic-identity registrar, one mechanism for both:

```ts
// Shown for illustration only.
runtime.unsafe_registerHostArtifact(value: object, options: {
  symbol: string;            // caller-chosen name
  reason: string;            // non-empty, like UnsafeHostTrustOptions today
}): { identity: string; symbol: string }
// identity = `host:` + hash of (reason, symbol, monotonic nonce) — a distinct
// namespace from cf:module hashes; never collides with compiled identities.
```

- Indexes `value` in `addressableByIdentity`/`valueToEntryRef` like any
  artifact, so serialization and resolution are uniform (`$implRef` with a
  `host:` identity resolves in-session only — host artifacts were never
  resumable from storage, unchanged).
- Trust: adds the value (and its `.implementation`) to a `hostTrusted` WeakSet;
  execution allowed, but CFC identity stays `undefined`/`unsupported` exactly
  as `unsafe-host:` refs behave today (`resolvePolicyFacingImplementationIdentity`
  returns `undefined` for host artifacts — fail-closed for policy purposes).
- Tests use the same API (possibly sugared as a `test-support` helper
  `registerTestArtifact(value, name)`), replacing every test that today relies
  on builder-time `implementationRef` registration outside a compiled program.
  Tests that want **verified** (CFC-passing) artifacts compile a small
  in-memory program — already the dominant idiom.

### 6. `patternId` scoping: deleted

`verifiedPatternFunctions` existed so a pattern instance resolves the function
objects of *its* load when the same `implementationRef` was registered by
several loads. Under content addressing any live instance of the same module
identity is interchangeable (no module-scope mutable state — § Invariant), so
the global `addressableByIdentity` index suffices and the pattern-scoped
second key is dropped. `PatternManager`'s piece/meta `patternId` (URIs, meta
cells, LRU) is unrelated and stays.

### 7. Pattern JSON becomes refs; the graph representation goes internal

Decision (resolves former open question 1): the serialization *boundary* emits
`{ identity, symbol }` refs — the full node-graph JSON becomes a runtime-
internal representation (and a debug output, e.g. `cf check --pattern-json`).

The timing objection that motivated the lazy backref does not apply at the
boundary: `createPattern` runs during module evaluation (refs not yet indexed),
but `toJSON` runs when a value is *written to a cell* — after
`registerEvaluatedModules` has indexed the module. So:

- `Pattern.toJSON()` → `{ $patternRef: { identity, symbol } }` (plus
  `argumentSchema`/`resultSchema` if consumers need them without resolving).
- `moduleToEncodableForm` for a pattern-type implementation (C2) → the same ref, not an
  embedded graph.
- `moduleToEncodableForm` for javascript modules → `$implRef` (§1).
- `Pattern.nodes` / `result` / `initial` stay as the in-memory instantiation
  representation only; nothing outside the runner consumes them as JSON.

Status: COMPLETE in two steps. E3 (2026-06-11) shipped dual-write —
`$patternRef` alongside the graph — because pattern artifacts then had no
session-lifetime index: a stored ref resolved only through the FIFO-bounded
`addressableByIdentity` (sync) or `loadPatternByIdentity` (async), and the
two production consumers of stored graphs (the list builtins' sync
`resolveOpPattern`; llm-dialog's cross-session tool invocation) could not
tolerate a miss. E4 (same day) removed that blocker and completed the flip:

- `addressableByIdentity` is session-lifetime (open question 1, E4
  extension): sync resolution covers every module evaluated in the reading
  session — every authored op by construction, since whatever instantiates
  the map mentioned the op and loaded it as part of its bundle.
- `Pattern.toJSON()` emits `{ $patternRef, argumentSchema, resultSchema }` —
  no graph. Schemas ride along for consumers that read them without
  resolving (llm-dialog tool schemas). A pattern with NO entry ref
  (manually constructed / dynamic / bare-Engine evaluation, e.g. the CLI's
  `--pattern-json` debug dump) still serializes its full graph.
- `$opFallback` dropped from the op sentinel: it was eviction insurance, and
  eviction no longer exists; a sync miss is a loud bug. Stored pre-E4
  sentinel vintages are still read tolerantly.
- llm-dialog follows the sync resolution with the async storage-backed
  `loadPatternByIdentity` (`resolveStoredPatternAsync`) — compiled artifacts
  persist in-space as part of the compilation step (the cold write-back is
  AWAITED inside `compilePattern`, so a persisted ref always has a durable
  closure behind it), and a tool invoked cold after a reload rehydrates
  source-free.
- The write-path audit (E3) found graphs persisted at exactly three
  cell-write sites and on no wire/IPC surface; stored graph vintages
  (pre-E3 bare graph, E3 ref+graph) keep loading and executing — pinned by
  `test/pre-e3-pattern-value-canary.test.ts` alongside the refs-only
  vintage's two resolution paths.
- The internal/boundary split is structural: `serializePatternGraph()`
  (to-encodable-form) serializes the full graph under an internal-serialization
  context that suppresses `$patternRef`; `withAliasBindings` (the
  builder-time node serializer) routes pattern values through it, so
  `Pattern.nodes` stays a bare-graph in-memory representation.

## Persisted-data compatibility

What's in stored graphs today (verified writer): `{ type: "javascript",
wrapper, schemas, implementationRef, preview, location }` — `implementation`
omitted when the function was admitted (verified) at serialization time, else
stringified. Resolution of old data depends on the registry repopulating the
same (ordinal-dependent!) refs when the pattern re-evaluates.

Phased migration (op-migration playbook):

- **Phase 0 — drop the `ordinal` from `ensureImplementationRef` (landable
  now).** The ordinal (`frame.generatedIdCounter++`) was a defense against the
  same function being inline-declared twice; the builder-call-hoisting
  transformer moves every builder call to a module-scope declaration and the
  SES verifier enforces that shape, so under the ESM loader `(kind, src,
  preview)` is already unique — and `src` is the canonical
  `cf:module/<hash>/<path>:line:col`, making the ref content-derived. Removing
  the ordinal eliminates build-order sensitivity (the same class of bug as the
  CT-1623 reload churn). Compat caveat: refs are persisted inside serialized
  graphs (e.g. `$opFallback` payloads); old ordinal-bearing refs will no
  longer match re-minted ones, so resolution of such stored graphs falls to
  the stringified-implementation fallback (or fails where the implementation
  was omitted). Mitigated by a transition shim (landed with Phase 0): the
  counter keeps incrementing at the same call sites and the fn is ALSO
  registered under the legacy `createRef({kind, source, preview, ordinal})`
  alias, reproducing the pre-removal ordinal sequence exactly. The attached/
  serialized ref is the content-derived one. The shim (and its test,
  `implementation-ref.test.ts`) is removed together with `implementationRef`
  itself in Phase 3.
- **Phase 1 — dual-write, dual-read.** Writers emit `$implRef` (+ keep
  `implementationRef` and the conditional stringified `implementation`).
  Readers prefer `$implRef`; absent that, fall back to the legacy
  `implementationRef` lookup (registry retained, deprecated). New CFC
  provenance WeakMap runs in parallel; CFC resolution prefers it and falls back
  to the loadId path. `noteDerivedCopy` lands; copy sites call it *in addition
  to* writing the symbol.
- **Phase 2 — legacy reads behind re-registration only.** Because a stored
  node only resolves after its pattern's module re-evaluates (which re-runs the
  builder and re-mints refs deterministically), the legacy path's only real
  dependency is `ensureImplementationRef` + the global index. Keep exactly
  that pair; delete pattern scoping, loadId threading, and the binding-metadata
  map (provenance WeakMap covers them).
- **Phase 3 — flip.** Writers stop emitting `implementationRef`/stringified
  `implementation`; `unsafe_*` symbols deleted (reads first, then writes);
  trust-chain walks become WeakSet probes; CFC loadId machinery deleted.
  Legacy read shim retained for stored-data only.
- **Phase 4 — drop the shim + fallbacks.** Requires either (a) accepted data
  migration on write (graphs rewrite to `$implRef` whenever a piece is saved —
  they do on every pattern re-instantiation, so old refs age out quickly), or
  (b) a `COMPILE_CACHE_RUNTIME_VERSION`-style cutoff. Also the point to decide
  whether `$opFallback`/stringified-implementation fallbacks can drop in favor
  of storage-backed by-identity loads (`loadPatternByIdentity` covers patterns;
  an analogous module-closure load covers handler modules — both async, so the
  sync action path keeps the in-memory index as the primary).

Rollback safety: Phases 1–2 are additive; the legacy path stays exercised by a
canary test compiling+resolving with `$implRef` stripped.

## What gets deleted (end state)

- `builder/module.ts`: `ensureImplementationRef`,
  `registerVerifiedFunctionImplementation` channel and its
  `setVerifiedFunctionRegistrar` ambient in `function-hardening.ts`.
- `builder/types.ts`: `unsafe_originalPattern`, `unsafe_parentPattern`, their
  `Pattern` declarations and `index.ts` exports.
- `to-encodable-form.ts`: backref write (line ~183), `admittedImplementation` probe,
  the "must carry implementationRef" throw; `moduleToEncodableForm` emits `$implRef`.
- `traverse-utils.ts` / `pattern-binding.ts`: backref/`verifiedLoadId`
  propagation → `noteDerivedCopy`; `unsafe_noteParentOnPatterns` deleted.
- `pattern-metadata.ts`: chain walks in `isTrustedPattern` /
  `isTrustedBuilderArtifact` (brand probes remain), `setVerifiedLoadId` /
  `getVerifiedLoadId` side tables.
- `pattern-manager.ts`: `findOriginalPattern`, `seedVerifiedLoadIds`,
  `patternToVerifiedLoadId`, `associateVerifiedFunctions`.
- `harness/executable-registry.ts`: ~everything string-keyed (§4);
  `function-cache.ts` re-keyed or deleted.
- `cfc/implementation-identity.ts`: loadId/ref plumbing → provenance WeakMap;
  `Engine` loses `getVerifiedLoadId`, `getVerifiedFunctionInLoad`,
  `isVerifiedSourceInLoad`, `getVerifiedBundleId`, `getVerifiedBindingMetadata`,
  `registerVerifiedFunction`, `getExecutableFunction`, `associatePattern`.
- `runner.ts`: `resolveJavaScriptFunction` ref path, `discoverAndCacheFunctions`,
  `verifiedLoadId` threading through `JavaScriptNodeContext`/frames.

## Delivery

- **Separate PRs per target**, independently revertible, each green before the
  next: (1) Phase 0 ordinal removal; (2) `unsafe_parentPattern` deletion
  (write-only today — no design dependency); (3) `noteDerivedCopy` + trust/
  entry-ref decoupling, then `unsafe_originalPattern` deletion; (4) `$implRef`
  dual-write + CFC provenance WeakMap; (5) pattern-scoped registry deletion;
  (6) flips and shim removals per the phases. Action-identity `patternId`
  rides on (5); the broader piece/root-pattern `patternId` (~300 refs across
  shell/piece/runtime-client, wire + persisted surfaces) is a separately
  designed follow-on — it has its own compat constraints (stored ids, IPC) and
  must not be bundled here.
- A note on layering (why `noteDerivedCopy` and not "just look at the
  manager"): the copy sites live in builder-layer utilities with no
  PatternManager handle. Either `noteDerivedCopy` lives module-level next to
  the trust WeakSets (preferred — `valueToEntryRef` keys are globally
  meaningful content addresses, so promoting that map toward module level is
  safe), or the builder calls it through the ambient frame.
- **Red-team pass** (security gate for the CFC change, PR 4): a dedicated
  adversarial review of the verified-identity path — forged functions with
  matching source text, `__cf_data`-shaped factories, replayed `$implRef`s
  pointing at other modules' symbols, host-artifact escalation attempts — with
  each attack landed as a test (extend `cfreg-security.test.ts` /
  `esm-verifier-adversarial.test.ts`). Every fail-closed property must be
  demonstrated, not argued.

## Test plan

- Red-green per phase: serialization snapshot tests pin the `$implRef` form;
  a stored-graph fixture (captured pre-migration) pins legacy-read compat.
- CFC: `cfc-implementation-identity.test.ts` ports to provenance-based
  `{ kind: "verified", moduleIdentity, ... }`; spoof tests assert an
  unregistered function (same source, constructed outside verified eval) is
  `unsupported`.
- Trust: `cfreg-security.test.ts` forgery suite ports from "string-keyed
  symbol is inert" to "no own property grants trust"; derived-copy trust tests
  go through `noteDerivedCopy`.
- Resume: `resume-by-identity` / `by-identity-handler-exec` extended with a
  handler-bearing piece resumed source-free, resolving through `$implRef`.
- Host/test registrar: a piece using `unsafe_registerHostArtifact` callables
  executes but its writes carry no verified identity (CFC fail-closed assert).
- Multi-instance: two pieces from byte-identical programs share resolution
  (the patternId-scoping deletion's regression guard).

## Open questions

1. **Eviction pinning — DECIDED (E1).** `addressableByIdentity` is
   FIFO-bounded; the op path tolerates eviction via `$opFallback`. Dropping
   the `implementationRef` writer removed the unbounded legacy registry's
   eviction insurance for new data, so E1 ships the replacement: a strong,
   session-lifetime, per-engine content-addressed implementation index
   (`ExecutableRegistry.#verifiedImplementationsByEntryRef`, populated by
   `Engine.#recordModuleProvenance`, surfaced as
   `Engine.getVerifiedImplementation`, consulted by `resolveByImplRef` after
   the bounded artifact index misses). Chosen over refcount pinning (piece
   lifecycle is fuzzy; high complexity) and a WeakRef shadow (fails exactly in
   the post-eviction-GC scenario it must cover). Memory is bounded by the set
   of distinct verified implementations per session — strictly less than the
   legacy per-load registries retained.
   **E4 extends the same resolution to pattern artifacts:**
   `addressableByIdentity` itself is now session-lifetime (its FIFO eviction
   deleted) — the same retention order, since the strong function index
   already keeps every verified implementation alive, and module-scope
   functions referencing module-level patterns transitively retain those
   factories anyway. With sync resolution eviction-proof for every module
   evaluated in the session, `$opFallback` was dropped: the op sentinel is
   stamped from its live artifact in the same session that reads it, so a
   miss is a loud bug, not a recoverable state. The module-NAMESPACE cache
   (`modulesByIdentity`) stays bounded; its misses recover via the async
   storage-backed load.
2. **`cfc/canonical.ts` digests.** Confirm no *persisted* artifact compares
   `bundleId`s across sessions (believed session-only; verify before Phase 3).
3. **`location`/`preview` retention.** Keep both on serialized modules for
   debugging (they're inert), or derive `location` from `$implRef` + symbol?
   Default: keep.
