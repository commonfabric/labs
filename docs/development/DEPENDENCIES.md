# Dependencies

This is the maintenance guide for adding and rolling dependencies, diagnosing
dependency failures, and preserving the repository's dependency boundaries. For
workstation setup, including installing Deno with mise, follow the
[development quick start](../../README.md#quick-start-development).

## Adding dependencies

### Declare dependencies at the narrowest scope

Add a dependency to the `deno.jsonc` of the workspace member that imports it.
Do not add a package-specific dependency to the root import map. A dependency
declared at the root becomes available throughout the workspace, which makes a
package appear lighter than it is and can make browser or worker code resolve a
dependency intended only for a server.

From the workspace member's directory, `deno add` writes the dependency to the
right config and updates `deno.lock`:

```bash
deno add npm:<package>
deno add jsr:<package>
```

Use an exact version only when the repository depends on that exact release.
Record the reason in this guide when future rolls need to preserve it. Otherwise
keep a compatible range so routine updates can move without rewriting every
import map.

Prefer JSR when a package is maintained there. Use npm when it is the package's
canonical distribution or the required release is unavailable from JSR.

After adding a dependency, import it from that member and run:

```bash
deno task check-unused-deps
deno task check
deno task test
```

Use a focused package test while iterating, then run the repository checks
before the change lands.

### Types for packages that ship none

Some npm packages carry no type declarations of their own and are described by a
separate `@types/*` package. Declaring that package in an import map is not what
makes it apply. Deno looks for an `@types` package when it resolves through a
`node_modules` directory, and this workspace does not use one, so the
declaration alone leaves the package fetched and unused. The import then types
as `any`, and nothing reports it: the import still resolves, and the type
positions still fill, so a name like `ScaleBand` reads as a real type while
standing for `any`.

Point the import at its types with a `@ts-types` comment. Write the specifier
bare so that it resolves through the import map, which keeps the version pinned
in one place rather than repeated in every file that imports the package:

```ts
// Shown for illustration only.
// @ts-types="@types/d3-scale"
import { scaleBand } from "d3-scale";
```

Declare both packages in the import map of the package that imports them: the
one supplying the code, and the one supplying its types.

### Declared dependencies must be imported

An import map that declares a dependency nothing imports carries dead weight: the
package still downloads on install, and it can pin a second copy of something the
rest of the tree already resolves. `deno outdated` never catches this, because it
only reports packages that are behind — an unused dependency at its newest
release is invisible to it. `deno task check-unused-deps` catches it instead. The
check fails when an import map alias is imported by no source file in that map's
scope, where a member's map covers only that member's files and the root map
covers the whole workspace. It runs in CI alongside the other lockfile and lint
checks.

An `@types/*` alias reached only through a `@ts-types` comment still counts as
imported, so wiring one up as above satisfies the check. A dependency that is
declared without a local import on purpose goes in the allowlist in
`tasks/check-unused-deps.ts` with a one-line reason.

## Packages that must resolve to a single copy

Most packages can be resolved twice without anyone noticing. A few cannot,
because one copy produces a value that another copy reads back:

- `ai` and `@ai-sdk/provider-utils` produce the telemetry spans that
  `@arizeai/openinference-vercel` translates into OpenInference attributes.
- `@arizeai/openinference-semantic-conventions` defines the attribute names
  that the same package's span processor reads back.

Two copies of any of them breaks the translation, and breaks it quietly: the
spans are still produced and still exported, they just carry the wrong
attributes or none. Nothing throws, no test fails, and the traces keep flowing
in the volume graphs.

`@ai-sdk/otel` depends on `ai` with an exact pin rather than a peer range, so
it resolves a second copy of `ai` as soon as its pin and the range toolshed
asks for stop agreeing. Rolling `ai`, any `@ai-sdk/*` provider, or either
`@arizeai/openinference-*` package on its own is enough to do it, which is why
they are rolled as one set:

```bash
deno outdated --update --latest --recursive ai @ai-sdk/groq @ai-sdk/openai \
  @ai-sdk/anthropic @ai-sdk/google-vertex @ai-sdk/otel \
  @arizeai/openinference-vercel @arizeai/openinference-semantic-conventions
```

`deno task check-single-copy-deps` (also a CI step) reads `deno.lock` and fails
when one of those packages resolves more than once. `tasks/check-single-copy-deps.ts`
holds the list, each entry with what breaks when it is duplicated; add to it
when a package starts carrying cross-copy state.

## Rolling dependencies

Start with `deno outdated --recursive`. It reports each workspace member's
declared range, the version in the lockfile, and available releases. Before
updating anything, check the package-specific sections below for dependencies
that must move together or stay on an older release.

To update within declared ranges:

```bash
deno outdated --update --recursive <aliases>
```

Add `--latest` only when the change is meant to rewrite the declared ranges and
take new major versions. Filters select import-map aliases, not necessarily the
published package names. When editing import maps by hand, run `deno install`
afterward to refresh `deno.lock`.

Review both the import-map changes and the lockfile graph. A small declaration
change can introduce a second transitive copy or a native binary. Then run the
checks named by the relevant section, followed by `deno task check` and
`deno task test`.

### Deno toolchain

`mise.toml` is the canonical pin. Everything else follows it or is checked
against it:

- `.github/actions/deno-setup` reads `mise.toml` at job time, so CI uses the
  pinned version.
- `tasks/check.sh` (run by `deno task check` and by CI) reads the pin for its
  version warning, and accepts the surrounding range set in its
  `DENO_VERSION_MIN`/`DENO_VERSION_MAX` variables.
- `Dockerfile.dashboard` and `Dockerfile.toolshed` repeat the version in their
  `FROM` lines, which cannot read another file.

To bump the toolchain: update the version in `mise.toml` and every
`denoland/deno` `FROM` line in the root deployment Dockerfiles, and move the
`tasks/check.sh` range if the new version falls outside it.

`deno task check-deno-pins` (also a CI step) catches a bump that misses one of
those. It checks that every `denoland/deno` tag in the root deployment
Dockerfiles equals the pin, that the `tasks/check.sh` range contains the pin,
that `check.sh` and the `deno-setup` action both still read `mise.toml` rather
than a hardcoded version, and that the action holds no version literal that
disagrees with the pin.

### GitHub Actions

Every step under `.github/` that names an action outside this repository
selects it by a 40-character commit, with the release as a trailing comment:

```
      uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

Both halves of that line defend against something. The commit defends against
the publisher: a tag is a name they can move, so a step naming one runs
whatever the name points at when the job starts, and several of these steps
share a job with a Google Cloud access token or a deploy key. The comment
defends against us: nobody checks a 40-character commit by eye, so a commit
that is not the release it claims to be would pass review on the strength of
the comment beside it.

`deno task check-action-pins`, a step in the `check` job, holds both. It asks
GitHub which commit the named release points at and fails when a step names no
commit, carries no release comment, or names a commit that release does not
point at.

The comment names the release itself, `# v4.2.0` and not `# v4`. A publisher
moves `v4` onto each release, so a comment naming one says only which major
version a commit belongs to, hides how far behind it is, and stops being true
without anybody touching the file. The check rejects such a comment and names
the release to write instead.

The check reaches api.github.com, which means a GitHub outage fails it. That
is the accepted cost of having one check that proves the thing rather than a
local record of a proof made earlier, which would need its own verification to
be worth anything. Set `GITHUB_TOKEN` in any context where the rate limit
matters; CI passes it from `secrets.GITHUB_TOKEN`.

To roll a pin, find the release to move to, resolve it to its commit, and
write both:

```bash
gh api repos/actions/checkout/releases/latest --jq '.tag_name'
gh api repos/actions/checkout/git/ref/tags/v7.0.1 --jq '.object.sha'
```

An annotated tag answers with the tag object rather than the commit; follow it
through with `gh api repos/OWNER/REPO/git/tags/SHA --jq '.object.sha'`.
Because the comments name releases, how far behind a pin is reads off the
line itself, and the releases page says what is newer.

Two actions are in use at two versions, which has to be decided when either is
rolled: `google-github-actions/auth` at v1.3.0 on the deploy path and v3.0.0
elsewhere, and `actions/cache` at v4.3.0 in four `deno.yml` steps and v6.1.0
everywhere else.

The `setup-deno` pin touches the Deno toolchain pin in one place.
`deno task check-deno-pins` rejects any version literal in
`.github/actions/deno-setup/action.yml` that disagrees with `mise.toml`, so
that pin's comment keeps its `v` prefix, `# v2.0.5` rather than `# 2.0.5`, and
the release is not read as a Deno version.

### TypeScript

The runtime compiles patterns itself, using the TypeScript compiler API at
runtime. Seven runtime and build packages (`js-compiler`, `ts-transformers`,
`schema-generator`, `runner`, `cli`, `static`, `deno-web-test`) import
`npm:typescript`. The `api` package imports it for the type-profiling harness,
`tasks` imports it for the coverage gate, which compiles a source file to find
out whether it holds any executable code, and `patterns` imports it for the
Topics browser-measurement helper, which parses authored and compiled sources
to find a lift's declaration. All ten workspace members pin the same version in
their `deno.jsonc` import maps. This npm dependency is separate from the
TypeScript that `deno check` uses: Deno bundles its own copy of the compiler.
Keeping the npm pin on the same minor version as the Deno-bundled compiler
(`deno --version` prints it) avoids the two disagreeing about what type-checks.

To roll the version, update the pins and the lockfile, then verify:

```bash
deno outdated --update --recursive typescript@<version>
deno task check
deno task test
(cd packages/static && deno task check-cfc-types)
deno run -A packages/api/perf/run-tsc.ts --version
```

The `check-cfc-types` command is a CI gate that `deno task test` does not cover;
see the note on `cfc.ts` below. The profiling command proves that its wrapper
resolves the same compiler pin rather than a stale path in `node_modules`.

#### Why the pin stops at 6.x

The `typescript` npm package now serves two different compilers. The 6.x line is
the original JavaScript implementation, developed in `microsoft/TypeScript`. The
7.x line is the Go rewrite, developed in `microsoft/typescript-go` and intended
to replace the JavaScript one rather than sit alongside it permanently; upstream
expects to merge that repository back into `microsoft/TypeScript` in time.

Only the 6.x line works here. The 7.x package ships platform binaries, and its
main entry point exports nothing but a version constant, so the in-process
compiler API that our packages are built on is absent. The replacement drives
the native binary from a separate process, and upstream currently marks that API
"not ready", meaning not yet worth building against. So this is not a port we
could choose to do early: until that API is ready there is nothing to port onto.
Treat 6.x as a holding position, and treat the Go compiler's API reaching a
usable state as the signal to re-evaluate.

The practical trap is that a bare `npm:typescript` specifier resolves to the
newest version on npm, which is now the Go line — hence the explicit 6.x pins.

#### The vendored type libraries

Pattern compilation runs outside Node and cannot read the compiler's type
libraries off disk, so it uses ambient libraries vendored in
`packages/static/assets/types`. The two have different provenance:
`es2023.d.ts` is flattened from the `lib` directory of a TypeScript source
checkout by `packages/static/scripts/compile-type-lib.ts`, while `dom.d.ts` is
a hand-maintained subset of the web APIs the runtime actually provides.

A compiler roll does not regenerate either one. They declare the API surface
patterns are allowed to use, which is a product decision rather than a
compiler-version one, and the compiler type-checks against whatever ambient
declarations it is handed. The `js-compiler` tests exercise the rolled compiler
against these files.

When that allowed API surface does change, check out the TypeScript source tree
beside the Labs checkout, then regenerate the flattened library from the static
package:

```bash
cd packages/static
deno task compile-types
```

The task expects the TypeScript checkout at the path encoded in
`packages/static/deno.jsonc`. The static package's
[withheld-globals documentation](../../packages/static/README.md#withheld-globals)
describes the sandbox-specific filtering applied to the generated file.

The third file in that directory, `cfc.ts`, is different: it comes out of the
compiler's declaration emit, via `packages/static/scripts/generate-cfc-types.ts`.
A roll can therefore change it, which is why `check-cfc-types` is part of the
sequence above. It reports whether the committed file still matches what the new
compiler emits. If it does not, run
`(cd packages/static && deno task gen-cfc-types)` and commit the result.

### esbuild

`packages/felt` is the only package that declares esbuild. Its import map holds
two entries that have to move in step: `npm:esbuild`, which felt calls directly,
and `jsr:@deno/esbuild-plugin`, which teaches esbuild to resolve and load
modules the way Deno does. The plugin is what lets felt bundle a source tree
full of `jsr:` and `npm:` specifiers.

Callers reach felt two ways, and the difference matters below. `packages/shell`
owns `packages/shell/felt.config.ts`, the only felt config file in the repo, and
it is the only caller that minifies. Everything else calls felt's exported
`build()` and passes its own esbuild options: `packages/deno-web-test`, which is
the browser test runner and forwards each package's `esbuildConfig`;
`scripts/bundle.ts`; and one shell integration test.

#### Why the pin stops at 0.25.x

esbuild is held at 0.25.x even though 0.28.1 has been released. The constraint
comes from the plugin rather than from esbuild.

`@deno/esbuild-plugin` declares `npm:esbuild@^0.25.5`. A caret range on a
version below 1.0 does not let the minor version move, so that range means
0.25.5 or newer, and older than 0.26.0. Felt declares the same range today. Both
resolve to one shared copy, and the lockfile holds a single esbuild.

Raising felt's range to 0.28.1 does not raise the plugin's. The two ranges then
have no version in common, so the lockfile carries 0.25.12 and 0.28.1 side by
side. The cost is more than a duplicated entry. esbuild ships its compiler as a
native binary, in a separate package for each platform, and Deno downloads the
binary for the platform it is running on. The graph then holds two esbuild
binaries of roughly ten megabytes each, and only one of them ever runs. CI
restores and saves the Deno dependency cache on every job, so the second binary
is weight carried in that cache rather than a download repeated per job. Every
fresh checkout fetches it once.

The second copy is never executed. The plugin's only mention of esbuild is a
type-only import, which the compiler erases, so nothing in the plugin loads the
esbuild that import names. Deno resolves and downloads that package anyway,
which is the only reason the duplicate exists.

That alone does not make the pairing safe, because the calls run the other way:
esbuild calls the plugin. The plugin implements esbuild's plugin API. It reads
the resolve and load arguments esbuild hands it, and returns paths and loader
names. What has to hold is that API rather than the version number, and none of
the three releases since 0.25 changed it. 0.26.0 changed nothing at all. 0.27.0
raised the operating system floors of the released binaries. 0.28.0 added an
integrity check to a fallback download path. Felt's builder tests exercise the
pairing.

Upstream is aware and has not acted.
[denoland/deno-esbuild-plugin#36](https://github.com/denoland/deno-esbuild-plugin/issues/36)
reports this exact duplicate, and no maintainer has replied. The plugin's
esbuild range has not changed once across its ten releases, while esbuild
shipped three new minor versions. A stale range costs the maintainers nothing,
because the import is type-only, so nothing forces them to notice it.

There are two ways around the plugin, and neither pays for itself. Felt could
drive `@deno/loader` directly, which is the loader the plugin wraps. The
plugin's value is absorbing that loader's API changes, and the loader is still
below 1.0 and moving, so felt would inherit that churn. Felt could instead
switch to `@luca/esbuild-deno-loader`, which sidesteps the duplicate by
vendoring its own copy of the esbuild type declarations rather than depending on
the npm package. That package resolves modules by its own reimplementation
rather than by the Rust crates Deno itself uses, and it has gone untouched about
a year longer than the plugin has. Either route would make felt the owner of how
modules are resolved during a build, inside the tool that builds the shell.

Treat 0.25.x as a holding position. The signal to re-evaluate is
`@deno/esbuild-plugin` widening its esbuild range, or dropping the dependency in
favor of vendored type declarations. Vendoring the declarations is the fix that
suits upstream, since the import is type-only, and `@luca/esbuild-deno-loader`
already does exactly that. If a future esbuild release carries something this
repo needs, the duplicate is worth accepting. The pairing is safe, and the price
is cache size.

#### Keep `using` lowering on while the pin stands

`packages/shell/felt.config.ts` sets `supported: { using: false }`, which asks
esbuild to lower `using` declarations into explicit disposal calls instead of
emitting them unchanged. The setting is there for output compatibility. On
0.25.x it also prevents a miscompilation, so it needs to stay until the pin
moves.

esbuild 0.25.12's minifier sometimes folds a `using` declaration into the next
use of the variable, and the disposal is lost. `packages/runner/src/traverse.ts`
has the shape that triggers it, in five places: it declares
`using t = ...tracker.include(...)` and reads `t` on the following line.
Disposal is what releases the entry from the cycle tracker, so losing it leaves
the entry behind. The consequence differs by call site. Where the code tests `t`
for null and reports a cycle, a later traversal of the same value and schema
would be read as a cycle that is not there. Where it falls back to the tracker's
existing entry, that entry would be a stale value.

Two things keep this off the table today. The fold happens only when minifying,
and the shell is the only caller that minifies. The shell also lowers `using`,
and the lowered form is not folded. esbuild fixed the underlying bug in 0.28.1.

### Tree-sitter

The CLI pins `web-tree-sitter` and `tree-sitter-python` exactly. `cf view`
colors and navigates Python through them, and a grammar package ships a
compiled parser whose binary interface has to match the runtime that loads it.
A range on either would let an install pair a parser with a runtime that
rejects it, which fails when a view opens a Python file rather than when the
dependency resolves. Roll the two together, and run the `cf view` Python tests
afterward.

`tree-sitter-python` is reached in two ways, both of which have to keep
working. `packages/cli/lib/view/languages/python/python.ts` imports its
`package.json`, which is what makes the package present, and resolves the
compiled grammar beside it with `import.meta.resolve`, which the adapter then
reads as a file. A source run resolves that through the Deno cache, and
`deno task build-binaries cf` embeds it in the binary with no step of its own.
Neither path is exercised by type checking, so a change to either is checked by
running `cf view` against a `.py` file.

Swift reaches its grammar the same way, through
`packages/cli/lib/view/languages/swift/swift.ts`, and the CLI pins
`@binclusive/tree-sitter-swift-wasm` exactly as well. The Swift grammar is
[`alex-pinkus/tree-sitter-swift`](https://github.com/alex-pinkus/tree-sitter-swift),
whose own npm package ships no compiled WebAssembly grammar; its WebAssembly
build is published only as an asset on each GitHub release. The pinned package
contains that release asset and nothing the pager uses besides it. Version
0.1.0 holds the 0.7.3 release's `tree-sitter-swift.wasm`, whose SHA-256 is
`0258a7ef17303a8079ffe0748b3583d59656b5c3e8653fca7b6451b3e6689eb2`, the digest
of the asset downloaded from the upstream release. Before rolling it, download
the new release's asset from the upstream repository and confirm that the
package's `wasm/tree-sitter-swift.wasm` has the same digest; the lockfile's
integrity hash then holds the package to those bytes. Run the `cf view` Swift
tests afterward, and `cf view` against a `.swift` file.

### Viz.js

The scripts workspace pins `@viz-js/viz` exactly. `scripts/docs-links.ts`
embeds the renderer's serialized SVG in its HTML output and records the renderer
version in that file. A renderer update can change the graph layout and the
generated bytes, so update the dependency pin and the recorded version together
and inspect the generated HTML before accepting a new release.

### Cliffy

The CLI uses four declarations that have to remain compatible:

- The root import map pins `@cliffy/command` at `1.0.0-rc.8`.
- `packages/cli/deno.jsonc` pins `@cliffy/flags` at the same release. It is
  `@cliffy/command`'s own option parser, read directly by the shuttle shell so
  that a shell verb's flags are spelled and refused as a command's are.
- That CLI config pins `@cliffy/table` at the same release.
- That CLI config pins `@std/fmt/colors` to the range used by Cliffy.

`@cliffy/command` and `@cliffy/table` share internal packages, and
`@cliffy/flags` is `@cliffy/command`'s own dependency, so all three resolve as
a set. A `@cliffy/flags` pinned here to anything but the release
`@cliffy/command` resolves puts two copies of the option parser in the
workspace: the one a `cf` command parses through, and the one the shell does.

They are held at the release candidate because Cliffy 1.2.1 changes how a
required argument followed by a variadic argument is parsed. With that release,
`cf piece call` stops receiving its first argument.

The `@std/fmt/colors` pin has a separate single-copy requirement.
`setColorEnabled()` stores state in its module instance. If the CLI imports a
different copy from Cliffy, disabling color does not affect Cliffy's version,
error, and usage output. `packages/cli/test/color-mode.test.ts` guards that
shared state.

When rolling Cliffy, update `@cliffy/command`, `@cliffy/flags` and
`@cliffy/table` together.
Inspect the new command package's `@std/fmt` dependency and update the CLI alias
to a compatible range that resolves to the same copy. Refresh the lockfile and
run the complete CLI test task:

```bash
(cd packages/cli && deno task test)
```

### SQLite

Eight workspace members pin `@db/sqlite` exactly: `memory`, `toolshed`,
`state-inspector`, `cf-harness`, `cli`, `piece`, `runner`, and `scripts`. They
must resolve one version. The `runner` pin serves one integration test — the
injected on-disk source
(`docs/specs/sqlite-builtin/03-database-sources.md` §03.3) is only exercisable
by seeding a real SQLite file, and the test proving `db.query` labels such a
read belongs with the builtin it covers. No `runner/src` file imports it, and
the runner's UNIT lane does not import `@db/sqlite`: its disk-source test
registers an empty temp file, whose contents never matter because the write it
asserts on is refused before any attach. The memory package also repeats that
version in `SQLITE3_RELEASE_VERSION` in
`packages/memory/v2/sqlite/column-origin.ts`.

The second pin is a native-library identity requirement, not bookkeeping.
`@db/sqlite` derives its libsqlite3 download URL from its package version, while
the column-origin binding derives the same URL from
`SQLITE3_RELEASE_VERSION`. Different versions name different files. Loading
both files creates two independent libsqlite3 images, and passing a prepared
statement between them can crash the process.

To roll SQLite, update all eight import maps and
`SQLITE3_RELEASE_VERSION` in one change, run `deno install`, and verify:

```bash
deno test -A packages/memory/test/v2-sqlite-column-origin.test.ts
deno task check
deno task test
```

The focused test checks that the code pin equals the version resolved in
`deno.lock`. The CI dependency-cache action reads the resolved version from the
lockfile, so it needs no separate version edit.

### `@types/node`

Nothing here imports `@types/node`, and no import map names it. It reaches the
dependency tree only because `protobufjs`, pulled in by the OpenTelemetry proto
exporters, depends on it with a `>=13.7.0` range. An open-ended range resolves
to the newest release each time the lockfile is regenerated, so this package's
version moves on its own rather than when someone decides to roll it.

Whether its globals reach a given package's type graph is not something
`deno info` will tell you. They arrive as a type-only injection rather than
through the module graph, and which packages they reach shifts with the rest of
the dependency tree and with the Deno version. At 26.1.1 under Deno 2.8.1 they
reach several package graphs, and `typeof fetch` there resolves to a type whose
`init` parameter is the union `global.RequestInit | RequestInit`. Fields such as
`signal` and `body` are not available on that union, so reading them stops type
checking. At 24.2.0 the same code checks clean, and so does 26.1.1 under Deno
2.8.3.

The practical trap is that `typeof fetch` is not a dependable way to name a
fetch-shaped value. Write the signature out instead. `HarnessFetch` in
`packages/cf-harness/src/contracts/http-fetch.ts` and `RuntimeFetch` in
`packages/runner/src/runtime.ts` are the package-level contracts. They hold
whichever version resolves and whichever compiler checks them.

Two things make this class of breakage easy to miss. `deno task check` does not
cover every package: `cf-harness` is type checked only by its own test task, so
its type errors surface in a test shard rather than the Check job. And CI pins
Deno 2.9.4 while `tasks/check.sh` accepts any 2.8.x or 2.9.x, so a local check
and CI can disagree about what type checks.

### Astral

Common Fabric uses the published `@astral/astral` package. The root import map
pins version 0.5.6. The repository does not carry a copy of Astral's source
(it previously did).

#### Local compatibility code

Common Fabric keeps its application-specific browser behavior at the integration
boundary:

| Behavior | Common Fabric owner | Published Astral surface |
| --- | --- | --- |
| Query open shadow roots with `strategy: "pierce"` | `packages/integration/astral-adapter.ts` | Raw page protocol bindings and the public `ElementHandle` constructor |
| Wait for a matching shadow element | `packages/integration/astral-adapter.ts` | Raw page protocol bindings |
| Observe clicks and typing for presentation recordings | `packages/integration/page.ts` | `ElementHandle`, page mouse, and page keyboard |
| Apply a default per-character typing delay | `packages/integration/page.ts` | Keyboard's per-call `delay` option |
| Treat an already-exited browser process as closed | `packages/integration/astral-adapter.ts` | Published browser lifecycle |
| Start and acknowledge screencast frames | `packages/integration/page.ts` | Raw page protocol bindings |
| Capture a Deno inspector CPU profile | `packages/cli/support/profiling/inspector-protocol-client.ts` | Chrome DevTools Protocol over the inspector WebSocket |

The pierce strategy searches the whole page: everything a native query matches
in the light DOM, plus every element inside an open shadow root at any depth. It
walks in document order and searches an element's shadow tree as soon as it
reaches that element. One traversal definition is serialized into each in-page
resolver, so an immediate query and a wait for the same selector settle on the
same elements. Immediate `$` and `$$` calls perform one query. A
`waitForSelector` call observes DOM, selector state, and shadow-root changes in
the page and resolves when a match appears. The event-driven wait has no
elapsed-time deadline. Protocol shadow-root notifications cover roots attached
through a cached or replaced `attachShadow` function. Common form-control state
setters trigger a selector check directly. Closing the page rejects pending
waits and skips protocol cleanup that can no longer complete.

The inspector profiler has its own small protocol client because Astral does
not publish its generated protocol client as a package export. The profiler
uses only the Console, Debugger, Profiler, and Runtime methods it needs.

#### Updating Astral

Update the version in the root `deno.jsonc`, refresh `deno.lock`, and run:

```sh
deno test -A packages/integration/test/astral-adapter.test.ts
deno test -A packages/cli/support/profiling/inspector-protocol-client.test.ts
deno test -A packages/cli/support/profiling/capture-deno-inspector-profile-lib.test.ts
deno fmt --check
deno lint
```

The focused integration test covers native, light-DOM, and shadow-root
selection, agreement between the immediate queries and the wait, dynamic
element and selector-state changes, shadow roots attached after a wait starts,
browser lifecycle compatibility, interaction callbacks, transformed element
coordinates, and the default typing delay.

#### Upstream history

[Astral pull request 166](https://github.com/lino-levan/astral/pull/166)
proposed shadow-root selector support on July 22, 2025. The maintainer asked for
an options-based API. The maintainer then approved the revised API, in which
the `strategy` option is either `native` or `pierce`. There was no formal
review or merge. The last discussion was July 31, 2025, and the pull request
remained open and mergeable on July 24, 2026.

The pull request's macOS check passed. Its Linux and Windows checks ended after
ten minutes in tests that depended on `example.com`. The proposed local test
server was split into
[Astral pull request 167](https://github.com/lino-levan/astral/pull/167),
which also remained open. Common Fabric does not depend on either pull request.

## Debugging dependency problems

Start with the declaration and the resolved graph:

- `deno outdated --recursive` shows the declared ranges and selected versions.
- `deno info <entrypoint>` shows the module graph for one entry point.
- `deno task check-unused-deps` reports declarations with no corresponding
  import.
- `deno task check-single-copy-deps` reports duplicate AI and OpenInference
  packages covered by the repository's central single-copy check. The
  dependency-specific sections above name checks for their other constraints.
- `deno install --frozen=true` reports when `deno.lock` no longer matches the
  import maps.

### SSL certificate failures

An environment with a missing or outdated certificate-authority bundle can fail
while Deno downloads npm packages:

```
error: Failed caching npm package: invalid peer certificate: UnknownIssuer
```

Install or update the operating system's certificate bundle:

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y ca-certificates

# Alpine Linux
apk add --no-cache ca-certificates

# Refresh the certificate store
sudo update-ca-certificates
```
