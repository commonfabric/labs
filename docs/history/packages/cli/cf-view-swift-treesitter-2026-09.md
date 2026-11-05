---
status: historical
created: 2026-09-22
archived: 2026-09-22
reason: "Point-in-time measurements of the shipped cf view Swift parser path."
---

# `cf view` Swift on Tree-sitter: shipped measurements

This report records what the shipped `cf view` Swift path costs, measured
against the operating maximums in the
[`cf view` language coverage plan](../../../plans/cf-view-language-coverage.md).
Swift is the second language on the shared Tree-sitter adapter, and the first
whose grammar is neither an official Tree-sitter grammar nor distributed on npm
by its own author. It also records how that grammar was chosen and how well it
covers the Swift in the organization's repositories.

Every recorded maximum is met. Two of them were not met by the first working
version, and the changes that brought them inside are described under "Query
compilation" and "The structure walk".

## Environment and method

The measurements ran on a MacBook Pro identified as `Mac17,6`, with an Apple M5
Max, 18 cores and 128 GB of memory, running arm64 macOS 26.6.2 with Deno 2.9.4,
V8 15.0.245.2-rusty, and TypeScript 6.0.3. They used `web-tree-sitter` 0.26.12
and `@binclusive/tree-sitter-swift-wasm` 0.1.0, described under "The grammar
package". The dependency cache was warm.

The adjacent retained [probe](cf-view-swift-treesitter-2026-09-probe.ts) is the
Python probe of the
[September 2026 Python measurement](cf-view-python-treesitter-2026-09.md) with
the Swift language and a Swift source substituted, so the two compare directly.
It runs from `packages/cli`:

```sh
cd packages/cli
deno run --allow-read --allow-env --allow-run \
  ../../docs/history/packages/cli/cf-view-swift-treesitter-2026-09-probe.ts
```

The source repeats a seven-line unit — an attributed generic class holding an
asynchronous throwing method whose body interpolates a call into a string —
after one line of non-ASCII comment, to exactly 100,009 UTF-8 bytes. The edit
renames the first `renderItem` after the middle of the source to `renderUnit`.
Sample counts and the operations timed are the Python probe's: 40
fresh-process initialization samples, and 50 each of a complete highlight, a
document parse with structure, and a re-color after one edit. No deadline,
retry, or sleep participated. The adjacent raw
[results](cf-view-swift-treesitter-2026-09-results.json) contain every sample.

## Results

| Dimension | Median | Shipped Swift | Accepted maximum |
| --- | ---: | ---: | ---: |
| 95th-percentile lazy initialization | 69.24 ms | 71.98 ms | 75 ms |
| 95th-percentile full highlighting | 29.64 ms | 37.69 ms | 50 ms |
| 95th-percentile document parse, with structure | 37.24 ms | 39.08 ms | 50 ms |
| 95th-percentile re-color after one edit | 14.59 ms | 15.36 ms | 25 ms |
| Compiled `cf` increase | | 3.72 MiB | 10 MiB for a later grammar |
| Unpacked dependencies | | 3.66 MiB | 10 MiB for a later grammar |
| Owned source | | 200 lines | 200 lines for a later grammar |
| Parser-specific build and deployment steps | | 0 | 0 |

The unpacked dependency figure is the sum of every file in the cached package
directory, 3,840,612 bytes; the package has no dependencies of its own. The
compiled figure comes from building `dist/cf` with `deno task build-binaries cf`
from this change and from a worktree of its merge base: 764,220,018 bytes
against 760,323,186, an increase of 3,896,832 bytes. The build ran with no step
of its own for the grammar, and the binary it produced colored a `.swift` file.

Owned source is
`packages/cli/lib/view/languages/swift/swift.ts`. The language descriptor beside
it is not counted, as Python's was not. The shared adapter grew by 16 lines, to
490, for the correction under "Runtime initialization", which counts toward the
plan's cumulative maximum rather than toward Swift's.

## The grammar package

The Swift grammar is
[`alex-pinkus/tree-sitter-swift`](https://github.com/alex-pinkus/tree-sitter-swift),
which is not part of the Tree-sitter organization. Its npm package,
`tree-sitter-swift` 0.7.1, ships generated C sources and native Node.js
bindings, 75.9 MB unpacked, and no WebAssembly grammar. Building one from it is
a parser-specific build step, whose maximum is zero. The upstream project
attaches a compiled `tree-sitter-swift.wasm` to each GitHub release, most
recently 0.7.3.

Three npm packages carry a compiled Swift grammar:

| Package | Unpacked | Swift grammar | Other contents |
| --- | ---: | --- | --- |
| `tree-sitter-wasms` 0.1.13 | 51.8 MB | built from the 0.4 sources with Tree-sitter 0.20 | 35 other grammars |
| `@repomix/tree-sitter-wasms` 0.1.17 | 23.9 MB | built from the 0.7.1 sources | 16 other grammars |
| `@binclusive/tree-sitter-swift-wasm` 0.1.0 | 3.8 MB | the 0.7.3 release asset | a checksum module and its documentation |

The first two exceed the 10 MiB a later grammar may add. The third holds the
upstream release asset: its `wasm/tree-sitter-swift.wasm` and the asset
downloaded from the upstream 0.7.3 release both have the SHA-256
`0258a7ef17303a8079ffe0748b3583d59656b5c3e8653fca7b6451b3e6689eb2`. It is
pinned exactly, and the lockfile's integrity hash holds the installed package to
the bytes that were compared. A republished grammar carries the risk that a
later version holds different bytes, which the roll procedure in
`docs/development/DEPENDENCIES.md` addresses by comparing digests before each
roll.

## Grammar coverage

The plan makes Tree-sitter the default for a later language only after checking
its grammar coverage. The check read every Swift file in local checkouts of
Fabric Mobile, gVisor, Loom, Loom Scripts, and the Weaver app, 1,039 files and
294,246 lines.

Every file's highlighted lines reconstructed its source exactly. Of the
non-whitespace characters, 0.071 percent carried no token class. Most of those
are statement-separating semicolons, which the grammar consumes without a node
a query can name, and backslashes opening a key path, which the query leaves
uncolored because the same token opens an escape inside a string. The rest are
inside regions the parser could not parse.

112 files contained a region the parser could not parse, covering 12,238 lines,
or 4.2 percent. Every one of those files is in the Weaver app, and three of
them account for 8,042 of the lines, because an error near the top of each
wraps the rest of the file. Coloring continues inside such a region, since the
parser still builds the nodes it recognizes there; the uncolored figure above
includes them. The 42 files from the four repositories the July survey covered
contained 9 such lines, in 5 files. One construct that produces such a region
is a conditional cast followed by nil coalescing, as in
`json["present"] as? Bool ?? false`, which a three-line function holding only
that statement reproduces. The Weaver app has 141 lines of that form. The
causes of the other regions were not isolated.

The grammar also reads `defer` and `fallthrough` as ordinary names rather than
as statements, so the highlight query names those two spellings explicitly.

## Query compilation

The first working version took 99.24 ms to initialize at the 95th percentile,
against a 75 ms maximum. Loading the runtime and the grammar and parsing an
empty source took about 28 ms of that; compiling the highlight query took 64
ms. Python's complete query compiles in 3.6 ms.

Compiling a query analyzes each pattern that constrains a node's parent against
the grammar's parse table, and the Swift grammar's WebAssembly module is 3.8
MB against Python's 0.46 MB. A query holding one leaf pattern took 4.3 ms to
compile. Removing one pattern at a time from the complete query showed the cost
concentrated in patterns whose parent is a node that appears in many parse
states: the three patterns naming a callee inside `call_expression` cost 27 ms
between them, and naming a function's name through `function_declaration` cost
11 ms on its own.

The shipped query matches those names by the token beside them instead: a
function's name is the identifier after `func`, a type's name is what follows
its declaring keyword, and a callee is whatever sits immediately before a call
suffix. That selects the same tokens, as the corpus above and the fixtures
confirm, and one alternation replaced the three callee patterns. The complete
query now compiles in about 23 ms, and initialization is 71.98 ms at the 95th
percentile.

## The structure walk

The first working version's document parse was 52.23 ms at the 95th
percentile, against a 50 ms maximum. The adapter's structure walk asks the
grammar about every node, and that version looked up each node's name and
parent before deciding whether the node was a declaration, each lookup being a
call into the parser's WebAssembly memory. Looking them up only for a
declaration brought the parse to 39.08 ms.

## Runtime initialization

Swift is the adapter's second grammar, and loading two at once exposed a defect
in the shared adapter. Every grammar load called the runtime's initialization,
which creates the WebAssembly module when none exists; two loads that started
together each created one, and the second replaced the first. A grammar loaded
into the replaced module then failed on first use with
`Incompatible language version 0`. The interactive pager then loaded every
language's grammar at once, which left one of the two grammars failing this
way. The adapter now initializes the runtime once. A test that loads Python's grammar
under two identifiers at once, in a fresh process, fails without the correction
for that reason.

## Loading only the grammars a view shows

The interactive pager loaded every language's grammar once its first frame was
drawn, and read its first key after they had all loaded, because the file
picker opens a file in any language and answers a keystroke synchronously.
Timing that warm-up in 15 fresh processes gave a median of 48.2 ms with Python
and Swift, against 13.2 ms with Python alone, so Swift would have made every
interactive view wait 35 ms longer before reading a key, whatever file it
showed.

The pager no longer loads any grammar up front. A view loads the grammars of
the languages it shows before its first frame, as a redirected view already
did. A file opened later in a language whose grammar has not loaded is drawn as
plain text while that grammar loads, and the pager parses it again when the
grammar loads, or shows the reason in its status line when it cannot.
