# Content-Addressed Module Loading

## Status

The ESM module-record loader specified here is the runtime's only loader.

Shipped and normative: per-module content-addressed identity (a Merkle hash over
each module's authored TypeScript source and its transitive import graph),
loading of per-module records into a SES compartment under `cf:module/<hash>`
specifiers, per-module security classification and structural graph
verification, per-module source maps, and persistence of source and compiled
modules as content-addressed cells per space.

Settled target behavior that still requires integration, called out at each
point below: the authoritative `getExecutableRuntimeFingerprint()` provider and
the executable identities that fold its value into external-dependency leaves;
the `publicSubpaths` program input and the `cf/runtime-neutral-program-digest/v1`
comparison value built from it; provenance-aware handling of authored and mounted
`.d.ts` declarations; and pin-on-deploy ordering for fabric type edges.
Production pattern compilation, entry-identity calculation, source verification,
and replication use the empty runtime fingerprint until that provider is enabled.

## Last Updated

2026-07-30

## Summary

Module identity is **module-grained**. Each module is content-addressed by a
Merkle hash over its own **authored TypeScript source**, its authored path, and
the hashes of every module it imports. That hash is:

- **stable** across entry points and unrelated sibling files, because it depends
  only on the module's own reachable import closure;
- **stable as authored source across TCB evolution**, because a runtime-neutral
  module identity hashes the author's source and pinned specifiers rather than
  compiled output. The executable module identity separately folds the runtime
  fingerprint into external-dependency leaves. An affected importer therefore
  receives a new executable identity after a runtime upgrade;
- **transitively sensitive**, because changing any module in that closure changes
  the importing module's hash too — behavior can change when an imported function
  *or an imported type* changes, and the fingerprint must reflect that.

The naive alternative — hashing each module's bytes in isolation — would be
stable across entry points but **incorrect**, because a module's runtime behavior
depends on what it imports. If module `A` imports `compute` from `B` and `B`'s
implementation changes, `A`'s behavior changes even though `A`'s own bytes did
not — and likewise if `A` imports a *type* from `B` that `B` redefines, because
that type is lowered into `A`'s generated schema. A correct fingerprint is both
stable across entry points and sensitive to transitive changes in any imported
module, value or type. The Merkle construction is what makes it both.

Imports are tracked regardless of whether they are value or type imports.
TypeScript types are load-bearing in Common Fabric: the transformer lowers types
into the emitted output (JSON schemas are generated from types, and those schemas
drive runtime validation and reactivity). A change to an imported type can change
runtime behavior, so type-import edges belong in the graph alongside value
imports.

Per-module identity is what makes the loader's addressing possible: emitted
modules are registered as content-addressed specifiers and executed through the
SES module system, so a registry keyed by content hash cannot have filename
collisions.

The consumer that motivates the stable identity is the scheduler's durable
action identity: the implementation fingerprint must survive a reload from a
different entry point, and server-execution v2 keys its basis index by the
same restart-stable identity
([serving-loop.md §3b](server-side-execution/serving-loop.md)).

The iframe sandbox path (`packages/iframe-sandbox`) is entirely independent of
this work and is out of scope.

## Goals

- Give every authored module, and every action within it, an identity that is
  stable across reloads and across the entry point used to compile it.
- Make that identity sensitive to transitive changes: editing an imported
  function or type invalidates the fingerprint of everything that transitively
  imports it.
- Keep a runtime-neutral identity for unchanged authored source across TCB
  evolution. Fold the runtime fingerprint into executable identities whose
  reachable graphs contain external dependencies. Revision history can then
  distinguish a runtime rebuild from an authored-source edit.
- Track type imports as well as value imports, because the transformer lowers
  types into emitted output (schema generation), so types affect runtime
  behavior.
- Load each module as its own record in a SES compartment, preserving the
  synchronous execution contract the scheduler requires.
- Preserve the verifiable-execution guarantees: every module item is still
  classified and verified before it can execute or become observable.
- Key the compilation cache per module rather than per program.

## Non-goals

- Do not change the SES security model, lockdown options, hardening, or the
  invocation-isolation guarantees described in
  [SES_SANDBOXING_SPEC.md](sandboxing/SES_SANDBOXING_SPEC.md). This governs how
  modules are *named and loaded*, not what authority they receive.
- Do not change the `packages/iframe-sandbox` DOM-iframe path. Confirmed
  independent.
- Do not change the ts-transformer pipeline's semantics. Only the emitted module
  packaging and the identity computation are in scope.
- Do not require asynchronous action execution. The scheduler runs actions
  synchronously; module loading must remain synchronous at run time.
- Do not attempt cross-runtime-version identity stability. A different runtime
  fingerprint (builder/runtime version, transformer version, scheduler mode)
  invalidates observations.

## Pipeline Overview

### Compilation

[`Engine.compileToRecordGraph`][c1] receives a `RuntimeProgram` =
`{ main, files[], mainExport?, sourceRoots?, dataFiles? }`, where `files` is the
entry file plus its resolved import closure, plus whatever else the source
package carries. `sourceRoots` names attached entry points that are resolved and
compiled but never executed, such as tests. `dataFiles` names members of `files`
that are not code at all: they are split out before the pipeline below runs, so
nothing prefixes, parses, transforms, or compiles them, and they rejoin only at
the identity and persistence steps. Their bytes are carried on the resulting
graph, keyed by stored path. A module reading one gets its own view of the
runtime namespaces that expose `dataFile`, whose reader resolves a path against
that module's own stored name — the way the record compiler resolves an import
specifier against the importing source — and then looks it up in that closure.
The result is a graph of per-module records.
It:

1. Derives a per-load program id and prefixes every file path with it
   ([`pretransformProgramForModules`][c2]). The prefix is a per-load namespace
   for source-map and diagnostic coordinates only; it is deliberately **not**
   part of module identity, and there is no synthetic `/index.ts` entry — the
   program entry is simply the prefixed main module.

2. Computes each module's content-addressed identity
   ([`computeModuleIdentities`][c7], over [`computeModuleHashes`][c3]) with the
   prefix stripped, so identities are entry-point independent and dedupe across
   programs. Programs carrying mounted fabric subtrees go through
   [`computeFabricModuleIdentities`][c7], which hashes each mount as its own
   standalone source set.

3. Compiles the closure through the `CommonFabricTransformerPipeline`, emitting
   one CommonJS body per module ([`MODULE_KIND`][c4]) plus a per-module source
   map. There is no whole-program `outFile` bundle.

4. Wraps each emitted body in a module record keyed `cf:module/<identity>`
   ([`compileSourcesToRecords`][c7]) and security-classifies it
   ([`verifyCompiledModuleBody`][c8], called from the Engine) before it can be
   loaded or cached.

5. Validates the assembled graph's shape and wiring
   ([`verifyModuleGraph`][c8]). Both verifications belong to the compile path:
   nothing in the graph has executed yet when they run.

### Loading

`lockdown()` runs once: the loader calls [`ensureSESLockdown`][c10], which
delegates to the idempotent [`ensureSESInitialized`][c10]. [`loadModuleGraph`][c6]
creates one `Compartment` per load, freezes its global bindings, and drives the
entry with `compartment.importNow(entrySpecifier)`. Its `verify` option runs
[`verifyModuleGraph`][c8] and defaults to **on**, so a graph assembled outside
the Engine cannot load unchecked; the Engine passes `verify: false` because it
already ran the check while compiling. Because every reachable record is
registered in the compartment's `importNowHook` up front, no asynchronous import
occurs at run time, preserving the scheduler's synchronous-execution contract.
Trusted runtime modules are ordinary records in the same graph under
`cf:runtime/<specifier>` ([`runtimeModuleRecords`][c6]); endowment and hardening
are unchanged. Exactly four specifiers are admitted —
[`RuntimeModuleIdentifiers`][c15]: `commonfabric`, `commonfabric/cfc`,
`commonfabric/schema`, and `turndown`. The Engine registers records only for
those ([`Engine.runtimeModuleNames`][c1]), and
[`isAllowedAuthoredImportSpecifier`][c15] admits only those four bare
specifiers, alongside relative/absolute local paths and `cf:` fabric refs
(which resolve to authored `cf:module/` records of their own, not to runtime
records — see the pin-in-source rule below). Any other bare specifier is a
compile error rather than a `cf:runtime/` record.

Records are SES *virtual* (third-party) records — `{ imports, exports, execute }`
([`VirtualModuleRecord`][c6]) — because this build of `ses` exposes no
`ModuleSource`/`StaticModuleRecord` constructor. Import cycles resolve through
lazy `compartment.importNow` inside `execute`.

### Identity flow into action identity

- [`Engine.#recordModuleProvenance`][c1] records each emitted module's identity
  and the module-scope symbols it exports or hoists, and joins each symbol to
  the authored position the compiler recorded for it in that module's
  builder-source-site sidecar.
- The scheduler's durable implementation fingerprint is stamped from that
  provenance at action creation (`applyImplementationHash`, `packages/runner/src/runner.ts`)
  and read back by [`schedulerImplementationFingerprint`][c12]. It is a content
  hash, not a source location: `.src` is served lazily from the debug-only
  [`authored-debug-source`][c16] map, through accessors
  [`defineAuthoredDebugAccessors`][c16] installs during builder construction,
  and is never consulted for identity.

## Model

### Module Identity: Merkle hash over the import graph

Identity is defined per module, bottom-up over the import graph, including
**all** imports — value and type.

For each authored module `M`:

- `normSrc(M)` — the canonical normalized representation of `M`'s **own** code
  (not its dependencies', which enter the hash via the Merkle edges below). It is
  the authored TypeScript source of `M`, as written, before the CF transformer
  pipeline and before TypeScript emit. Normalization is limited to line-ending
  canonicalization ([`normalizeSource`][c3]); type annotations and comments are
  retained. Hashing the author's source rather than compiled JS is deliberate:
  - It keeps the runtime-neutral module identity **stable across TCB
    evolution.** The transformer and compiler are the trusted computing base;
    they improve over time. Hashing emitted output would make it impossible to
    tell a runtime rebuild from an authored-source change. The executable module
    identity separately includes `runtimeFingerprint` on external-dependency
    leaves. A runtime upgrade therefore changes affected executable identities
    without changing the runtime-neutral module identity.
  - It naturally **includes types**, which are load-bearing (the transformer
    lowers types into emitted schemas). Types are therefore not stripped, and
    type-only and value imports need no distinction.
- `path(M)` — `M`'s authored, program-relative filename. It is part of the hash
  so two byte-identical modules at different paths keep distinct identities.
  The per-load program prefix is stripped before hashing, so the path is stable
  across entry points.
- `deps(M)` — `M`'s imports (value and type alike), each a pair
  `(specifierText, target)` where `target` is either another authored module or
  an external runtime module. External specifiers are deduplicated and then
  sorted. Internal edges are partitioned: those leaving `M`'s
  strongly-connected component are sorted by `(specifierText, targetHash)`, and
  those staying inside it by `(specifierText, targetPath)` — see **Cycles**.

The hash is computed over strongly-connected components of the import graph, so
that an import cycle hashes as a unit. For the acyclic case a component has one
member, `intraDeps` is empty, and the construction reduces to:

```
componentHash(M) = H({
  v: "cf/module-id/v1",
  members: [ { path: path(M),
               src:  normSrc(M),
               external:  sortByText([ (specifierText_i, runtimeLeaf(target_i)) ]),
               crossDeps: sortBySpecifierThenHash([ (specifierText_j, moduleHash(target_j)) ]),
               intraDeps: [] } ],
})

moduleHash(M) = H(["cf/module-id/v1", "module", componentHash(M), path(M)])

runtimeLeaf(target) = "runtime:<specifierText>@<runtimeFingerprint>"
```

Every member field is always present — `intraDeps: []` in the acyclic case, not
omitted — because `H` hashes an absent key differently from an empty array.

`H` is the existing SHA-256 construction [`hashStringOf`][c13]. External runtime
modules (`commonfabric`, etc.) are leaves keyed by the runtime fingerprint, so a
runtime upgrade invalidates everything that imports them, consistent with the
existing `runtimeFingerprint` invariant.

**Cycles.** ES modules permit import cycles, so the import graph is not strictly
a DAG. Identity is computed over the condensation ([`tarjanSccs`][c3]): each
strongly-connected component is hashed as a unit over its members sorted by
authored path, folding in each member's `path`, `normSrc`, external leaves, and
out-of-component edges, plus the *structure* of its intra-component edges
(`(specifierText, targetPath)` pairs) so two different cycle shapes over the same
sources hash differently. Every member then derives its own
`moduleHash = H(tag, "module", componentHash, path)`, so members of one cycle
remain individually addressable. Tarjan yields components in reverse-topological
order, which is exactly the bottom-up order the Merkle hash needs.

**Import-edge completeness.** Every `import`, `import type`, `export … from`, and
inline `import("./mod").Type` edge is collected
([`collectImportSpecifiers`][c5]); there is no value/type filtering and no
dependence on emit elision. `export * from` barrel edges are counted as ordinary
edges, so a barrel does not collapse distinct modules into one hash. Missing a
type edge would silently treat a behavior-changing type edit as a no-op, which is
the under-counting the construction exists to avoid. Dynamic `import()`
expressions and `require()` are unsupported and are not edges.

The executable runtime fingerprint comes from one authoritative provider,
`getExecutableRuntimeFingerprint()`. Its version-1 value is a domain-separated
hash with the tag `cf/executable-runtime-fingerprint/v1`. The hash includes:

- the value returned by [`getCompileCacheRuntimeVersion()`][c14];
- [`schedulerRuntimeFingerprint()`][c12];
- an automatically generated catalog hash of the implementations and export
  surfaces of every pattern-facing runtime module; and
- an automatically generated catalog hash of the sandbox and execution-policy
  inputs that can change pattern behavior.

The existing compile-cache runtime version intentionally hashes a broad set of
compiler, transformer, schema, harness, sandbox, API, compiler-option, and
dependency inputs. Version 1 uses that value as a mandatory input even though it
can over-invalidate executable identities. A later design may split
representation-only cache inputs from executable semantics. Such a split may
roll `runtimeVersion` alone only for an input proven unable to affect compiled
behavior. A compiler, transformer, generated-schema, runtime-module, sandbox,
execution-policy, or scheduler-semantics change must roll the executable runtime
fingerprint.

The provider and its input catalogs are required production work. Once the
provider is enabled, inability to calculate its value fails closed. The empty
fingerprint remains only the canonical interpretation of source documents
published before this integration. It is not a valid fingerprint for newly
published source whose identity depends on an external module.

Piece history compares complete authored programs with a versioned,
runtime-neutral digest:

```text
const hashes = computeModuleHashes(authoredProgram, {
  runtimeFingerprint: "",
});
const normalizedExports = Object.entries(publicSubpaths)
  .sort(([a], [b]) => utf8Compare(a, b))
  .map(([subpath, filename]) => [subpath, filename]);
const runtimeNeutralProgramDigest = hashStringOf({
  v: "cf/runtime-neutral-program-digest/v1",
  main: authoredProgram.main,
  modules: [...hashes]
    .sort(([a], [b]) => utf8Compare(a, b))
    .map(([filename, identity]) => [filename, identity]),
  exports: normalizedExports,
});
```

The input is the explicitly enumerated canonical authored program before adding
fabric-mounted files or synthetic retention links. It includes every enumerated
authored file, including an unreachable sibling and an authored declaration
file. It also includes the normalized exact public-subpath map from the
immutable authored-program manifest. A program with no explicit subpaths uses
an empty map; its entry remains implicitly public through `main`. Each
per-module identity includes the canonical filename, normalized source,
internal import graph, and external specifier text, including fabric pins. The
digest excludes the selected executable export, which revision comparison
checks separately. It is comparison metadata rather than a fabric URL,
executable identity, or revert target.

`publicSubpaths` is required lifecycle input alongside the repository's current
`Program` shape. The existing `Program` interface has only `main` and `files`.
Adding the map to source ingestion and retained manifests is required work; the
digest code above describes the target algorithm rather than current behavior.

Changing only the public-subpath map changes the manifest identity and this
digest. It does not change any per-module identity or the executable entry
identity. Piece lifecycle history therefore records a source-only revision and
propagates it to followers without rebuilding unchanged modules.

The lifecycle source service must materialize that complete `Program` before
import-closure resolution. The current `ProgramResolver` interface cannot
enumerate unreachable files, so existing resolver-only flows define their input
as the reachable closure until they adopt an explicit program manifest.

Authored and verified mounted `.d.ts` files are source-only identity nodes. A
value or type import of one of these declarations contributes the declaration's
module identity to every transitive importer. The declaration is stored in
source history but does not produce a JavaScript module record.

Declaration stubs supplied by the runtime for modules such as `commonfabric`
remain type-check inputs rather than authored identity nodes. The authored bare
specifier stays an external leaf that contains the runtime fingerprint. Record
assembly, compiled-cache membership, and compiled links include only emitted
modules.

Production `Engine` paths currently filter every `.d.ts` file before
[`computeFabricModuleIdentities`][c7], `CacheableModule` construction, and
[`writeSourceDocs`][c14]. Replacing that blanket filter with provenance-aware
type-check, identity and source-history, and emitted sets is required integration
work.

#### Stability and sensitivity properties

- **Entry-point independence.** `moduleHash(M)` is a function only of the
  transitive import closure reachable from `M` and the authored source text and
  paths of those modules. It does not reference the entry point, sibling modules
  outside `M`'s closure, file ordering, or any per-load program prefix. Therefore
  the same module with the same reachable imports hashes identically no matter
  which entry point pulled it into a compilation.
- **Runtime sensitivity with source continuity.** `moduleHash(M)` changes with
  `runtimeFingerprint` when `M` or its reachable dependencies import an external
  module. A module with no reachable external dependency remains unchanged. A
  separate runtime-neutral module identity over authored source and pinned
  specifiers identifies the module across runtime rebuilds. Trusting a persisted
  observation still requires both a matching `moduleHash` and a matching
  `runtimeFingerprint`.
- **Transitive sensitivity.** If any module `N` in `M`'s closure changes,
  `moduleHash(N)` changes; since `moduleHash(N)` is an input to every module that
  transitively imports `N`, all of their hashes change. Changes propagate to
  fingerprints along every import edge, value or type.

#### Action / function identity

An action's implementation identity is a stable intra-module symbol scoped by the
module hash, never a line:col source location:

```
actionImplId = "cf:module/" + moduleHash(M) + ":" + stableSymbol(M, decl)
```

`stableSymbol` is the exported binding name where one exists, or the hoisted
`__cfReg` registration key for anonymous callbacks (`pattern`, `lift`,
`handler`, `action` arguments). An artifact whose provenance carries a module
identity but no symbol is addressed by the one-part `cf:module/<identity>` form
instead. [`schedulerImplementationFingerprint`][c12]
therefore reports a genuine content hash, so a clean persisted observation can
never be trusted against changed code. The reference machinery that carries
`{ identity, symbol }` through the runtime is specified in
[content-addressed-action-identity.md](content-addressed-action-identity.md).

The instance binding hash computed in `schedulerJavaScriptActionName` /
`schedulerRawActionName` (`packages/runner/src/runner.ts`, over process cell +
read/write links) is orthogonal: it distinguishes multiple instances of the same
implementation. Identity is the pair
*(implementation hash, instance binding hash)*.

#### Type imports are included

Type imports are part of the graph. In Common Fabric the transformer lowers
TypeScript types into emitted output — JSON schemas are generated from types, and
those schemas drive runtime validation and reactivity — so an imported type is
load-bearing: redefining it can change runtime behavior. Hashing authored TS
source (which retains type annotations and `import type` declarations) and
counting every import edge captures type changes by construction.

A static fabric type edge in the supported ESM-style syntax also follows the
ordinary pin-in-source rule. An `import type`, type-only named import or export,
or inline `import("cf:…").Type` reference cannot remain mutable in deployed
source. If it could, a later type change could alter generated schemas and
executable behavior without changing the importing pattern's stored source. The
current `rewriteFabricPins` visitor already rewrites import declarations, export
declarations, and inline import-type nodes. [`collectImportSpecifiers`][c5]
already includes these edges in module identity. Automatic piece deployment still
uses an ordinary local resolver before invoking the rewriter. It therefore
rejects every fabric import or export declaration at that stage, including an
already-pinned reference. Correct pin-on-deploy ordering remains required
integration work.

The CommonJS-style TypeScript form
`import type Alias = require("cf:…")` is unsupported. The current visitors do
not recognize its `ImportEqualsDeclaration`, so graph discovery, rewriting, and
identity calculation must reject it explicitly rather than allow it to bypass
the pin. Production resolution and persistence of all authored declaration
inputs also require the integration described in
[pattern-imports/implementation-plan.md](pattern-imports/implementation-plan.md).

### Loader: per-module records in SES compartments

1. **Per-module emit.** Each authored file emits as its own CommonJS body
   ([`MODULE_KIND`][c4]) with its own source map. Bodies must come from the full
   transformer pipeline, not `ts.transpileModule`: only the pipeline emits the
   `__cf_data` wrapping the verifier's grammar requires.

2. **Content-addressed specifiers.** Each emitted module is registered under
   `cf:module/<moduleHash(M)>` and carries a `resolutions` map recording, for its
   own imports, `relativeSpecifierText -> cf:module/<hash>` and
   `runtimeSpecifier -> cf:runtime/<specifier>`. Records whose imports are
   already absolute (the runtime modules) omit the map, and resolution is then
   the identity function. Collisions are impossible under content addressing, so
   no filename namespace is needed and there is no synthetic `/index.ts`.

3. **Synchronous load.** Every reachable record is registered in the
   compartment's module map before execution, and the entry is driven with
   `compartment.importNow(entrySpecifier)` ([`loadModuleGraph`][c6]), so no
   asynchronous import occurs at run time.

4. **Runtime modules as records.** The four admitted runtime specifiers are
   records in the same graph ([`runtimeModuleRecords`][c6]), each copying the
   already-frozen runtime namespace onto its module exports.

5. **Compartment lifecycle.** One compartment per load, hosting all of that
   load's modules, with its global bindings frozen so no module can poison
   globals seen by siblings.

The per-load program prefix survives on the *diagnostic* path only: source maps
resolve through `/<programId>/<authoredPath>`, while identities are computed
prefix-free. Consumers that must present a load-independent spelling normalize
through the Engine's `storedFilenameFor`, which strips the prefix and unmaps
fabric-mount paths. Debug `fn.src` reaches the same load-independent spelling
without a source map: `recordModuleProvenance` joins the module identity to the
sidecar's authored coordinates, yielding
`cf:module/<identity>/<authoredPath>:<line>:<col>`.

## Compilation Cache

The cache key is the per-module `moduleHash(M)`, not a whole-program id. Editing
one file in a multi-file pattern then:

- recompiles only that module and its transitive importers (whose hashes
  changed), not the whole pattern;
- leaves the identities and cache entries of untouched modules stable.

### Storage model: two content-addressed document sets, per space

The persistent cache is **content-addressed cells**, not an in-process map. Each
emitted module is stored as two regular cells in the **target space**. Authored
and mounted declarations have only a source document because they emit no
JavaScript record. There is no global cache. The storage layer's existing
**sigil-link following** under a schema loads the whole import closure
transitively from a single request. Per-document dedup handles cycles, as for any
linked data:

1. **Source set — `pattern:<identity>`.** Authored TypeScript implementation and
   declaration source, keyed by the per-module Merkle `moduleHash`
   (`cf:module/<hash>`, [`sourceDocKey`][c14]). It is independent of the
   compiled-cache `runtimeVersion`. An affected module receives another source
   set when `runtimeFingerprint` changes. It is **self-verifying**: a reader
   recomputes the identity from the source, import graph, and recorded identity
   fingerprint ([`verifySourceDocs`][c14]). Content addressing is the integrity
   check, so no separate label is needed.
2. **Compiled set — `compileCache:<runtimeVersion>/<identity>`.** Compiled and
   verified JS, keyed by `(runtimeVersion, identity)` ([`compiledDocKey`][c14]).
   Under the version-1 executable-fingerprint rule, the existing broad
   compiler-input fingerprint rolls both `runtimeVersion` and
   `runtimeFingerprint`. That creates a new executable identity for an affected
   module and writes a new source set. A future representation-only cache change
   may roll `runtimeVersion` alone only after the fingerprint inputs distinguish
   it from executable semantics.

A source or compiled document is written whole, and only when the stored
document differs. Its `imports` elements are stored inline in the document,
not in documents of their own, so a write of the same document from any
session lands on that one document and touches no other. A stored document
whose elements sit in documents of their own is rewritten whole, and those
element documents are left behind. The pre-write sync loads each document the
write-back writes, so the write reads it with its true version rather than
claiming it absent, a claim the store refuses.

Each new source document whose reachable graph contains an external dependency
also records the runtime fingerprint used for its identity. A source document
without such a dependency uses the canonical empty fingerprint, and writers
omit the field for that value. The same identity therefore never has two
effective fingerprint representations. Other non-normative fields, including
annotations and synthetic retention links, may differ without changing module
identity. An absent fingerprint field always means the empty value for legacy
compatibility. Verification recomputes that document under the effective value.
Removing the non-empty field from a newer document therefore produces an
identity mismatch without a separate missing-field rule. A verifier rejects a
non-empty value on a document whose identity does not depend on it because that
fingerprint representation is not canonical.
As in the existing per-view verifier, each source document becomes the root of
its authored-import view and supplies that view's effective fingerprint.
Synthetic retention links are excluded. This lets one retained source set hold
unrelated legacy and current roots without applying one entry fingerprint to
every document.

Source and compiled documents share the base shape
`{ code, filename, imports: [{ specifier, link }], delegatedModuleIdentities? }`.
`code` is a sigil link to the content-addressed code document holding the
module's text, `cid:<taggedHash>` over the string alone, so identical text is
one document per space however many records or runtime versions name it
([code documents](content-addressed-schemas.md#code-documents)). A read
under the document schema resolves the link to the string, and the loader
checks that the string hashes to the id the link names. A document written
before code documents existed holds the string inline, and readers accept
both. A source document may additionally carry the runtime fingerprint used
for its identity. Their link sets are different. A source document stores internal
authored-import links, including links to authored declarations. It omits fabric
edges so one program's source closure does not absorb another program.
Synthetic retention links may keep other source roots alive, but they are
excluded from the identity hash and executable graph traversal. Separately, an
entry source document stores one identity-only link per member of its source
package that no import reaches: [`SOURCE_ROOT_SPECIFIER`][c7]
(`cf:source-root/`) for an attached source entry point such as a test, and
[`DATA_FILE_SPECIFIER`][c7] (`cf:data-file/`) for an attached data file. Unlike
a retention link, these participate in the entry module's identity, so changing
the package changes the revision. Neither resolves a module record. A data
document is hashed as a leaf over its own bytes and filename rather than through
a parse of its contents, which is what lets a data file hold bytes that are not
TypeScript. Both namespaces are reserved against authored imports. The compiled
set carries the same data documents under `kind: "data"`, with the authored
bytes as their `code`, so a warm load has everything the pattern needs without
reading the source set. A compiled
document stores runtime edges only between emitted modules. It includes fabric
edges needed by the self-contained compiled closure. The entry compiled
document also uses synthetic [`ROOT_LINK_SPECIFIER`][c14] (`cf:cache-root/`)
links to load emitted modules that no runtime edge reaches. Compiled runtime and
synthetic links only target emitted modules. They never target a declaration
document.

`delegatedModuleIdentities` is mutable metadata, excluded from the Merkle
identity, that records predecessor module hashes whose writer authority the
current module may exercise. Since content addressing does not authenticate that
mutable field, source documents carry the compiler integrity stamp on the
delegation field alone. Compiled documents authenticate it with their existing
root compiler stamp. Loaders discard delegation metadata without the applicable
stamp. The source-update transaction computes a union of proposed entries and
authenticated entries already stored in either document set under
`editWithRetry`. It writes the same union to both sets with the source pointer
and revision, and registers it in the active runtime only after the durable
commit succeeds. General cache saves ([`writeSourceAndCompiledDocs`][c14])
preserve authenticated authority already present in either set. Entries
accumulate because one content-addressed successor can be shared by patterns
updated from different predecessors.

Because `identity` is a one-way Merkle hash, internal source links are
load-bearing and stored explicitly. The parent hash commits to those children's
identities. The authored graph wiring is verifiable on load by recomputing
identities and checking each against its document key. This is the
content-addressed analog of the structural graph verifier. A module shared by N
programs is stored once per `(space, identity)`. An executable graph is an entry
identity over a shared set of module documents.
Piece revision history separately uses the immutable
`cf/authored-program-manifest/v1` value from
[piece-source-lifecycle.md](piece-source-lifecycle.md) to bind the canonical main
and every authored file, including files outside that executable graph. The
same manifest binds the exact public-subpath map.

`runtimeVersion` selects a compiled-cache variant. It is separate from the
`runtimeFingerprint` input to executable module identity. The compiled set is
only ever written from verified output, and the per-module SES body verifier is
skipped on a read only for a full hit whose bodies came from an integrity-gated
load (`trustedBodies`); a miss or partial hit always re-verifies (see the threat
model).

### Module update delegation (`piece setsrc`, and a `system:` release)

`piece setsrc` is the temporary authority handoff while pattern files remain
local, content-addressed modules; an unattended update from a `system:`
origin — a release the deployment gated, adopted by the source reconciler —
derives the same handoff, and an update from any other origin derives none.
Compilation persists artifacts without granting update authority. Setup
prepares a proposal from the current and candidate entries' verified
recursive source closures. The two entries match
each other outright, since the update is what names the one as the other's
successor. Every other module matches by canonical full authored filename
(resolved relative imports meet at the same stored path; basenames are never
matched), and additionally under the root substitution the two entry names
define: when the entries end the same way, the roots each sits under read as
the same authored tree grounded at two places — the program the toolshed
serves under `/api/patterns` and the same checkout supplied from a repository
root under `/packages/patterns` — and a module matches the previous module
named by its own name under the previous root. For every unambiguous match,
the successor inherits the direct predecessor plus the predecessor's
cumulative delegation list ([`deriveModuleDelegations`][c14]). Each setup
attempt pins the
proposal alongside committed authority in its own transaction; ordinary
transactions cannot observe it. The authority fields commit atomically with the
source transition. Rejection publishes no proposed authority, while success
registers the committed union before the updated pattern starts. This makes an
update chain cold-reload-stable.

A source update carrying proposed authority requires an owned setup transaction
that commits to storage. A serving wave's withdrawable acceptance cannot publish
runtime authority and is refused at this boundary. On a serving runtime the
served `setsrc` verb's setup transaction therefore commits directly to the
store, outside the wave, and registers its authority from that verdict
([`server-pattern-lifecycle.md`](../features/server-pattern-lifecycle.md)).

`piece setsrc --check` compiles and reviews the candidate without saving it or
repairing the current source's compiled cache. The review includes the CFC
schema-envelope merge the setup transaction performs at commit, run in dry run
over the envelopes stored on the piece's argument document and on the piece's
own document — the latter only where setup would rewrite the result
projection, as the commit merges it only then — so a stored `writeAuthorizedBy`
claim the candidate's schema cannot reconcile with is reported by the check
rather than by the commit. It issues no storage writes and creates no module
update authority. Verified byte caches and in-memory compiler state may be
reused by later operations. Normal storage reads can demand materialization by
an active server executor; preflight does not freeze the space or suppress
other actors' writes.

Asynchronous source and compiled closure loads register authority only when the
transaction carries no uncommitted writes (`tx.hasWrites()` is false). Source
loads register only field-integrity-authenticated lists; integrity-valid
compiled-cache loads register lists from their root-authenticated documents.
Loads in a transaction with writes still return the verified closure but do not
publish its delegation metadata ahead of a commit verdict. Synchronous source
verification within setup retains transaction reads without registering authority.

A runtime can hold a successor module before another runtime's source update
grants it a predecessor's authority, and resolving a pattern from memory loads
no closure. A source update records the pattern it moves a piece to as the
latest revision of the piece's source history. So when the runner starts a
piece, or swaps a running one after its pattern pointer moves, and the latest
revision names the pattern it is about to run, it checks that the runtime
registers the new pattern's module as inheriting from every other pattern the
history names. A grant registered for one of them settles nothing about the
rest, since a later update onto the same successor extends its stored grants
with that update's own predecessors. If any is missing, the runner first reads
the new pattern's verified source closure in a transaction without writes,
which registers whatever delegation that closure durably carries. The start or
swap proceeds once the read settles, whether or not it added a grant.

Registration and transitive closure are scoped by the space carrying that
attestation. Each transaction snapshots the resulting per-space maps, and
`writeAuthorizedBy` consults only the map for the target document's space. It may
then match the live writer's module hash directly or through that space's
snapshot, while its binding path must still match exactly. Delegation metadata
loaded from another space grants no authority. Source and compiled closure loaders
reject a cache graph containing any cross-space import link, so a child document's
local attestation cannot be flattened into the root's space. Source-file spelling
is diagnostic at verification because it is resolver-dependent. A renamed
entry still succeeds the entry it replaces; a renamed module below the entry
receives no delegation, because old and new no longer match by canonical
authored filename under either root. A module with candidates under both its
own name and the substituted root, one that two successors claim, an
ambiguous canonical filename, and unauthenticated metadata all fail closed by
receiving no delegation. If a runtime-version miss recompiles
from source, the compiled-cache repair carries the authenticated map forward so
later warm loads retain the same authority chain. Cross-space closure
replication copies code and imports but omits the origin space's delegation
metadata; the destination save preserves only authority already authenticated in
the destination. When multiple patterns converge on one successor within a space
across restarts, save-time unioning preserves every predecessor in both cache
sets and in the runtime that performed the later update.

## Verifiable Execution

### Security classification

Every module item is classified before it can execute or become observable.
[`verifyCompiledModuleBody`][c8] runs per module on the compile path: it
recognizes the `const x = require("…")` import preamble, seeds the classification
environment with that module's import bindings (marking runtime modules trusted),
and hands the remaining top-level items to the shared
[`classifyModuleItems`][c9] core.

The classifier admits only top-level items it can place in the module-item
grammar SES_SANDBOXING requires — direct callbacks to trusted builders, safe
top-level functions, `__cf_data`/`schema` wrappers around verified module-safe
data, export assignments, re-export getters, and canonical
function-hardening (`__cfHardenFn(fn)`) and binding-identity
statements recognized by byte-equality to `sandbox-contract.ts` sources
([`CANONICAL_HARDENING_HELPER`][c9]). It rejects
raw mutable literals and arbitrary call results at module scope. A same-named
helper with a different body is therefore just an ordinary function, and the
module fails on its call sites. The rules are byte-level and the classifier does
not interpret a wrapper's payload; load-time enforcement of the module-safe data
subset is the runtime freezer (`freezeVerifiedPlainData`,
`packages/runner/src/sandbox/plain-data.ts`; see
[SES_SANDBOXING_SPEC.md](sandboxing/SES_SANDBOXING_SPEC.md) §4.2.3, §4.2.6).

Write-once module exports neutralize side effects smuggled into an accepted
wrapper argument, and the transformer emits at most one trailing `__cfReg({ … })`
registration call per module — a second is a tampering signal the classifier
rejects, and only a module whose registration was accepted is granted the real
registrar.

### Graph shape and wiring

[`verifyModuleGraph`][c8] validates the graph *structurally* before any module
executes: the entry specifier is present, every specifier is content-addressed
(`cf:module/…` or `cf:runtime/…`), every record is well-formed, every entry in a
record's `resolutions` map remaps an import that record actually declares, and
every resolved import points at a present record — with a runtime import required
to resolve to exactly `cf:runtime/<specifier>` so a record cannot be handed a
sibling module's namespace under a runtime name. This is a pre-flight check, not
the security boundary; the boundary is the per-module classification above.

It runs on the compile path (and again on the warm path that rebuilds a graph
from cached bodies), so the graph a Compartment receives has always been checked.

## Threat Model — the persistent compilation cache

Storing the compiled artifact in a **storage cell** means the runtime `eval`s the
cell's contents. The cache is designed around this:

- **Source set integrity is free.** `pattern:<identity>` is keyed by a hash of
  its own contents, import graph, and recorded identity fingerprint, so a reader
  recomputes and checks the requested identity. A tampered source document or
  fingerprint fails the check. The verifier also rejects a non-empty fingerprint
  on a module whose identity does not depend on one. Recompiling a source
  document also re-runs the SES verifier, so a malformed source is rejected on
  the compile path. Mutable delegation metadata is deliberately outside that
  hash and requires its own field-level compiler integrity stamp before a loader
  can use it as authority.
- **Compiled set integrity is a CFC label.** `compileCache:<runtimeVersion>/<identity>`
  is keyed by the *source* identity, which does not bind the *JS* bytes.
  The compiled document therefore carries a **CFC integrity label**, written with
  the entry (`addIntegrity`) and **required on read** (`requiredIntegrity`). The
  label — not the SES verifier — is the security boundary for cache hits.
- **A cache document declares no confidentiality policy, and says so.** Both
  sets are addressed by causes built from the module's content-derived
  identity, so no pattern names one of these records, and the schemas
  describing their fields are the two write schemas in `cell-cache.ts`, which
  declare integrity alone. So the ceiling the §8.12.4 writer-fit check
  resolves at a cache write is the empty one, and at `enforce-strict` a write
  carrying any confidentiality clause is a refused commit — which any
  transaction that both reads labeled data and reaches a cache write takes, a
  piece's source transition among them. Each cache write therefore records a
  `runtime.undeclarable-store` marker naming its document
  (`recordUndeclarablePolicyStore`), and the check skips the ceiling there.
  The skip is scoped to a join the target's own space produced: where a clause
  reached the join from another space, the cache write is measured like any
  other, so a compile cannot carry a foreign space's labeled value into a
  local record. The write stays a flow-stamp target, so the transaction's join
  still lands on the record and a later read of a stamped path carries that
  clause. The module's bytes are unaffected: they live in a `cid:` document,
  which CFC leaves out of the flow join on both sides, so what a stamp can
  reach is the compiler's bookkeeping beside them. `cfc-enforcement-matrix.md`
  §4 carries the reasoning, including where this stops short of spec §18.6.2.
- **Fail-closed, not fail-hard.** A compiled document with a missing or invalid
  integrity label is treated as a **cache miss** and recompiled from the
  (self-verifying) source set, which re-runs the SES verifier. So the verifier
  always guards the compile/miss path; only integrity-valid warm hits skip it.
- **Why skip the SES verifier on a hit.** That verifier's guarantee is that no
  data flows between components in a way the runtime does not track. An attacker
  who can write arbitrary storage can already create such untracked flows
  (writing data a pattern reads), so re-verifying integrity-labeled cache hits
  adds no protection beyond the label while costing per-load work. Once the label
  is unforgeable (below), re-verification is redundant.
- **Per-space containment, then server-only writes.** The cache is per-space, so
  cross-tenant poisoning is impossible — only a space's own writers can affect
  its cache. The stamp is the constant `cf-compiled-by:cf-compiler` atom
  ([`COMPILED_INTEGRITY_ATOM`][c14]): it attests to the **code** that produced
  the doc (the system compiler), not the user who ran it, so every member of a
  shared space reads one cache (a per-user stamp made every other member a
  permanent miss and made their write-backs collide on the label merge). Minting
  is gated — prepare strips `cf-compiled-by:` atoms from any write not authored
  by a trusted builtin — so pattern code cannot stamp a forged doc. While
  compilation is still client-side, the label remains client-asserted at the
  raw-storage level, so within a space it amounts to self-poisoning (acceptable,
  and contained by the per-space scope). The end state moves **compilation to the
  server**: the server becomes the sole acceptor of that write integrity and can
  attach real attestation data, making the label a hard guarantee — with no
  change to the read path, which already requires it.
- **Cross-space closure replication (CT-1687).** Cache docs do not only live
  where they compiled: when a pattern materializes a child piece in another
  space (`Factory.inSpace(...)`), the runner replicates the child pattern's
  source + compiled closures into the child's space so the piece is
  independently loadable there (`PatternManager.replicatePatternToSpace`).
  Chain-of-custody holds — compiled docs are read through the integrity-gated
  loader ([`loadCompiledClosure`][c14]; only docs already carrying the compiler
  stamp replicate) and re-stamped on the child-space write by a legitimate
  child-space writer. Module-update authority does not cross that boundary:
  `delegatedModuleIdentities` from the origin is omitted during replication,
  while any entries already authenticated in the destination are preserved.
  Note for the server-compilation end state: a client can then no longer stamp
  replicated compiled docs, so child spaces will need server-side replication
  or by-identity source recovery instead.
- **CFC verified-source derives from the source set, not the cached JS.** A
  poisoned-but-SES-safe JS document must not be able to spoof `fn.src` /
  authorship, so the CFC verified-source identity is anchored to the
  content-addressed `pattern:<identity>` source, never to the compiled
  document's source maps.

## Source Maps and Diagnostics

Source maps are per module. `SESInternals` loads them keyed by filename
([`SESRuntime.loadSourceMapLazy`][c10]), and the Engine registers each module's
map twice: once composed under the per-load `<evalId>.js` name, and once under
the module's own eval `sourceURL`, shifted by the CommonJS factory-wrapper line,
because the browser surfaces the per-module eval frame in `new Error().stack`.
When a warm cached record retained no authored map, an identity map keyed on the
module's authored name is registered instead, so the frame names the module
source rather than a raw bundle coordinate. Diagnostic names are
`cf:module/<hash>/<path>` rather than a bundle-relative location, which is both
stable and directly meaningful as an identity.

Source maps serve error stacks only. A builder artifact's debug `fn.src` is
independent of them: the compiler records authored positions in a per-module
sidecar, so a warm load that retained no map still serves them.

## Interaction With Durable Scheduler Identity

This spec supplies the stable implementation identity that durable scheduler
state depends on (originally the persisted-observation form — archived at
[persistent-scheduler-state.md](../history/specs/persistent-scheduler-state.md)
after server-execution v2 Phase 1 stage C deleted it — and now the basis
index's restart-stable `action` column,
[serving-loop.md §3b](server-side-execution/serving-loop.md)):

- `SchedulerActionObservationV1.implementationFingerprint` is
  `cf:module/<moduleHash(M)>:<symbol>`. It is stable across reloads and entry
  points. It changes when any transitive import (value or type) changes. It also
  changes when the runtime fingerprint changes and the reachable graph contains
  an external dependency. The scheduler continues to check `runtimeFingerprint`
  separately before trusting a persisted observation.
- Because the fingerprint is content-derived rather than a source location, a
  clean observation cannot be trusted against changed code.
- `processGeneration` and durable graph-snapshot identity remain future work and
  are not addressed here.

## Test Strategy

- Identical module compiled from two different entry points produces the same
  `moduleHash` and the same action implementation fingerprint.
- Changing a transitively-imported value function changes the importer's
  `moduleHash`; changing a transitively-imported **type** also changes it.
- Changing an authored `.d.ts` declaration changes every importer identity that
  reaches it, invalidates the compiled-cache entry, and persists the declaration
  as source-only history without emitting a JavaScript record. A later warm load
  does not request a compiled declaration document. Runtime-provided declaration
  stubs remain external fingerprinted dependencies.
- Recompiling unchanged source under a changed runtime fingerprint changes the
  `moduleHash` of every module whose reachable graph contains an external
  dependency. Its runtime-neutral module identity and the complete program's
  runtime-neutral digest remain unchanged. A module with no reachable external
  dependency keeps its `moduleHash`.
- An unrelated sibling file added to or removed from the compilation does not
  change an untouched module's hash.
- Import cycles produce deterministic, stable hashes across reloads, and two
  different cycle shapes over the same sources hash differently.
- Re-export/barrel edges propagate transitive changes correctly.
- `importNow` over a fully-registered record graph loads every pattern in the
  corpus synchronously, including cyclic programs, and produces the expected
  exports.
- Adversarial module bodies are rejected by the per-module classifier: a
  non-canonical `__cfHardenFn` laundering a callback, a second `__cfReg` call, a
  side effect smuggled into a `__cf_data` argument, and a record resolving a
  runtime import to a sibling module.
- Persistent-scheduler-state restart test: a pattern reloaded from a different
  entry point rehydrates clean (no rerun).
- Compilation-cache test: editing one file invalidates only that module and its
  transitive importers.
- Content-addressed cache: a cold compile writes the source and compiled
  document sets into the space; a warm load hits the compiled set with no
  recompilation and identical exports. Two programs sharing a module produce a
  single compiled document (per-module dedup).
- Cross-space (`Pattern.inSpace`): a pattern authored/loaded in space A but
  instantiated through `PatternFactory.inSpace(B)` writes its source and compiled
  documents into **space B**, with import links resolving within B and the
  compiled documents carrying the required CFC integrity; a later load in B is a
  warm hit.
- Cache integrity fail-closed: a compiled document with a missing/invalid
  integrity label is treated as a miss and recompiled from the self-verifying
  source document; only integrity-valid documents are reused without
  re-verification.
- A future representation-only compile-cache `runtimeVersion` bump with an
  unchanged runtime fingerprint misses the compiled set and recompiles while
  the source set (`pattern:<identity>`) persists. Version 1 treats the current
  broad compiler-input version as executable and therefore rolls both values.
- A `runtimeFingerprint` bump gives an affected entry module a new executable
  identity and writes a new source set. The prior source set remains retained
  for history. Tests compare the runtime-neutral digest to classify this as a
  runtime rebuild rather than an authored-source change.

## Appendix: Pipeline Reference

[c1]: ../../packages/runner/src/harness/engine.ts
[c2]: ../../packages/runner/src/harness/pretransform.ts
[c3]: ../../packages/runner/src/harness/module-identity.ts
[c4]: ../../packages/js-compiler/typescript/options.ts
[c5]: ../../packages/js-compiler/typescript/resolver.ts
[c6]: ../../packages/runner/src/sandbox/esm-module-loader.ts
[c7]: ../../packages/runner/src/sandbox/module-record-compiler.ts
[c8]: ../../packages/runner/src/sandbox/module-record-verifier.ts
[c9]: ../../packages/runner/src/sandbox/compiled-bundle-verifier.ts
[c10]: ../../packages/runner/src/sandbox/ses-runtime.ts
[c11]: ../../packages/runner/src/builder/module.ts
[c12]: ../../packages/runner/src/scheduler/run.ts
[c13]: ../../packages/data-model/src/value-hash/impl.ts
[c14]: ../../packages/runner/src/compilation-cache/cell-cache.ts
[c15]: ../../packages/runner/src/sandbox/runtime-module-policy.ts
[c16]: ../../packages/runner/src/harness/authored-debug-source.ts

- Compile and evaluate entry points: [`Engine.compileToRecordGraph`][c1],
  [`Engine.compileResolvedToRecordGraph`][c1],
  [`Engine.compileAndEvaluateModules`][c1], [`Engine.evaluateRecordGraph`][c1],
  and the warm path [`Engine.evaluateCachedModules`][c1].
- Per-load path prefixing: [`pretransformProgramForModules`][c2], stripped again
  for identity by [`stripIdentityPrefix`][c7] and for stored spellings by
  [`storedFilenameFor`][c1].
- Module identity: [`computeModuleHashes`][c3] and [`resolveModuleImports`][c3],
  with [`findInternalTarget`][c3] deciding what counts as an internal edge, and
  the Engine-facing wrappers [`computeModuleIdentities`][c7] and
  [`computeFabricModuleIdentities`][c7].
- Emit configuration: [`getCompilerOptions`][c4] / [`MODULE_KIND`][c4].
- Import-graph discovery, including `export * from` and inline import types:
  [`collectImportSpecifiers`][c5].
- Record assembly and the warm-load rebuild: [`compileSourcesToRecords`][c7],
  [`deriveModuleRecordFields`][c7], [`buildRecordsFromCompiled`][c7].
- Loading: [`loadModuleGraph`][c6] / [`importModuleGraphNow`][c6] over
  [`VirtualModuleRecord`][c6]s, with [`runtimeModuleRecords`][c6] supplying the
  trusted host modules.
- Runtime-module policy: [`RuntimeModuleIdentifiers`][c15] is the admitted set,
  enforced on the authored side by [`isAllowedAuthoredImportSpecifier`][c15] and
  on the registration side by [`Engine.runtimeModuleNames`][c1].
- Verification: [`verifyCompiledModuleBody`][c8] and [`verifyModuleGraph`][c8],
  over the shared [`classifyModuleItems`][c9] core.
- SES lockdown and source-map registration: [`ensureSESInitialized`][c10],
  [`SESRuntime.loadSourceMapLazy`][c10]; the error-mapping entry point the
  harness invokes pattern functions through is [`SESRuntime.exec`][c10].
- Debug-only source annotation: the [`recordAuthoredDebugSource`][c16] /
  [`defineAuthoredDebugAccessors`][c16] map. Function-backed node and handler
  implementations install their accessors through
  [`annotateFunctionDebugMetadata`][c11]; pattern factories call
  `defineAuthoredDebugAccessors` directly.
- Scheduler fingerprints: [`schedulerImplementationFingerprint`][c12] and
  [`schedulerRuntimeFingerprint`][c12].
- Hash primitive: [`hashStringOf`][c13] (and [`hashOf`][c13]).
- Content-addressed cache: [`sourceDocKey`][c14], [`compiledDocKey`][c14],
  [`buildSourceDocs`][c14], [`verifySourceDocs`][c14],
  [`writeSourceAndCompiledDocs`][c14], [`loadVerifiedSourceClosure`][c14],
  [`loadCompiledClosure`][c14], [`deriveModuleDelegations`][c14].
