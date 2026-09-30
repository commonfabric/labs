# Pattern Imports — Implementation Plan

Implements `docs/specs/pattern-imports/README.md`. **Read the spec first**;
this plan tells you *how*, the spec tells you *what and why*. When this plan
and the spec disagree, stop and ask — do not improvise.

## How to work this plan

- Work milestones strictly in order (M0 → M1 → M2). Within a milestone, tasks
  are ordered by dependency; do not reorder.
- Every task is red-green: write the listed tests first, watch them fail for
  the right reason, then implement. Run the package's test task
  (`deno task test` in the package dir) before moving on.
- Commit per task (small, coherent commits). Pre-commit hooks misbehave in
  worktrees for new files; verify locally, then `git commit --no-verify`.
- Use `deno task cf check <fixture>.tsx --show-transformed --no-run` when you
  need to see what the compiler actually emitted.
- **Do not modify any file not listed in a task without flagging it.** If you
  find yourself needing to, the plan missed something — say so in the commit
  message and keep the deviation minimal.
- M3/M4 are sketched for orientation only. Do not start them.

## Decisions already made — do not relitigate

These were settled in the spec + design review. Implement as stated:

1. **One grammar, no type tag**: `cf:<ref>`, `cf:/<space>/<ref>`,
   `cf://<host>/<space>/<ref>`, trailing `@<pin>`. Resolution chases pointers
   and selects a module identity.
2. **Pin-in-source** (rewrite the import specifier at pin time). No lockfile
   side-table. No pin resolution at compile time for stored programs.
3. **Type-only fabric references are pinned.** Supported ESM-style
   `import type`, type-only named imports and exports, and inline
   `import("cf:…").Type` references follow the same deploy-time rewrite and
   frozen-compile rules as value imports. The transformer uses imported types
   to generate runtime schemas, so an unpinned type could change executable
   behavior under unchanged stored source. Reject the unsupported CommonJS-style
   `import type Alias = require("cf:…")` form before resolution or identity
   calculation.
4. **Imported subtrees keep their published identities.** Mounted files hash
   with their original authored paths and each source document's effective
   identity fingerprint. Identities, cache docs, and live modules therefore
   dedupe with the already-deployed pattern. This is Strategy A; the "fresh
   identities per importer" variant (A′) was considered and rejected (no
   dedupe, divergent CFC provenance).
5. **Self-contained bundles**: imported modules ARE compiled and emitted as
   part of the importer's record graph (no lazy cross-bundle loading at
   evaluation time). Dedup happens via identity (cache hits, idempotent
   write-back, `modulesByIdentity`), not via emission-skipping.
6. **Source set stays per-program**: an importer's source docs do NOT link to
   the imported subtree's source docs (the `cf:` specifier itself carries the
   target identity; loaders parse it). The **compiled** set DOES link across
   the boundary (it has no Merkle-union verification, and the link gives the
   warm loader the full closure for free).
7. **No service endpoints.** All resolution and fetch are cell reads through
   the compiling runtime's storage session.
8. **v1 limitation**: an imported subtree whose modules use root-absolute
   internal imports (`import … from "/utils.ts"`) is rejected at fetch time
   with a clear error. Relative (`./`, `../`) imports only inside subtrees.
9. **CFC provenance of fetched source is follow-up work** (spec § Security).
   Do not build label propagation now; do not silently strip it either —
   the write-back path reuses existing write machinery so labels flow (or
   fail) exactly as any cell write does today.
10. **Subpaths use explicit public exports.** The immutable
    `cf/authored-program-manifest/v1` value maps exact public subpaths to
    authored filenames. The entry is public without a map entry. There are no
    wildcard or conditional entries in version 1, and arbitrary files are not
    addressable. Pin time writes the selected file's module identity. Frozen
    compilation does not consult the map. A direct `cf:pattern:<identity>`
    names one exact module and never accepts a subpath. The manifest identity
    and runtime-neutral program digest include the map.

## Architecture recap (what plugs in where)

```
authored source ──pretransformProgramForModules──► /<id>/-prefixed program
      │                                                  (engine.ts)
      ▼
engine.resolve(resolver)  ◄── FabricAwareResolver wraps EngineProgramResolver   [M1.4]
      │                        • intercepts cf: specifiers
      │                        • loadVerifiedSourceClosure(space, hash)  (cell-cache.ts)
      │                        • mounts files at /~cf/<hash>/<storedFilename>
      ▼
resolved program (authored ∪ mounted files)
      │
      ├─ computeFabricModuleIdentities: authored set stripped /<id>,            [M1.3]
      │  each subtree stripped /~cf/<hash>; each document verifies under
      │  its PUBLISHED identity fingerprint; verified identities form merged map
      │
      ├─ compiler.compileToModules(..., { specifierAliases })                   [M1.1]
      │     TypeScriptHost maps "cf:…" → mounted entry path (type-check)
      │
      ├─ compileSourcesToRecords(..., { specifierAliases, identityByPath })     [M1.2]
      │     record resolutions: "cf:…" → "cf:module/<published-identity>"
      │
      ├─ source-persistence descriptors: all authored/mounted identity nodes,   [M1.5]
      │  including declarations; fabric edges are not stored as source links    [M1.6]
      │
      └─ emitted CacheableModule[]: mounted implementation modules keep their   [M1.5]
         original filenames; emitted runtime fabric edges become compiled links [M1.6]
```

Reload paths:
- **Warm** (compiled docs): for a value import, `loadCompiledClosure` follows
  the fabric link to the full runtime closure and then calls
  `evaluateCachedModules`. A type-only edge is absent from compiled runtime
  links. Verify both cases. [M1.7]
- **Cold** (source docs): importer closure excludes subtrees by design; the
  same `FabricAwareResolver` wrapped around `compileResolvedToRecordGraph`'s
  resolver re-fetches each subtree by the hash in the specifier. [M1.7]

## Glossary (use these exact terms in code comments)

- **fabric ref / fabric specifier** — an authored import specifier under the
  `cf:` grammar
  (`cf:pattern:<hash>`, `cf:/did:key:z6Mk…/todo-list@<hash>`, …).
- **pin** — the trailing `@<hash>` selected-module identity on a mutable ref.
- **hash** — 43 base64url chars (`[A-Za-z0-9_-]`, case-SENSITIVE, no
  padding), the unprefixed output of `hashStringOf`/`hashOf`
  (`packages/data-model/src/value-hash/impl.ts`). NOT hex — e.g.
  `Avcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c`. Never lowercase or
  otherwise normalize a hash.
- **terminal identity** — the selected-module identity after pointer and
  subpath resolution. It is the entry-module identity when no subpath exists.
- **subtree** — the source closure of one imported pattern (its own program).
- **mount** — a subtree's files spliced into a compilation under
  `/~cf/<terminalIdentity>/<storedFilename>`.
- **fabric edge** — an import edge whose specifier is a fabric ref; external
  for Merkle identity, aliased for type-check and record resolution.
- **authored set** — the importer's own files (everything not under `/~cf/`).

---

## M0 — Grammar and policy (pure functions, no I/O)

### M0.1 New file: `packages/runner/src/sandbox/fabric-import-specifier.ts`

```ts
// Shown for illustration only.
export interface FabricRef {
  /** Toolshed host (authority); only present in the cf://host/... form. */
  host?: string;
  /** Space name or DID; absent = the compiling space. */
  space?: string;
  ref:
    | { kind: "slug"; slug: string }
    // "of" = entity URI (stored/spelled "of:fid1:<hash>"); "pattern" =
    // exact module identity ("pattern:<hash>"). hash is the bare base64url
    // part (no "fid1:" tag) in both cases.
    | { kind: "uri"; scheme: "of" | "pattern"; hash: string };
  /** Exact public name in the target manifest (phase 4; currently rejected). */
  subpath?: string;
  /** Trailing selected-module @<hash> pin; never normalized. */
  pin?: string;
}

export class FabricRefError extends Error {
  constructor(message: string, readonly specifier: string) { /* … */ }
}

/**
 * Parse an import specifier under the cf: reference grammar.
 * - Returns undefined when the specifier does not start with "cf:" —
 *   callers treat it as not-a-fabric-ref (relative import, runtime module…).
 * - THROWS FabricRefError when it starts with "cf:" but is malformed or
 *   reserved. A cf:-prefixed specifier is never silently ignored.
 */
export function parseFabricRef(specifier: string): FabricRef | undefined;

/** True iff parseFabricRef returns a value (false for undefined OR throw). */
export function isFabricImportSpecifier(specifier: string): boolean;

/** Canonical string for a ref (parse(format(r)) deep-equals r). */
export function formatFabricRef(ref: FabricRef): string;

/**
 * The identity a ref resolves to WITHOUT touching any mutable pointer:
 * the pin if present, else the hash of a pattern: URI ref, else undefined
 * (meaning: resolution requires the chase — M2).
 */
export function pinnedIdentity(ref: FabricRef): string | undefined;

/** Re-format with a (new) pin set; used by the pin-rewrite tooling (M2.3). */
export function withPin(ref: FabricRef, pin: string): FabricRef;
```

Parsing algorithm — implement exactly this order:

1. If the specifier does not start with `"cf:"`, return `undefined`.
2. Strip `"cf:"`. Call the remainder `rest`.
3. **Reserved namespaces** (emitted/internal — never authored): if `rest`
   starts with `"module/"` or `"cache-root/"`, throw
   `FabricRefError("'cf:module/…' / 'cf:cache-root/…' are compiler-internal
   namespaces and cannot be imported", specifier)`.
4. **Pin**: if `rest` contains `"@"`, split at the LAST `"@"`. The right part
   must match `HASH_RE` (below) or throw (`"malformed pin"`). The left part
   replaces `rest`.
5. **Authority/space prefix**:
   - `rest` starts with `"//"`: strip it; split on `"/"`; first segment is
     `host` (must be non-empty, must contain no `"@"`; validate loosely:
     `/^[a-z0-9.-]+(:\d+)?$/i`, throw otherwise); the SECOND segment is the
     space (required in this form — throw `"host-qualified refs require a
     space"` if fewer than 3 segments); remaining segments per step 6.
   - `rest` starts with a single `"/"`: strip it; first segment is `space`;
     remaining segments per step 6.
   - otherwise: no host, no space; all of `rest` per step 6.
6. **Ref + subpath**: of the remaining `"/"`-separated segments, the FIRST is
   the ref token; the rest (joined by `"/"`) is `subpath` (omit when empty).
   - Ref token contains `":"` → URI form. Accepted shapes (hash part must
     match `HASH_RE`):
     - `pattern:<hash>` → `{ scheme: "pattern", hash }`
     - `of:fid1:<hash>` → `{ scheme: "of", hash }` (what `toURI` emits —
       `toURI` in `packages/runner/src/uri-utils.ts`; the `fid1:` tag is required
       inside `of:`)
     - `fid1:<hash>` → alias for `of:fid1:<hash>` (the shell's bare piece-id
       form); `formatFabricRef` canonicalizes to `of:fid1:<hash>`.
     Anything else with a colon throws `"unsupported cell URI scheme"`
     (including `of:<hash>` without the `fid1:` tag, and `data:`).
   - No colon → slug form: validate with `validateSlug` from
     `packages/runner/src/slugs.ts` (re-throw its message wrapped in
     FabricRefError).
7. **Space validation**: if present and not a DID (`/^did:[a-z0-9]+:.+$/`),
   it must validate as a slug (space *names* share the slug grammar — spec
   § Specifier syntax). Throw otherwise.
8. **Consistency**: a `pattern:` URI ref with a pin whose hash differs from
   the URI hash throws `"conflicting pin"`. (Equal is allowed, normalized to
   pin-absent by `formatFabricRef`.)

`HASH_RE`: **base64url, exactly 43 chars, case-sensitive**:
`/^[A-Za-z0-9_-]{43}$/`. This is the unprefixed `hashStringOf` output
(SHA-256 → 43 unpadded base64url chars; `hashStringOf` in `value-hash/impl.ts`) —
NOT hex.
Add two canary unit tests pinning the real formats so a future hash-encoding
change fails here first:
1. feed a REAL module identity from `computeModuleHashes` (import it, hash a
   tiny one-file program) → `HASH_RE` matches, and
   `parseFabricRef("cf:pattern:" + h)` succeeds;
2. feed a REAL entity URI from `createRef(...)`+`toURI(...)`
   (`uri-utils.ts`) → it has the `of:fid1:` shape and
   `parseFabricRef("cf:/somespace/" + uri)` succeeds.
Never lowercase, trim, or re-encode hashes anywhere in parsing or
formatting — they compare byte-exact.

### M0.2 Policy: `packages/runner/src/sandbox/runtime-module-policy.ts`

Extend `isAllowedAuthoredImportSpecifier` (line 25):

```ts
// Shown at module scope.
export function isAllowedAuthoredImportSpecifier(specifier: string): boolean {
  if (specifier.startsWith("cf:")) {
    try { return parseFabricRef(specifier) !== undefined; }
    catch { return false; }
  }
  return isRuntimeModuleIdentifier(specifier) ||
    ALLOWED_LOCAL_IMPORT_PREFIXES.some((p) => specifier.startsWith(p));
}
```

`isAllowedCompiledDependencySpecifier` (line 32) composes the same predicate —
verify it needs no separate change (it delegates). Grep for every caller of
both functions and read each call site; list them in the commit message with
a one-line "unaffected because…" each. (Expected: the SES compiled-body
verifier and the authored-import check; if you find more, flag it.)

### M0.3 Tests: `packages/runner/test/fabric-import-specifier.test.ts`

Table-driven. Minimum cases (✓ = parses, ✗ = throws, ∅ = undefined):

| Specifier | Expect |
|---|---|
| `./foo.ts`, `commonfabric`, `npm:x` | ∅ |
| `cf:todo-list` | ✓ slug, no space |
| `cf:todo-list/schemas` | ✓ slug + subpath `schemas` |
| `cf:/kitchen/todo-list` | ✓ space `kitchen` |
| `cf:/kitchen/todo-list/a/b.ts` | ✓ subpath `a/b.ts` |
| `cf:/did:key:z6Mk…/todo-list` | ✓ DID space |
| `cf://host.example/kitchen/todo-list` | ✓ host + space |
| `cf://host.example:8000/kitchen/todo-list` | ✓ host with port |
| `cf://host.example/todo-list` | ✗ host requires space |
(`<b64u43>` below = a 43-char base64url hash, e.g.
`Avcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c` — note it exercises uppercase,
`-`, and `_`.)

| `cf:/kitchen/todo-list@<b64u43>` | ✓ pin |
| `cf:todo-list@abc` (too short) | ✗ malformed pin |
| `cf:todo-list@<b64u43 with "=" appended>` | ✗ malformed pin (no padding) |
| `cf:todo-list@<44 chars>` | ✗ malformed pin (length) |
| `cf:pattern:<b64u43>` | ✓ uri/pattern; `pinnedIdentity` = hash |
| `cf:pattern:<b64u43, hex-only chars>` | ✓ (hex-looking hashes are legal base64url) |
| `cf:pattern:<b64u43>@<same>` | ✓ normalizes (format drops pin) |
| `cf:pattern:<b64uA>@<b64uB>` | ✗ conflicting pin |
| `cf:pattern:<UPPERCASED b64u43>@<original>` | ✗ conflicting pin (case-sensitive — no normalization) |
| `cf:/kitchen/of:fid1:<b64u43>` | ✓ uri/of |
| `cf:of:fid1:<b64u43>` | ✓ uri/of, no space |
| `cf:fid1:<b64u43>` | ✓ uri/of alias; formats as `cf:of:fid1:<b64u43>` |
| `cf:of:<b64u43>` (no fid1 tag) | ✗ unsupported cell URI scheme |
| `cf:data:abc` | ✗ unsupported cell URI scheme |
| `cf:module/<b64u43>` | ✗ reserved |
| `cf:cache-root/x` | ✗ reserved |
| `cf:Has_Upper` | ✗ slug grammar |
| `cf:` / `cf:/` / `cf://` | ✗ |
| `cf:/kitchen/` (empty ref) | ✗ |

Round-trip: for every ✓ case, `parseFabricRef(formatFabricRef(parse(s)))`
deep-equals `parse(s)`. Policy tests: each ✓ case is allowed, each ✗/∅
`cf:`-prefixed case is rejected by `isAllowedAuthoredImportSpecifier`.

**Acceptance M0**: new tests green; full `packages/runner` suite green
(policy change must not break existing import tests).

---

## M1 — `cf:pattern:<hash>` end-to-end, same space

Scope guard: in M1 the resolver handles ONLY refs where
`pinnedIdentity(ref) !== undefined` and `ref.host === undefined`. Everything
else throws `"fabric ref requires resolution of a mutable pointer — not yet
supported (M2)"` or `"cross-host fabric refs not yet supported (M3)"`.
Subpaths throw `"subpaths not yet supported (M4)"`.

### M1.1 js-compiler: specifier aliases for type resolution

File: `packages/js-compiler/typescript/compiler.ts`.

1. Add to `TypeScriptCompilerOptions` (line 227):
   ```ts
   // Shown as interface or class members.
   /**
    * Maps an import specifier (verbatim text) to a program file name. Used
    * for scheme-prefixed specifiers (cf:…) that the path-join and
    * runtime-module rules cannot resolve. The target MUST be a file in the
    * program.
    */
   specifierAliases?: ReadonlyMap<string, string>;
   ```
2. Thread it into the `TypeScriptHost` constructor (line 123) and use it in
   `resolveModuleNameLiterals` (line 176) — check the alias map FIRST (before
   the relative-path branch; alias text is exact, so order is safe — but
   first keeps the dispatch obvious):
   ```ts
   // Shown for illustration only.
   const aliased = this.specifierAliases?.get(name);
   if (aliased !== undefined) {
     return {
       resolvedModule: {
         resolvedFileName: aliased,
         extension: aliased.endsWith(".tsx") ? ts.Extension.Tsx : ts.Extension.Ts,
       },
     };
   }
   ```
3. Also accept aliases in `resolveProgram`'s config? **No** — resolution of
   fabric specifiers happens in the runner's resolver wrapper (M1.4); the
   js-compiler's `resolveProgram` sees them resolve successfully via
   `graph.resolveSource` and never consults the unresolved-module policy.
   Do not touch `resolver.ts`.

Tests: `packages/js-compiler/test/` — find the existing compiler test file
and add: a two-file program where `/main.tsx` imports `"x-scheme:thing"` and
`specifierAliases` maps it to `/dep.tsx`; assert type-checking sees `/dep.tsx`
exports (a deliberate type error through the alias must be reported), and the
emitted body for `/main.tsx` contains `require("x-scheme:thing")` (the alias
affects type resolution, NOT emitted specifier text).

### M1.2 Record graph: alias resolutions

File: `packages/runner/src/sandbox/module-record-compiler.ts`.

1. Add `specifierAliases?: ReadonlyMap<string, string>` to
   `CompileSourcesOptions`.
2. In the per-source resolutions loop (the
   `internal → cf:module/… / runtimeModules → cf:runtime/… / unknown` chain),
   insert an alias branch BEFORE the unknown-external fallback:
   ```ts
   // Shown for illustration only.
   } else if (options.specifierAliases?.has(spec)) {
     const target = options.specifierAliases.get(spec)!;
     const targetSpecifier = specifierByPath.get(target);
     if (targetSpecifier === undefined) {
       throw new Error(`specifier alias '${spec}' → '${target}' does not name a program file`);
     }
     resolutions[spec] = targetSpecifier;
   }
   ```
3. Mirror the alias in the `export * from` walk (`resolveFullExports`): the
   star-target resolution uses `findInternalTarget`; add the same alias check
   so `export * from "cf:pattern:<h>"` re-exports correctly.

Tests: extend the existing module-record-compiler test file: program of
`/a.tsx` (imports `"cf:pattern:<b64u43>"`, any valid-shape hash) +
`/~cf/<h>/main.tsx`, alias map +
an `identityByPath` where the mounted file's identity is a fixed fake hash;
assert the record for `/a.tsx` has
`resolutions["cf:pattern:…"] === "cf:module/<fake>"`, and a star-re-export
variant surfaces the mounted file's export names.

### M1.3 Per-subtree identities: `computeFabricModuleIdentities`

File: `packages/runner/src/sandbox/module-record-compiler.ts` (next to
`computeModuleIdentities`).

```ts
// Shown for illustration only.
export const FABRIC_MOUNT_ROOT = "/~cf/";

export interface PublishedFabricModule {
  /** Published identity that the verified source document was stored under. */
  identity: string;
  /** Effective fingerprint used to verify this document's identity. */
  identityRuntimeFingerprint: string;
}

export interface FabricMount {
  /** Terminal identity the subtree was fetched by (and must hash back to). */
  entryIdentity: string;
  /** Mounted path of the subtree's entry file. */
  entryPath: string;          // `${FABRIC_MOUNT_ROOT}${entryIdentity}${storedEntryFilename}`
  /** Verified published identity and effective fingerprint for each mounted path. */
  publishedModules: ReadonlyMap<string, PublishedFabricModule>;
  /** The fabric specifiers that resolve to this mount (≥1). */
  specifiers: string[];
}

/**
 * Identity map for a program containing fabric mounts. Authored files hash
 * with `idPrefix` stripped (status quo). Each mounted source document verifies
 * under its published effective fingerprint with `/~cf/<entryIdentity>`
 * stripped, so mixed legacy and current documents preserve their published
 * identities. Throws if any mounted source does not hash back to its recorded
 * identity or the entry does not match `entryIdentity`.
 */
export function computeFabricModuleIdentities(
  sources: Source[],
  mounts: readonly FabricMount[],
  options: { idPrefix?: string; runtimeFingerprint?: string } = {},
): Map<string, string>;
```

Implementation:
1. Partition `sources` by name: each file under
   `${FABRIC_MOUNT_ROOT}${m.entryIdentity}/` belongs to mount `m`; everything
   else is the authored set. A file under `FABRIC_MOUNT_ROOT` matching NO
   mount → throw (corrupt assembly).
2. Authored set → `computeModuleIdentities(authored, options)` unchanged.
   (The fabric edges inside authored sources resolve as EXTERNAL deps because
   the mounted file names never match the specifier — this is what folds the
   pin into the importer's hash. Do not "fix" that.)
3. For each mount, require the mounted path set to equal the keys of
   `m.publishedModules`. Group those entries by effective fingerprint. For each
   distinct value, run `computeModuleIdentities` over the mounted view with
   `idPrefix` set to `/~cf/${m.entryIdentity}` and that fingerprint. Compare the
   recomputed identity for every entry in the group with its recorded identity.
   Merge the recorded identities only after all comparisons succeed. This
   preserves the identity of every published document instead of applying the
   entry document's fingerprint to the entire closure. The authored importer
   uses the current fingerprint through `options`, so its own identity changes
   after a runtime upgrade without changing the pin.
   **Note**: subtree files may themselves contain fabric specifiers
   (transitive imports) — those are external deps within the subtree
   computation, exactly as they were when the subtree was published. Files of
   a TRANSITIVE mount are NOT part of this mount's partition (they live under
   their own `/~cf/<h2>/` prefix).
4. Verify that `m.publishedModules.get(m.entryPath)?.identity` equals
   `m.entryIdentity`; throw with both values on mismatch.
5. Merge all maps. The key sets are disjoint by construction.

Tests (new file `packages/runner/test/fabric-module-identity.test.ts`):
- Two-file subtree published standalone (compute identities with no prefix),
  then the same files mounted under `/~cf/<entry>/…` inside a host program →
  identities identical to standalone; authored file's identity changes when
  (only) the pin hash inside its specifier text changes.
- Mount entry mismatch (tampered byte) → throws.
- File under `/~cf/` with no matching mount → throws.
- Two mounts whose subtrees both contain `/main.tsx` → no interference.
- A mount with an affected entry and a pure internal module verifies the
  entry under its non-empty fingerprint and the pure module under the canonical
  empty value.
- Synthetic root links and documents outside the entry's authored-import view
  do not become mounted modules. Two retained generations with the same
  filename therefore cannot overwrite one another in a mount.

#### Authored declaration-file integration

Authored `.d.ts` files participate in module identity and source history even
though they do not emit JavaScript records. Production `Engine` paths currently
remove declarations before `computeFabricModuleIdentities`, build
`CacheableModule` values only for emitted modules, and therefore omit
declarations from `writeSourceDocs`.

Required changes:

1. Preserve source provenance before resolver output is merged. Distinguish
   explicitly enumerated authored files, verified mounted files, and declaration
   stubs supplied by `EngineProgramResolver` for runtime modules. A filename or
   `.d.ts` suffix alone does not establish provenance.
2. Extend production graph discovery to follow string-literal inline import-type
   references such as `import("./types.d.ts").Foo`. `collectImportSpecifiers`
   already includes these edges for identity, while `resolveProgram()`
   deliberately does not fetch their targets. Load relative, authored, mounted,
   and fabric inline type targets before identity calculation and type checking.
   Apply the ordinary fabric pin and alias rules to a fabric target. When an
   allowed bare runtime target is unresolved, preserve the existing
   `resolveProgram()` fallback that asks the resolver for
   `${identifier}.d.ts`. Apply that fallback to an inline-only reference too.
   The returned runtime stub belongs only to the type-check set. Continue to
   reject or ignore dynamic import expressions according to the existing
   policy; they are not type-only edges.
3. Build three sets. The type-check set contains all resolved inputs, including
   runtime declaration stubs. The identity and source-history set contains the
   implementation sources already identified today plus authored and mounted
   declarations. The emitted and compiled-cache set contains only modules that
   produce JavaScript records.
4. Exclude runtime-provided declaration stubs from the identity set. An authored
   import of `commonfabric` must remain an external leaf containing the runtime
   fingerprint even though TypeScript reads a supplied `commonfabric.d.ts`.
5. Keep authored and mounted declarations in the identity set. A type-import
   edge contributes the declaration identity to its importer like any other
   internal edge. Persist and verify those declarations through `SourceDoc` and
   include them in immutable authored-program manifests.
6. Restrict record assembly, compiled-cache lookup, compiled-document writes,
   compiled synthetic roots, and compiled import links to the emitted set. No
   compiled document or runtime record exists for a declaration. Derive direct
   compiled links only from import specifiers present in emitted JavaScript.
   Keep the broader value-and-type graph for source identity and source links.
7. Add a production-engine regression in which an entry uses
   `import("./types.d.ts").Foo`. Prove that resolution fetches the declaration,
   changing it changes the entry identity and compiled bytes, and both revisions
   remain restorable from source history. Run the corresponding case through a
   pinned fabric inline type reference as well. Also prove follower propagation,
   that `commonfabric` remains an external fingerprinted leaf, and that a cold
   write followed by a warm load succeeds without requesting a compiled
   declaration document. Add a separate inline-only
   `import("commonfabric/schema").Schema` regression. It must find the existing
   runtime declaration through the `${identifier}.d.ts` fallback without
   turning the bare runtime module into an authored identity node or broadening
   the sandbox import allowlist. This is distinct from the helper-injected
   `commonfabric` import.

#### Runtime-fingerprint integration

A current runtime fingerprint is part of the executable identity of an authored
importer because a fabric specifier is an external-dependency leaf. A fingerprint
change therefore creates a new importer identity even when its source and pins
are unchanged. Every document in a pinned mount keeps the identity and effective
fingerprint under which it was published. It is not re-identified under the
importing runtime. The current runtime must reject the import with an actionable
republish-and-repin error when it cannot execute a recorded fingerprint.

The hash primitive already accepts an optional `runtimeFingerprint`, and
`module-identity.test.ts` proves that changing it changes a module that imports
an external dependency. The production engine, entry-identity helper, source
verification, and replication paths currently use the empty default. Source
documents do not record which non-empty fingerprint created an identity. The
piece lifecycle has no revision metadata or separate operation and cause for a
runtime rebuild.

Before enabling a non-empty production fingerprint:

1. Implement the authoritative `getExecutableRuntimeFingerprint()` provider
   defined in [module-loading.md](../module-loading.md). Version 1 hashes the
   existing broad compile-cache runtime version, the scheduler fingerprint, and
   automatic catalogs of pattern-facing runtime modules and execution-policy
   inputs. Inability to calculate the value fails closed. The empty value is
   reserved for legacy source verification.
2. Thread the provider's current value through authored identity calculation,
   source-document construction, compilation, and cache lookup.
3. Add optional normative `identityRuntimeFingerprint` fields to `SourceDoc`
   and `StoredSourceDoc`. Use the effective value when verifying a retained or
   mounted closure. An absent legacy field has the canonical empty value. A
   newly published module whose reachable graph contains an external dependency
   stores the non-empty provider value.
   Verification recomputes under the effective value, so removing or changing a
   required value creates an ordinary identity mismatch. Reject a non-empty
   value for an unaffected module because that representation is not canonical.
4. Carry each source document's recorded fingerprint separately from the
   current fingerprint used for the importer. Treat equality as compatible by
   default. Permit another fingerprint only through a versioned runtime
   compatibility declaration.
5. Compute `cf/runtime-neutral-program-digest/v1` exactly as defined in
   [module-loading.md](../module-loading.md): hash the canonical main filename
   and the UTF-8 filename-sorted runtime-neutral identities of every authored
   file. Also hash the UTF-8 key-sorted public exports map. Do not include
   mounted files or synthetic retention links. Piece history uses this
   comparison value with the selected export and active origin to distinguish
   a runtime rebuild from a source edit.
6. Record the accepted runtime fingerprint and a separate revision cause. A
   detached piece or resolved web origin may publish an authorized runtime
   rebuild. A mutable fabric follower only adopts the revision advertised by
   its upstream origin. An immutable fabric-origin piece does not move while
   retaining that origin. Every accepted revision can then propagate to that
   piece's own downstream followers through the ordinary guarded update.
7. Test source verification across mixed fingerprints, unchanged-pin importer
   invalidation, compatible and incompatible old-fingerprint pins, legacy
   documents, cache misses, lifecycle history, authorized upstream rebuild
   propagation through a multi-piece follow chain, detach-and-rebuild recovery
   for a first immutable-origin revision, and revert that rebuilds an earlier
   retained authored program under the current runtime.

### M1.4 The resolver wrapper: `FabricAwareResolver`

New file: `packages/runner/src/harness/fabric-resolver.ts`.

```ts
// Shown for illustration only.
export interface FabricResolutionContext {
  runtime: Runtime;          // this.ctRuntime from the engine
  space: MemorySpace;        // the cell-cache space of this compile
}

export class FabricAwareResolver implements ProgramResolver {
  constructor(inner: ProgramResolver, ctx: FabricResolutionContext) {}
  main(): Promise<Source>;                       // delegate
  resolveSource(id: string): Promise<Source | undefined>;
  /** Mounts + alias map accumulated during the resolve walk. */
  mounts(): FabricMount[];
  specifierAliases(): Map<string, string>;
}
```

`resolveSource(identifier)` behavior, in order:

1. If `identifier` starts with `FABRIC_MOUNT_ROOT`: serve from the internal
   `mountedFiles: Map<path, Source>`; return `undefined` if absent (lets the
   normal missing-import error fire with the mounted path in it).
2. `parseFabricRef(identifier)`:
   - `undefined` → delegate to `inner.resolveSource`.
   - throws → re-throw (policy already rejects these; belt and suspenders).
3. Fabric ref:
   a. Scope checks (M1): `host` set → throw M3 message; `subpath` set → throw
      M4 message; `pinnedIdentity(ref)` undefined → throw M2 message.
      `ref.space` set and ≠ compiling space → M1: throw
      `"cross-space fabric refs not yet supported (M2)"`.
   b. Dedupe: if a mount for this identity exists, register the specifier on
      it and return the SAME entry Source object already returned before
      (identity-keyed `mountByIdentity` map).
   c. Depth guard: more than 32 distinct mounts in one compile → throw
      `"fabric import graph too deep/large"` (runaway-recursion backstop —
      transitive mounts arrive through this same method as the walk reaches
      mounted files' own fabric specifiers).
   d. Fetch: open a read tx exactly like
      `PatternManager.#replicateClosures()` does
      (`packages/runner/src/pattern-manager.ts` —
      `runtime.edit()` /
      `finally tx.abort?.(…)`), call `loadVerifiedSourceClosure(runtime,
      ctx.space, hash, tx)`. `undefined` → throw
      `"source for pattern:<hash> not found in space <space> (or failed
      integrity verification)"`.
   e. Starting at the entry document, walk authored import links and exclude
      `ROOT_LINK_SPECIFIER` retention links. Mount only that entry view. This
      prevents unreachable documents and sibling retained generations from
      becoming executable mount files.
   f. **Root-absolute import check** (decision 8): for every document in that
      entry view, run `collectImportSpecifiers` (from
      `@commonfabric/js-compiler`). Any specifier starting with `"/"` throws
      `"imported pattern <hash> uses root-absolute imports; not supported"`.
      Relative, fabric, and runtime-module specifiers pass. Do not inspect an
      excluded synthetic root because it cannot execute through this mount.
   g. For each document in the entry view,
      `mountedFiles.set("/~cf/" + hash + doc.filename,
      { name: …, contents: doc.code })`. Entry path =
      `/~cf/<hash><entryFilename>` where `entryFilename` comes from
      `verifySourceDocs`'s `entryFilename` (already returned inside
      `loadVerifiedSourceClosure` — if not surfaced, extend
      `loadVerifiedSourceClosure` to return `{ docs, entryFilename }`; check its
      callers: `PatternManager.#replicateClosures()` and the pattern-manager
      cold path — adjust both destructurings). For each mounted path, record
      the source document's verified identity and effective identity
      fingerprint in `publishedModules`. An absent legacy field contributes
      the empty value.
   h. Record `FabricMount`, including `publishedModules`, plus the alias
      (`identifier → entryPath`); return the entry Source.

Pitfalls to encode as comments + tests:
- The walk calls `resolveSource` with the verbatim specifier text (bare
  specifiers pass through `resolveSpecifier` unchanged —
  `resolveSpecifier`, `packages/js-compiler/typescript/resolver.ts`). Two files importing the
  same text → `sources.has(identifier)` dedupes upstream; two DIFFERENT
  texts pinning the same hash (e.g. `cf:pattern:<h>` and a pinned slug form
  in M2) → step (b) returns the same Source object, and `resolveProgram`
  stores it under BOTH identifiers → **duplicate entries in
  `program.files`**. Therefore M1.5 must dedupe the identity and source-history
  set by name (see there). Write the test now with two import lines and the same
  hash. Let it go green in M1.5.
- Authored programs must not collide with the mount root: in
  `compileToRecordGraph` authored names carry the `/<id>/` prefix so they
  can't start with `/~cf/`; in `compileResolvedToRecordGraph` they are
  unprefixed stored names — add an explicit guard in M1.5: any AUTHORED
  input file (pre-resolve) named under `/~cf/` → throw.

Unit tests (`packages/runner/test/fabric-resolver.test.ts`): use an
in-process runtime (mirror the setup of existing cell-cache tests — find
`cell-cache` or `compile-cache` test files and copy their runtime/space
bootstrap). Seed source docs by running `writeSourceDocs` with a small
hand-built module set. Cover: fetch+mount happy path; missing hash; tampered
doc (flip a byte in a stored cell → verification failure surfaces as
not-found error); root-absolute rejection in the entry view; acceptance of a
root-absolute import in an excluded synthetic root; dedupe-by-identity;
M2/M3/M4 scope errors.

### M1.5 Engine integration

File: `packages/runner/src/harness/engine.ts`.

1. Add to `TypeScriptHarnessProcessOptions`
   (`packages/runner/src/harness/types.ts`):
   ```ts
   // Shown as interface or class members.
   /**
    * Enables fabric (cf:) imports for this compile: the space whose cell
    * cache fabric refs are fetched from / verified against. Absent → any
    * fabric specifier in the program is a compile error ("fabric imports
    * require a space context").
    */
   fabricImports?: { space: MemorySpace };
   ```
2. `compileToRecordGraph` (`packages/runner/src/harness/engine.ts`):
   - Wrap the resolver:
     ```ts
     // Shown for illustration only.
     const engineResolver = new EngineProgramResolver(mappedProgram, this.ctRuntime.staticCache);
     const resolver = options.fabricImports
       ? new FabricAwareResolver(engineResolver, { runtime: this.ctRuntime, space: options.fabricImports.space })
       : engineResolver;
     ```
     When `fabricImports` is absent, fabric specifiers reach
     `isUnresolvedModuleOk` and throw `Could not resolve…` — wrap that into
     the friendlier error: BEFORE resolving, scan `mappedProgram` files with
     `collectImportSpecifiers` for `cf:`-parsing specifiers and throw
     `"fabric imports require a space context (options.fabricImports)"` if
     found without the option. (Cheap, explicit, testable.)
   - After `this.resolve(resolver)`: collect
     `const mounts = options.fabricImports ? resolver.mounts() : []` and
     `const aliases = …specifierAliases()`.
   - Preserve provenance while assembling the resolved program. Files from the
     explicit authored `Program` are authored. Files created from verified
     `SourceDoc` values are mounted. Declaration stubs returned only by
     `EngineProgramResolver` are runtime type inputs. Carry this classification
     separately from each `Source.name`.
   - Build the three sets from the declaration-file integration section. Pass
     the full type-check set to TypeScript. Pass the identity and source-history
     set to `computeFabricModuleIdentities`. Pass only the emitted set to record
     assembly and compiled-cache operations.
   - **Dedupe the identity and source-history set by `name`**, asserting equal
     contents and equal provenance on duplicates (see M1.4 pitfall). Reject a
     provenance mismatch before projecting the wrapper back to `Source`:
     ```ts
     // Shown for illustration only.
     type IdentitySourceInput = {
       source: Source;
       provenance: "authored" | "mounted";
     };
     const byName = new Map<string, IdentitySourceInput>();
     for (const input of identitySourceInputs) {
       const prev = byName.get(input.source.name);
       if (
         prev !== undefined &&
         (prev.source.contents !== input.source.contents ||
           prev.provenance !== input.provenance)
       ) throw new Error(…);
       byName.set(input.source.name, input);
     }
     const uniqueIdentitySourceFiles = [...byName.values()]
       .map(({ source }) => source);
     ```
   - Guard: any file of the ORIGINAL `program.files` (pre-pretransform input)
     named under `/~cf/` → throw `"/~cf/ is a reserved namespace"`.
   - Identity computation (line 242): replace `computeModuleIdentities(…)`
     with `computeFabricModuleIdentities(uniqueIdentitySourceFiles, mounts,
     { idPrefix: \`/${id}\` })`. (With zero mounts it must behave byte-for-byte
     like today — M1.3 guarantees it; add a regression assertion to an
     existing engine test rather than trusting it.)
   - Pass `specifierAliases: aliases` into `compiler.compileToModules` over the
     type-check set and into `compileSourcesToRecords` over the emitted set.
     Derive `emittedIdentityByPath` by restricting `identityByPath` to emitted
     modules. Give record assembly only that restricted map.
   - Restrict `precompiledModulesFor` requests and module-byte-cache completeness
     checks to emitted identities. An authored declaration has a source identity
     but never has a compiled body.
   - Split source and compiled edges in write-back descriptors.
     `resolveModuleImports` includes type-only edges and therefore supplies the
     source identity and source-history descriptors. It must not directly
     supply compiled links. Derive compiled import specifiers from the emitted
     JavaScript, using the same `importSpecs` extraction persisted on compiled
     documents. Resolve only those runtime specifiers through internal paths or
     `specifierAliases`, and map their targets through
     `emittedIdentityByPath`:
     ```ts
     // Shown for illustration only.
     const runtimeSpecifiers = deriveModuleRecordFields(compiledJs).importSpecs;
     const compiledImports = runtimeSpecifiers.flatMap((specifier) => {
       const target = resolveInternalOrAliasTarget(file, specifier, aliases);
       if (target === undefined) return []; // A runtime-provided module.
       const targetIdentity = emittedIdentityByPath.get(target);
       if (targetIdentity === undefined) {
         throw new Error(
           `emitted module '${file.name}' imports declaration-only target '${specifier}'`,
         );
       }
       return [{
         specifier,
         targetIdentity,
       }];
     });
     ```
     Build source-persistence descriptors from the identity and source-history
     set with the complete value-and-type edge graph. Build compiled descriptors
     from emitted records and `compiledImports` only. A source descriptor may
     represent a declaration and have no compiled counterpart. A type-only edge
     between two emitted `.ts` modules remains a source link but is not a direct
     compiled link. Fail clearly if emitted JavaScript names a declaration-only
     target instead of manufacturing a compiled link for it.
   - `filename` for mounted files (line 422): `stripModuleIdPrefix(file.name,
     id)` only strips `/<id>`; mounted names need the mount prefix stripped
     instead. Write a small helper
     `storedFilenameFor(name, id, mounts)` → authored: status quo; mounted:
     `name.slice(("/~cf/" + m.entryIdentity).length)`.
3. `compileResolvedToRecordGraph` (same file): use the same provenance
   classification, three sets, merged identity computation, aliases, and fabric
   edges, with `idPrefix` absent for the authored set because stored names are
   prefix-free. Add `options?: { fabricImports?: { space: MemorySpace } }`; the
   pattern-manager caller in M1.7 threads the space it already has. Return
   separate source-persistence descriptors and emitted `CacheableModule`
   values. The emitted set contains mounted implementation modules for the
   self-contained cached-module evaluator. It excludes all declarations.

Tests (`packages/runner/test/fabric-imports-engine.test.ts`, in-process
runtime):
- Seed: compile + write-back a small two-file pattern P (existing engine
  compile helpers; mirror how `esm-*`/cell-cache tests drive
  `compileToRecordGraph` + `writeSourceDocs`/`writeCompiledDocs`). Record its
  `entryIdentity`.
- Importer I with `import { x } from "cf:pattern:<P-entry>"`:
  - compiles; record graph contains a record keyed
    `cf:module/<P-entry>`; I's record resolutions map the specifier to it.
  - `modules` write-back set: P's modules appear with their ORIGINAL
    filenames + identities; I's entry carries the fabric edge.
  - Evaluation: I's exports work; P's pattern callable through I.
  - Type error variant: I uses a wrong member name → compile fails with a TS
    diagnostic naming the member (proves real type-checking through the
    alias).
  - Identity sensitivity: byte-change P → republish under new hash; I pinned
    to OLD hash still compiles to the OLD identity (reads old docs); I with
    the NEW hash has a different module identity than the old I.
  - No `fabricImports` option → the friendly "requires a space context"
    error.
  - Same hash imported via two specifier texts → compiles (dedupe), one
    record.
  - Transitive: P itself imports `cf:pattern:<Q>` → I→P→Q compiles and
    evaluates; Q mounted once.
  - `--show-transformed` path (`getTransformedProgram`) includes mounted
    files (smoke assertion: a mounted filename appears).

### M1.6 Cache write-back: source-side link filtering

File: `packages/runner/src/compilation-cache/cell-cache.ts`.

1. Source-document construction consumes the identity and source-history set,
   including authored and mounted declarations. `storedImportRefs` (line 119)
   keeps internal declaration edges but skips fabric edges when building source
   links:
   ```ts
   // Shown for illustration only.
   const refs = module.imports
     .filter((imp) => !isFabricImportSpecifier(imp.specifier))
     .map(…);
   ```
   `unreachedRoots` (line 96) stays UNTOUCHED — it must keep seeing fabric
   edges as reachability (otherwise every mounted module gets a synthetic
   root link from the importer's entry, dragging subtrees back into the
   importer's source closure — the exact thing decision 6 forbids).
2. **Compiled side**: `writeCompiledDocs`, compiled synthetic roots, and
   compiled import links consume only the emitted set. Direct compiled links
   come only from runtime imports extracted from emitted JavaScript. A
   declaration identity is never a compiled-cache member or link target. A
   value fabric import between emitted modules becomes a link
   (`{specifier: "cf:pattern:…", link → compiledDocKey(rtv, <identity>)}`).
   An erased type-only import does not. Use separate source and compiled
   descriptor fields rather than assuming both stores have the same membership
   or edge graph. The compiled synthetic-root pass may still link an otherwise
   unreachable emitted module under `cf:cache-root/`; that is not the erased
   type-only specifier.
3. `verifySourceDocs` still verifies only the importer's closure because that
   closure no longer contains subtree docs. It must also read the normative
   identity fingerprint from each source document and use it when recomputing
   the identity. Add a regression test proving both properties: write back an
   importer's modules, `loadVerifiedSourceClosure(importerEntry)` returns only
   the importer's own docs, verification succeeds under the recorded
   fingerprint, and the importer doc's stored imports contain no fabric
   specifier.

Tests (extend the existing cell-cache and module-byte-cache test files): the
regression above; a program with an authored declaration writes declaration
source but no declaration compiled document, then obtains a warm compiled-cache
hit without requesting one; a runtime declaration stub does not appear in the
source set and its module remains an external fingerprinted leaf; a compiled
closure walk returns importer and subtree emitted docs but no declaration docs;
and a type-only relative edge between two emitted `.ts` modules appears under
its authored specifier in the source links but not the compiled runtime links.
The emitted target may still be retained by a synthetic compiled root. Also
show that `PatternManager.#replicateClosures()` of an importer initially
fails or loses the subtree because the source closure excludes it. Fix
`PatternManager.#replicateClosures()` by
parsing each replicated source doc's external specifiers with
`collectImportSpecifiers`, `isFabricImportSpecifier`, and `pinnedIdentity`, then
recurse per subtree identity with a visited set. Test that an importer replicated
to a second space loads cold in that space.

The piece-lifecycle manifest writer reuses this recursive pinned-dependency walk
as a retention walk. It records each dependency identity once and retains the
complete transitive graph. A regression removes every incidental source root
after retaining an importer whose pinned dependency has another pinned
dependency, then restores and compiles the importer from its revision manifest.

### M1.7 Reload paths (warm + cold)

File: `packages/runner/src/pattern-manager.ts`.

1. Locate the by-identity load (`loadPatternByIdentity`, ~line 985) and read
   it END TO END before changing anything. Identify:
   - the warm branch (`loadCompiledClosure` → `evaluateCachedModules`-style
     evaluation), and
   - the cold branch (`loadVerifiedSourceClosure` →
     `compileResolvedToRecordGraph`).
2. **Warm**: with M1.6 the compiled closure includes subtree docs. Follow the
   code from closure → records and verify the record builder maps the fabric
   edge's specifier to `cf:module/<identity>` using the STORED import edges
   (the same mechanism internal edges use). If it re-derives resolutions from
   specifier text + `findInternalTarget` instead, extend it with a branch:
   "specifier parses as fabric ref → resolution = `cf:module/<stored edge
   identity>`". Add a test before touching code: deploy importer (M1.5 test
   helper), drop the in-memory pattern cache (new runtime instance on the
   same storage — mirror how resume tests do this; see
   `resume-by-identity`-named tests), `loadPatternByIdentity(importerEntry)`
   → warm load works.
3. **Cold**: force the cold path (bump
   `COMPILE_CACHE_RUNTIME_VERSION` in the test via its option/parameter if
   injectable, or write source docs only) → `compileResolvedToRecordGraph`
   must receive `{ fabricImports: { space } }` from this call site. The
   FabricAwareResolver inside it refetches subtrees (they exist in the same
   space). Test: cold load of the importer works, and the recompiled module
   identities EQUAL the originals (assert on returned `entryIdentity` and a
   spot-check module).
4. Eviction/`addressableByIdentity`: no changes — but add one test: after
   importer evaluation, `artifactFromIdentitySync(<P-entry>, <symbol>)`
   resolves (proves imported modules registered under their published
   identities → op-by-identity / `$patternRef` referencing imported patterns
   works).

### M1.8 CLI surfacing

Files: `packages/cli/lib/dev.ts`, `packages/cli/commands/dev.ts`.

- `cf check` compiles via `engine.compileToRecordGraph` (`packages/cli/lib/dev.ts`).
  Thread `fabricImports: { space }` only when the dev session has a space
  (inspect how `dev.ts` builds the runtime and whether a space/identity is
  configured; if none, leave the option absent — the M1.5 friendly error then
  tells the user why). Add `--space <did>` plumbing ONLY if it already exists
  in the command's option surface; otherwise leave a TODO comment referencing
  M2 (do not invent new CLI flags in M1).
- Acceptance: a fixture pattern with a fabric import produces the
  "requires a space context" error through `cf check` (snapshot the message),
  not a raw `Could not resolve` error.

**Acceptance M1** (run all): new test files green; full
`packages/runner`, `packages/js-compiler`, `packages/cli` suites green;
the M1.5 end-to-end test demonstrates: compile, type-check, evaluate,
write-back, warm reload, cold reload, cross-runtime resume, tamper rejection.

---

## M2 — Mutable refs (slug / piece / of:) + pinning

### M2.1 Generic slug→cell resolution in runner

`resolveSlugTargetCell` in `packages/piece/src/slugs.ts` is the model; it
uses only `runtime` + `space`. Lift it:

- New: `packages/runner/src/slug-resolution.ts` —
  `resolveSlugTargetCell(runtime: Runtime, space: MemorySpace, slug: string):
  Promise<Cell<unknown>>` — copy the body, replacing `manager.runtime`/
  `manager.getSpace()`; move `SlugResolutionError` here and re-export from
  the piece package for compatibility.
- `packages/piece/src/slugs.ts` delegates to it (keep its piece-specific
  `resolvePieceAddress` checks where they are).
- Tests: move/duplicate the existing piece slug-resolution tests' generic
  cases to a runner test; piece suite must stay green untouched otherwise.

### M2.2 The chase: ref → terminal identity

New: `packages/runner/src/fabric-ref-resolution.ts`.

```ts
// Shown for illustration only.
export interface FabricChaseResult {
  entryIdentity: string;
  /** Human-readable hops for errors/tooling, e.g.
   *  ["slug:todo-list", "piece:of:…", "patternMeta:of:…", "entryIdentity:…"] */
  chain: string[];
}

export async function resolveFabricRefToIdentity(
  runtime: Runtime,
  compilingSpace: MemorySpace,
  ref: FabricRef,
): Promise<FabricChaseResult>;
```

Algorithm (spec § Resolution rule — implement hops exactly):

1. Scope guard: when `ref.subpath` is present, throw
   `"subpaths not yet supported (M4): <specifier>"` before resolving the space,
   slug, piece, or entry identity. This guard is shared by deployment pinning
   and `cf deps update`; otherwise those paths can silently write the entry
   identity as the pin for an unsupported subpath. M4 replaces this guard with
   manifest lookup. Keep the independent `FabricAwareResolver` guard until M4
   also teaches frozen compilation to mount a selected subpath module.
2. Space: `ref.space` undefined → `compilingSpace`; a DID → use as-is; a name
   → M2 throws
   `"space names are currently unsupported; resolve the name to a DID first"`.
   The tentative identifier-only policy keeps name resolution outside the
   fabric resolver. Under the dormant
   [Common Fabric URLs](../fabric-urls.md) concept, human-readable browser
   aliases would resolve before the resolver receives a DID. No such resolver
   is planned for deployment.
3. Start cell:
   - slug → M2.1 resolver (wrap `SlugResolutionError` with the chain so far).
   - `of:` URI → reconstruct the entity id from the parsed hash via the
     `uri-utils.ts` helpers (`fromURI("of:fid1:" + hash)` / the `{"/": id}`
     shape — mirror an existing `getCellFromEntityId` call site rather than
     hand-building the string), then `sync()`.
   - `pattern:` → already terminal (return immediately; callers normally
     short-circuit via `pinnedIdentity` and never get here).
4. Piece hop: if the cell has pattern metadata — use the SAME accessor the
   runner uses, `getPatternIdentityRef`, already exported from
   `packages/runner/src/runner.ts`:
   - `patternIdentity` present → its `.identity` IS the terminal identity;
     append hops; done.
   - absent → throw `"cf:… does not resolve to a pattern (chain: …)"`.
     `patternIdentity` is the only pattern pointer — the legacy `patternId`
     meta field is retired — so there is no second pointer to chase and no
     pattern-meta hop behind this one.

No cycle guard needed (≤3 hops, no recursion).

Tests (`packages/runner/test/fabric-ref-resolution.test.ts`): build, in an
in-process runtime: a fake piece cell carrying `meta("pattern")` /
`meta("patternIdentity")` (use the real setters — `setPatternCell` in
`packages/runner/src/result-utils.ts` writes `meta("pattern")`, and
`Runner.#applySetupState` writes `meta("patternIdentity")` — and mirror them);
slug → piece; slug → plain data cell (error + chain); missing slug; `of:`
directly to a piece cell. Add a direct `pattern:` subpath test that proves the scope
guard runs before the otherwise-terminal identity is returned. Add a CLI
pin/update regression that resolves a valid slug but rejects its subpath rather
than writing the slug target's entry identity.

### M2.3 Pin rewriting (byte-precise source surgery)

New: `packages/runner/src/fabric-pin-rewrite.ts`.

```ts
// Shown for illustration only.
export interface PinRewrite { specifier: string; pinned: string; line: number }

/**
 * Rewrite fabric import/export/import-type specifiers in ONE source text.
 * `resolvePin(ref)` returns the identity to pin (or null = leave untouched).
 * Returns the new text + the rewrites performed. MUST only change the
 * string-literal spans — byte-identical elsewhere (no reprinting).
 */
export async function rewriteFabricPins(
  contents: string,
  resolvePin: (ref: FabricRef, specifier: string) => Promise<string | null>,
): Promise<{ contents: string; rewrites: PinRewrite[] }>;
```

Implementation: `ts.createSourceFile`, walk EXACTLY the three node shapes
`collectImportSpecifiers` walks (import decl / export-from / ImportTypeNode —
copy that visitor, `collectImportSpecifiers` in
`packages/js-compiler/typescript/resolver.ts`),
collect `{ literal.getStart()+1, literal.end-1, text }` spans, compute
replacements with `formatFabricRef(withPin(ref, pin))`, apply BACK TO FRONT
on the original string. Skip non-fabric specifiers; skip refs where
`pinnedIdentity` already matches; error on a fabric ref inside a dynamic
`import()` expression? — dynamic imports are unsupported by the compiler
(resolver.ts comment) so they cannot occur in valid programs; ignore.

Detect an `ImportEqualsDeclaration` whose external module reference is a
`cf:` string and reject it with
`"fabric import-equals syntax is unsupported; use an ESM import type"`.
Apply the same validation in graph discovery and identity collection so this
syntax cannot bypass the pin or become an unhashed runtime dependency.

Tests: fixtures with weird-but-valid formatting (multiline imports, comments
between clause and specifier, `export * from`, `import type`, single vs
double quotes — PRESERVE the original quote character: detect from the
literal's raw text). Assert byte-identity outside the replaced spans
(compare prefix/suffix slices, not just "compiles"). Add a rejection test for
`import type Alias = require("cf:dep")` in rewriting, graph discovery, and
identity calculation.

### M2.4 Engine: unpinned refs in dev mode

- `TypeScriptHarnessProcessOptions.fabricImports` gains
  `allowUnpinned?: boolean` and the engine threads it into
  `FabricAwareResolver`.
- Resolver step (a) update: ref with no `pinnedIdentity` →
  - `allowUnpinned` false/absent → throw `"unpinned fabric import 'cf:…';
    pin it (cf deps update) or deploy to pin"`.
  - true → run M2.2's chase, then proceed exactly as a pinned ref with the
    chased identity; record `{ specifier, resolvedIdentity, chain }` in a new
    `resolvedPins()` accessor.
  - cross-space (`ref.space` a DID ≠ compiling space): fetch via
    `loadVerifiedSourceClosure(runtime, refSpace, …)` — the storage session
    routes; CFC caveat is documented follow-up (decision 9). The write-back
    then copies the docs into the compiling space (this is
    `PatternManager.#replicateClosures()`
    semantics through the normal compile path — no extra code, but ADD a test
    asserting it happens, and a `logger.info` naming source space → dest
    space for the provenance audit trail).
- Engine surfaces `resolvedPins` in `compileToRecordGraph`'s return value
  (additive field).

Tests: unpinned + allowUnpinned=false → error; =true → compiles and
`resolvedPins` carries the chain; pinned ref never touches the slug (delete
the slug cell after pinning, recompile → still works).

### M2.5 CLI: pin-on-deploy + `cf deps update`

Read `packages/cli/` command structure first (mirror an existing command's
file layout, e.g. how `dev.ts` registers).

- **Deploy pinning**: `getPinnedProgramFromFile()` currently calls
  `getProgramFromFile()`. Its ordinary harness resolver has no fabric-aware
  layer, so it rejects every fabric import or export declaration before
  `pinProgramFabricImports()` runs. An already-pinned declaration fails too,
  and an unpinned declaration never reaches the rewriter. Replace that ordering
  with the `cf deps update` pattern: call `collectLocalProgram()` with fabric
  imports allowed, run `pinProgramFabricImports()` over every collected file,
  then pass the pinned program through the frozen compile path. If any rewrite
  happened, print each (`pinned cf:/did:key:z6Mk…/todo-list → @AvcnyZ…`). The
  stored program is the pinned one. Deploying with an unresolvable reference
  fails with the chase's error.
- **`cf deps update [file] [--import <specifier>]`**: new command; operates
  on the local working files (filesystem), not deployed state: parse, chase
  every mutable fabric ref (or just `--import`), rewrite pins in place,
  print a per-file diff summary. `--check` flag: exit non-zero if any pin
  would change (CI freshness gate).
- **`cf check`**: pass `allowUnpinned: true` + print
  `resolvedPins` ("resolved cf:… → <hash> (not pinned — run cf deps update)").

Tests: CLI-level tests follow whatever harness existing cli tests use (look
in `packages/cli` for test conventions; if commands are thin over lib
functions, test the lib functions and add one smoke test per command). Add
pin-on-deploy regressions for an unpinned value import, `import type`, a
type-only export, and an inline import type. Each unpinned reference must reach
the rewriter before the frozen compile. Add an already-pinned import regression
that reaches the frozen compile without local-resolution failure. Keep the
existing `cf deps update` coverage.

### M2.6 End-to-end snapshot-semantics test (the spec's core scenario)

One integration test (runner-level, in-process, two "deploys"):

1. Deploy pattern P v1; create piece from it; assign slug `dep`.
2. Author importer I with `cf:dep` (unpinned); simulate deploy: pin → assert
   source now contains `cf:dep@<v1-entry>`; deploy I; run it.
3. Update the piece to P v2 (new pattern meta + `patternIdentity`).
4. Recompile/reload I from its stored program: byte-identical behavior,
   SAME module identities as step 2 (assert hash equality), v1 code still
   runs.
5. Re-pin (M2.3 with the chase): only the import line differs; new identity;
   v2 code runs.
6. Re-point the slug at an unrelated data cell: pinned I still loads (pin
   never re-reads the slug); a fresh unpinned resolve now fails with the
   "does not resolve to a pattern" chain error.

**Acceptance M2**: all the above green; full repo test suite green
(`deno task test` at root, or at minimum runner + js-compiler + piece + cli).

---

## M3 / M4 — sketches only (do NOT implement)

- **M3 cross-host + publish**: `cf publish` verifies source-read authorization,
  destination-write authorization, and the CFC flow. It copies the verified
  source closure, creates a lightweight patternIdentity-bearing publication
  cell, and optionally assigns a slug in the target space. It does not copy the
  source piece or its state. The resulting replica uses the destination space's
  ACL. Host-qualified refs register their accepted hint through the ordinary
  per-space storage manager before opening the target space. Do not use a
  secondary session. A seeded route can only be confirmed. Once a late hint is
  accepted, a different hint is a conflict before or after the space opens. An
  unseeded provider opened through the default host remains provisional while
  it is read-only. Its first hint can replace that provider. Overlapping reads
  follow the replay, which also loads dependencies discovered from the hinted
  data. A different-host hint can replace an operation that is waiting for a
  session. The route becomes fixed when the session accepts a stateful
  operation for issue, even if acknowledgment later fails. Initial site-table
  hydration selects the last entry for each space that contains only an HTTP or
  HTTPS origin, with no credentials, path, query, or fragment. It does not
  replace a route already accepted through IPC.
  A conflicting table route accepted first makes later IPC registration fail.
  Dynamic registration and site-table hydration exist as foundations, but
  import-resolver integration, host failure, and replacement of an explicit
  route remain work. Cross-host publication also needs CFC label propagation
  for fetched source (spec § Security). A possible public-pattern HTTP endpoint
  remains open under the public distribution question in the spec.
- **M4 explicit subpaths**: extend lifecycle source ingestion and retained
  publications with the following behavior.

  1. Add an `exports` map to `cf/authored-program-manifest/v1`. The empty
     subpath implicitly selects `main` and cannot appear in the map. Require
     each key to be a canonical slash-separated public name with no leading or
     trailing slash, empty segment, `.` segment, `..` segment, or `@`
     character. Reject noncanonical keys, duplicate keys, wildcards,
     conditions, and targets that are not canonical authored filenames in the
     manifest. Compare the parsed subpath exactly. Do not percent-decode or
     fold case.
  2. Include the UTF-8 key-sorted map in the manifest identity and
     `cf/runtime-neutral-program-digest/v1`. A map-only edit creates a new
     source revision even when all module identities and the executable entry
     identity stay equal. Revert restores the previous map. Followers observe
     the new revision.
  3. Make each mutable import target expose its current immutable manifest
     through the source revision. This applies to pieces and future lightweight
     publication pointers. A target that exposes only `patternIdentity` cannot
     resolve an unpinned subpath.
  4. At pin time, chase the mutable locator to its current source revision.
     Look up the exact public subpath, load the mapped file's verified
     source-document identity, and write that selected module identity as the
     trailing pin. Preserve the locator and subpath before the pin. `cf deps
     update` repeats the lookup against the current manifest. Replace the M2
     subpath guard in `resolveFabricRefToIdentity()` with this branch. Extend
     `FabricChaseResult` with `selectedIdentity`; keep `entryIdentity` as the
     identity reached by the pointer chase. The two values are equal without a
     subpath. Pin rewriting must use `selectedIdentity`.
  5. During frozen compilation, let the existing `pinnedIdentity()` fast path
     mount the selected module closure directly. Do not read the mutable target
     or manifest. An entry import continues to pin
     `patternIdentity.identity`, so M1 and M2 behavior stays unchanged.
  6. Reject any subpath on a direct `cf:pattern:<identity>` reference. One
     module source identity does not bind an authoritative manifest. A caller
     that knows the target module identity uses it directly. Do not infer
     public names from entry-module re-exports or expose a file merely because
     its source document is readable.
  7. Permit an exports-map target to be an authored `.d.ts` file. Type-only
     imports retain and hash that declaration normally. Reject a value import
     from a declaration-only target because it has no emitted runtime module.
  8. Test exact selection, selected-module pin rewrite, frozen resolution after
     the mutable target disappears, explicit dependency updates, invalid map
     entries, arbitrary-file rejection, direct-pattern subpath rejection,
     declaration targets, map-only revision propagation, and revert.
- **Later npm vendoring**: `npm:` fetches through the selected package source,
  vendors a content-addressed source set, and then uses the same identity and
  mounting machinery. Its design remains separate from explicit fabric
  subpaths.

## Invariants checklist (the reviewer will check every one)

1. Fabric resolution does not otherwise change a compile with zero fabric
   imports. The declaration-identity and runtime-fingerprint integrations in
   this plan intentionally change identities and source persistence when their
   inputs require it. Outside those migrations, identities, records, cache
   documents, and behavior remain byte-for-byte unchanged. Guard this boundary
   with the existing engine and cache suites plus the migration tests specified
   above.
2. A mounted module's computed identity ALWAYS equals the identity it was
   fetched by (M1.3 throws otherwise) — never trust, always recompute.
3. The importer's module identity changes when its own source, a transitive
   authored dependency, a fabric pin, or its effective runtime fingerprint
   changes. Runtime-provided declaration stubs remain external fingerprinted
   dependencies rather than internal authored files.
4. Source closures never span programs; compiled closures may (links).
5. Fabric specifiers never appear in: emitted record KEYS (only
   `cf:module/<hash>`), source-doc links, slug cells. They appear verbatim
   in authored source and identity inputs. A value import also appears in record
   `resolutions`, compiled `require()` calls, and emitted-module compiled edges.
   A type-only import may be erased from JavaScript but still affects identity
   and retains its pinned source dependency.
6. Every error message names the failing specifier and (where applicable) the
   chain of hops — copy the exact strings from this plan.
7. No new HTTP surface, no new authz checks — reads go through normal cell
   reads and fail with normal authz errors.
8. `/~cf/` is reserved: authored files under it are rejected everywhere.

## Risk register (check early, in this order)

| Risk | Check | Fallback |
|---|---|---|
| Injected helper module (`transformInjectHelperModule` → `transformCfDirective`) references a path that breaks under mount prefixing | FIRST test in M1.4: mount pristine source produced by a real `compileToRecordGraph` write-back and assert that the ordinary compile-time helper transform runs exactly once. Cover the tolerated legacy envelope in a separate fixture. | If the helper import is non-relative and path-ambiguous: serve it from the wrapper by suffix-matching within the requesting subtree — but ESCALATE first; this needs a design look |
| `loadCompiledClosure` verifies link/edge consistency in a way fabric links violate | M1.6 compiled-walk test before any M1.7 work | Teach its check the fabric branch. Use the same shape as the `verifySourceDocs` partition, but escalate first because the compiled set's integrity model uses CFC labels and is security-sensitive. |
| `evaluateCachedModules` record building can't map fabric edges | M1.7 step 2 test-first | Small resolution branch keyed on `isFabricImportSpecifier` |
| Engine cache-hit (`fullHit`) misbehaves with mounted identities | M1.5 test: SECOND compile of the importer is a full hit (no TS compile — assert via the `compile-cache-hit` log or `esmCacheStats`) | — |
| TS extension inference for mounted entry (`.tsx` vs `.ts`) | M1.1 alias test uses a `.tsx` target | use stored filename's real extension (already in plan) |
| `validateSource` / emit-stem ambiguity with mounted names | M1.5 e2e covers; stems differ by mount dir | — |

## What NOT to do

- Do NOT modify `computeModuleHashes` / `module-identity.ts`. All fabric
  awareness lives a layer above (M1.3 partitions, then calls it).
- Do NOT rewrite specifier text in stored/authored source anywhere except
  the explicit pin-rewrite tool (M2.3) invoked by deploy/`deps update`.
- Do NOT add fabric links to SOURCE docs or "fix" `verifySourceDocs` to
  union across programs.
- Do NOT pretransform mounted source before storing or mounting it. Source
  documents retain pristine authored bytes. After resolution, the engine
  applies the ordinary compile-time helper transform exactly once. Preserve the
  existing tolerance for source stored in the legacy envelope.
- Do NOT thread a space through globals/singletons — it rides options.
- Do NOT touch CFC label code paths in this work (decision 9); if a test
  fails on labels, stop and escalate rather than loosening a check.
- Do NOT introduce new CLI flags beyond `cf deps update`'s listed ones.
