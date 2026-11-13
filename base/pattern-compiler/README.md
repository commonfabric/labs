# pattern-compiler

A prototype of the front end of the compiled pattern language, which
[`docs/specs/compiled-pattern-language/`](../../docs/specs/compiled-pattern-language/README.md)
proposes. The language is a subset of TypeScript, and the design gives it a
compiler of its own, written in Rust. This crate is the first part of stage 2 of
that design's staging: it shows how much of the pattern corpus the rules of the
subset accept.

Nothing in the repository depends on this crate, and no continuous-integration
job builds or tests it. It is not a Deno workspace member.

## What it covers

- **Parsing.** `.ts` and `.tsx` modules, with a position for every diagnostic.
- **The module model.** Each module's imports, its module-scope definitions, its
  exports, and whether it begins with the `"use typescript";` directive. A name
  from `commonfabric` is recognized by resolving it through its import, never by
  how it is written.
- **Tiers.** Every function body is classified as module scope, the reactive
  tier, the function tier, or imported TypeScript, as
  [`language-subset.md`](../../docs/specs/compiled-pattern-language/language-subset.md)
  §1 defines them. Each body is recorded with its kind, where it is written, the
  body that encloses it, what it captures, and the runtime calls it makes.
- **Rules.** The rules of `language-subset.md` §3, §4, and §5 that syntax and
  name resolution decide, and the rules of §7 and §8 that the type of an
  expression decides, reported under the identifiers of that document's §10. The
  promotion criterion of its §6.1 is applied by syntax and with types, and the
  typed outcome decides wherever every type it reads is evaluated.
- **The corpus report.** How many modules of `patterns/` are accepted, the count
  of each diagnostic, the number of bodies of each kind, and the count of each
  removed form.

## What it does not cover

It has no footprint analysis and no code or plan emission. Its type checker
resolves written types and the declared types of bindings, infers the types of
call results, standard-library members, operators, literals, and callback
parameters, narrows a reference by the conditions around it and by the
assignments to a `let`, and decides assignability (`language-subset.md` §7.5)
at four sites: an argument, an attribute of a tag that names a pattern, a
returned value under a written return type, and an initializer under an
annotation. The arguments of a pattern, of a handler, and of a `lift` result
written in the reactive tier are bound by reference (§7.5.2). It does not check
a generic function per instantiation, and it does not apply assignability at an
assignment or at the argument of a handle method. Where it has no type for an
expression, the expression is counted under the reason, and a rule that needs
the type counts the site as not decided and reports nothing. `SPEC-NOTES.md`
lists the places where the specification was ambiguous or could not be
implemented as written, with the reading this crate chose.

The `catalog` command prints, for each entry of the diagnostics catalog, whether
the crate implements it, implements the part syntax decides, leaves it to the
type checker or to footprint analysis, or lists it as retired.
`tests/catalog.rs` compares that table with the identifiers in the
specification, so the two cannot differ without a failing test.

## The parser

The crate parses with the [`oxc`](https://oxc.rs) crates and does not tokenize
or parse TypeScript itself. `oxc` was chosen over `swc` for three reasons: its
scope analysis (`oxc_semantic`) resolves every identifier to its declaration,
which the rule "resolve a name through its import" needs; its syntax tree keeps
TypeScript type syntax and JSX in one tree with byte spans; and it compiles in
seconds with few dependencies. The crates are pinned to `0.133.0`, the newest
release that builds with the Rust 1.93 toolchain.

## Layout

| Module                   | Holds                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `parse`                  | The call into the parser and the scope analysis                                                                       |
| `module`                 | The module model: imports, definitions, exports                                                                       |
| `api`                    | The `commonfabric` exports, the methods of a cell handle, and the standard-library surface of `language-subset.md` §9 |
| `tiers`                  | The records of bodies, captures, and call sites that the later stages read                                            |
| `check`                  | The walk that classifies code into tiers and applies the rules                                                        |
| `types`                  | The representation of types, the resolution of written types, and the rules it decides (`language-subset.md` §7, §8)  |
| `declared`               | The declared type of a binding and of an expression that names one                                                    |
| `infer`                  | The types no declaration gives: call results, standard-library members, operators, literals, and callback parameters  |
| `narrow`                 | The type of a reference where a condition has been tested (`language-subset.md` §7.6)                                 |
| `assign`                 | Assignability (`language-subset.md` §7.5, §7.5.1, §7.5.2) and the sites it is checked at                              |
| `typed`                  | The other catalog rules that read the type of an expression: property reads, casts, pattern results, generic calls    |
| `program`                | A set of modules, the resolution of imports between them, and the rules that follow a call into another function      |
| `catalog`, `diagnostics` | The diagnostics catalog and the diagnostic record                                                                     |
| `corpus`, `report`       | Which files are the corpus, and the report over them                                                                  |

Footprint analysis reads the body records of `tiers`.

## What the corpus report counts for the type checker

Beside the diagnostics, `corpus` prints counts whose names begin with `types:`.
`types:receiver:` and `types:collection:` say, for the receiver of each method
call and for each per-element collection, whether it has a type, and if not,
why. `types:written:` says how far each written type was evaluated.
`types:assignability:` says, for each argument by its callee and by where the
call is written, and for each attribute of a pattern tag, returned value, and
initializer, whether it is assignable, refused (with the kind of difference), or
not decided. `types:rule:` says the same for the rules of `typed`.
`types:by-reference:` counts each value bound where a writable handle is
declared by what the value is, and `types:sites:` counts the sites the open
questions of the specification ask about: a handle of a known type given where a
handle of `unknown` is declared, a write through a handle of `unknown`, a type
name of the DOM library, and an argument of an authored function called in the
reactive tier that is not accepted. `corpus --sites` lists those sites with
their source text. The report also prints the promotion of `computed` by the
syntactic and by the typed criterion, and the calls the two decide differently.

`tests/narrowing.rs` reads the type of an expression through
`program::types_at_markers`, which takes a source text with `/*?*/` before each
expression of interest.

## Build, test, and run

```sh
cd base/pattern-compiler
cargo build --release
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check

cargo run --release -- catalog
cargo run --release -- check path/to/module.tsx path/to/other.ts
cargo run --release -- check --hints path/to/module.tsx
cargo run --release -- bodies path/to/module.tsx
cargo run --release -- types path/to/module.tsx
cargo run --release -- corpus ../../patterns
cargo run --release -- corpus ../../patterns --json
cargo run --release -- corpus ../../patterns --files
cargo run --release -- corpus ../../patterns --diagnostics
cargo run --release -- corpus ../../patterns --sites
```

`check` takes the modules of one program: an import between two of them is
resolved, and an import of a module that is not given is left unresolved.
`bodies` prints the body records as JSON. `corpus` takes the path of the
`patterns` directory, prints the report, and exits with a failure when a module
does not parse. The corpus is the set of files the corpus measurement beside the
specification uses: the files `deno task cfcheck` compiles, with what they
import by relative path, without the files that share no program with pattern
code.

## The specification it implements

The crate follows `language-subset.md` as it stands at commit `d0973bc0de`.
`catalog-ids.txt` holds the identifiers of that document's catalog, and
`cargo test` fails when the document's catalog and the copy differ. To follow a
change of the catalog, edit `catalog-ids.txt` and the table in `src/catalog.rs`
together.
