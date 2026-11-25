# `cf view` dependencies

This is the maintenance guide for the dependencies of `cf view`, the CLI's
terminal file viewer: the Tree-sitter runtime and the grammar packages its
languages load. The repository's
[dependency guide](../../../../docs/development/DEPENDENCIES.md) covers adding
and rolling dependencies in general.

## Tree-sitter

The CLI pins `web-tree-sitter` and `tree-sitter-python` exactly. `cf view`
colors and navigates Python through them, and a grammar package ships a compiled
parser whose binary interface has to match the runtime that loads it. A range on
either would let an install pair a parser with a runtime that rejects it, which
fails when a view opens a Python file rather than when the dependency resolves.
Roll the two together, and run the `cf view` Python tests afterward.

`tree-sitter-python` is reached in two ways, both of which have to keep working.
`runtime/cli/lib/view/languages/python/python.ts` imports its `package.json`,
which is what makes the package present, and resolves the compiled grammar
beside it with `import.meta.resolve`, which the adapter then reads as a file. A
source run resolves that through the Deno cache, and
`deno task build-binaries cf` embeds it in the binary with no step of its own.
Neither path is exercised by type checking, so a change to either is checked by
running `cf view` against a `.py` file.

Starlark, whose syntax is a subset of Python's, runs on the same compiled
grammar through `runtime/cli/lib/view/languages/starlark/starlark.ts`, with
Python's highlight query and one pattern of its own. Rolling
`tree-sitter-python` therefore also needs the `cf view` Starlark tests, and
`cf view` against a Bazel `BUILD` file.

Swift reaches its grammar the same way, through
`runtime/cli/lib/view/languages/swift/swift.ts`, and the CLI pins
`@binclusive/tree-sitter-swift-wasm` exactly as well. The Swift grammar is
[`alex-pinkus/tree-sitter-swift`](https://github.com/alex-pinkus/tree-sitter-swift),
whose own npm package ships no compiled WebAssembly grammar; its WebAssembly
build is published only as an asset on each GitHub release. The pinned package
contains that release asset and nothing the pager uses besides it. Version 0.1.0
holds the 0.7.3 release's `tree-sitter-swift.wasm`, whose SHA-256 is
`0258a7ef17303a8079ffe0748b3583d59656b5c3e8653fca7b6451b3e6689eb2`, the digest
of the asset downloaded from the upstream release. Before rolling it, download
the new release's asset from the upstream repository and confirm that the
package's `wasm/tree-sitter-swift.wasm` has the same digest; the lockfile's
integrity hash then holds the package to those bytes. Run the `cf view` Swift
tests afterward, and `cf view` against a `.swift` file.

Kotlin reaches its grammar through
`runtime/cli/lib/view/languages/kotlin/kotlin.ts`, and the CLI pins
`@binclusive/tree-sitter-kotlin-wasm` exactly. The Kotlin grammar is
[`tree-sitter-grammars/tree-sitter-kotlin`](https://github.com/tree-sitter-grammars/tree-sitter-kotlin),
whose own npm package ships its WebAssembly build beside 44 MB of generated C
source and native bindings, a development tool as a runtime dependency, and an
install script. The pinned package holds only that WebAssembly build. Version
0.1.0 holds the 1.1.0 release's `tree-sitter-kotlin.wasm`, whose SHA-256 is
`7009d69453bc8735e438b2818a633efb21c88f99782769abba60dffedfab73f7`, the digest
of both the asset attached to the upstream release and the file in the upstream
npm package. Before rolling it, confirm that the package's
`wasm/tree-sitter-kotlin.wasm` has the digest of the new upstream release's
asset. Like every grammar, it has to match the `web-tree-sitter` runtime's
binary interface, so roll it with the runtime. Run the `cf view` Kotlin tests
afterward, and `cf view` against a `.kt` file.

TOML reaches its grammar through `runtime/cli/lib/view/languages/toml/toml.ts`,
and the CLI pins `@tree-sitter-grammars/tree-sitter-toml` exactly. That package
is the grammar's own and ships its WebAssembly build. Like `tree-sitter-python`,
it also ships native bindings and an install script that builds them, which the
pager never loads; the whole package is 0.76 MB unpacked, and its two
dependencies are the ones `tree-sitter-python` already brings. Roll it with the
runtime, then run the `cf view` TOML tests and `cf view` against a `.toml` file.

HCL reaches its grammar through `runtime/cli/lib/view/languages/hcl/hcl.ts`, and
the CLI pins `@tree-sitter-grammars/tree-sitter-hcl` exactly. That package is
the grammar's own and ships WebAssembly builds of HCL and of a Terraform dialect
with the same rules, of which the pager loads the HCL one. Like
`tree-sitter-python`, it also ships generated C source, native bindings, and an
install script, which the pager never uses; its dependencies are the two
`tree-sitter-python` already brings. Roll it with the runtime, then run the
`cf view` HCL tests and `cf view` against a `.tf` file.

Rust reaches its grammar through `runtime/cli/lib/view/languages/rust/rust.ts`,
and the CLI pins `tree-sitter-rust` exactly. That package is the official Rust
grammar and ships its WebAssembly build. Like `tree-sitter-python`, it also
ships generated C source, native bindings, and an install script, which the
pager never uses; its dependencies are the two `tree-sitter-python` already
brings. Roll it with the runtime, then run the `cf view` Rust tests and
`cf view` against a `.rs` file.

C, C++, CUDA, and C-family headers reach their grammars through
`runtime/cli/lib/view/languages/c-family/c-family.ts`, and the CLI pins
`tree-sitter-c` and `tree-sitter-cpp` exactly. Both packages are the official
grammars and ship their WebAssembly builds; the pager loads the C grammar for C
and the C++ grammar for the rest. `tree-sitter-cpp` depends on `tree-sitter-c`
through a version range, and the C pin is chosen inside that range so that the
lockfile holds one copy of it. Like `tree-sitter-python`, both packages also
ship generated C source, native bindings, and an install script, which the pager
never uses. Roll them together and with the runtime, keeping the C pin inside
the range the C++ package names, then run the `cf view` C-family tests and
`cf view` against a `.c` and a `.cc` file.

Shell reaches its grammar through
`runtime/cli/lib/view/languages/shell/shell.ts`, and the CLI pins
`tree-sitter-bash` exactly. That package is the official Bash grammar and ships
its WebAssembly build, which the pager loads for Bash and POSIX shell alike.
Like `tree-sitter-python`, it also ships generated C source, native bindings,
and an install script, which the pager never uses; its dependencies are the two
`tree-sitter-python` already brings. Roll it with the runtime, then run the
`cf view` shell tests and `cf view` against a `.sh` file.

Go reaches its grammar through `runtime/cli/lib/view/languages/go/go.ts`, and
the CLI pins `tree-sitter-go` exactly. That package is the official Go grammar
and ships its WebAssembly build. Like `tree-sitter-python`, it also ships
generated C source, native bindings, and an install script, which the pager
never uses; its dependencies are the two `tree-sitter-python` already brings.
Roll it with the runtime, then run the `cf view` Go tests and `cf view` against
a `.go` file.

CSS reaches its grammar through `runtime/cli/lib/view/languages/css/css.ts`, and
the CLI pins `tree-sitter-css` exactly. That package is the official CSS grammar
and ships its WebAssembly build. Like `tree-sitter-python`, it also ships
generated C source, native bindings, and an install script, which the pager
never uses; its dependencies are the two `tree-sitter-python` already brings.
Roll it with the runtime, then run the `cf view` CSS tests and `cf view` against
a `.css` file.

HTML reaches its grammar through `runtime/cli/lib/view/languages/html/html.ts`,
and the CLI pins `tree-sitter-html` exactly. That package is the official HTML
grammar and ships its WebAssembly build. Like `tree-sitter-python`, it also
ships generated C source, native bindings, and an install script, which the
pager never uses; its dependencies are the two `tree-sitter-python` already
brings. Roll it with the runtime, then run the `cf view` HTML tests and
`cf view` against a `.html` file.
