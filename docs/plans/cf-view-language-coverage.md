# `cf view` language and syntax coverage plan

Status: In progress.

Unknown named files and filename-free source without a recognized shebang use
plain text, while filename-free transformed compiler output keeps its
TypeScript default. Piped source can select a language directly or through a
virtual filename. Declarative metadata can now describe extensions, exact
names, compound patterns, explicit aliases, direct interpreter shebangs,
launcher shebangs that a subcommand settles, and extensions that several
syntaxes share. JSON Lines and NDJSON use the JSON tokenizer with independent
lexical state for each record. JSON also covers the surveyed names that no
`.json` suffix announces: web manifests, TLDraw documents, Deno lock files,
editor workspace files, Swift package resolutions, and the `.cfg` files whose
source opens a JSON object. Python has syntax highlighting and a structure tree
of its classes and functions. Swift has syntax highlighting and a structure
tree of its types, functions, initializers, and type-level properties, and its
package manifests select it through their `.swift` extension.

Automatic container detection is limited to structurally identified raw unified
diffs and standard Git commit output. Source evidence otherwise settles only an
extension that several syntaxes share. Each of those extensions is paired in
metadata with the evidence one language claims it on, and a view with no source
text leaves such a name unclaimed. Recognized shebangs and transformed compiler
headers remain explicit source selectors. Binary is a supported, read-only
language with raw-byte decoding and a hex-dump rendered view. Known binary
filenames, NUL-containing input, and invalid UTF-8 select it before text
decoding. Interactive binary views use a bounded preview, while redirected
output streams the complete dump. Text saves use the encoder paired with the
decoded source, including preservation of a UTF-8 byte order mark. Binary files
remain outside diff editing and semantic source loading.

Python and Swift run on Tree-sitter through a shared, language-neutral adapter,
which Go, shell, and HTML will use as well.
The order is provisional because recent activity was measured in six of the 26
active organization repositories.

This plan takes `cf view` from its current TypeScript and JavaScript, Markdown,
JSON, JSONC, JSON Lines, YAML, Python, Swift, and diff support to honest
handling of every textual syntax in the active
`commonfabric` repositories.

The frozen evidence is in the
[July 2026 coverage survey](../history/packages/cli/cf-view-language-coverage-2026-07.md).
Keep this plan current when support lands or newer repository evidence changes
the order. Do not update the historical survey.

## Status convention

- [ ] Not started
- [x] Complete and verified

Mark a parent complete only after its completion gate passes. When all stages
land or the plan is abandoned, archive this document under
`docs/history/plans/` as described in `docs/README.md`.

## Goal

Full active-repository coverage means:

- every surveyed textual syntax selects from its real filename, compound
  filename, explicit override, or shebang;
- direct files, diffs, and live edits preserve the input exactly;
- highlighting tolerates incomplete input;
- unknown text is plain text, not false TypeScript;
- binary input is recognized without being decoded as source;
- every supported selection and highlighting path has representative tests
  drawn from the surveyed repositories.

Syntax highlighting is required. Structure navigation should ship when the
chosen parser exposes stable ranges. Cross-file semantic lookup remains
limited to languages where a real project model makes it reliable.

## Ordering rubric

Apply these rules in order:

1. Complete shared selection and fallback work before adding language
   implementations that depend on it.
2. Extend a proven parser to cheap aliases and line-oriented variants before
   introducing a new grammar.
3. Rank new source languages by measured recent activity, active file count,
   repository breadth, and operational risk.
4. Discount generated and vendored concentrations when they dominate raw
   counts.
5. Keep host syntaxes and their embedded syntaxes close together so one phase
   can test delegation.
6. Prefer work that unlocks several later families, when the earlier evidence
   is otherwise close.

The leading evidence is:

| Family | Recent path changes | Active files | Active repositories | Ordering effect |
| --- | ---: | ---: | ---: | --- |
| Python | at least 14,481 | at least 2,017 | 9 | First new programming language |
| Go | 2,129 | 2,568 | 6 | Second new programming language |
| Shell | at least 1,929 | at least 269 | 14 | Third; breadth and operational use outweigh the lower extension count |
| HTML and CSS or SCSS | 3,216 | 1,382 | 12 for HTML, 6 for CSS | After shell because generated Specs and Loom files inflate activity |
| Lean | 1,280 | 310 | 1 | After broadly shared web formats |
| Starlark and Bazel | 259 | 537 | 1 | Large static population, concentrated in gVisor |
| OpenTofu and HCL | 105 | 96 | 1 | Modest volume, but operationally sensitive in Infra |

The counted Python, Go, and shell filename forms account for 74 percent of the
activity that the audit found outside currently recognized extensions. They
would raise coverage of the measured activity from 66 percent to 91 percent.
Shebang recognition would add extensionless programs to that gain.

Before starting each numbered language group, refresh its active file count
and recent activity. Reorder later groups when the new evidence changes their
relative value. Record the reason in this plan.

## Stage 0: honest selection and implementation foundation

- [x] Add a plain-text language and select it for unknown named files.
- [x] Preserve the intentional TypeScript default only for transformed
  compiler output that has no filename.
- [x] Add `--language` and `--filename` overrides for piped input.
- [x] Represent extensions, exact filenames, compound filename patterns,
  aliases, and shebang interpreters as language metadata.
- [x] Keep content detection only for unambiguous containers such as unified
  diffs, and for the evidence a shared extension pairs with one language.
- [x] Detect known binary files and NUL-containing input before source
  decoding.
- [x] Build a fixture corpus with direct-file, diff, incomplete-edit, and
  selection cases from the survey.
- [x] Run a parser-adapter spike on Python, Go, shell, and HTML. The
  [August 2026 report](../history/packages/cli/cf-view-parser-adapter-spike-2026-08.md)
  records the measurements and leaves the decision to the next item.
- [x] Record the parser decision before the remaining Stage 2 work.
- [x] Before the first Tree-sitter-backed implementation, measure the lazy
  selected-language path and record accepted maximums for 95th-percentile
  initialization, full highlighting, and incremental editing; shipped parser
  bytes; downloaded or unpacked dependency bytes; owned non-generated adapter
  and workaround source lines; and parser-specific build and deployment steps.
  The
  [August 2026 operating-envelope report](../history/packages/cli/cf-view-tree-sitter-operating-envelope-2026-08.md)
  records the measurements and raw samples.

### Parser operating maximums

The common adapter and every parser-backed language must stay within these
limits on a comparable arm64 macOS machine. Timing uses a 100-kilobyte source
and a warm dependency cache. Initialization starts at the first statement in a
fresh Deno process and includes dynamic imports, runtime initialization, the
selected grammar and query, and one empty highlight.

| Dimension | Shipped Python | Shipped Swift | Accepted maximum |
| --- | ---: | ---: | ---: |
| 95th-percentile lazy initialization | 29.41 ms | 71.98 ms | 75 ms |
| 95th-percentile full highlighting | 27.89 ms | 37.69 ms | 50 ms |
| 95th-percentile document parse, with structure | 35.56 ms | 39.08 ms | 50 ms |
| 95th-percentile re-color after one edit | 15.07 ms | 15.36 ms | 25 ms |
| Compiled `cf` increase | 12.03 MiB | 3.72 MiB | 14 MiB for runtime and first grammar; 10 MiB for a later grammar |
| Unpacked dependencies | 11.95 MiB | 3.66 MiB | 14 MiB for runtime and first grammar; 10 MiB for a later grammar |
| Owned source | 584 lines | 200 lines | 650 shipped lines; 200 for a later grammar |
| Parser-specific build and deployment steps | 0 | 0 | 0 |

The Python column is the
[September 2026 Python measurement](../history/packages/cli/cf-view-python-treesitter-2026-09.md),
which drives the real language object. Three rows changed when that
measurement replaced the probe's. Document parsing is a row because it is what
opening a file runs, and the probe had not measured it. Re-coloring after an
edit replaces a row that read "incremental edit and changed-line highlight",
for the reason under "An edit re-colors the whole document" below. The
owned-source maximum was raised, for the reason under "Owned source over its
maximum".

The Swift column is the
[September 2026 Swift measurement](../history/packages/cli/cf-view-swift-treesitter-2026-09.md),
made the same way. Its byte and source figures are what Swift adds, and they
are held to the later-grammar maximums in the next paragraph. A view loads only
the grammars of the languages it shows, so only a view showing Swift pays
Swift's initialization.

Each later host grammar may add at most 10 MiB to both byte measures and 200
owned source lines. The common runtime and the Python, Go, Bash, and HTML host
grammars together may occupy at most 40 MiB and 1,000 owned source lines. Tests,
fixtures, and generated code do not count toward the source limit. The separate
nested-HTML measurement sets the limits for its CSS and JavaScript grammars
before Stage 5.

### Parser decision

Use `web-tree-sitter` 0.26.12, with pinned official Tree-sitter grammar
packages, for parser-backed Python, Go, shell, and HTML implementations. Put
parser initialization, gapless range normalization, incomplete-input recovery,
edits to a warm tree, and structure extraction behind one adapter that accepts
language-specific highlight-capture and structure mappings. Treat Tree-sitter
as the default for later source languages only after checking their grammar
coverage and integration cost.

The language selection and parsing interfaces are synchronous, while
Tree-sitter initialization and grammar loading are asynchronous, so a language
declares what it has to load and a view loads the grammars of the languages it
selected before parsing anything. No other grammar is loaded. When the
interactive pager opens a file in a language whose grammar has not loaded, as
the file picker can, the synchronous entry point shows the source as plain text
and starts the load, and the pager parses the document again once the grammar
loads. A grammar that cannot load leaves the source plain, and the pager shows
the reason in its status line. A redirected view, which loads its grammars
before it parses, fails with the reason instead.

The measured four-grammar setup initialized in 37.2 milliseconds and highlighted
about 100 kilobytes in 14.03 to 28.29 milliseconds at the 95th percentile. Its
incremental parses took 0.13 to 1.60 milliseconds at the 95th percentile. Those
costs leave enough room for an interactive view. Tree-sitter also preserved
complete, incomplete, edited, and diff source exactly. The measured mappings
exposed Python classes and functions; Go types, functions, and methods; shell
functions; and HTML elements and style and script host ranges. Each language
stage must extend and test that mapping for structures the spike did not cover,
including decorated Python definitions and Go packages.

Tree-sitter's official grammars cover Python, Go, Bash, and HTML. The Bash
grammar accepted the complete generated Bash fixture and classified its heredoc
body. The separately maintained Lezer Bash grammar marked that fixture as
containing an error and left the heredoc body unclassified. Lezer's smaller
runtime and built-in HTML nesting do not outweigh using two parser families or
accepting weaker shell coverage. Focused scanners remain suitable for simple
data formats, but the Python scanner's 862 lines when this was written — 863
by the time it was removed — and the YAML scanner's 970 lines make one custom
scanner per measured source language the larger maintenance surface. They also
require a second implementation for structure.

Depend on the complete npm packages rather than checking selected WebAssembly
artifacts into the repository. The measured packages occupy 35.66 MiB when
unpacked, while the JavaScript and WebAssembly files used at runtime occupy 2.30
MiB. Keeping the packages intact leaves grammar builds, licenses, and release
synchronization with their publishers. The adapter must pin the observed
JavaScript string-offset behavior with non-ASCII contract tests. HTML embedding
must dispatch the grammar's injection ranges to the official Tree-sitter CSS and
JavaScript grammars rather than treating the host grammar as if it parsed those
regions. The Tree-sitter startup and dependency-size measurements exclude those
two embedded grammars. The startup measurement does not describe the nested
setup, while the dependency-size measurements are lower bounds for the
cumulative parser packages. Measure and record the complete nested-HTML setup
before implementing Stage 5.

Do not add another focused scanner for Python, Go, shell, or HTML.

#### An edit re-colors the whole document

The probe measured, and this plan recorded a 5-millisecond maximum for,
re-running the highlight query over the lines `Tree.getChangedRanges` reports
after an edit. That operation does not produce the colors a complete highlight
would, so the shipped implementation does not perform it.

The report says where the tree's shape differs. A highlight query reads the
shape around a node to classify it, so a node that keeps its own type while its
parent changes is classified differently and is not in the report. Inserting
one line break turned `Sto` `re()` into a call and changed how `re` is
classified, with no range reported. Sweeping every single-character insertion
and deletion at every offset of a 15-line Python sample found 47 edits where
lines drawn from the report disagreed with a complete highlight.

An update therefore edits the warm tree, re-parses from it, and colors the whole
document from that parse. The incremental parse stays, because it is under a
millisecond of the cost where a fresh parse is 11; the query over the whole
document is the rest. The dimension is now the per-keystroke re-color, and its
maximum is 25 milliseconds — above the 15.07 measured, and below the
50-millisecond complete highlight this operation is a part of.

Reopening the parser decision on this dimension alone would favor a focused
scanner: the 863-line Python scanner re-colored the same source in 7.26
milliseconds at the 95th percentile against 17.44 for the adapter, both
measured in one paired run. It produced no structure, which is what this stage
was for, so the decision stands.

#### Owned source over its maximum

Python's implementation measures 584 physical lines of owned source. The
maximum was 500 when it was measured, and an overrun starts a measured
comparison with a focused implementation under "Reconsidering the dependency".
That comparison ran, it keeps the decision, and the maximum in the table above
is the one it settled on.

The maximum came from a 131-line probe that loaded a grammar, ran a query, and
split the result into lines. A shipped adapter also reports which grammar is
missing, converts between the two offset conventions Tree-sitter uses, gives
each bracket its nesting depth, leaves the space between tokens uncolored,
derives an edit from two versions of a text, and colors a document from the
parse that edit produced. The overrun is in that work rather than in
Tree-sitter.

Compare the marginal costs a switch would remove, which is the Python-specific
part: 127 lines of highlight query and structure rule, against the 863-line
focused Python scanner they replaced. The scanner covered highlighting alone,
so the focused implementation would be larger and cover less. The remaining 457
lines are the adapter that Go, shell, and HTML use as well.

Raise the first-language maximum to 650 lines and leave every other maximum
where it is. The 1,000-line cumulative maximum is what binds the three
languages after Python: 584 lines are spent, so 416 remain, about 139 each. The
200 lines a later host language may add is a ceiling on any one of them rather
than an allowance all three can take, and the first to reach the cumulative
maximum starts its own comparison.

#### Reconsidering the dependency

Reopen the parser decision for a language when any of these conditions becomes
true:

- the shared fixture contract or stage-specific tests cannot pass without a
  grammar fork or local grammar patch;
- measured initialization, full highlighting, incremental editing, shipped
  bytes, downloaded or unpacked dependency bytes, owned adapter or workaround
  source lines, or build and deployment work exceeds a recorded maximum;
- the runtime or grammar is archived, or has no release compatible with the
  supported Deno version or with a required security fix; or
- an unresolved license or security problem prevents shipping the dependency.

A trigger starts a new measured comparison; it does not select the replacement.
Before switching, require the focused implementation to pass the shared fixture
contract and every stage-specific selection, highlighting, structure, and
embedded-language test. If the dependency cannot ship or cannot meet those
contracts, switch when the focused implementation passes them and remains within
the recorded operating maximums.

Otherwise compare these dimensions separately: owned non-generated parser,
adapter, and workaround source lines; local patches or forks; 95th-percentile
initialization, full-highlight, and incremental-edit latency; shipped runtime
bytes; downloaded or unpacked dependency bytes; and parser-specific build and
deployment steps. Compare only the marginal costs that the proposed switch would
remove. Count language-specific grammar bytes, capture and structure mappings,
workarounds, and selected-language latency as marginal costs. Treat the common
adapter core, runtime package bytes, and shared deployment steps as unchanged
while another language still uses them; count them as removable only when the
switch removes their final consumer. Switch automatically only when the focused
implementation is no worse in every dimension and strictly better in at least
one. When the dimensions trade off, record a new parser decision with the
individual measurements and priorities instead of combining unlike units into a
single cost score. Carrying a grammar fork is sufficient to start the comparison
because it takes on grammar maintenance while retaining the external runtime and
integration costs.

The parser spike must compare available Deno-compatible parsers with focused
scanners. Measure startup cost, dependency size, exact source preservation,
behavior on incomplete edits, state across lines, diff integration, and
maintenance cost. The YAML scanner's size demonstrates that repeated custom
implementations may be expensive. It does not settle the parser choice by
itself.

Completion gate: unknown text and binary input are no longer presented as
TypeScript. Exact names, compound names, shebangs, and explicit overrides use
one tested selection path. The parser decision and operating maximums are
recorded with measurements.

## Stage 1: JSON aliases and line-oriented JSON

The August 18, 2026 refresh found 43 `.jsonl` and `.ndjson` files across seven
of the 26 active organization repositories. The six-repository history sample
contains 40 path-change events on current JSON Lines paths since February 18,
2026. This activity and the existing tokenizer reuse keep Stage 1 ahead of new
grammar work.

A September 2, 2026 check read the JSON-shaped special cases in the local
`labs`, `loom`, `gvisor`, `common-cluster`, `infra`, and `specs` checkouts. All
three surveyed web manifests are there, one in Labs and two in Loom, along with
the Labs TLDraw document, the Labs and Loom Deno lock files, and the gVisor
syzkaller `.cfg`. Each of those files opens a JSON object. The check also read
the two syntaxes that `.cfg` has to be told apart from. TLC configuration in
Labs and Common Cluster opens with a `\*` comment or a directive, and the
Ansible configuration in Infra opens with a `[defaults]` section header. An
opening brace is therefore the evidence for claiming a `.cfg` file as JSON, and
an opening bracket is not. These six checkouts hold neither the surveyed editor
workspace file nor the surveyed Swift package resolution, so those two names
rest on the survey alone. The check confirms the recorded forms in the
repositories it covers; it does not refresh any count.

- [x] Reuse the JSON tokenizer for `.jsonl` and `.ndjson`.
- [x] Isolate malformed lines so one line cannot affect the next.
- [x] Recognize `.webmanifest`, `.tldr`, Deno lock files, JSON-shaped `.cfg`
  files, VS Code workspace files, and Swift `Package.resolved`.
- [ ] Add Jupyter notebook container recognition for `.ipynb`.
- [ ] Leave notebook cell-language delegation for the matching language phase.

Completion gate: every JSON-shaped active-tree special case and recent-history
notebook selects JSON or line-oriented JSON without broad suffix guesses.

## Stage 2: Python

- [x] Highlight `.py`, `.pyi`, and `.pyw` files.
- [x] Recognize extensionless programs from direct Python shebangs.
- [x] Recognize extensionless programs from `uv run` shebangs.
- [x] Add class, function, async function, and decorated-definition structure.
- [x] Add representative Loom, Specs, Legibility, Raia, and gVisor fixtures.

Completion gate: direct files, diffs, and incomplete edits pass the shared
fixture contract without altering source text. The gate passes: one fixture
from each of the five repositories runs the contract, and a corpus language may
now carry more than one.

## Stage 3: Go and Go manifests

- [ ] Highlight `.go`.
- [ ] Add package, type, function, and method structure.
- [ ] Recognize `go.mod` and `go.sum` as separate data syntaxes.
- [ ] Add Common Cluster, Bay, Run Orchestrator, Raia, and gVisor fixtures.

Completion gate: Go source and both manifest formats select correctly in
direct and diff views.

## Stage 4: shell

- [ ] Cover Bash and POSIX shell with dialect selection from the shebang.
- [ ] Recognize `.sh`, `.command`, Git hooks, entrypoint scripts, and
  extensionless executables with shell shebangs.
- [ ] Highlight heredocs without guessing an embedded language unless the
  delimiter names it reliably.
- [ ] Add Infra and Loom fixtures that exercise operational scripts.

Completion gate: every surveyed shell selection form works in direct files,
diffs, and incomplete edits.

## Stage 5: web markup, styling, and XML

- [ ] Add HTML, CSS, and SCSS.
- [ ] Delegate HTML `style` and `script` regions to CSS and JavaScript.
- [ ] Add strict XML separately from permissive HTML.
- [ ] Route SVG, Apple property lists, and entitlement files through XML.
- [ ] Evaluate the HTML and CSS parsers already pinned by the UI package
  before adding a dependency.

Completion gate: host and embedded syntax ranges preserve the complete input,
including malformed and partially edited markup.

## Stage 6: Lean

- [ ] Highlight `.lean`.
- [ ] Recognize `lean-toolchain`.
- [ ] Add structure for namespaces, sections, declarations, definitions,
  theorems, and inductive types.

Completion gate: representative Specs source and diffs pass the shared fixture
contract.

## Stage 7: Starlark and Bazel

- [ ] Use one Starlark implementation for `BUILD`, `BUILD.bazel`,
  `MODULE.bazel`, workspace files, and `.bzl`.
- [ ] Add small selectors for `.bazelrc`, `.bazelignore`, and
  `.bazelversion`.
- [ ] Add representative gVisor build fixtures.

Completion gate: all 537 surveyed Starlark and Bazel files have an honest
selection path.

## Stage 8: OpenTofu, HCL, and infrastructure templates

- [ ] Add `.tf` and `.tfvars` HCL.
- [ ] Layer Terraform interpolation over the shell host in `.tftpl`.
- [ ] Layer Jinja delimiters over a separately selected host syntax.
- [ ] Cover the surveyed shell, systemd-unit, authorized-keys, and YAML Jinja
  hosts.

Completion gate: an extension such as `.j2` does not force one host language,
and every current Infra template has an explicit tested selection rule.

## Stage 9: build and operational configuration

- [ ] Add Dockerfile, including every `Dockerfile.*` variant.
- [ ] Add Makefile and `.mk`.
- [ ] Add Git, Docker, Deno, and Bazel ignore files.
- [ ] Add Git attributes, modules, hooks, and worktree-include syntax.
- [ ] Add dotenv files and compound examples.
- [ ] Add INI, Ansible configuration, and inventory files.
- [ ] Add systemd units, tmpfiles configuration, and surveyed directive
  configuration.

Completion gate: every surveyed exact-name and compound-name operational file
selects without content guessing.

## Stage 10: Swift, Rust, TOML, and native manifests

Swift is implemented ahead of Stages 3 to 9. A September 22, 2026 refresh read
the Swift in local checkouts of Fabric Mobile (19 files), gVisor (10), Loom
(12), Loom Scripts (1), and the `commonfabric-weaver` repository (1,150), which
the July survey predates. The six months before the refresh hold 6,646
path-change events on Swift paths in `commonfabric-weaver` alone, more than the
survey's history sample recorded for any family except Python. Rust, TOML, and
Cargo keep their place.

- [x] Add Swift source.
- [ ] Add Rust source.
- [ ] Add TOML.
- [ ] Recognize Cargo manifests and lock files.
- [x] Recognize Swift package manifests and package-resolution JSON.
- [ ] Delegate embedded notebook cells when their language metadata names one
  of the implemented languages.

Swift runs on the Tree-sitter adapter with the
[`alex-pinkus/tree-sitter-swift`](https://github.com/alex-pinkus/tree-sitter-swift)
grammar, which is not an official Tree-sitter grammar. Its own npm package
ships no WebAssembly grammar, so the CLI depends on a package holding the
upstream release's WebAssembly build, whose digest matches the release asset;
`docs/development/DEPENDENCIES.md` gives the procedure for rolling it. A
coverage check over 1,039 Swift files from those five repositories found every
file reconstructed exactly and 0.071 percent of non-whitespace characters
without a token class. The grammar could not parse part of 112 of those files,
all in `commonfabric-weaver`, and continues coloring inside those regions.

The Swift grammar is about eight times the size of Python's, and compiling a
highlight query costs it several milliseconds for each pattern that constrains
a node's parent. The Swift query therefore matches a declared name or a callee
by the token beside it, which keeps its initialization inside the maximum. The
[September 2026 Swift measurement](../history/packages/cli/cf-view-swift-treesitter-2026-09.md)
records the costs pattern by pattern.

Structure covers classes, structures, enumerations, actors, extensions,
protocols, type aliases, functions, methods, protocol method and property
requirements, initializers, deinitializers, subscripts, and each property
declaration on a type or at file level, under the first name it binds. Local
variables are not structure. `.swift` selects Swift, which covers
`Package.swift` and a manifest for one compiler version such as
`Package@swift-5.9.swift`, and so does a module's textual `.swiftinterface`.
`swift` and `xcrun swift` shebangs select it for an extensionless script.
Fixtures come from Fabric Mobile, gVisor, Loom, and Loom Scripts.

Completion gate: Fabric Mobile and surveyed gVisor native-language files have
complete source and manifest selection.

## Stage 11: TLA+ and TLC configuration

- [ ] Highlight `.tla`.
- [ ] Highlight TLC `.cfg`.
- [ ] Distinguish TLC configuration from JSON and INI `.cfg` files by filename
  and content evidence.

Completion gate: all Labs and Common Cluster formal files select correctly,
without claiming the unrelated gVisor and Infra configurations.

## Stage 12: systems-language group

- [ ] Add C, C++, headers, and CUDA.
- [ ] Add assembly and linker scripts.
- [ ] Add Protocol Buffers and protobuf text format.
- [ ] Add Packetdrill.
- [ ] Use a neutral C-family mode for ambiguous headers until project context
  establishes the dialect.

Completion gate: every systems-language family in the active gVisor branch
passes direct-file and diff fixtures.

## Stage 13: remaining active text formats

- [ ] Add Ruby, Rack, ERB, Gemfiles, and Bundler lock files.
- [ ] Add TeX and BibTeX.
- [ ] Add Org mode.
- [ ] Add SQL.
- [ ] Add CSV, TSV, numeric `.dat` tables, and structured JSON log records.
- [ ] Add Graphviz DOT.
- [ ] Add Handlebars and generic `.in` templates.
- [ ] Classify application-specific configuration when it has stable syntax.
- [ ] Keep prose, logs, checksums, versions, PID files, and opaque task records
  as plain text.

Completion gate: every textual syntax in the survey's 24 active repositories
has a tested selector and highlighter or an explicit plain-text classification.
