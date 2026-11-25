# `cf view` language and syntax coverage plan

Status: In progress.

Unknown named files and filename-free source use plain text unless a recognized
shebang or an XML declaration opens the source, while filename-free transformed
compiler output keeps its TypeScript default. Piped source can select a language
directly or through a virtual filename. Declarative metadata can now describe
extensions, exact names, compound patterns, explicit aliases, direct interpreter
shebangs, launcher shebangs that a subcommand settles, and extensions that
several syntaxes share. JSON Lines and NDJSON use the JSON tokenizer with
independent lexical state for each record. JSON also covers the surveyed names
that no `.json` suffix announces: web manifests, TLDraw documents, Deno lock
files, editor workspace files, Swift package resolutions, and the `.cfg` files
whose source opens a JSON object. Python has syntax highlighting and a structure
tree of its classes and functions. Go has syntax highlighting and a structure
tree of its package clause, types, functions, methods, package-level names, and
the fields and methods each type declares; `go.mod` and `go.work`, and `go.sum`
and `go.work.sum`, are two data syntaxes of their own. Swift has syntax
highlighting and a structure tree of its types, functions, initializers, and
type-level properties, and its package manifests select it through their
`.swift` extension. Kotlin, which
covers Gradle's Kotlin build scripts, has syntax highlighting and a structure
tree of its types, objects, functions, constructors, and type-level properties.
Rust has syntax highlighting and a structure tree of its items and members.
Shell, which covers Bash and POSIX shell, has syntax highlighting and a
structure tree of its functions; `sh`, `bash`, `dash`, and `ash` shebangs select
it for Git hooks and other extensionless programs viewed directly, and a
heredoc's body is a string with the expansions its delimiter allows. Makefiles
have syntax highlighting, with recipes and the other commands make passes to the
shell colored by the shell grammar, and a structure tree of targets and
variables. Dockerfiles have syntax highlighting, with the shell form of their
commands colored by the shell grammar, and a structure tree of build stages and
the variables they set.
TOML, which covers Gradle version catalogs and Cargo manifests and
lock files, has syntax highlighting and a structure tree of tables and keys. HCL,
which covers OpenTofu and Terraform configuration, variable definitions files,
backend configuration files, and dependency lock files, has syntax highlighting
and a structure tree of blocks and of the attributes that define values, which
are those at a file's top level and in `locals` blocks; a string's
interpolations and template directives are code inside the string. C, C++, and
CUDA have syntax highlighting and a structure tree of functions, declarations,
named types, type aliases, and macros, and of C++'s namespaces and classes. A
`.h` header, which C and C++ both write, uses a mode that claims neither dialect
and parses with the C++ grammar until an explicit language names one. Starlark,
which covers Bazel's build, module, workspace, and extension files, has syntax
highlighting and a structure tree of functions, assigned names, and build
targets, and Bazel rc files have syntax highlighting and a structure tree of
imports and configurations. Java properties files, ProGuard and R8 keep rules,
and XML, which covers Android manifests and resources, SVG, and Apple property
lists, have syntax highlighting; properties files list their keys, and XML lists
its elements.
INI, which covers Ansible configuration and inventories and the configuration
files of Python tools, has syntax highlighting and a structure tree of sections
and the keys and hosts in each. Dotenv, which covers environment files and the
example copies of them that projects commit, has syntax highlighting and a
structure tree of the variables each file sets. Org mode has syntax highlighting, with each
source block colored as the language it names, and a structure tree of
headlines. Git attributes files have syntax highlighting and a structure tree of
their patterns and macro definitions. Git configuration files, which cover
`.gitmodules`, have syntax highlighting and a structure tree of sections and the
variables in each. Lean has syntax highlighting and a structure tree of
namespaces, sections, and declarations, and a project's `lean-toolchain` file
has highlighting of its own.
Directive configuration, which covers nginx, Apache httpd, nftables, Netdata
health alerts, and sysusers.d, has syntax highlighting and a structure tree of
blocks, sections, and alert entries. Logs, checksums, version files, PID files,
keys, and short prose files are plain text by name. Git, Docker, and Bazel
ignore files have syntax highlighting that follows each tool's comments,
negation, wildcards, and white space.
Graphviz DOT has syntax highlighting and a structure tree of graphs, subgraphs,
and the nodes that node statements declare. Comma-separated and tab-separated
values and numeric `.dat` tables have syntax highlighting.
Assembly, which covers the Go assembler's source and GNU assembler source that
the C preprocessor reads first, has syntax highlighting and a structure tree of
functions, symbols, macros, and labels.

Automatic container detection is limited to structurally identified raw unified
diffs and standard Git commit output. Source evidence otherwise settles only an
extension that several syntaxes share. Each of those extensions is paired in
metadata with the evidence one language claims it on, and a view with no source
text leaves such a name unclaimed. Recognized shebangs, XML declarations, and
transformed compiler headers remain explicit source selectors. A diff selects
the language of each side of each file once, and every view of that side uses
it. A path no language claims defers to that side's content: a hunk that begins
at its first line, and then its complete file in the workspace or in Git. A side
with no such evidence takes the other side's language. Binary is a supported,
read-only language with raw-byte decoding and a hex-dump rendered view. Known
binary filenames, NUL-containing input, and invalid UTF-8 select it before text
decoding. Interactive binary views use a bounded preview, while redirected
output streams the complete dump. Text saves use the encoder paired with the
decoded source, including preservation of a UTF-8 byte order mark. Binary files
remain outside diff editing and semantic source loading.

Python, Go, Swift, Kotlin, Rust, TOML, HCL, shell, C, C++, and Starlark run on
Tree-sitter through a shared, language-neutral adapter, which HTML will use as
well. Java properties, INI, dotenv, ProGuard rules, Git attributes, Git
configuration files, XML, makefiles, Org mode, Lean, ignore files, Go's module
and checksum files, Bazel rc files, Graphviz DOT, Dockerfiles, delimited tables,
and assembly use focused scanners. The order is provisional because recent
activity was measured in six of the 26 active organization repositories.

This plan takes `cf view` from its current TypeScript and JavaScript, Markdown,
JSON, JSONC, JSON Lines, YAML, Python, Go, Go module file, Go checksum file,
Swift, Kotlin, Rust, TOML, HCL, Starlark, Bazel rc, Lean, shell, C, C++, CUDA,
makefile, Dockerfile, Java properties, INI, dotenv, ProGuard, Git attributes,
Git configuration, XML, Org mode, directive configuration, ignore-file, Graphviz
DOT, CSV, TSV, `.dat` table, assembly, and diff support to honest handling of
every textual syntax in the active `commonfabric` repositories.

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

| Dimension | Shipped Python | Shipped Swift | Shipped Kotlin | Shipped TOML | Shipped shell | Shipped HCL | Shipped Rust | Shipped C++ / C | Shipped Go | Shipped Starlark | Accepted maximum |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 95th-percentile lazy initialization | 29.41 ms | 71.98 ms | 65.31 ms | 23.42 ms | 56.6 ms, estimated | 26.1 ms, estimated | 59.3 ms, estimated | 84.7 / 39.3 ms, estimated | 41.4 ms, estimated | 50.8 ms, estimated | 75 ms |
| 95th-percentile full highlighting | 27.89 ms | 37.69 ms | 44.66 ms | 19.79 ms | 32.7 ms, estimated | 47.0 ms, estimated | 38.4 ms, estimated | 35.3 / 34.2 ms, estimated | 30.4 ms, estimated | 29.5 ms, estimated | 50 ms |
| 95th-percentile document parse, with structure | 35.56 ms | 39.08 ms | 54.36 ms | 29.61 ms | 39.7 ms, estimated | 47.5 ms, estimated | 48.7 ms, estimated | 38.5 / 34.3 ms, estimated | 31.9 ms, estimated | 31.1 ms, estimated | 50 ms |
| 95th-percentile re-color after one edit | 15.07 ms | 15.36 ms | 32.76 ms | 11.96 ms | 23.9 ms, estimated | 21.4 ms, estimated | 23.4 to 29.5 ms, estimated | 22.5 / 19.8 ms, estimated | 21.5 ms, estimated | 16.8 ms, estimated | 25 ms |
| Compiled `cf` increase | 12.03 MiB | 3.72 MiB | 4.09 MiB, with TOML | with Kotlin | 1.32 MiB | 0.19 MiB | 1.07 MiB | 4.03 MiB, both | 0.38 MiB | 0.13 MiB | 14 MiB for runtime and first grammar; 10 MiB for a later grammar |
| Unpacked dependencies | 11.95 MiB | 3.66 MiB | 3.30 MiB | 0.72 MiB | 19.34 MiB | 1.91 MiB | 14.35 MiB | 48.98 MiB, both | 3.66 MiB | 0 MiB | 14 MiB for runtime and first grammar; 10 MiB for a later grammar |
| Owned source | 584 lines | 200 lines | 200 lines | 75 lines | 91 lines | 146 lines | 200 lines | 532 lines, both | 197 lines | 91 lines | 650 shipped lines; 200 for a later grammar |
| Parser-specific build and deployment steps | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

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

The Kotlin and TOML columns are the
[September 2026 Android formats measurement](../history/packages/cli/cf-view-android-formats-2026-09.md),
made the same way in two rounds on a shared machine, each beside a Swift run
that stayed close to Swift's recorded figures. Each timing is the higher of the
two rounds' 95th percentiles. Kotlin is over two maximums, for the reason under
"Kotlin over its re-color maximum".

The shell column is the
[September 2026 shell measurement](../history/packages/cli/cf-view-shell-2026-09.md).
It ran on a machine so loaded that a TOML control run beside each round was 1.2
to 2.2 times TOML's recorded figures, so its timings are estimates: TOML's
recorded 95th percentiles multiplied by the largest ratio of shell to TOML seen
in any round. The report gives the figures measured directly, which exceed the
document-parse and re-color maximums in some rounds. Shell is over the unpacked
dependency maximum, for the reason under "Shell over its unpacked-dependency
maximum".

The HCL column is the
[October 2026 HCL measurement](../history/packages/cli/cf-view-hcl-2026-10.md),
made the same way in eight rounds, each between two TOML control runs, on a
loaded machine. Its timings are estimates in the way the shell column's are:
TOML's recorded 95th percentiles multiplied by the largest ratio of HCL to TOML
seen in the six rounds whose controls stayed within 1.22 times TOML's recorded
medians. The report gives the figures measured directly, which exceed the
complete-highlight and document-parse maximums in some rounds. The HCL grammar names the node types a
structure entry can be found inside, which keeps the structure walk out of
expressions; without that, its document parse was over the maximum.

The Rust column is the [November 2026 Rust
measurement](../history/packages/cli/cf-view-rust-2026-11.md). It was made in
three runs on a machine more loaded than for the shell and HCL measurements.
Each run took each Rust sample beside a TOML and an HCL sample, and recorded
processor time beside wall-clock time. Its timings are a control's recorded
figures multiplied by the largest ratio of Rust to that control seen in any run.
Initialization, the complete highlight, and the document parse are inside their
maximums scaled against either control, and for them the column gives the
HCL-scaled figures; for the re-color it gives the range of every estimate. The
re-color is probably over its maximum, for the reason under "Rust over its
re-color maximum". Rust is over the unpacked-dependency maximum, for the reason
under "Rust over its unpacked-dependency maximum".

The C++ / C column is the
[November 2026 C-family measurement](../history/packages/cli/cf-view-c-family-2026-11.md),
made in two rounds, each between two TOML control runs, on a machine whose load
had fallen to one-minute averages of 60 and then 20. Its timings are TOML's
recorded 95th percentiles multiplied by the ratio of the language's median to
TOML's in the round whose controls stayed within 1.29 times TOML's recorded
medians; a third round on the final code put C++ at 78.5, 39.8, 44.1, and 25.4
ms. CUDA and headers use the C++ figures. The direct measurements behind the
overruns below are in the report. C++ is over its initialization and re-color
maximums, and at its document-parse maximum, for the reason under "C++ over its
initialization and re-color maximums". The byte and source figures are both
grammars' together. The owned source serves the C grammar and the C++ grammar,
and is over the maximum even for two later grammars, for the reason under "C and
C++ over their owned-source maximum". C++ and C are over the unpacked-dependency
maximum, for the reason under "C and C++ over their unpacked-dependency
maximum".

The Go column is the
[November 2026 Go measurement](../history/packages/cli/cf-view-go-2026-11.md),
made in six rounds, each between two TOML control runs, on a machine whose load
average stood between 125 and 278. Wall-clock time there measured the wait for
a processor, so the probe also recorded each sample's processor time, and the
TOML controls' processor-time medians stayed between 1.65 and 2.58 times TOML's
recorded medians. Its timings are estimates in the way the shell and HCL
columns' are, from processor time: TOML's recorded 95th percentiles multiplied
by the largest ratio of Go to TOML seen in any round. Like HCL, the Go grammar
names the node types a structure entry can be found inside. Go is over the
cumulative owned-source maximum, for the reason under "Go over the cumulative
owned-source maximum".

The binary build leaves out every directory of a grammar package except the
one holding its WebAssembly grammar, such as generated C source and native
builds, which the pager never reads. Shell's compiled figure is measured with
that in place. The Python and TOML figures above were measured before it, and
it removes 7.37 MiB of their packages from the binary.

The Starlark column is the
[November 2026 Starlark measurement](../history/packages/cli/cf-view-starlark-2026-11.md).
Starlark runs on the Python grammar and adds no package. The machine was so
loaded that elapsed times could not be scaled, so its timings are estimates
from processor time: TOML's recorded 95th percentiles multiplied by the largest
ratio of Starlark's processor time to that of a TOML control run beside each of
three rounds. The report gives reasons to think the initialization estimate is
high.

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

#### Kotlin over its re-color maximum

Kotlin re-colors the measured source in 26 milliseconds at the median and 33
at the 95th percentile, against a 25-millisecond maximum, and parses it with
structure in 54 at the 95th percentile in one of two rounds, against 50. The
source repeats a seven-line unit as dense as Swift's, so the difference is in
the grammar: its incremental parse costs about 5 milliseconds wherever an edit
falls, against Swift's 0.2, and its query runs about 3 milliseconds longer. On
100 kilobytes of the Weaver app's own Kotlin, which is less dense, it re-colors
in 21 at the 95th percentile and parses in 46.

The overrun starts the comparison under "Reconsidering the dependency". The
other Kotlin grammar pays the same incremental parse, ships its WebAssembly
build only as a release asset, and leaves more of the Weaver app unparsed. No
focused Kotlin implementation exists, and one would give up the structure tree.
The comparison therefore keeps the dependency, and the maximums stay where they
are. Kotlin's overrun is on a source denser than the code it serves, and a
change that lowers either the grammar's incremental parse or the adapter's
per-capture cost is the way to bring it inside.

#### Shell over its unpacked-dependency maximum

The official Bash grammar's package is 19.34 MiB unpacked, against a 10 MiB
maximum for a later grammar. 1.30 MiB of it is the WebAssembly grammar the
pager loads; the rest is generated C source and native builds. The binary
build leaves those out, so the figure is what a developer's dependency cache
holds, and shell adds 1.32 MiB to the binary.

The overrun starts the comparison under "Reconsidering the dependency". No
focused shell implementation exists, and this plan rules out writing one: the
parser spike found that the one alternative grammar, Lezer's Bash, marked its
Bash fixture as containing an error, and a scanner needs a second
implementation for structure. The comparison therefore keeps the dependency. A package holding only the
WebAssembly build, as Swift and Kotlin use, would bring shell inside the
maximum.

Python, shell, and Go take 34.95 MiB of the 40 MiB that the runtime and the
four host grammars may occupy unpacked. The official HTML package unpacks to
0.70 MiB.

#### Go over the cumulative owned-source maximum

The common runtime and the Python, Go, Bash, and HTML host grammars may occupy
1,000 owned source lines together. Without Go, they measure 1,189: the
adapter's `treesitter/adapter.ts` 678 lines and the `classes.ts` split out of it
115, `python/python.ts` 126, and `shell/shell.ts` 270. The adapter was 457
lines when Python was measured; it has since gained the line-break, structure
parent, and short-comment rules that Kotlin, HCL, and shell use, and the
tracking of grammar loads that Org mode's source blocks use. Shell's module was
91 lines when it was measured, and its short-comment rule brought it to 270.
Go's `go/go.ts` adds 197 lines, inside the 200 a later host grammar may add,
which brings the total to 1,386.

Go is the first language measured since the total passed its maximum, so it
starts the comparison under "Reconsidering the dependency". The marginal costs
a switch would remove are Go's 197 lines of highlight query and structure rule
and its 0.21 MiB WebAssembly grammar. No focused Go implementation exists. The
focused Python scanner that the adapter replaced was 863 lines and colored
without a structure tree, and a focused implementation needs a second
implementation for structure, as the parser decision records. The comparison
therefore keeps the dependency, and the maximums stay where they are. The
cumulative overrun is in the shared adapter and in shell's module rather than
in Go.

#### Rust over its unpacked-dependency maximum

The official Rust grammar's package is 14.35 MiB unpacked, against a 10 MiB
maximum for a later grammar. 1.05 MiB of it is the WebAssembly grammar the pager
loads; nearly all the rest is generated C source and native builds, which the
binary build leaves out, so Rust adds 1.07 MiB to the binary.

The overrun starts the comparison under "Reconsidering the dependency". No
focused Rust implementation exists, and a scanner would need a second
implementation for structure, as one for shell would. The comparison therefore
keeps the dependency. A package holding only the WebAssembly build, as Swift
and Kotlin use, would bring Rust inside the maximum. The npm packages that
hold one, which the report names, are not published by the grammar's
maintainers.

#### Rust over its re-color maximum

Rust re-colors the measured source in about the time HCL does: in the same runs,
the ratio of Rust's median to HCL's was 0.82 to 1.09. Scaled from HCL's recorded
estimate, that is 23.4 ms against the 25 ms maximum. Scaled from TOML's recorded
figure, it is 29.2 ms. Under that load HCL's own re-color was 2.35 to 2.55 times
TOML's in processor time, against 1.68 to 1.79 when HCL was measured, so the
report argues that the TOML scaling overstates both languages. HCL's recorded
figure is itself scaled from TOML, though. Scaled instead from the 95th
percentiles HCL's own report measured directly, up to 23.79 ms on a quiet
machine and 26.94 ms in rounds whose controls stayed close to their recorded
figures, Rust's re-color is 26.0 to 29.5 ms. Three of the four estimates are
over the maximum, by up to about a fifth.

The overrun starts the comparison under "Reconsidering the dependency". The
highlight query over the whole document is most of the cost. On the measured
source it makes 36,784 captures, and in one-off measurements whose samples are
not retained, removing groups of patterns from it gave no improvement that held
across runs. No focused Rust implementation exists, and a scanner would need a
second implementation for structure. The comparison therefore keeps the
dependency, and the maximums stay where they are. A change that lowers the
adapter's cost for each capture is the way to bring Rust inside, as it is for
Kotlin.

#### C and C++ over their unpacked-dependency maximum

The official C and C++ grammars' packages are 8.55 and 40.43 MiB unpacked,
48.98 MiB together, against a 10 MiB maximum for a later grammar. Their
WebAssembly grammars, which the pager loads, are 0.59 and 3.28 MiB; the rest is
generated C source, native builds, and bindings, which the binary build leaves
out. The C++ package depends on the C package, so the C package is in the
dependency cache whichever grammar C uses.

The overrun starts the comparison under "Reconsidering the dependency". No
focused C or C++ implementation exists, and one would need a second
implementation for structure, as the parser decision found for the other
source languages. The comparison therefore keeps the dependency. Packages
holding only the WebAssembly builds, as Swift and Kotlin use, would bring C and
C++ inside the maximum.

#### C++ over its initialization and re-color maximums

C++ initialized in 73 and 86 ms at the 95th percentile in two rounds, against a
75 ms maximum, and in an estimated 84.7 ms scaled against the TOML control. In
the same session it took 4 percent longer than Swift, whose own median there
was above the 95th percentile its report recorded. It re-colored after one edit
in 28 and 34 ms at the 95th percentile, against 25, and in an estimated
22.5 ms, and parsed a document in 60 and 49 ms, against 50, and in an estimated
38.5 ms. CUDA and headers use the C++ grammar
and share its figures. C is inside every timing maximum by its estimates; its
re-color measured 25 and 26 ms at the 95th percentile directly, in rounds whose
TOML control re-colored 1.2 to 1.8 times as slowly as recorded.

Initialization is the C++ grammar's size and its highlight query's
compilation, which takes about 37 ms of processor time against Swift's 28;
the query already shares parents and alternatives among its patterns, which cut
that cost by about half. The overruns start the comparison under
"Reconsidering the dependency". No focused C++ implementation exists, and one
would give up the structure tree or need a second implementation for it. The
comparison therefore keeps the dependency. A cheaper query, with fewer patterns
that constrain a node's parent, is the way to bring initialization inside, at
the cost of coloring fewer declared names.

#### C and C++ over their owned-source maximum

The C-family grammar module measures 532 physical lines of owned source, for
the C grammar and the C++ grammar together, against 200 lines for each later
grammar. 159 of them are the two highlight queries, which tell declared names
from called ones, parameters from other bindings, and declaring keywords from
control keywords, as the other languages' queries do, and which name CUDA's
qualifiers and a parser's recovered keywords. The rest find each declaration's
name through C's declarators, which nest pointers, arrays, references,
parentheses, and function parameter lists around it, and label macro-defined
definitions, conversion operators, and template members.

The overrun starts the comparison under "Reconsidering the dependency". No
focused C or C++ implementation exists. One would have to lex both languages,
raw strings and the preprocessor included, and would need a second
implementation for structure, as the parser decision found for the other
source languages. The focused Python scanner that this plan replaced took 863
lines for highlighting alone, which suggests that a focused implementation of
two larger languages would not be smaller than these 532 lines. The comparison
therefore keeps the dependency.

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

A November 13, 2026 read of the local checkouts of the organization's
repositories, at the tip of each default branch and of gVisor's active
`cfc_v2` branch, found 2,954 Go files in 7 repositories: gVisor (2,345), Common
Cluster (304), Bay (143), Loom Scripts (112), Raia (43), Run Orchestrator (6),
and Infra (1). The six months before the read hold 1,524 path-change events on
them, most in Common Cluster (615), Loom Scripts (305), gVisor (295), and Bay
(230). The same checkouts hold 9 `go.mod` and 8 `go.sum` files, with 25
path-change events, and no `go.work` or `go.work.sum` file.

- [x] Highlight `.go`.
- [x] Add package, type, function, and method structure.
- [x] Recognize `go.mod` and `go.sum` as separate data syntaxes.
- [x] Add Common Cluster, Bay, Run Orchestrator, Raia, and gVisor fixtures.

Go runs on the Tree-sitter adapter with the official
[`tree-sitter/tree-sitter-go`](https://github.com/tree-sitter/tree-sitter-go)
grammar, whose npm package ships its WebAssembly build. `.go` selects it.
Structure lists the package clause, types, functions, methods, constants and
variables declared at package level, and the fields and methods each type
declares. A declaration that binds several names lists them all and declares
the first that is not blank, and an embedded field is listed under its type. A
method's label names its receiver's type, as in `func (*Item) Render`.
Declarations inside a function body are not structure. A comment that Go's
tools read as a directive, such as a `//go:build` constraint, is colored as a
directive rather than a comment, as are the comments between `import "C"` and
the declaration before it, which include the preamble that cgo compiles as C.

A coverage check over the 2,954 files found every file reconstructed exactly,
and fewer than one in a million characters other than white space without a
token class. The grammar could not parse part of 2 files, 3 of their 1,125
lines. Both declare a function of their own named `new` or `make`, which Go
allows, and the grammar reads a call's first argument as the type that the
built-in function of that name takes. Coloring continues inside those regions.

`go.mod` and `go.work` select a Go module file language, and `go.sum` and
`go.work.sum` a Go checksum file language. Both use focused scanners: the npm
packages of the `go.mod` and `go.sum` Tree-sitter grammars ship no WebAssembly
build and were last published in 2023, and both syntaxes are line-oriented. The
module file scanner reads the tokens the Go command's `modfile` package reads,
colors the directives that package knows as keywords, the declared module path
as a declared name, and versions as numbers, and lists each directive with the
lines of its block under it. The checksum scanner colors each line's module
path, version, and hash, and lists each module over the lines that name it. Every one of the 17 files
reconstructed exactly, with every character other than white space classed.

Completion gate: Go source and both manifest formats select correctly in
direct and diff views. The gate passes: the shared fixture contract runs Go
fixtures from gVisor, Common Cluster, Bay, Run Orchestrator, and Raia, and
module and checksum fixtures from gVisor, directly and in diffs.

## Stage 4: shell

A September 29, 2026 read of the local checkouts of the organization's
repositories found 391 files that select shell, in 20 repositories, and 1,839
path-change events on them in the six months before the read. The July survey
found Go in 2,568 files in 6 repositories, with 2,129 path-change events. Go
leads on files and activity; shell leads on repositories.

- [x] Cover Bash and POSIX shell with dialect selection from the shebang.
- [x] Recognize `.sh`, `.command`, Git hooks, entrypoint scripts, and
  extensionless executables with shell shebangs.
- [x] Highlight heredocs without guessing an embedded language unless the
  delimiter names it reliably.
- [x] Add Infra and Loom fixtures that exercise operational scripts.
- [x] Select an extensionless file's language from its shebang in a diff.

Shell runs on the Tree-sitter adapter with the official
[`tree-sitter/tree-sitter-bash`](https://github.com/tree-sitter/tree-sitter-bash)
grammar, whose npm package ships its WebAssembly build. POSIX shell's syntax is
a subset of what that grammar parses, so one language covers both, and `sh`,
`bash`, `dash`, and `ash` shebangs select it. zsh and ksh are not claimed. `.sh`,
`.bash`, `.command`, and Bash's startup files select it by name. Structure lists
function definitions in both forms. A heredoc's body is a string, with the
expansions an unquoted delimiter allows colored inside it, and no delimiter is
taken to name an embedded language. The grammar does not read a second heredoc
on the same command line, so that heredoc's body is colored as commands.

A coverage check over the 391 files found every file reconstructed exactly and
4.58 percent of characters other than white space without a token class, almost
all of them command arguments. The grammar could not parse part of 20 files,
covering 12.69 percent of lines, almost all in two files where a `]` in an
expansion's removal pattern, as in `${h%]}`, derails it; coloring continues
inside those regions, and the structure tree loses 12 of one file's 161
functions and 4 of the other's 44.

A diff reads an extensionless script's shebang from a hunk that starts at its
first line, from the workspace file, or from the old Git blob. The shared
fixture contract checks every recorded filename and shebang of a language in a
diff as well as directly, which covers Git hooks and other extensionless
programs.

Completion gate: every surveyed shell selection form works in direct files,
diffs, and incomplete edits. The gate passes.

## Stage 5: web markup, styling, and XML

- [ ] Add HTML, CSS, and SCSS.
- [ ] Delegate HTML `style` and `script` regions to CSS and JavaScript.
- [x] Add strict XML separately from permissive HTML.
- [x] Route SVG, Apple property lists, and entitlement files through XML.
- [ ] Evaluate the HTML and CSS parsers already pinned by the UI package
  before adding a dependency.

XML is implemented ahead of the rest of this stage, for the Android formats
under Stage 14. It uses a focused scanner rather than Tree-sitter: the official
Tree-sitter XML grammar attaches its WebAssembly build to its GitHub releases
but no npm package carries it, and XML's lexical syntax is simple enough that
a scanner covers it, with a structure tree of elements. The
scanner also selects `.xcprivacy` privacy manifests and `.xcworkspacedata`
workspace files, which are XML. It colored all 88 XML, SVG, property list,
entitlement, and privacy manifest files in the local checkouts of the
organization's repositories without altering their source. A file that no name
claims selects XML when its source starts with an XML declaration, which covers
Interface Builder documents and project files.

Completion gate: host and embedded syntax ranges preserve the complete input,
including malformed and partially edited markup.

## Stage 6: Lean

Lean is implemented ahead of Stage 3 and the rest of Stage 5. A November 13,
2026 read of the local checkouts of the organization's repositories found Lean
only in Specs: 398 `.lean` files and 2 `lean-toolchain` files, with 324
path-change events on the Lean files and 1 on a toolchain file in the six months
before the read.

- [x] Highlight `.lean`.
- [x] Recognize `lean-toolchain`.
- [x] Add structure for namespaces, sections, declarations, definitions,
  theorems, and inductive types.

Lean uses a focused scanner rather than Tree-sitter. No npm package carries a
Tree-sitter Lean grammar, and a Lean file can extend its own grammar with
notation, macros, and syntax declarations, so a fixed grammar cannot parse Lean
in general. The scanner reads the lexical syntax that every Lean file shares:
nested block comments and documentation comments; strings, with the code in
the braces of an `s!`, `m!`, or `f!` string or a `throwError` or `dbg_trace`
message colored as code; character, name, and number literals; identifiers,
which may hold Greek letters, letter-like symbols such as `ℝ`, subscripts, and
`«…»` escapes; keywords; and attribute names. The mathematical angle, white,
and double brackets Lean uses take a nesting depth as ASCII brackets do.
`.lean` selects the language. Tactic names are identifiers to the scanner,
since a file's imports define them.

A command keyword, such as `theorem`, `namespace`, or `open`, starts a command
when it begins a line indented no further than the open declaration's first
line. A declaration keyword also starts one after a modifier, an attribute, or
`in` on its line. Any other word that begins such a line starts a command too,
unless the token before it cannot end a term, as `:=`, `by`, `where`, and `,`
cannot. So an `open … in` inside a proof stays part of the proof, and a command
that a library defines, such as Mathlib's `notation3`, ends the declaration
before it. Structure lists namespaces, sections, and `mutual` blocks, each
closed by an `end` or the end of the input, and the definitions, theorems,
lemmas, abbreviations, instances, examples, axioms, opaque constants, Mathlib's
irreducible definitions, structures, classes, and inductive and coinductive
types inside them. An `end` that names a dotted namespace closes one scope for each
component. A declaration starts at its first modifier or attribute and ends at
its last token before the next command. A declaration that names nothing, such
as an anonymous instance, takes as its label its signature on its first line,
up to a `:=` or `where` outside brackets.

A coverage check over the 398 Lean files found every file reconstructed exactly.
Of the characters other than white space, 68 percent are identifiers, 14
percent are comments, and the rest are keywords, declared names, operators,
brackets, and literals. The structure tree has one declaration for each of the
6,784 lines outside comments that start with a declaration keyword, after any
modifiers and attributes, and lists 894 namespaces, sections, and `mutual`
blocks. Every line other than blank lines, comments, scope lines, and commands
that declare nothing, such as `open` and `macro` and their continuation lines,
lies inside a declaration.

The timings ran on a machine whose load average stayed between 74 and 105. A
TOML control run before and after each of four rounds took 2.5 to 12.6 times
TOML's recorded medians, so no figure measured directly describes a quiet
machine. In every round, the median of each Lean operation on 100 kilobytes of
source was at most 0.31 of the TOML medians around it for a complete highlight,
0.39 for a document parse, and 0.56 for a re-color after one edit. Scaling
TOML's recorded 95th percentiles by those ratios gives 6.2, 11.6, and 6.7
milliseconds, inside each maximum. This is an inference from the control. In
CPU time, which the load inflates less, a complete highlight took a median of
14 milliseconds against TOML's 28 in the same runs. Initialization loads no
grammar, and its median was under 4 milliseconds in every round. Each
100-kilobyte input built to slow the scanner that was measured, such as one
line of 25,000 words, 50,000 unclosed attribute lists, or an interpolated
string opening 100,000 braces, took under 100 milliseconds of CPU time to parse
with structure, and the time grew linearly with the input. The structure
tree, its flattened list, and its projection into a diff are built with
explicit stacks, so 20,000 nested scopes build as a few do.

The `lean-toolchain` language colors the repository that publishes the
toolchain, such as `leanprover`'s `lean4`, as a type name, and the release
after the `:` as a string. Its name selects it. The fixtures come from Specs.

Completion gate: representative Specs source and diffs pass the shared fixture
contract. The gate passes.

## Stage 7: Starlark and Bazel

A November 13, 2026 read of the local checkouts of the organization's
repositories found Starlark and Bazel files in gVisor alone. At its `5e59860`
commit, 537 files are Starlark: 502 `BUILD` files, 33 `.bzl` files,
`MODULE.bazel`, and one `.BUILD` file that a repository rule adds to an
external repository. These are the 537 files the July survey counted. gVisor
also holds `.bazelrc`, `.bazelversion`, and `.bazelignore`. The six months
before the read hold 11 path-change events on these files, all on `BUILD`
files, against the survey's 259.

- [x] Use one Starlark implementation for `BUILD`, `BUILD.bazel`,
  `MODULE.bazel`, workspace files, and `.bzl`.
- [x] Add small selectors for `.bazelrc` and `.bazelversion`.
- [x] Add representative gVisor build fixtures.

`.bazelignore` is an ignore file, and Stage 9 covers it with the others.

Starlark's syntax is a subset of Python's, so Starlark runs on the Tree-sitter
adapter with the Python grammar the pager already ships, using Python's
highlight query and one pattern of its own that colors `load` as the statement
it is. The separately maintained
[`tree-sitter-grammars/tree-sitter-starlark`](https://github.com/tree-sitter-grammars/tree-sitter-starlark)
grammar is built by extending the Python grammar, and its npm package declares
an older `tree-sitter-python` as a runtime dependency. Depending on it would
add 12.39 MiB of unpacked packages, over the 10 MiB maximum for a later
grammar, while the Python grammar adds nothing. The adapter compiles a grammar
file once however many languages use it.

`BUILD`, `WORKSPACE`, and `WORKSPACE.bzlmod` select Starlark by name, a
`.BUILD` suffix selects it in that case only, so that Meson's `meson.build` is
not claimed, and `.bzl`, `.bazel`, and `.star` select it in any case. `.bazel`
covers `BUILD.bazel`, `MODULE.bazel`, `REPO.bazel`, and `WORKSPACE.bazel`.
Structure lists functions, each single name assigned outside functions, and
each target that a call outside functions declares through a string `name`
argument.

`.bazelrc` files use a focused scanner that reads them as Bazel does: a
backslash at a line's end joins it to the next, quotes and backslashes group
characters into words, and `#` outside quotes starts a comment. The scanner colors the
command, the configuration a line defines, such as `race` in `build:race`, and
each option and value. It leaves plain a line for a command Bazel does not
have, which Bazel ignores, and an import with the wrong number of words, which
Bazel refuses. Structure lists imports and configurations.
`.bazelversion` is plain text by name.

A coverage check over the 537 Starlark files found every file parsed without an
error and reconstructed exactly, with no character other than white space left
without a token class. The same holds for gVisor's `.bazelrc`. The
[November 2026 Starlark measurement](../history/packages/cli/cf-view-starlark-2026-11.md)
records the coverage checks and the costs.

Completion gate: all 537 surveyed Starlark and Bazel files have an honest
selection path. The gate passes.

## Stage 8: OpenTofu, HCL, and infrastructure templates

- [x] Add `.tf` and `.tfvars` HCL.
- [ ] Layer Terraform interpolation over the shell host in `.tftpl`.
- [ ] Layer Jinja delimiters over a separately selected host syntax.
- [ ] Cover the surveyed shell, systemd-unit, authorized-keys, and YAML Jinja
  hosts.

Completion gate: an extension such as `.j2` does not force one host language,
and every current Infra template has an explicit tested selection rule.

HCL is implemented ahead of Stages 3 to 7. Outside its own language module it
needed one optional addition to the shared adapter, the set of node types a
structure entry can be found inside. The grammar's own npm package ships its
WebAssembly build, and that grammar parsed every one of the 153 HCL files in the
Infra repository without an error. HCL runs on the Tree-sitter adapter with the
[`tree-sitter-grammars/tree-sitter-hcl`](https://github.com/tree-sitter-grammars/tree-sitter-hcl)
grammar. It selects OpenTofu and Terraform configuration through `.tf` and
`.tofu`, variable definitions files through `.tfvars`, backend configuration
files through `.tfbackend`, and test files and dependency lock files through
`.hcl`. The JSON forms of those files, such as `.tf.json`, remain JSON. It
colored every character other than white space in those 153 files, and each
file reconstructed exactly.

## Stage 9: build and operational configuration

- [x] Add Dockerfile, including every `Dockerfile.*` variant.
- [x] Add Makefile and `.mk`.
- [x] Add Git, Docker, Deno, and Bazel ignore files.
- [x] Add Git attributes files.
- [x] Add Git modules and other Git configuration files.
- [x] Add worktree-include syntax.
- [x] Add dotenv files and compound examples.
- [x] Add INI, Ansible configuration, and inventory files.
- [ ] Add systemd units.
- [ ] Add tmpfiles configuration.
- [x] Add surveyed directive configuration.

Makefiles are implemented ahead of the rest of this stage. An October 20, 2026
read of the local checkouts of the organization's repositories found 19
makefiles in 5 repositories, all named `Makefile` or `.mk`, with 56 path-change
events on them in the six months before the read. `Makefile`, `makefile`,
`GNUmakefile`, and `.mk` select the language, as do `make` and `gmake`
shebangs.

The language uses a focused scanner rather than Tree-sitter. The
[`tree-sitter-grammars/tree-sitter-make`](https://github.com/tree-sitter-grammars/tree-sitter-make)
grammar's npm package ships its WebAssembly build, but the grammar could not
parse part of 7 of the 19 files, 133 of the 2,595 lines in all 19. It fails on
idioms those files use: a `$$(` shell substitution, a `$(shell ...)` call that
spans continuation lines, and parentheses inside a variable's value. Make's
lexical syntax is line-oriented, and a scanner reads every one of those files
and reconstructs each exactly.

Make passes recipe lines, the recipe after a rule's `;`, the command of a `!=`
assignment, and the argument of the `shell` function to the shell. The scanner
colors each such stretch through the shell language's grammar as make runs
it: one logical recipe line at a time, or a rule's whole recipe at a time when
the makefile names the `.ONESHELL` target. Make's own references inside a
stretch are hidden from that grammar and colored by the scanner. On 100
kilobytes of gVisor's makefile, the 95th-percentile full highlight took 10.6
milliseconds, the document parse 7.2, and the re-color after one edit 6.9, all
inside the maximums for a parser-backed language.

An October 20, 2026 refresh found nine INI files in the local checkouts of the
organization's repositories: six Ansible inventories and the Ansible
configuration in Infra, `pytest.ini` in Loom, and `.codespellrc` in gVisor. The
six months before the refresh hold 23 path-change events on the Infra files, 9
on Loom's, and none on gVisor's.

INI uses a focused scanner, in the dialect Python's `configparser` reads by
default: `;` and `#` start comment lines, the first `=` or `:` separates a key
from its value, and a line indented further than the line that set a key
continues that key's value. A line whose first word does not end in `:` and is
followed by a `name=value` word or a `#` is an Ansible inventory host line,
split into words as Ansible splits it: the first word is the host, the
`name=value` words set the host's variables, and a `#` outside quotes starts a
comment. `.ini` selects INI, and so do `ansible.cfg`, `.ansible.cfg`,
`setup.cfg`, `.codespellrc`, and the configuration files of Python tools that
have no extension of their own. Another `.cfg` file is INI when its first line
other than blank lines and comments heads a section whose name does not start
the way a JSON array's first value does. TLC configuration and JSON do not open
that way. Every character other than white space in the nine files has a token
class. The scanner re-colors 100 kilobytes of inventory and configuration text
in under 2 milliseconds at the 95th percentile, and each 100-kilobyte input
built to slow it that was measured, such as unclosed quotes or a single line of
25,000 words, in under 6. The fixture comes from Infra.

Git attributes are implemented ahead of the rest of this stage. Git hooks
select shell through their shebangs, as Stage 4 describes. A November 13, 2026
read of the local checkouts of 32 of the organization's repositories found four
`.gitattributes` files, one each in Labs, Loom, Infra, and the
`commonfabric-weaver` repository, with 11 path-change events on them in the six
months before the read. The name `.gitattributes` selects the language in any
directory, without reading the source.

The language uses a focused scanner rather than Tree-sitter. A line holds a
pattern followed by attributes, separated by blanks, and no line depends on
another. The scanner follows Git's own reader. `languages/glob.ts` colors a
pattern as Git's wildcard matching reads it: `*`, `?`, and bracket expressions,
including character classes such as `[:space:]`, as regular-expression syntax,
`/` and an escaping backslash as punctuation, and the rest as a string. A quoted
pattern is colored after its C-style quoting is removed, and a pattern whose
quoting is not valid runs to the first blank. An attribute's name is a property
name, after an optional `-` or `!`, and a value after `=` is a string. A pattern
written `[attr]name`, with a name after the prefix, defines a macro, whose name
the structure tree lists beside each pattern and indexes for definition peeks.
Git reads macro definitions only in a repository's top-level file, which a
file's name does not show, so the scanner colors them in every file. Git ignores
a whole line when a name on it is not one Git accepts, when its pattern starts
with `!`, or when it is 2,048 bytes long or longer, not counting a carriage
return before its line feed. A `#` after a line's pattern is such a name rather
than a comment. The scanner leaves those lines uncolored and out of the
structure tree. A pattern followed by one `name=value` attribute is also an
Ansible inventory host line, so the INI fixture and the Loom Git attributes
fixture declare each other as highlighting peers. The fixtures come from all
four repositories.

Every character other than white space in the four files has a token class,
and each file reconstructs exactly. The machine that measured the scanner was
too loaded for elapsed-time percentiles to mean anything: the INI scanner's
95th percentiles there were over 150 milliseconds, against under 2 recorded
for it. The figures are therefore the mean processor time of 200 runs. On 100
kilobytes built from the four files, a full highlight takes 2.3 milliseconds, a
document parse 3.1, and a re-color after one edit 2.8. The INI scanner takes
1.7, 2.6, and 1.9 on 100 kilobytes of an Infra inventory, measured the same
way. Of the 100-kilobyte inputs built to slow the scanner, 20,000 lines that
each open a bracket expression and a character class that nothing closes take
7.0 milliseconds to highlight and 15 to parse, and one line of 20,000
attributes takes 2.0 to highlight.

Git configuration files are implemented ahead of the rest of this stage. A
November 13, 2026 read of the local checkouts of the organization's
repositories found one tracked file in Git's configuration syntax, Pond's
`.gitmodules`, with 2 path-change events on it in the six months before the
read.

Git configuration uses a focused scanner that follows the rules Git's own parser
applies: section headers with optional quoted subsection names, several of which
may share a line, variable names, quoted values, backslash escapes, comments
after a value, and values continued onto the next line by a final backslash. A
line Git rejects is left out of the structure tree. It is colored up to the
point where Git rejects it, except that a name is colored as a variable's only
when a `=` or the end of the line follows it. `.gitmodules`, `.gitconfig`,
`gitconfig`, a worktree's `config.worktree`, `.lfsconfig`, and names ending in
`.gitconfig` select it. A repository's own `.git/config` is not claimed, because
many other formats share its name, `config`. A coverage check read Pond's
`.gitmodules`, the `.git/config` of each of the 32 local checkouts, and the user
configuration file of the machine that ran the check. Every one of the 34 files
reconstructed exactly, and every character other than white space in them has a
token class. The machine was too loaded for 95th percentiles to mean anything,
so the shortest of 100 runs stands in for each figure. On 100 kilobytes of those
files the scanner highlighted in 2.3 milliseconds and parsed with structure in
3.9, where the INI scanner took 1.7 and 3.2 on the same input in the same run.
The slowest input built to slow it, 34,134 section headers on one line, parsed
in 44 milliseconds and highlighted in 6, so most of the time went to building
the structure tree. The fixture comes from Pond.

A November 13, 2026 read of the local checkouts of the organization's
repositories found 11 `.conf` files, in Infra, gVisor, and Legibility, and they
hold eight syntaxes: Netdata health alerts and a Netdata collector's YAML in
Infra, nginx in Infra and gVisor, Apache httpd and OpenSSL configuration in
gVisor, a systemd drop-in and sysusers.d configuration in Infra, and tmpfiles.d
configuration in Legibility. The same read found an nftables ruleset in Infra
and a Clang module map in the `commonfabric-weaver` repository.

nginx, Apache httpd, nftables, Netdata health alerts, and sysusers.d share one
syntax, which one focused scanner reads as a directive configuration language. A
statement starts with a directive and ends at the end of its line unless the
line ends with `\` or a list is still open. A `{` that ends a line opens a
block, a `}` that starts a line closes one, and only a whole line that starts
with `#` is a comment, unless the line before ends with `\`, so a regular
expression's `{4}` or a `#` in a Netdata description is ordinary text. In a file
in which at least half of the statement lines end with `;`, as nginx's and some
nftables rulesets' do, a `;` ends a statement, any `{` or `}` opens or closes a
block, a `#` after white space, `;`, `{`, or `}` starts a comment, a statement
continues onto a line that is indented further than its first, as an nginx
argument list that runs over several lines does, and a quoted string runs to its
closing quote over as many lines as it takes. A Netdata `key: value` line and an
Apache section tag start a statement unless the line before ends with `\`. A `{`
that follows `=` opens a list rather than a block, such as an nftables set, as
does a block's `{` that a comma follows on its line before any `;`, `{`, or `#`,
or that a `}` closes later on its line around content without a `;`, `{`, or
`#`, counting nothing inside quotes. A `{` after `$` or `%` is part of a
variable reference. The structure tree lists blocks, sections, and the entries
that top-level Netdata `alarm` and `template` keys start. `nginx.conf`,
`httpd.conf`, `apache2.conf`, and other `.conf` names that begin with one of
those words select it, as do `.htaccess`, `.nft`, `nftables.conf`, and `nft`
shebangs. `.conf` is shared, so another `.conf` file is directive configuration
only when it does not open with a shebang and its first line other than blank
lines and `#` or `;` comments starts a Netdata entry, opens an Apache section,
starts with a sysusers.d `u`, `g`, or `m` line, or starts with a word that
neither ends with `:` nor holds or precedes `=` and then holds a `;` or a `{`
that does not follow `$` or `%`. It is YAML when it opens, after blank lines and
`#` comments, with a `---` document marker or an unindented key with no value
followed by an indented line or a sequence entry, as the Netdata collector's
configuration is, INI when its first line other than blank lines and comments
heads a section other than one a systemd unit opens with, as gVisor's OpenSSL
configuration does, and JSON when the file opens with `{`. Each of those 11
files opens in only one of those ways, except the systemd drop-in, which opens
with a systemd unit's section, and the tmpfiles.d file, which opens in none.

The scanner reconstructs each of the eight directive configuration files
exactly. Arguments are uncolored unless they are strings, variable references,
numbers, or booleans, which leaves 36.82 percent of their characters other than
white space plain. On 100 kilobytes of Infra's nginx configuration and of its
Netdata alerts, the 95th-percentile full highlight took 3.25 and 4.76
milliseconds, the document parse 4.84 and 4.74, and the re-color after an edit
3.51 and 5.40, in two rounds on a machine whose load average was 7 to 13. The
INI scanner, run beside it as a control, re-colored its own 100 kilobytes in
2.74 milliseconds at most, close to its recorded figure. All of those are inside
the maximums for a parser-backed language. Twenty-two inputs built to slow the
scanner, such as unclosed quotes, blocks, and section tags, runs of tags with no
space between them, runs of unmatched brackets, `#` banners after a `{`, lines
that hold a carriage return, and a single line of 50,000 words, were each parsed
at 100 and 200 kilobytes: doubling the input multiplied the time by 1.1 to 2.4,
and the slowest took 123 milliseconds at 200 kilobytes. 25,000 nested unclosed
blocks build a structure tree. The fixtures come from Infra's Netdata alerts and
gVisor's nginx benchmark configuration.

Ignore files and worktree-include files are implemented ahead of the rest of
this stage. A November 13, 2026 read of the local checkouts of the
organization's repositories found 81 tracked ignore files in 30 repositories: 70
`.gitignore` files, 7 Docker ignore files, two `.worktreeinclude` files, one
`.denoignore`, and one `.bazelignore`. The six months before the read hold 189
path-change events on them. Three of the Docker ignore files are named after
the Dockerfile they serve, such as `Dockerfile.build.dockerignore`.

Git, Docker, and Bazel read an ignore file differently, so each reading is its
own language, and the three share one focused scanner. In all three, a line that
starts with `#` is a comment. `gitignore` reads Git's patterns: a leading `!`
negates a pattern; `*`, `?`, and bracket expressions are wildcards; `/`
separates directories; a backslash makes the next character literal; and spaces
at the end of a line that no backslash escapes are not part of the pattern.
`.gitignore` selects it, and so do Claude Code's `.worktreeinclude`, which uses
Git's syntax, and `.denoignore`, which only Labs has and nothing there reads,
but which is written in Git's syntax. `dockerignore` reads Docker's patterns,
which differ in that white space before a pattern, after its `!`, and at its
end, escaped or not, is not part of it, and in that Go's `filepath.Match` and
Go's regular expressions decide which bracket expressions are valid: only `^`
negates one, a `]` or `-` must be escaped where a member starts, and a range may
not run backwards. The `.dockerignore` extension selects it, which covers a file
named after its Dockerfile, and so does the `.containerignore` extension, which
Podman reads. `bazelignore` reads each line other than a comment as a literal
directory path, as Bazel does, so it colors no wildcard and no negation; a
carriage return ends a line there, as it does for Bazel's reader. An ignore file
declares no names, so none of the three has a structure tree. Their patterns
are colored by `languages/glob.ts`, as Git attributes patterns are, in Go's
syntax for Docker.

A coverage check over the 81 files found every file reconstructed exactly and
every character other than white space with a token class. The timings ran on a
machine whose load average was between 130 and 200 on 18 cores, which put every
95th percentile over 100 milliseconds, so they are medians, each beside an INI
control run interleaved with it whose median stayed between 1.5 and 3.8
milliseconds. Re-coloring 100 kilobytes of the surveyed files took a median of
2.0 to 5.0 milliseconds across runs. Of the 100-kilobyte inputs built to be
slow, those of many very short lines took the longest: 50,000 lines holding one
`[` each took a median of 13 to 105 milliseconds across runs, against 73 for INI
on 50,000 lines holding one `a` each. The scanner looks at each character a
bounded number of times, so its work grows in proportion to the input's size.
The fixtures come from Infra and gVisor.

A November 13, 2026 read of the local checkouts of the organization's
repositories found 96 Dockerfiles in 6 repositories: 79 in gVisor, 7 in Common
Cluster, 6 in Infra, 2 in Labs, and one each in CRM and Web Weaver. 57 are named
`Dockerfile`, and the other 39 add a suffix to that name, such as
`Dockerfile.x86_64` and `Dockerfile.sandbox-rootfs`. The six months before the
read hold 53 path-change events on them. Infra also holds three ignore files
that BuildKit pairs with a Dockerfile, such as `Dockerfile.build.dockerignore`.
They are not Dockerfiles, and they belong with the Docker ignore files.

`Dockerfile` and `Containerfile`, their lowercase spellings, and the
`.dockerfile` and `.containerfile` extensions select the language. So does a
name that adds a dot and a suffix to either name, in any case, unless it is such
an ignore file or its last suffix is an extension another language claims
whatever the source holds, as shell claims `Dockerfile.sh`. It uses a focused
scanner rather than Tree-sitter. No npm package carries a WebAssembly build of a
Dockerfile grammar: the `tree-sitter-dockerfile` package holds only a security
placeholder, and the
[`camdencheek/tree-sitter-dockerfile`](https://github.com/camdencheek/tree-sitter-dockerfile)
grammar's releases attach no build. A Dockerfile's own syntax is line-oriented,
and the shell commands that make up most of its text are colored through the
shell language's grammar, as makefile recipes are.

The scanner reads the syntax of BuildKit's Dockerfile frontend. Parser
directives open the file, and the `escape` directive can make the backtick the
escape character. A line that ends in the escape character continues on the next
line other than a blank line or a comment, and the shell grammar reads the
continued command as BuildKit joins it, without the escape character and line
break. The shell form of `RUN`, `CMD`, `ENTRYPOINT`, and a `HEALTHCHECK` command
is colored as shell, unless a `SHELL` instruction earlier in the stage, or in
the stage it is built from, names a shell other than `sh`, `bash`, `dash`, or
`ash`. The exec form is colored as a JSON array of strings. A `RUN` whose
command is a single heredoc runs that heredoc's body as a script, with the
interpreter its shebang names or else the stage's shell, and the shell grammar
colors the body when that is one of those shells. The shell reads the heredocs
of any other `RUN` as part of its command, and the bodies of `COPY` and `ADD`
heredocs are strings. Other arguments color quoted strings and variable
references. The structure tree lists build stages, by name or by base image, and
the variables that `ARG` and `ENV` set in each.

A coverage check over the 96 files found every file selected by its name and
reconstructed exactly. Outside shell commands, 4,761 of the 22,209 characters
other than white space, 21.4 percent, have no token class: almost all are the
paths that `COPY` and `WORKDIR` name and the values that `ENV` and `ARG` set.
Inside shell commands, 49.4 percent have none, almost all package names and the
other command arguments that the shell grammar reads as plain words. None of the
files uses a heredoc or a parser directive. Fixtures come from Common Cluster,
Infra, and gVisor.

On 100 kilobytes of Common Cluster's `Dockerfile.sandbox-kitchensink`, repeated,
the 95th-percentile lazy initialization is estimated at 33.5 milliseconds, the
full highlight at 17.6, the document parse at 18.8, and the re-color after one
edit at 13.6. All four are inside the maximums for a parser-backed language. The
estimates are made as the shell column's are, from seven rounds, each between
two TOML control runs: TOML's recorded 95th percentiles multiplied by the
largest ratio of Dockerfile to TOML seen in any round. The machine was loaded so
heavily that the controls ran 12.6 to 46 times slower than TOML's recorded
medians, so no round met the condition the HCL measurement set on its controls,
and these figures are less certain than HCL's.

A November 13, 2026 read of the local checkouts of the organization's
repositories found 24 dotenv files in 7 repositories: ten `config.env.example`
files in Loom Scripts, eight files in Infra, two in Labs, and one each in Auth
Broker, CRM, Dynabook, and the `commonfabric-weaver` repository. The six months
before the read hold 57 path-change events on them. The July survey also listed
dotenv examples in Loom and Pattern Factory, whose local checkouts hold none.

Dotenv uses a focused scanner, which reads the common forms as the dotenv
libraries, Docker Compose, and a shell sourcing the file all read them: `#`
starts a comment line, an optional `export` precedes a variable's name, and the
first `=` separates the name from its value. A value that opens with a quote
runs to the matching quote, across lines, and is read as an unquoted value when
no quote matches it, as the npm `dotenv` package reads it. A `#` that follows
white space starts a comment after a value. `$NAME` and `${NAME}` references,
with the operator and default of forms such as `${NAME:-default}`, are colored
in unquoted and double-quoted values, and `$$` is a dollar sign, as Docker
Compose reads it. `.env` and a name that continues it with a further suffix,
such as `.env.local` or `.env.example`, select dotenv by name, unless that
suffix is another language's extension. So does an example copy whose name ends
in `env` followed by `.example`, `.sample`, `.template`, or `.dist`, such as
`config.env.example` or `toolshed-env.example`. A filename pattern claims a name
only when no language claims it by extension or exact name, which is what leaves
`.env.xml` to XML. Another `.env` file is dotenv when its first line other than
blank lines and comments sets a variable. That evidence leaves out the three
`.env` files in those checkouts that are not dotenv: two Ansible Vault files in
Infra, and Skip's app configuration in `commonfabric-weaver`, which follows
Xcode's build-settings syntax with `//` comments. Infra's `runner.env.j2` and
`otel-collector.env.j2` are Jinja templates over a dotenv host, which the Jinja
item under Stage 8 covers.

Every one of the 24 files reconstructs exactly, every one of their 14,585
characters other than white space has a token class, and each of their 116
variable assignments is a structure entry. On 100 kilobytes of those files, the
scanner's median full highlight, document parse, and re-color after one edit
stayed between 2.0 and 8.1 milliseconds in three runs. The machine's load
average was about 166, so the 95th percentiles measured only its stalls, and
each run alternated with the Java properties scanner, whose medians on the same
source stayed between 2.4 and 8.8. Inputs built to slow it are slowest where
each reference becomes its own colored span: 100 kilobytes of `$A` references
took medians of 7 to 52 milliseconds. Fixtures come from Labs and
`commonfabric-weaver`.

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
- [x] Add Rust source.
- [x] Add TOML.
- [x] Recognize Cargo manifests and lock files.
- [x] Recognize Swift package manifests and package-resolution JSON.
- [ ] Delegate embedded notebook cells when their language metadata names one
  of the implemented languages.

Swift runs on the Tree-sitter adapter with the
[`alex-pinkus/tree-sitter-swift`](https://github.com/alex-pinkus/tree-sitter-swift)
grammar, which is not an official Tree-sitter grammar. Its own npm package
ships no WebAssembly grammar, so the CLI depends on a package holding the
upstream release's WebAssembly build, whose digest matches the release asset;
`runtime/cli/lib/view/DEPENDENCIES.md` gives the procedure for rolling it. A
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

TOML runs on the Tree-sitter adapter with the
[`tree-sitter-grammars/tree-sitter-toml`](https://github.com/tree-sitter-grammars/tree-sitter-toml)
grammar, whose npm package ships its WebAssembly build. It is implemented ahead
of Rust for the Gradle version catalogs under Stage 14, and it covers Cargo
manifests through their `.toml` extension and Cargo lock files by name. It
colored every character other than white space in the 14 TOML files in the
local checkouts of the organization's repositories.

Rust runs on the Tree-sitter adapter with the official
[`tree-sitter/tree-sitter-rust`](https://github.com/tree-sitter/tree-sitter-rust)
grammar, whose npm package ships its WebAssembly build. A November 13, 2026
read of the local checkouts of the organization's repositories found 33 Rust
files: 28 in Infra's memory router, 4 in danfuzz-land, and 1 in gVisor. The six
months before the read hold 51 path-change events on the Infra paths, 8 on
danfuzz-land's, and none on gVisor's. Fabric Mobile, where the July survey
found most of its 11 Rust files, removed its Rust on July 30, 2026, after 22
path-change events in those six months. `.rs` selects Rust. None of the 33
files is a script, so no shebang selects it.

A coverage check over the 33 files found every file parsed without an error and
reconstructed exactly, with every character other than white space given a token
class. The arguments of a macro invocation are tokens without a syntax tree, so
they are colored token by token. Structure covers structures and unions and
their named fields, enumerations and their variants, traits, implementations,
type aliases and associated types, modules, `macro_rules!` macros, functions,
methods, constants, and statics, including those declared directly in a function
body. An implementation is indexed under the first type name in the implementing
type that is not one of its type parameters. The structure walk descends only
into item lists, structure, union, and enumeration bodies, function bodies'
blocks and statements, and error nodes. Over the 33 files, it lists the same
entries as a walk into every node. After 2 of 13,628 single-character insertions
into two fixtures, it lists one method fewer, because error recovery holds the
method inside an expression, which the walk does not enter. Fixtures come from
Infra, danfuzz-land, and gVisor. The [November 2026 Rust
measurement](../history/packages/cli/cf-view-rust-2026-11.md) records the costs
and the coverage check.

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

- [x] Add C, C++, headers, and CUDA.
- [x] Add assembly.
- [ ] Add linker scripts.
- [ ] Add Protocol Buffers and protobuf text format.
- [ ] Add Packetdrill.
- [x] Use a neutral C-family mode for ambiguous headers.
- [ ] Establish an ambiguous header's dialect from its project, in direct files
  and diffs.
- [ ] Color C-family macro bodies, and read through the annotation macros that
  the grammars cannot parse, such as `class GTEST_API_ Foo`.

C, C++, headers, and CUDA are implemented ahead of the rest of this stage. A
November 13, 2026 read of the local checkouts of the organization's
repositories found 469 C-family files in 5 repositories: 464 on gVisor's
`cfc_v2` branch, which are 353 `.cc`, 85 `.h`, 22 `.c`, and 4 `.cu` files, and
one or two each in Labs, Loom, Infra, and the `commonfabric-weaver` repository.
The six months before the read hold 12 path-change events on C-family paths: 4
in gVisor, 3 each in Labs and `commonfabric-weaver`, and 1 each in Infra and
Loom. The read also found three Objective-C files, named `.m`, in Infra, which
no item in this plan covers.

C runs on the Tree-sitter adapter with the official
[`tree-sitter/tree-sitter-c`](https://github.com/tree-sitter/tree-sitter-c)
grammar, and C++, CUDA, and headers with the official
[`tree-sitter/tree-sitter-cpp`](https://github.com/tree-sitter/tree-sitter-cpp)
grammar; each npm package ships its WebAssembly build. A lowercase `.c` selects
C. `.cc`, `.cpp`, `.cxx`, `.c++`, `.hh`, `.hpp`, `.hxx`, `.h++`, `.tcc`, and an
uppercase `.C`, which compilers read as C++, select C++, and `.cu` and `.cuh`
select CUDA. The CUDA grammar attaches its WebAssembly
build to its GitHub releases but no npm package carries it, so CUDA uses the
C++ grammar, with CUDA's qualifiers, such as `__global__`, colored as keywords.
That grammar reads a kernel launch's `<<<` and `>>>` as shift operators around
a region it could not parse. C keeps its own grammar because the C++ grammar
cannot parse C that uses C++'s keywords as names, such as `int template = 1;`
or `this->next`, and because the C grammar initializes in about half the time.

A `.h` header selects a mode named `c-family-header`, which claims neither
dialect and parses with the C++ grammar. That grammar reads the declarations C
headers usually make: over the 86 surveyed headers, 12 of them written in C, it
could not parse 0.25 percent of lines, against 20.32 percent for the C grammar.
It cannot parse C that uses one of C++'s keywords as a name, which none of the
surveyed headers does. Selection reads a name and a source, not the project
around them, so for now only an explicit language names a header's dialect, and
the explicit language options apply to piped source alone: a header piped with
`--language c` is colored as C, and a header named on the command line or in a
diff is colored with the C++ grammar. Establishing the dialect from the project
is an open item above.

Structure covers functions and their prototypes, each name declared at a file's
top level and in types, named structures, unions, enumerations, and classes,
typedefs and `using` aliases, macros, and namespaces. A member of a class, and a
qualified definition such as `FileDescriptor::reset`, is a method, indexed under
its own name. A definition that a macro expands to, such as Google Test's
`TEST_F(Suite, Name) {`, is labeled with the whole macro call. The highlight
query colors a defined or called name qualified by one or two scopes, such as
`std::chrono::now`; one qualified by three or more is an identifier, because
each further level makes the C++ grammar's query costlier to compile.

A coverage check over the 469 files found every file reconstructed exactly. The
grammars could not parse part of 71 files, covering 0.46 percent of lines,
mostly at macros they cannot see through: eBPF `section("maps")` annotations,
register variables bound to named registers with `asm`, and classes declared
through annotation macros, which the structure tree then lists as variables
without their members. 0.22 percent of characters other than white space have
no token class, almost all of them in macro bodies, which both grammars leave
as one unparsed token. The item above about macro bodies and annotation macros
covers both. Fixtures come from gVisor and Labs. The
[November 2026 C-family measurement](../history/packages/cli/cf-view-c-family-2026-11.md)
records the costs and the coverage check.

Completion gate: every systems-language family in the active gVisor branch
passes direct-file and diff fixtures.

Assembly is implemented ahead of the rest of this stage. A November 13, 2026
read of the local checkouts of the organization's repositories found 64
assembly files, all in gVisor: 56 Go assembler files named `.s`, and 8 GNU
assembler files named `.S`, which the C preprocessor reads first. The six months
before the read hold no path-change events on them. A ninth `.S` file,
`pie.lds.S`, is a linker script, which the linker-script item covers.

Assembly uses a focused scanner. The one Tree-sitter assembly grammar,
[`RubixDev/tree-sitter-asm`](https://github.com/RubixDev/tree-sitter-asm),
publishes neither an npm package nor a release holding its WebAssembly build.
Both dialects share a lexical syntax that a scanner reads directly: `//` and
`/*` comments, preprocessor lines, and statements made of labels, a directive or
a mnemonic, and operands. `.s` and `.S` select the language, apart from
`.lds.S`. The structure tree lists the functions that the Go assembler's `TEXT`
directive declares, directly or through a call of a function-like `#define`
macro that passes one of its parameters to it, under the argument that parameter
receives; a macro sees the macros defined before it, and its call of itself adds
nothing. Each line of a `#define` body that a `\` continues is a statement of
its own, as the Go assembler reads it. It also lists the symbols that the
`GLOBL` directive declares, `#define` and `.macro` macros, and labels. A label
that an earlier GNU `.type` directive declares as a function or an object is
listed as one. Any other label is listed inside the function it follows, and a
macro inside the label or function whose code continues after it. Numeric local
labels and the labels and functions in a macro's body are not listed.

The scanner gave a token class to every character other than white space in the
64 files, and reconstructed each file exactly. Timing ran on 100 kilobytes of
gVisor's assembly in three rounds, each beside a makefile control run, on a
machine whose load average was near 13; the control's 95th percentiles were 0.8
to 1.6 times the figures recorded for it. The assembly scanner's 95th
percentiles were at most 6.8 milliseconds for a full highlight, 4.9 for a
document parse, and 4.1 for a re-color after one edit, inside the maximums for a
parser-backed language. Each of the 100-kilobyte inputs measured that were built
to slow the scanner, such as one line of 25,000 operands or 33,000 unclosed
quotes, parsed in under 21 milliseconds of processor time at the 95th
percentile. The slowest was 33,000 labels, at 44, whose cost is in the structure
building the languages share: 33,000 INI keys took 37 in the same run. The
fixture comes from gVisor.

## Stage 13: remaining active text formats

- [ ] Add Ruby, Rack, ERB, Gemfiles, and Bundler lock files.
- [ ] Add TeX and BibTeX.
- [x] Add Org mode.
- [ ] Add SQL.
- [x] Add CSV, TSV, and numeric `.dat` tables.
- [ ] Add structured JSON log records.
- [x] Add Graphviz DOT.
- [ ] Add Handlebars and generic `.in` templates.
- [x] Classify application-specific configuration when it has stable syntax.
- [x] Keep prose, logs, checksums, versions, PID files, and opaque task records
  as plain text.
- [ ] Add Objective-C, jq, and AppleScript, which the November 2026 read found
  in Infra and Loom.

Delimited tables are implemented ahead of the rest of this stage. A November
13, 2026 read of the default branches in the local checkouts of the
organization's repositories found 37 tables in 5 repositories: 23
comma-separated files, of which 19 are in gVisor, 3 in Labs, and 1 in Resonant
Computing; 4 tab-separated files in Loom; and 10 whitespace-separated `.dat`
tables in Specs, which PGFPlots draws. The six months before the read hold 20
path-change events on them: 3 on the comma-separated files, 4 on the
tab-separated files, and 13 on the `.dat` tables.

One focused scanner reads all three formats, with a dialect for each. A line is
a record. An unquoted field that reads as a decimal number is colored as a
number, any other field that holds more than white space as a string, and a
separator as punctuation. `.csv` selects comma-separated values, read as RFC
4180 defines them: a field that opens with `"` runs to the next quote that is
not doubled, across commas and line breaks, so a live edit in a diff re-colors
the whole file. `.tsv` selects tab-separated values, which have no quoting, and
in which a line that starts with `#` is a comment, as Loom's census tables
write. Spaces and tabs separate a `.dat` table's fields, and a line whose first
character other than spaces and tabs is `#` is a comment, as gnuplot and
PGFPlots read it, and so is one that starts with `%`, as PGFPlots reads it. A file carries no mark of whether its first record names the
columns, so that record is colored like any other. No field is colored as a
boolean, because `TRUE` is one of the surnames in Loom's census table. A table
has no structure tree.

`.dat` names data of every kind, so a `.dat` file is a table only when its first
line other than blank lines and comments, or the next such line, is a row of two
or more numbers; a single number is as likely to be a counter or a process
identifier. A shared extension's evidence is a function of the source. The
`.dat` evidence reads lines until it has seen two that are neither blank nor
comments. The INI, directive configuration, YAML, and dotenv evidence skips blank and
comment lines one at a time until the first other line, and then matches a
regular expression starting at that line. None of them is one regular expression over the whole
source: V8's regular expression engine records a step for each repetition it may
have to undo, so a pattern that repeats once for each line or each number
exhausts its stack on a few million of them.

The scanner reconstructed each of the 37 files exactly and gave every character
other than white space a token class. It was measured on 100 kilobytes of each
format's surveyed source, and on 100-kilobyte inputs built to slow it: an
unclosed quote, a single line of commas, a single line of numbers, a single line
of tabs, tabs between fields of spaces, and rows of a thousand empty
tab-separated fields. The machine's load average was above 150, so no scanner
figure is a direct measurement. Each is an estimate: the properties scanner's recorded
95th percentile multiplied by the largest ratio to a properties control run
seen in six rounds. The largest estimates are 6.5 milliseconds for a full
highlight, 6.4 for a document parse, and 6.2 for a re-color after one edit, all
inside the maximums for a parser-backed language. On 100-kilobyte sources built
to slow the `.dat` evidence, such as 100,000 blank lines before a line of text
or a single row of 50,000 numbers, the evidence took at most 4 milliseconds at
the median, measured directly at a load average near 200.

Fixtures come from gVisor, Labs, Loom, and Specs.

The November 13, 2026 read of the local checkouts of the organization's
repositories listed every tracked file with the language `cf view` selects for
it. Application-specific configuration with a stable syntax uses the language
whose syntax it shares. Netdata's health alerts are directive configuration and
its collector configuration is YAML, as Stage 9 describes. sysusers.d
configuration is directive configuration, and OpenSSL configuration is INI.
Per-platform copies of a Swift package resolution, such as
`Package.resolved.android`, Xcode string catalogs (`.xcstrings`), CPU profiles
(`.cpuprofile`), and Firebase's `.firebaserc` are JSON, and so are `.config` and
`.lock` files whose source opens a JSON object, which covers the
`swift-java.config` in `commonfabric-weaver` and a Deno lock file in Loom with a
name of its own. The plain-text language claims prose (`AUTHORS`,
`CONTRIBUTORS`, `COPYING`, and `CNAME`), captured output (`.stdout` and `.out`),
logs and error output (`.log` and `.stderr`) that do not open with a JSON
object, checksum lists (`SHA256SUMS`, `MD5SUMS`, and those names with a prefix
such as `GO_`, and `.sha256` and `.sha512` files), version files (`VERSION` and
uppercase names ending in `_VERSION`, dot files such as `.python-version`,
`.nvmrc`, and Loom's `protocol-version`), process and port records (`.pid`,
`.pids`, and `.port`), SSH host key files (`known_hosts`, `ssh_known_hosts`, and
the `github-known-hosts` files in Infra and `commonfabric-weaver`) and keys and
certificates (`.pem`, `.crt`, and `.key`), and the empty placeholders `.gitkeep`
and `.nojekyll`. A name it claims stays plain text whatever shebang or
declaration its content starts with. A name that only ends in `version`, such as
a `bump-version` script, is not claimed. Task records with no naming convention,
such as Loom's generation counters and lock markers and the Beads activity
record in Run Orchestrator, remain plain text because no language claims their
names, and a shebang or an XML declaration is the only content that could select
one. The extensionless task records the survey found in Raia are no longer in
its tree.

The same read found syntaxes that no stage lists: Objective-C in Infra, jq and
AppleScript in Loom, a Firestore security rules file, Netlify-style `_redirects`
and `_headers` files, Vue components, SurrealQL, Google Apps Script, a Clang
module map, whose `//` and `/* */` comments directive configuration does not
read, an Xcode project file, and a server-sent event stream fixture. Only the
first three are in the survey's 24 active repositories, so only they are added
above.

A November 13, 2026 read of the local checkouts of the organization's
repositories found Org mode only in gVisor: `cfc-gvisor.org` and
`scenarios.org`, 968 lines in all, on the `cfc_v2` branch and four other
branches. The six months before the read hold 3 path-change events on them.
`.org` selects the language.

Org mode uses a focused scanner. npm carries a Tree-sitter Org grammar,
`@krisfremen/tree-sitter-org`, which republishes the Neovim Org mode project's
fork, but it ships no highlight query, has no node for to-do keywords or for
`~code~` and `=verbatim=` text, and depends on `node-gyp` and other native build
tools. Org's syntax is line-oriented: a line's first characters say
whether it is a headline, a keyword, a block delimiter, a comment, a drawer, a
table row, a list item, or text. The scanner colors each of those, and links,
code and verbatim text, and timestamps inside text. A source block's body is
colored as the language that its first parameter names, through that
language's own highlighting, after the indentation its lines share is removed.
A block of Org inside Org stays literal, because coloring it as Org would scan
each level of nesting again for every level outside it.
A view whose parse starts loading such a language's parser waits for the load
and is built again, so the first view shown has the block colored, and fails,
as for a language it selected, when the parser cannot load. A block whose end
line is missing, or comes after the next headline, is not a block, as in Org,
so an unclosed block leaves the rest of the file colored as Org. The structure
tree lists headlines, each inside the one above it.

Both files reconstruct exactly, and the structure tree lists all 38 of their
headlines. Their 17 `bash` blocks are colored as shell. Their one `go` block is
colored as a string until Go is supported. Paragraph text stays plain, as it
does in Markdown. Under a load average above 200, timed in processor time
beside an INI control run, the scanner colored 100 kilobytes of those files in
5.0 milliseconds at the 95th percentile, parsed it with structure in 4.7, and
re-colored it after one edit in 7.0. Those figures come from the one round of
three whose control, at 2.9 milliseconds, stayed near INI's recorded figure of
under 2; in the other two the control took 12 to 17 milliseconds and Org 20
to 29.

Each 100-kilobyte input built to slow the scanner that was measured, under the
same load, took under 50 milliseconds of processor time, except those made of
source blocks. Such inputs include one line of unclosed links or code markers,
a headline of white space, block openings before their end lines, and Org
blocks nested 300 deep. Each source block is colored by a parse of its own, so
about 3,000 one-line `bash` blocks took 118 to 146 milliseconds and as many
`python` blocks 36 to 72; the surveyed files hold 18 blocks. The fixture comes from gVisor.

Graphviz DOT is implemented. A November 13, 2026 read of the local checkouts
of the organization's repositories found one DOT file, gVisor's
`pkg/sentry/kernel/g3doc/run_states.dot`, which no commit changed in the six
months before the read, and no other file whose source opens a graph. Labs
prints DOT from `cf inspect graph --dot` and `cf piece map --format dot`, and
`--language dot` selects it for that output when it is piped in. `.dot` and
`.gv` select the language, and `graphviz` and `gv` name it as well. A `.dot`
file holding a NUL byte, as a Word template does, is binary.

The language uses a focused scanner. The one Tree-sitter DOT grammar on npm,
`tree-sitter-dot` 0.1.5, is not an official grammar, was last published in
2021, and ships no WebAssembly build. DOT's lexical syntax is small: comments,
four forms of ID, six keywords, two edge operators, and punctuation. The scanner
colors an ID by what it names: a graph, an attribute, an attribute's value, a
port, or a node. Every character other than white space in the gVisor file, and
in the DOT that `cf inspect graph --dot` prints, has a token class, and each
reconstructs exactly.

The timings were measured in processor time, because the machine was so loaded
that elapsed time mostly measured waiting for a processor. INI control runs
beside them took 2.9 to 8.1 milliseconds at the 95th percentile, against the
under 2 recorded for INI. The scanner re-colors 100 kilobytes of DOT shaped like
the gVisor file, or like the output of `cf inspect graph --dot`, in under 7
milliseconds at the 95th percentile, and parses it with structure in under 7.
The inputs built to slow it are slower. Each fills 100 kilobytes with tens of
thousands of tokens, such as a single chain of 51,200 ports or 51,200 node
statements. They re-color in 24 to 59 milliseconds at the 95th percentile, and
parse in 29 to 130. The parse is slowest where every token is a node that the
structure tree lists. In the same runs, INI took 91 to 115 milliseconds to parse
51,200 keys, and DOT took 90 to 136 to parse 51,200 nodes. The fixture comes
from gVisor.

Completion gate: every textual syntax in the survey's 24 active repositories
has a tested selector and highlighter or an explicit plain-text classification.

## Stage 14: Kotlin and Android build configuration

Kotlin and the Android build formats are implemented ahead of Stages 3 to 9,
as Swift was. The July survey predates the Android port of the
`commonfabric-weaver` repository. A September 25, 2026 read of that repository
found 453 Kotlin source and script files, 10 XML manifests and resources, 2
Java properties files, and one ProGuard rules file. The six months before the
read hold 1,035 path-change events on those Kotlin paths, 14 on the XML, 3 on
the properties files, and 1 on the rules file. No other local checkout of an
organization repository holds Kotlin, Java properties, or ProGuard rules, and
none holds Java source or Groovy Gradle scripts.

- [x] Add Kotlin source and Kotlin scripts, which cover Gradle's
  `build.gradle.kts` and `settings.gradle.kts`.
- [x] Add Gradle version catalogs through TOML.
- [x] Add Java properties files, which cover `gradle.properties` and the Gradle
  wrapper's settings.
- [x] Add ProGuard and R8 keep rules.
- [x] Add Android manifests and resources through XML.
- [x] Add a `commonfabric-weaver` fixture for each format.

Kotlin runs on the Tree-sitter adapter with the
[`tree-sitter-grammars/tree-sitter-kotlin`](https://github.com/tree-sitter-grammars/tree-sitter-kotlin)
grammar, through a package holding only its WebAssembly build;
`runtime/cli/lib/view/DEPENDENCIES.md` gives the procedure for rolling it. The
grammar ends a statement at a line break between a catch block and a `catch` or
`finally` clause after it, and then misreads the clause or leaves the whole
declaration holding it unparsed. The adapter hands the parser each such line
break as a space, which it does for any grammar that names the stretches of
source whose line breaks the language ignores. A line break that ends a line
comment after the block stays, because it ends the comment, so a clause after
such a comment is left to the grammar. A coverage check over the 453 Kotlin
files found every file reconstructed exactly and 1.35 percent of characters
other than white space without a token class. Semicolons, which the grammar
consumes without a node a query can name, are 2,081 of those characters. 21
files hold a region the parser could not parse, covering 2.22 percent of lines.
Without the line-break handling, those figures are 9.5 percent, 54 files, and
14.8 percent.

Structure covers classes, interfaces, enumerations, objects, companion objects,
type aliases, functions, methods, secondary constructors, initializer blocks,
and each property declared on a type, in a primary constructor, or at file
level, under the first name it binds. `.kt` and `.kts` select Kotlin, and so do
`kotlin` shebangs.

Java properties files and ProGuard rules use focused scanners. The Tree-sitter
properties grammar lexes keys and values one character at a time, and
re-colored a 100-kilobyte file in 39 milliseconds at the 95th percentile, over
the 25-millisecond maximum; the scanner colors the same file in about 5
milliseconds. No Tree-sitter grammar exists for ProGuard rules. `.pro` is also
the suffix of Qt project files and Prolog, and a Qt project's continuation
lines can start with compiler flags, so a `.pro` file is ProGuard only when a
line starts with one of ProGuard's option names, apart from the two names an
Android module template creates.

The
[September 2026 Android formats measurement](../history/packages/cli/cf-view-android-formats-2026-09.md)
records the costs and the coverage checks.

Completion gate: every Kotlin, Gradle, properties, ProGuard, and Android XML
file in `commonfabric-weaver` selects its language, and direct files, diffs,
and incomplete edits pass the shared fixture contract. The gate passes.
