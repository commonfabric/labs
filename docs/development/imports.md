# Imports

A file's `import` declarations are the list of what that file depends on.
Reading the top of a file tells you what it pulls in, what the build has to
resolve, and what a reader has to know about before reading further. Two
constructs break that: a type written as `import("./mod.ts").Thing`, and a
module loaded by an `import("./mod.ts")` expression in the middle of a
function. Both are called an inline import here.

How the declarations at the top are then grouped, collated and sorted, and how
many statements one module may take, is the `Imports` section of
[`DEVELOPMENT.md`](DEVELOPMENT.md). One rule of that section is enforced too,
by `cf-import-list/one-statement-per-kind` in
[`tasks/lint-import-list.ts`](../../tasks/lint-import-list.ts): a module is
imported in one statement of each kind, never two. That section documents it.
This document is about what may not be written outside the list at all.

Two lint rules keep them out. They live in
[`tasks/lint-inline-imports.ts`](../../tasks/lint-inline-imports.ts) and are
registered under `lint.plugins` in the root `deno.jsonc`, so `deno lint` runs
them over the whole repository.

## `cf-imports/no-inline-type-import`

Reports every type written as `import("...")`, with no exceptions.

```ts
import type { VNode } from "commonfabric";

// Wrong: the dependency is written into the type that uses it.
interface WrongPatternOutput {
  tile: import("commonfabric").VNode;
}

// Right: the dependency is in the import list.
interface RightPatternOutput {
  tile: VNode;
}
```

Nothing is lost by moving the declaration to the top. TypeScript erases an
`import type` entirely, so it adds no runtime dependency, no load-order
effect, and no bundle weight — which is the whole of what the inline form was
buying. The inline form exists so a `.d.ts` can name a type without a
declaration of its own; ordinary source has a declaration list, and the type
belongs in it.

Two shapes are worth naming:

- A class or other value used in a type query. `import type { Thing }` still
  works: a type-only binding is legal in a `typeof` position.

  ```ts
  import type { FabricLink } from "@commonfabric/data-model/fabric-instances";

  interface Api {
    FabricLink: typeof FabricLink;
  }
  ```

- A whole module, written `typeof import("./mod.ts")`. Import the namespace
  type and take `typeof` of it.

  ```ts
  // Shown for illustration only.
  import type * as cellCache from "../src/compilation-cache/cell-cache.ts";

  type CellCacheModule = typeof cellCache;
  ```

When the local name is already taken — a test that declares its own `UI` to
stand in for an ambient one, say — import under an alias
(`import type { UI as UI_TYPE }`).

One shape has no top-of-file form: an ambient declaration file with no
imports of its own, whose `declare` statements are global precisely because
the file is not a module. Adding an import there makes it a module and the
globals stop being global. No file in this repository is in that position
today; one that ends up there takes a `deno-lint-ignore` saying so.

## `cf-imports/no-inline-module-import`

Reports an `import("...")` expression that names its module with a plain
string. A computed specifier is not reported: a module named by a template
literal, a variable, or a URL built while the program runs has no
top-of-file equivalent at all.

```ts
// Reported: the module could be imported at the top.
const { listPieces } = await import("../piece.ts");

// Not reported: no import declaration can name this.
const isolated = await import(`./benchmark.ts?scope=${crypto.randomUUID()}`);
```

Unlike the type rule, this one has real exceptions. A deferred load earns its
place when:

- **The module cannot load here.** `node:async_hooks` exists under Deno and
  Node and nowhere else; the FUSE bindings for one platform cannot load on
  another.
- **Loading it costs something the caller may not want to pay.** Importing
  `@commonfabric/runner/storage/cache.deno` opens SQLite's native library, so
  it needs `--allow-ffi` from every consumer that so much as mentions the
  module. The OpenTelemetry SDK probes its environment as it loads. A `cf`
  completion request runs between two keystrokes and should load only what
  its own candidates need.
- **The load has to happen at a chosen moment.** A test that installs browser
  globals, replaces a global, or sets an environment variable that a module
  reads as it loads has to do that first. A test that wants a module
  evaluated afresh loads it again through a query string.
- **The load is the thing under test.** A test asserting that evaluating an
  entry point does not run it as `main` has to evaluate it.

Keep the deferred load and say which of these it is:

```ts
// The Deno storage cache opens SQLite as it loads, and a caller that never
// builds a runtime should not pay for that.
// deno-lint-ignore cf-imports/no-inline-module-import
const { StorageManager } = await import("@commonfabric/runner/storage/cache.deno");
```

A Deno ignore directive applies to the line directly after it, so the
directive is always the last line of the comment block and the explanation
goes above it.

When a whole file is about loading modules at run time — the shell's view
tests, the A/B harness that loads one module graph from two checkouts — one
directive at the top carries the reason for all of its sites:

```ts
// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.
```

A file-level directive covers sites added later too, so prefer the per-site
form unless the file really is uniformly about deferred loading.

A file gets one such directive and no more. Deno reads the first and ignores
every one after it, so a second directive suppresses nothing while reading as
though it does. A file that already carries one names every rule it needs on
that single line. Only the rule names sit before the `--`, so the reason can
run onto the lines below it:

```text
// deno-lint-ignore-file no-explicit-any cf-imports/no-inline-module-import --
// the harness loads each checkout's own copy of the module under test.
```

## Node built-ins

A static `import ... from "node:crypto"` is rejected by Deno's
`no-external-import` rule, which the repository switches on. Reaching for a
dynamic `import("node:crypto")` to get around that trades one problem for
another. Alias the specifier in the package's own `deno.jsonc` instead, which
is what `no-external-import` means by "use import maps":

```jsonc
"imports": {
  "@node/crypto": "node:crypto"
}
```

```ts
// Shown for illustration only.
import * as nodeCrypto from "@node/crypto";
```

`runtime/cli`, `base/data-model`, and `runtime/toolshed` each
carry one of these aliases. A module that genuinely cannot depend on a Node
built-in — because it also loads in a browser — is a different case, and belongs
under `cf-imports/no-inline-module-import` with its reason written down.
