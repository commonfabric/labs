# The cell reference grammar

## Status

Adopted. This is a decision record for the cell reference grammar — the one
string form that names a cell — and for the mechanism by which that grammar
admits a new requirement. It records the requirements the grammar answers to,
the decisions taken against them, the alternatives a reader would ask about, and
the decisions elsewhere in this tree that each confirms or replaces.

`packages/runner/src/cell-reference.ts` owns the shared reader and renderer.
[Migration](#migration) describes their adoption across callers.
[#6775](https://github.com/commonfabric/labs/issues/6775) is the question this
document answers.

## Vocabulary

Seven nouns, each one thing, in the order a reference names them.

- **Space** — where documents live; written as a DID, or as a **space name**,
  which a session resolves to a DID and a pattern cannot. Today the DID is
  derived from the name (`createSession` in `packages/identity/src/session.ts`);
  a registry could resolve it instead, and the grammar assumes nothing about
  which.
- **Document** — the unit the store holds: an id (`of:fid1:…`, the `id` field)
  and a JSON value (the `value` field), with metadata beside the value. The
  store calls it an entity.
- **Piece** — a running pattern, named by its **result document** — by id, or by
  a **slug**: a name registered in a space, resolved by reading the space's slug
  document for it (`slugIdForSpace` in `packages/runner/src/slugs.ts`), and held
  to lowercase letters, digits, and hyphens. Its inputs live in its **arguments
  document**, which the result's metadata links to; the CLI's "arguments cell"
  is that document's root.
- **Cell** — in this document, a position: a document, a path into its value,
  and a scope. Every reference names a cell, and a document's root is the cell
  whose path is empty; there is no other kind. It is what a `Cell` holds — `id`,
  `space`, `path`, `scope` — and what `cell.key()` steps deeper into; the
  [glossary](../common/concepts/glossary.md#cell) describes the same thing from
  the reactive side, as a unit that holds a value and notifies its readers.
- **Value** — what a cell holds: the JSON at its position. Reading a reference
  returns its value.
- **Path** — the way from a document's root to a cell, as JSON Pointer segments
  (RFC 6901): the `path` field of every link and address. A stored path is an
  array of segments; RFC 6901's `~0` and `~1` escapes belong to the rendered
  string alone. An empty segment is the key `""`, at the end of a reference as
  anywhere else, because the data can hold one: a pattern that names a key from
  an input field a person left blank produces it. A reference is never called a
  path; the whole string is a **reference**.
- **Scope** — which instance of a document: `space`, `user`, or `session`. A
  stored link may also say `inherit`, the containing cell's scope.

Two words for parts of the string: a **member** is one of a piece's documents,
named on the piece segment (`#argument`; `#result` to say the default), and a
**qualifier** is which instance or version of a piece (`@user`, `@pin=`). A
**context** is a cell address with parts missing, supplying what a reference
omits; its cell is the **position** a relative reference is written against.

## Summary

A cell reference is one string that names one cell, read the same way by every
reader in the fabric. It is written at one of three levels, and the head of the
string says which:

```text
//<space>/<piece>[#<member>][@<qualifier>…][<pointer>]     complete
/<piece>[#<member>][@<qualifier>…][<pointer>]              space-relative
<head>[#<member>][@<qualifier>…][<pointer>]  or  <bare>     piece-relative

<pointer>  the path as an RFC 6901 JSON Pointer, leading `/` included
<head>     `.`, or a run of `..` optionally ended by `/.`
<bare>     the pointer without its leading `/`, when its first key is not
           `""`, `.`, or `..`
```

A complete reference names its whole location. A space-relative one takes its
space from the reader's context; a piece-relative one takes its space and piece
from the context and names a path against the context's position. The scope,
when omitted, is the context's at every level, and the empty context's scope is
the base. After the head, every form is one RFC 6901 pointer, in which `.` and
`..` are keys like any other; they mean the position and a climb to its parent
only in the head. Parsing never needs the context — the head decides the level —
and only resolving does.

Three characters carry structure, and each carries exactly one meaning:

- `/` separates segments. Doubled at the head, `//` introduces the space, the
  way it introduces the authority in a URL.
- `@` introduces a **qualifier** on the piece: which instance of it, which
  version of it. A qualifier is written `@name=value`; the scope, the one
  qualifier people type, has the abbreviation `@user`.
- `#` introduces a **member** on the piece: one of its other documents.
  `#argument` names the piece's inputs; `#result` names what the piece segment
  names on its own, and is written only to return there from inside the
  arguments document.

Read from the outside in: the space says where to resolve, the piece says what,
the member says which of its documents, the qualifiers say which instance and
version of it, and the path says where inside it. A reference that carries all
of them:

```text
//did:key:z6MkBakery/of:fid1:Glz…#argument@user@pin=Avcny…rC1c/items/0/title
```

The same cell, written by a reader that can resolve a space name and a slug:

```text
//bakery/glaze-tracker#argument@user/items/0/title
```

And the common case — a same-space, base-scoped cell — is unchanged:

```text
/glaze-tracker/items/0/title
```

From inside that piece — the cell a `--cell` names on the command line — the
path alone:

```text
items/0/title
```

## What this governs

The cell reference grammar: the form `parseReferenceParts` reads, the form its
writers write (R12 names them), and the form every `cf` command reads in its
target positional and prints in every address it publishes — the bare alias
included, since it designates the same piece. The CLI's bare alias
(`pieceId[@scope]`, `pieceId/path` at a link endpoint, and a slug on its own) is
a convenience over this grammar and follows it; `packages/cli/README.md` records
that new capability lands in the reference first and the alias never grows one
the reference lacks. The alias reads a bare string piece-first, where this
grammar reads it as a path against the context's piece
([D1](#d1-qualification-is-positional-the-urls-three-levels)); the CLI keeps the
two apart by slot, offering the alias only where no path competes for the
position, and the `./` form reaches the grammar's reading anywhere.

Three neighboring grammars name related things and are **not** this grammar,
though each is held to it in a stated way:

| Grammar                                                             | Where defined                                                                             | Relation to this document                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shell page URL, `https://<host>/<space>/<piece>/<path>`             | `packages/shell` routes; `parseFabricUrl` in `packages/runner/src/fabric-url.ts` reads it | Mutually translatable with a reference, segment for segment ([R11](#r11--translatable-with-its-siblings))                                                                                                                            |
| Pattern import specifier, `cf:[/<space>/]<ref>[/<subpath>][@<pin>]` | [Pattern imports](pattern-imports/README.md#specifier-syntax)                             | Shares the reserved characters and the trailing-qualifier position; its pin is a qualifier this grammar registers ([D2](#d2--is-the-qualifier-introducer-and-nothing-else))                                                          |
| Projection grammar, `--select 'topic@,topic.title'`                 | `packages/cli/README.md`, "Shell completion"                                              | Its own grammar by its own statement: a list splits on `,`, a path on `.`, and a trailing `@` asks for "a position's address", in its own words. It borrows `@` and `,`; the [inventory](#character-inventory) records the borrowing |

## Requirements

Each requirement names where it comes from. A grammar decision below serves one
or more of these by number, and a future requirement is admitted by being
written here first.

### R1 — One grammar, every reader

The same structure names the same cell in a pattern, in the shell, and at the
CLI's intake seams. Readers differ in what they can _resolve_, and in how — a
pattern resolves from the string alone and so requires a DID and a handle; a
session-holding reader resolves a space name and a slug as well, by whatever
mechanism its session has — and not in what the grammar _admits_.

Source: `packages/cli/README.md` ("the one reference syntax of the fabric"); the
doc comment heading `packages/cli/lib/llm-friendly-ref.ts`.

### R2 — Every dimension of a link's address has a written form

A stored link addresses a cell by `id`, `space`, `path`, and `scope`, and every
value any of those can hold in storage can be written as a reference. In
particular the grammar's scope vocabulary is the storage layer's: `LinkScope` in
`packages/api/index.ts` is `"inherit" | "space" | "user" | "session"`, and all
four are writable.

Source: [Scoped cell instances](scoped-cell-instances.md#goals) requires scope
to be "expressible in TypeScript authoring, generated schema, normalized links,
and serialized sigil links". A stored link's `scope` is a `LinkScope`
(`CellLinkRefPayload` in `packages/runner/src/sigil-types.ts`), which is where
the fourth value lives; the writer's input, `NormalizedFullLink`, is typed to
the three, and the grammar has to write what storage holds rather than what one
caller is typed to pass.

### R3 — The string decides its own shape

Which level a reference is written at, and which characters are the space, the
piece, a member, a qualifier, and the path, is fixed by the string, without a
session, a position, or a schema. What a context supplies for the parts a string
omits is the context's to decide — an interactive reader may hold a default for
every one of them
([Appendix](#appendix-how-an-interactive-reader-supplies-a-context)) — and it
never changes which parts the string carries. Defaulting is resolution; parsing
is the same everywhere.

Source: `parseLLMFriendlyLink(target, space?)` takes the string and at most a
fallback space; the runner has nothing else at link-resolution time.

### R4 — Relative to a context, at each level

A reader that holds a context writes only what the context does not supply. A
context is a space; a space and a piece, at one of the piece's documents; or a
position inside that document — each a prefix of the next, with a scope beside
any of them ([D10](#d10-reader-and-writer-share-one-context) gives the shape).
The levels a reference can be written at are the levels a context can supply,
and a reader with no context refuses a reference that needs one rather than
guessing.

Source: `parseLLMFriendlyLink(target, space)` takes a fallback space; `cf` takes
`--space` (or `CF_SPACE`) and `--cell`, and its positional path is a path
against that cell, and "a relative path never does" begin with `/`
(`packages/cli/README.md`, "Writing the target"); `parseLinkPrimitive` in
`packages/runner/src/link-types.ts` resolves a stored link with no `id` against
its base cell.

### R5 — Absence means the context's, and the empty context is the base

A reference that omits a part means the context's value for that part — at every
level, for every part, the scope included. A reader with no context reads
against the empty one, whose scope is the base: no space means the space the
link is resolved in, no scope means `space`. A writer against the empty context
writes every part, so a string that has to be read anywhere is written against
it, and the relative reading stays a convenience for what a person types rather
than a property of a string in flight.

Source: `createLLMFriendlyLink` writes the space only when it differs from the
context and the scope only when it is not the base; `areNormalizedLinksSame`
compares `scope ?? "space"`.

### R6 — One meaning per character

Within this grammar a structural character means one thing wherever it appears.
Where a segment sits may say _what_ it is; it may not be the only thing that
says what a _character_ is.

Source: #6775.

### R7 — Slot vocabularies do not overlap

A value that is legal in one slot must not also be a legal, differently meaning
value in another slot that is written with the same introducer. Space names are
free-form — `createSession` in `packages/identity/src/session.ts` takes any
string as a derivation seed — so any rule that relies on a space never being
named `user` is a rule the fabric does not enforce.

Source: #6775's measured case, `/@session/<handle>@user`, in which two
`@`-introduced tokens written with scope words name opposite dimensions.

### R8 — Survives a stock interactive shell unquoted

`cf` is typed at a shell, and an address one command prints is pasted into the
next. A character a stock shell rewrites before the program sees it is not
available to the grammar, whatever it would otherwise mean; this is measured
rather than assumed, and the [inventory](#shell-behavior-measured) holds the
table. References containing `#` need quoting under zsh's opt-in
`extendedglob` option. Where a transport can tell, it quotes — a tool that
prints a command line quotes a
reference holding `#`, and `zsh` completion, which runs inside the user's shell,
uses native shell quoting to protect the completed reference. Quote a reference
holding `#` when entering it at a shell with `extendedglob` enabled. A leading
`#` in a wish operand also needs quoting where it would start a shell comment;
Bash completion escapes that leading character.

Source: shell quoting examples in `packages/cli/README.md` and completion in
`packages/cli/lib/completion/script.ts`.

### R9 — The next qualifier costs no new character

A new way to select which instance or version of a piece is meant is admitted by
registering a name, not by reserving a character. One such qualifier is already
scheduled: the pattern-imports pin.

Source: [Pattern imports](pattern-imports/README.md#specifier-syntax) places
`@<pin>` in the trailing slot and reserves `@` for it.

### R10 — Composes across commands

An address one command publishes is the whole target of the next, unchanged: no
reassembly, no flag beside it, no part of it read out and passed separately.

Source: `packages/cli/README.md`, "Every address this CLI publishes is that one
string".

### R11 — Translatable with its siblings

A reference, a shell page URL, and a `cf:` import specifier that name the same
cell translate into one another segment for segment, with no reordering and no
character that one has and another must escape.

Source: `parseFabricUrl` in `packages/runner/src/fabric-url.ts` reads both the
page URL and the reference today, and is where a translation that stopped
holding would first fail.

### R12 — The forms that are emitted keep reading

A stored link is fields — `id`, `space`, `path`, and `scope`
(`packages/runner/src/sigil-types.ts`) — and a reference string is a rendering
of them, so the runtime never needs string compatibility for a link. What holds
the string durably is small and known: the `ref` the cf-harness handle table
keeps with a run's state (`packages/cf-harness/src/contracts/handle-table.ts`),
the `@link` strings the LLM dialog writes into tool results, and rendered
markdown in documents people keep; beyond those, pasted text, tool output, and
documents in this tree.

The grammar is forward-only: what the writer writes and every reader reads. A
change prefers a form nothing emits. Where an emitted form must change, the old
form is read as an **alias** — accepted by readers, written by none — for one
recorded reason, confined so it cannot collide with grammar, and with the
retirement policy stated beside it; [Migration](#aliases) keeps the
table. No alias is precedent for another.

Source: the writers that render a reference today — `createLLMFriendlyLink` in
the runner; `linkAddress` in `packages/patterns/notes/reference-address.ts`, a
copy of it that a pattern can import; `canonicalAddress` in
`packages/cli/lib/callable.ts`; `decomposeUrl` in
`packages/cli/commands/piece.ts`, which renders a `--url`'s space _name_; and
`renderPosition` in `packages/cli/lib/shuttle/place.ts`, which writes what `pwd`
prints — plus the bare form `addressArgument` prints there.

## Character inventory

What each structural character is reserved for, by which grammar, and what it
costs at a shell. The reserved set is deliberately small: a grammar that spends
a character per requirement runs out of characters before it runs out of
requirements, and the shell-safe alphabet below is smaller than it looks.

| Character              | Reserved by                        | Meaning                                                                                                                                                                                         |
| ---------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                    | this grammar                       | segment separator; at the head, `//` opens the space slot, one `/` roots at the context's space, and neither is piece-relative                                                                  |
| `@`                    | this grammar                       | qualifier introducer on the piece ([D2](#d2--is-the-qualifier-introducer-and-nothing-else))                                                                                                     |
| `#`                    | this grammar, on the piece segment | member introducer, `#argument` ([D6](#d6-a-pieces-other-documents-are-members)); in a path it is data. Separately, a leading `#name` on a whole operand is a wish target at `cf`'s intake seams |
| `~0`, `~1`             | RFC 6901                           | escapes for `~` and `/` inside a path key — the one escape scheme the grammar has                                                                                                               |
| `:`                    | the identifiers                    | inside a DID and a handle (`did:key:…`, `of:fid1:…`); a segment holding one is an identifier, one without is a name                                                                             |
| `=`                    | this grammar, inside a qualifier   | separates a qualifier's name from its value                                                                                                                                                     |
| `.`, `..`              | this grammar, in a relative head   | the position, and a climb to its parent, repeatable, with `/.` ending a run of climbs; keys anywhere in a pointer. The head is where a relative reference takes a member or a qualifier         |
| `,` and a trailing `@` | the projection grammar             | list separator, and the address marker on a projected position                                                                                                                                  |
| a leading `@`          | `--schema`                         | its `@file` form; the projection's own document records the interaction with the trailing marker                                                                                                |

No character on this table is spent on the space or on relativity. Both are
introduced by their slot at the head of the string, and
[D1](#d1-qualification-is-positional-the-urls-three-levels) says why.

### Shell behavior, measured

Each candidate was passed unquoted to `printf '[%s]'` under macOS `zsh` and
`bash`, stock and with `extendedglob`, an opt-in option. What the program
received:

| Written                                                                   | zsh                       | zsh + `extendedglob` | bash      | Result                                                                                            |
| ------------------------------------------------------------------------- | ------------------------- | -------------------- | --------- | ------------------------------------------------------------------------------------------------- |
| `$session/board`                                                          | `/board`                  | `/board`             | `/board`  | the space is **silently dropped**; a valid reference to a different cell                          |
| `/board?scope=user`                                                       | error, `no matches found` | error                | passes    | the command never runs                                                                            |
| `/board^user`                                                             | passes                    | error                | passes    |                                                                                                   |
| `board#favorites`                                                         | passes                    | error                | passes    |                                                                                                   |
| `#favorites`                                                              | passes                    | error, `bad pattern` | swallowed | a comment to bash and to any script, so the argument vanishes; a bad pattern under `extendedglob` |
| `/board@user`, `//space/board`                                            | passes                    | passes               | passes    |                                                                                                   |
| `/board:user`, `/board%user`, `/board,user`, `/board+user`, `/board=user` | passes                    | passes               | passes    |                                                                                                   |
| `items/0`, `./items`, `../title`, `.`                                     | passes                    | passes               | passes    | the relative forms                                                                                |
| `/board/a~1b`, `/board/a~0b`                                              | passes                    | passes               | passes    | the path escapes, mid-word                                                                        |
| `/board!user`                                                             | error, `event not found`  | error                | error     | history expansion at a typed prompt; passes only in a script or a `-c` string                     |

Available to the grammar unquoted, then: `@ : % , + = . - /`. Not available: `$`
(silent, in every shell), `?` and `^` (a glob), `#` at the head of a word (a
comment), `!` followed by a word (history expansion, at the prompt where a
reference is typed), and the glob and expansion set `* [ ] { } ~`. The `-c`
string a script passes sees none of the history expansion, which is why a
measurement taken there says `!` is safe and a prompt says otherwise.

Two things this table settles. A `$`-introduced space is not a matter of taste:
it produces a different valid reference with no error, the worst failure a
grammar can have. And a `?`-introduced query — the right _idea_ for a qualifier,
and the URL's own — is the wrong character for it at a `zsh` prompt.

The `#` row records a hazard the grammar already carries: a bare `#favorites` is
a comment to `bash` and to every script, and survives only at an interactive
`zsh` prompt with stock options. That is outside this document's decisions and
is recorded so the next reader of the wish syntax finds it measured.

### Escaping is the grammar's; quoting is the transport's

Two different things make a character survive, and they belong to different
owners.

**Escaping** is part of the string. It is what lets a key that holds a
structural character be written at all, and it is the grammar's own: the writer
applies it, the reader removes it, and the string round-trips under D10's law
with the escape inside it. The grammar has one escape table, the path's — RFC
6901's `~0` for `~` and `~1` for `/` — and nothing else in the string is ever
escaped. `#` and `%` are data in a path. The escapes are a property of the
rendered string: a stored path is an array of segments and holds none. A
mid-word `~` is shell-safe under every measured configuration, so the escape
adds no quoting burden.

**Quoting** is not part of the string. It is what a transport needs so that its
own reading does not consume the string on the way through — a shell's quotes
around a `$` or a `?`, a URL's percent-encoding of a space or a `#` — and the
transport strips it before the grammar sees anything. The page URL is the worked
case: `parseFabricUrl` percent-decodes each segment, which undoes the URL's
quoting, and only then applies the path's unescaping, which is the grammar's.
The [table above](#shell-behavior-measured) is about quoting: it measures which
characters a shell consumes unquoted, and the grammar's design goal is that none
of its structural characters need quoting at a stock prompt — R8 names the one
exception. That promise is about the grammar's characters: a key holding a space
or a shell character is quoted like any argument, and that too is the
transport's. A writer never adds quoting, and a reader never expects it; whoever
hands a reference to a transport — a person, completion, a tool printing a
command line — owns it.

## Decisions

Each decision names the requirements it serves, the alternatives it rejected,
and the existing decisions it confirms or replaces.

### D1. Qualification is positional: the URL's three levels

```text
//<space>/<piece>…      complete: the location is all its own
/<piece>…               space-relative: the space is the context's
<head>[#<member>][@<qualifier>…][<pointer>]  or  <bare>
                        piece-relative: space and piece are the context's,
                        and the pointer is against the context's position
```

The head of the string says how much of the address it carries, and it spends no
sigil to say so: `//` opens the space slot the way it opens a URL's authority, a
single `/` roots at the context's space, and neither roots at the context's
position. The space segment is a DID or a name; a segment holding `:` is a DID,
and one without is a space name, which a session resolves to a DID — which is
the rule the CLI already applies to the piece segment (`validatePieceSegment`
and `namesResolvedParts` in `packages/cli/lib/llm-friendly-ref.ts`), now applied
to both; `parseReferenceParts` itself holds neither segment to a form.

A **context** is a cell address with parts missing — a space, a piece, a path
inside it, and a scope, in the shape
[D10](#d10-reader-and-writer-share-one-context) gives it. Whatever holds one —
the runner's base cell, `cf`'s `--space` and `--cell` — supplies the parts a
reference omits, and a reader holding less than a reference needs refuses it: a
piece-relative reference read with a space and no piece names nothing. A
relative reference is written against the position's path. Its head is `.`, the
position, or a run of `..`, each a climb to the parent, optionally ended by `/.`
to mark where the climbing stops and the pointer begins — `../.` is the
filesystem's own spelling of "up one, here." The head is read longest-match, so
`../..` climbs twice and `.././..` climbs once and then names the key `..`. A
`..` that would leave the piece is refused by this grammar, which has nothing
above a piece; a layer with a larger tree above the piece may continue the walk
on its own terms. Everything after the head is one RFC 6901 pointer, in which
`.` and `..` are keys like any other: `a/../b` names three literal keys.
This rule also governs shuttle's `cd`. Leading climbs in shuttle follow its
recorded route, including above the piece; walking into a child and then back
out takes separate navigation commands. `parseRelativeReference` exposes the
leading climb count and decoded literal path without applying a position, so a
route reader can execute those climbs without parsing the head again. At a
position that is a piece's root, "against the position" and "from the piece's
root" coincide.

A relative reference takes a member or a qualifier only on its head, whichever
head it is: `.@user/items` is the context's piece at scope `user`, then `items`;
`.@user` alone is the position at that scope; `..@user/title` climbs and moves
the scope in one head. `.#argument/items` is the context's piece's arguments
document, from its root, and `.#result/items` returns to the result from inside
the arguments document, the member's counterpart of `.@space`. The path resets
on a member switch and holds on a scope move because of what each preserves:
schemas and link structure are shared across scopes
([scoped cell instances](scoped-cell-instances.md)), so a path stays meaningful
at another scope, while another member is another schema, where the position's
path means nothing. Everywhere in the pointer `@` and `#` are ordinary
characters of a key — `items@user` is a key named `items@user`, `issue#12` a key
named `issue#12`. Unless `.#argument` switches it, the document is the
context's, since the path is inside it.

The bare form — the pointer without a head and without its leading `/` — is for
the common case, a path that could not be read as a head: its first key is not
`""`, `.`, or `..`, and it never names the root. Those take the `.` head: `.//x`
for a first key `""`, `./..` for a first key `..`, and `.` for the root.
`./items` and `items` name the same key; `./` alone is the key `""` under the
position, as RFC 6901 reads a trailing `/`. The `.` head is also how a relative
reference is written where a bare word is read as something else — a slug on
`--cell`.

Serves R4, R6, R7, R9, R11. Taking `@` off the space is what gives `@` one
meaning ([D2](#d2--is-the-qualifier-introducer-and-nothing-else)); it also ends
the vocabulary overlap of R7 at its source, since a scope word can no longer be
written where a space name is expected. And it is the shape the sibling grammars
already have, relative forms included.

**Confirms.**
[Pattern imports](pattern-imports/README.md#alternatives-considered) qualifies
the space by slash depth — `cf:<ref>`, `cf:/<space>/<ref>`,
`cf://<host>/<space>/<ref>` — and rejected a leading-`@` namespace in so many
words ("reads like npm, which is exactly the problem"). The shell's page URL is
`/<space>/<piece>` with no sigil. The CLI's positional path is already the
piece-relative form — a path against the `--cell`, never beginning with `/`.

**Replaces.** The `/@<space>/` prefix `parseReferenceParts` reads and
`createLLMFriendlyLink` writes. [Migration](#migration) keeps the DID form of it
readable. The bare alias's piece-first reading of `pieceId/path` is not
replaced; it remains supported in slots where no path competes for the
position. [Surface decisions](#surface-decisions) records that policy.

**Rejected.**

- `$<space>` — silently expanded by every shell; the
  [table](#shell-behavior-measured) shows the space vanishing without an error.
- `./<piece>` for the context's space, with `/<space>/<piece>` absolute — the
  filesystem's shape, and Ben Follington's third option on #6775. It redefines
  `/of:fid1:…`, the one form everything emits, from "piece in my space" to
  "space named `of:fid1:…`", against R12; and it spends `./` on the space where
  a filesystem, and this grammar, spend it on the current position. `//` costs
  nothing: a doubled slash at the head is an empty first segment today, and
  `parseReferenceParts` refuses it, so the position is free to claim.
- Keeping `/@<space>/` and reserving the scope words as space names — closes the
  measured collision and leaves `@` with two meanings, R9 unserved, and a
  reserved-word rule on a value the fabric otherwise never validates.

**Cost, stated.** RFC 6901 reads `//` as an empty token. The reference is not a
JSON Pointer — its head segments are not path keys — and no reader of one has
ever been offered an empty first segment, so the reading is not one anyone
holds; but it is the one objection to `//`, and it is recorded rather than
argued away. Bare strings take their meaning from the CLI argument slot:
piece aliases in target slots, keys in path slots. Rooted references make the
piece explicit, and `./` makes the relative-path reading explicit.

### D2. `@` is the qualifier introducer, and nothing else

`@` introduces a qualifier on the piece segment: a statement about _which_ of
that piece is meant, without changing _what_ is meant. Which instance (scope)
and which version (pin) are the two the grammar registers. A qualifier is
written `@name=value` and attaches to the piece segment on its left; several are
written one after another. In a relative reference the `.` that stands for the
context's piece is the one segment that takes one.

Serves R6, R9. One meaning, one slot, and a name rather than a character per
qualifier.

**Confirms.** The trailing `@<pin>` of
[pattern imports](pattern-imports/README.md#specifier-syntax), and that
specification's reservation of the character: "Slugs, space names, DIDs, and
hosts cannot contain `@`". The scope suffix `parseScopedIdSegment` reads today
is a qualifier under this decision and keeps its form
([D3](#d3-the-scope-keeps-its-abbreviation)).

**Replaces.** `@` as the space introducer
([D1](#d1-qualification-is-positional-the-urls-three-levels)). Once that goes,
the two grammars that write a trailing `@` — this one for the scope, pattern
imports for the pin — agree on what the character is, and a future convergence
of the two puts no two meanings in one slot.

**On the direction the precedent points.** Every established trailing-`@`
convention puts the _container_ or the _version_ after the `@`: `user@host`,
`image@sha256:…`, `pkg@1.2.3`. A scope is neither — it selects among parallel
instances of one thing — so `tracker@user` cannot lean on the email intuition
and must be learned. The named form makes that explicit: `@scope=user` reads as
the statement it is, and the abbreviation is there for the reader who already
knows.

**Rejected.**

- A second character for the scope, leaving `@` to the space — serves R6 and
  nothing else: the pin still lands on `@` in the sibling grammar, and the next
  qualifier after that needs a third character from an alphabet the
  [table](#shell-behavior-measured) shows has almost none left.
- `?scope=user`, the URL's query — the right model, and Ben Follington's second
  option on #6775; the character fails R8 under `zsh`.

### D3. The scope keeps its abbreviation

```text
@user          ≡  @scope=user
@session       ≡  @scope=session
@space         ≡  @scope=space       (the base; omitted if the context matches)
@inherit       ≡  @scope=inherit
```

A bare word after `@` is a scope value and nothing else. Only the scope gets
this: it is the qualifier people type, its four values are a closed set the
runtime owns, and a qualifier _name_ is never written bare, so a bare word is
never ambiguous between the two. A bare word that is not a scope value is
refused with a message naming the `@name=value` form.

Serves R2 (the four values of `LinkScope` are all writable; today `inherit` is
not), R12 (every `@user` and `@session` in the tree and in flight reads
unchanged).

**Confirms.** The scope suffix of `parseScopedIdSegment`, and the
`space < user < session` lattice of
[scoped cell instances](scoped-cell-instances.md#summary).

**On `inherit`.** In a stored link, `inherit` means "the containing cell's
scope", and `parseLinkPrimitive` resolves it against its base before a full link
exists, which is why the writer has never had one to write. As a written
qualifier it is the explicit form of the relative reading R5 describes: a
context-holding reader that reads an absent scope from its position has a way to
say so on a printed line, and a canonical reader that has no context refuses it
rather than guessing. In a relative reference `@inherit` and an omitted scope
denote the same cell.

### D4. Qualifiers repeat; a name appears once

```text
/glaze-tracker@user@pin=Avcny…rC1c/items
```

Each qualifier is introduced by its own `@`. Order carries no meaning, and a
name written twice is refused. A qualifier's value runs to the next `@` or `/`,
so a value holds neither; every registered value is drawn from an alphabet that
excludes them (scope words are letters; a pin is base64url). A value can hold
neither; a registration that ever needed one would say how it is written.

Serves R3, R9.

**Rejected.** `@scope=user,pin=…`, one `@` and a `,`-separated list — `,` is the
projection grammar's list separator, so an address written inside a `--select`
list would need escaping there, against R10.

### D5. Registered qualifiers

| Name    | Values                                              | Bare form            | Read by                                                                                                             |
| ------- | --------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `scope` | `space`, `user`, `session`, `inherit`               | yes, the value alone | every reader; `inherit` is refused by a reader with no context                                                      |
| `pin`   | 43 base64url characters, a selected module identity | no                   | reserved by [pattern imports](pattern-imports/README.md#specifier-syntax); not read by the runner's link resolution |

A name not on this table is refused, with the message naming the table. Adding a
row is the whole cost of a new qualifier
([Admitting a new requirement](#admitting-a-new-requirement)).

Serves R9.

### D6. A piece's other documents are members

```text
/glaze-tracker#argument/items/0/title   the arguments document, then inside it
/glaze-tracker#argument@user/items      the user instance's arguments document
/glaze-tracker/issue#12                 the result document, a key `issue#12`
```

A piece is named by its result document — the one its id names, that a slug
points at and other pieces link to. Its inputs live in a second document, the
**arguments document**, which the result links to through a hidden field named
`argument` (`getMetaLink` in `packages/runner/src/link-utils.ts`: "our internal
and argument cells are linked to by the result cell"). The arguments document is
a member of the piece, not a variant of it, and is written as one: `#argument`
on the piece segment, before the path, so the string reads in the order the
address is resolved — which piece, which of its documents, where inside it. Two
members are registered, and any other is refused:

| Member     | Document           | Written                                                                                                                                                                                                                                                                |
| ---------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `argument` | the piece's inputs | wherever it is meant; `--input` remains the flag that writes the same selection                                                                                                                                                                                        |
| `result`   | the default        | only in a relative reference whose context is inside the arguments document, to return: `.#result/items`. In a form that names a piece an omitted member is the result in every context, so a writer never writes `#result` there — not even against the empty context |

That last asymmetry with `@space` is the two axes of
[D10](#d10-reader-and-writer-share-one-context): the scope is not cut off when a
piece is written, so an omitted scope means the context's and the empty context
must write `@space`; the member is a location part, cut off with the piece, so
nothing is left to disambiguate.

The piece segment is `name[#member][@qualifier…]`, one spelling: what, then
which. It is read by splitting at `/`, then at `@`, then its head at `#`.
Because the member is parsed only there, `#` in a path is ordinary data —
`/glaze-tracker/issue#12` names a key — and the path needs no escape beyond RFC
6901's own. The bare alias `glaze-tracker#argument` is unchanged: it already
puts the member beside the piece, with the path positional.

A reference names one piece, so `#argument` appears at most once, on that
piece's segment. A child piece reached through the path is not named by the
path: `/glaze-tracker/items/0` is a link to the child's result, and
`/glaze-tracker/items/0#argument` is a key named `0#argument`. The child has its
own id — `of:fid1:Dnt…`, which a `$link` marker on `items/0` returns — and its
arguments are written the way any piece's are, `/of:fid1:Dnt…#argument`. A path
never re-enters piece syntax, which is what keeps `#` data inside one.

Serves R2 (a key holding `#` has a written form at every level), R6 (`#` means
one thing, in one place), R11, and R8 under the exception it states.

**Confirms.** The `#argument` token and its meaning, the `--input` flag, and the
`#argument`-only rule of `splitArgumentSuffix` in
`packages/cli/lib/llm-friendly-ref.ts`; `#result` is an addition, the default's
spelling. The `Owner#member` notation of Javadoc and Ruby documentation is the
precedent: the member of a named thing.

**Replaces.** The trailing slot — `/glaze-tracker/items#argument` — and with it
the whole-string scan that made every `#` structural. No writer has rendered the
suffix, so nothing rendered carries it; the CLI's readers, its completion, and
the documents that teach the suffix move it.

**Cost, stated.** `#` stays shell-fragile under `zsh`'s `extendedglob`
([measured](#shell-behavior-measured)). It is the cost the grammar already
carries, and #6826 records the mitigation.

### D7. What a writer writes

A writer takes the context the requester gives it and writes exactly what
distinguishes the cell from that context: every part the context has no opinion
about, and every part whose value differs from the context's. It omits a part
only on equality, and it measures equality against the context _after_ the
cutoff [D10](#d10-reader-and-writer-share-one-context) describes — once it has
written the piece, the context's path is nothing to be relative to.

The consequences, in the order they arise:

- **No context → complete and fully qualified**: `//S/X@space/items`, the
  `@space` written because the empty context has no opinion about it. This is
  the form for anything that leaves the requester's context — a shared link, a
  printed address, a string handed to another session.
- **A context that knows the space and holds scope `space`** → today's output
  exactly: `/X/items` for a base-scoped cell, `/X@user/items` for a user-scoped
  one.
- **A context that knows the piece and its scope** → piece-relative when the
  cell is in that piece: `items/0` or `../1/title` at the context's scope, and
  `.@session/items/0` when only the scope differs, and `.#result/items/0` or
  `.#argument/items/0` when only the document does; a different piece is the
  next level up. On inequality a writer falls back a level and never refuses: a
  more-qualified form is always correct in the same context, and a listing that
  mixes levels is fine because the head of each string says its level (R3).
- **A relative rendering whose first key is `""`, `.`, or `..`** takes the `.`
  head — `.//x`, `./..` — since the bare form is reserved for a path that could
  not be read as a head. Nothing is left unabbreviated: with climbs in the head
  and the pointer pure, every cell in the piece has a relative spelling.

The writer assumes the reader has the same context it was given, and writes
nothing more. The requester owns the difference between the context it passes
and the context the string is actually read in; a requester that does not want a
piece assumed does not supply one.

Serves R4, R5, R10, R12.

**Confirms.** `createLLMFriendlyLink`'s two omission rules, as the case of a
one-part context whose scope is `space`.

**No context.** `createLLMFriendlyLink(link)` writes the complete form,
including space and scope. The harness handle table renders resolved links
with the same empty context.

### D8. The space segment's vocabulary

A space segment is a DID or a name. A name may not contain `/` (the separator),
`@` (a qualifier never attaches to a space), `#` (nor a member), or `:` (what
tells a DID from a name). Those are the grammar's rules; a resolver may hold a
name to more — `createSession` today holds it to nothing further, and a registry
would hold it to an alphabet of its own. No word is reserved: a space named
`user` is written `//user/…`, and nothing else in the grammar can be written
that way.

Serves R7. This is where the reserved-word alternative under D1 becomes
unnecessary: the collision was between two `@`-introduced slots, and once only
one slot is `@`-introduced there is nothing to reserve.

### D9. The reference names a cell, not how to read it

A schema, a projection, a filter, a write-redirect flag: each is a statement
about the read or the write, not about the cell, and each stays a flag. The
reference carries identity and nothing else.

Serves R10 (an address is passed on whole because there is nothing in it a
reader would want to strip) and keeps R9 honest: "no new character" is only true
if the grammar refuses the requirements that are not addressing.

**Confirms.** `packages/cli/README.md`: "No schema is inlined and no
write-redirect flag rides along."

### D10. Reader and writer share one context

A **context** is a cell address with parts missing, and both halves of the
grammar take one: a reader fills a string's omitted parts from it, a writer
omits the parts it supplies. The contract between them is one law:

```text
read(write(link, C), C) = link      for every context C, ∅ included
```

**Shape.** A context has two axes. Its _location_ is a prefix of
`space → piece → document → path`: any suffix may be missing, and nothing may be
skipped — no path without a piece, no piece without a space, no `#argument`
without a piece. Its _scope_ sits beside the location, known or unknown,
whatever the location's depth. "Missing" and "unknown" are one thing: the
context has no opinion, and a writer writes what the context has no opinion
about.

| Context                                 | Location                            | Scope   |
| --------------------------------------- | ----------------------------------- | ------- |
| ∅                                       | none                                | unknown |
| `//bakery`                              | space                               | unknown |
| `//bakery/glaze-tracker`                | space, piece, result document, root | unknown |
| `//bakery/glaze-tracker@user`           | the same                            | `user`  |
| `//bakery/glaze-tracker@user/items/0`   | …, path `items/0`                   | `user`  |
| `//bakery/glaze-tracker#argument/items` | …, arguments document, path `items` | unknown |

**Text and structure.** Structurally a context is the parts of a reference —
space, piece, member, path, scope — with any location suffix missing;
`ReferenceParts` today lacks the member and gains it. It is not the sigil link's
address: the arguments document has an id of its own, and that address is what a
context's parts resolve to. Textually it is a complete reference at the matching
level, with one admission: a space alone, `//bakery`, is a valid _context_
though not a valid _cell reference_ — the same parser, a different acceptance,
the way a session-holding reader accepts a name a pattern cannot. A context
travels beside a reference and never inside one
([D9](#d9-the-reference-names-a-cell-not-how-to-read-it)): output that carries
relative references states, once, the context they are relative to, in this
form.

**Location: the first part written cuts the context off below it.** A reference
that names a piece ignores the context's piece, document, and path — its path is
from the piece's root, and its document is the result unless it writes
`#argument`. A reference that names a space ignores everything below the space.
A piece-relative reference names no location part above the document — `.` is
the context's piece, and `.#argument` chooses its document — so it takes space
and piece from the context, the document unless it chose one, and anchors its
path at the context's path.

**Scope: written → the reference's; omitted → the context's.** The scope is not
cut off when a piece or a space is written, because it is not a level of the
location: it asks _which instance_, and that question is the same in every
piece. `/X/items` read against a `@user` context is `X@user/items`; the same
string against `@space` is `X@space/items`.

**The empty context.** For a writer, ∅ has no opinion about anything, so
`write(link, ∅)` writes every part — `//S/X@space/items`, `@space` included —
and the result names the same cell in every reader's context. For a reader, an
omitted scope with no context is `space`, the base; an omitted space is left for
the base cell that resolves the link, as the runner's `parseLinkPrimitive` does
today; an omitted piece is refused. An omitted member needs no default: in a
form that names a piece it is cut off with the piece and means the result in
every context, and in a relative form it is the context's, with `#result` the
way back. The law never leans on the reader's defaults: under ∅ the writer wrote
everything out. They fire only when a string written against a richer context is
read against none — the requester's case under [D7](#d7-what-a-writer-writes) —
and then they are the canonical reading.

**Worked.** Context `//S/Y@user/items/0`; the cell to write is
`//S/X@user/items`.

| Step                 | Result              | Why                                                                    |
| -------------------- | ------------------- | ---------------------------------------------------------------------- |
| writer: space        | omitted             | equal                                                                  |
| writer: piece        | written, `/X`       | differs; cuts off the context's document and path                      |
| writer: path         | `items`, from root  | the cutoff: nothing left to be relative to                             |
| writer: scope        | omitted             | equal to the context's, and the scope is not cut off                   |
| **the string**       | `/X/items`          |                                                                        |
| reader, same context | `//S/X@user/items`  | piece written → space from context, path from root, scope from context |
| reader, no context   | `//S/X@space/items` | a different cell — the requester's difference, not the writer's        |

**Library.** One module, `packages/runner/src/cell-reference.ts`, owns both
halves and the context between them:

```text
parseCellReference(text, context?): ReferenceParts     the reader
renderCellReference(link, context?): string            the writer
parseReferenceContext(text): ReferenceContext          a context from its text
renderReferenceContext(context): string                and back
ReferenceContext                          a cell address with parts missing
```

The prose says _reader_ and _writer_; the code says `parse` and `render`,
because `render` is what this tree already calls structure-to-text and `write`
is what it calls a store operation. The context is for resolving, not parsing:
`parseCellReference` parses the same with or without one, and uses it only to
fill the parts the string omits. `parseReferenceParts` aliases
`parseCellReference`. `parseLLMFriendlyLink` and `createLLMFriendlyLink` wrap
the pair for their callers — the name records an audience, and the grammar is
for every reader.

Serves R3 (the shape is the string's; the values are the context's), R10, R5,
R4.

**Confirms.** `parseLLMFriendlyLink(target, space?)` and
`parseLinkPrimitive(value, base)` on the read side,
`createLLMFriendlyLink(link, contextSpace?)` on the write side: each is this
decision with a one-part context. The harness handle table renders resolved
links against an empty context, so their space and scope remain explicit.

**Rejected.** A single chain in which the scope is a level below the piece, so
that writing a piece resets the scope to the base. It would make `/X` at a
`@user` position name someone else's `X`, and it would make every cross-piece
reference in a user-scoped session re-write `@user`, against the minimality D7
asks for.

## Examples

Every combination the grammar admits, with `bakery` a space name,
`did:key:z6MkBakery` its DID, `glaze-tracker` a slug, and `of:fid1:Glz…` the
handle behind it. A row's meaning is what a reader with no context and no
session takes from the string; a session-holding reader resolves the names to
the same cells. The relative rows at the end need a context, and theirs is
`//bakery/glaze-tracker@user/items/0`.

| Written                                                                       | Space                  | Piece         | Scope         | Path                                        | Cell                                                                                                                                 |
| ----------------------------------------------------------------------------- | ---------------------- | ------------- | ------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/of:fid1:Glz…`                                                               | the reader's           | handle        | `space`       | root                                        | the piece's result                                                                                                                   |
| `/glaze-tracker`                                                              | the reader's           | slug          | `space`       | root                                        | the same, by name                                                                                                                    |
| `/glaze-tracker/items/0/title`                                                | the reader's           | slug          | `space`       | `items/0/title`                             | one field                                                                                                                            |
| `/glaze-tracker@user`                                                         | the reader's           | slug          | `user`        | root                                        | the reading user's instance                                                                                                          |
| `/glaze-tracker@scope=user`                                                   | the reader's           | slug          | `user`        | root                                        | the same, written in full                                                                                                            |
| `/glaze-tracker@session/items`                                                | the reader's           | slug          | `session`     | `items`                                     | this session's instance                                                                                                              |
| `/glaze-tracker@inherit`                                                      | the reader's           | slug          | the context's | root                                        | refused by a reader with no context                                                                                                  |
| `//bakery/glaze-tracker`                                                      | `bakery`               | slug          | `space`       | root                                        | needs a session to resolve both names                                                                                                |
| `//did:key:z6MkBakery/of:fid1:Glz…`                                           | the DID                | handle        | `space`       | root                                        | resolvable from the string alone                                                                                                     |
| `//did:key:z6MkBakery/of:fid1:Glz…@user/items/0`                              | the DID                | handle        | `user`        | `items/0`                                   | fully qualified: the same cell from anywhere                                                                                         |
| `//user/glaze-tracker@user`                                                   | a space _named_ `user` | slug          | `user`        | root                                        | no ambiguity: the space slot is not `@`-introduced                                                                                   |
| `/glaze-tracker@pin=Avcny…rC1c`                                               | the reader's           | slug          | `space`       | root                                        | pinned to one module identity; the runner ignores the pin                                                                            |
| `/glaze-tracker@user@pin=Avcny…rC1c`                                          | the reader's           | slug          | `user`        | root                                        | two qualifiers; order is free                                                                                                        |
| `/glaze-tracker#argument`                                                     | the reader's           | slug          | `space`       | root                                        | the arguments document                                                                                                               |
| `/glaze-tracker#argument@user/items`                                          | the reader's           | slug          | `user`        | `items`                                     | inside the user instance's arguments document                                                                                        |
| `/glaze-tracker/issue#12`                                                     | the reader's           | slug          | `space`       | `issue#12`                                  | a key named `issue#12`: `#` in a path is data                                                                                        |
| `/glaze-tracker/items/0#argument`                                             | the reader's           | slug          | `space`       | `items/0#argument`                          | a key named `0#argument` — not the child's arguments; the child at `items/0` has its own id, and `/of:fid1:Dnt…#argument` names them |
| `/glaze-tracker/`                                                             | the reader's           | slug          | `space`       | `""`                                        | the key `""` at the root: pointer `/`, as RFC 6901 reads it                                                                          |
| `title`                                                                       | the context's          | the context's | the context's | `title` against the position                | `//bakery/glaze-tracker@user/items/0/title`                                                                                          |
| `./title`                                                                     | the context's          | the context's | the context's | `title` against the position                | the same as `title`; `./` forces the reading where a bare word is a slug                                                             |
| `.`                                                                           | the context's          | the context's | the context's | the position                                | the context's own cell                                                                                                               |
| `./items@user`                                                                | the context's          | the context's | the context's | `items@user` against the position           | a key named `items@user`: `@` is data everywhere but on the head                                                                     |
| `../1/title`                                                                  | the context's          | the context's | the context's | the parent, then `1/title`                  | `//bakery/glaze-tracker@user/items/1/title`                                                                                          |
| `.@session/title`                                                             | the context's          | the context's | `session`     | `title` against the position                | `//bakery/glaze-tracker@session/items/0/title`: the scope moves, the position holds                                                  |
| `.@space`                                                                     | the context's          | the context's | `space`       | the position                                | `//bakery/glaze-tracker@space/items/0`                                                                                               |
| `.@user/../title`                                                             | the context's          | the context's | `user`        | the keys `..`, `title` under the position   | in a pointer `..` is a key; the climb is written `..@user/title`                                                                     |
| `..@user/title`                                                               | the context's          | the context's | `user`        | the parent, then `title`                    | `//bakery/glaze-tracker@user/items/title`: a climb and a scope move in one head                                                      |
| `../..`                                                                       | the context's          | the context's | the context's | two climbs                                  | `//bakery/glaze-tracker@user`, the root                                                                                              |
| `.././..`                                                                     | the context's          | the context's | the context's | one climb, then the key `..`                | `//bakery/glaze-tracker@user/items/..`: `/.` ends the run of climbs                                                                  |
| `./`                                                                          | the context's          | the context's | the context's | the key `""` under the position             | `//bakery/glaze-tracker@user/items/0/`, as RFC 6901 reads a trailing `/`                                                             |
| `.#argument/items`                                                            | the context's          | the context's | the context's | `items`, from the arguments document's root | `//bakery/glaze-tracker#argument@user/items`: a member switch resets the path                                                        |
| `.#result/title`, read where the context's document is the arguments document | the context's          | the context's | the context's | `title`, from the result document's root    | the result document; the member's counterpart of `.`                                                                                 |

Refused, and why:

| Written                               | Refusal                                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `/@bakery/glaze-tracker`              | a name-shaped `@` space: the message names `//bakery/…`                                                                     |
| `/glaze-tracker@owner`                | not a scope value: the message names `@name=value` and the registered names                                                 |
| `/glaze-tracker@user@user`            | a name written twice                                                                                                        |
| `/glaze-tracker@color=pink`           | a name not on the table                                                                                                     |
| `//bakery`                            | a space and no piece — refused as a cell reference; accepted as a context ([D10](#d10-reader-and-writer-share-one-context)) |
| `/glaze-tracker#items`                | not a member of a piece: the message names `#argument` and `#result`                                                        |
| `/glaze-tracker@user#argument`        | `user#argument` is not a scope value; the one spelling is `#argument@user`                                                  |
| `items/0`, read with no context piece | a relative reference and nothing to resolve it against                                                                      |
| `../../../title`, read at `items/0`   | a climb above the piece; this grammar has nothing there                                                                     |

## Translation to the sibling grammars

The same cell in each grammar, segment for segment (R11):

| Cell reference                      | Shell page URL                                                                             | Import specifier                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| `/glaze-tracker`                    | `https://<host>/<my-space>/glaze-tracker`                                                  | `cf:glaze-tracker`                    |
| `/glaze-tracker/items`              | `https://<host>/<my-space>/glaze-tracker/items`                                            | —                                     |
| `//bakery/glaze-tracker`            | `https://<host>/bakery/glaze-tracker`                                                      | `cf:/bakery/glaze-tracker`            |
| `//did:key:z6MkBakery/of:fid1:Glz…` | `https://<host>/did:key:z6MkBakery/of:fid1:Glz…`                                           | `cf:/did:key:z6MkBakery/of:fid1:Glz…` |
| `/glaze-tracker@pin=Avcny…rC1c`     | —                                                                                          | `cf:glaze-tracker@Avcny…rC1c`         |
| `items/0`                           | `items/0`, as a browser resolves it against the page; the URL grammar has no relative form | —                                     |

The page URL has no scope and no pin; the specifier has no scope, no path into a
cell, and no relative form — an import's subpath is a public name, not a
position. Nor can the page URL carry a key named `""`: its splitter discards
empty segments. The page URL may also carry, before the space, things a
reference never does — a namespace naming the provider, or an empty space
meaning the reader's home — the way it carries a host: the URL layer resolves
them to a space before any reference is formed. Where a slot exists in two of
them it is in the same place and written the same way, and the one written
difference — the specifier's bare `@<pin>` against the reference's `@pin=` — is
intentional. Imports have a single pin qualifier; a bare word after `@` in a
cell reference selects scope. Revisit the import spelling when imports need
additional qualifiers.

## Admitting a new requirement

A new requirement is written into [Requirements](#requirements) first, with its
source. Then it is placed by asking, in order:

1. **Does it select which instance or which version of the named piece?** It is
   a qualifier: register a name in [D5](#d5-registered-qualifiers), state its
   value alphabet, and say which readers read it. No character is spent.
2. **Does it select a different document that belongs to the piece?** It is a
   member beside `#argument` and `#result`. Today there are two; a third is a
   row, not a character.
3. **Does it change where the reference resolves** — a host, a different
   authority than a space? It belongs in the `//` slot, where a URL puts an
   authority, and the [open question](#open-questions) on hosts is where that
   goes when it is needed.
4. **Does it change what is inside the cell that is named?** It is a path
   segment, and RFC 6901 already says how to write any key.
5. **Is it about how to read or write, rather than what?** It is a flag
   ([D9](#d9-the-reference-names-a-cell-not-how-to-read-it)), and this document
   does not admit it.

A requirement that survives all five is the case for a new structural character,
and the [measured table](#shell-behavior-measured) says which characters there
are to spend: `: % , + -`, of which `:` is inside every identifier and `,` is
the projection's. That is the whole reason the grammar spends names rather than
characters.

This is what makes the mechanism reasonable rather than merely tidy. Four
independent uses of `@` sit on the `cf` surface — the space, the scope, the
projection's address marker, `--schema`'s file form — and nothing on that
surface says which slot is open; a character is the cheapest thing to reach for.
A named slot is as cheap to add to and cannot collide with the last one.

## Migration

Readers and writers share the grammar below. Persisted DID-prefixed strings
remain readable through the compatibility alias (R12).

1. **Read the new forms.** `parseReferenceParts` reads `//<space>/`,
   `@name=value`, repeated qualifiers, and `@inherit`; `parseScopedIdSegment`
   reads scope abbreviations. The `/@did:…/` prefix stays readable as an
   alias for `//did:…/` because it occurs in harness refs, messages, and
   markdown. Named-space `/@name/` prefixes are refused; callers use `//name/`.
   The [alias table](#aliases) records the retained forms. `parseFabricUrl`
   reads `//<space>/` alongside the alias. The CLI's `validateEmbeddedSpaces`
   and completion providers follow the same split. The reader takes a context
   ([D10](#d10-reader-and-writer-share-one-context)) and reads the
   piece-relative form against it; `cf`'s positional path supports the `.` and
   `..` heads; every reader of the piece-relative form — an
   interactive reader with a position among them — takes them from the shared
   reader rather than reading them on its own. A trailing empty segment inside
   a piece names the key `""`; shared readers and shuttle preserve it.
   `#argument` selects a member only on the piece segment or relative
   head. In a path it is literal data, including a final key named
   `a#argument`. Readers must preserve these keys so every cell remains
   addressable; they cannot distinguish a literal key from an intended
   member selection written in the wrong slot.
2. **Write the new forms.** `renderCellReference` is the reader's inverse, in
   the same module, and takes the same context. Writers delegate to it.
   `createLLMFriendlyLink` is a wrapper that passes a context holding its
   `contextSpace` and scope `space`, so a caller that passes a space gets
   its context-relative output, and one that passes none gets the complete form
   under [D7](#d7-what-a-writer-writes). The harness handle table and
   `linkAddress` in `packages/patterns/notes/reference-address.ts` call the
   shared renderer directly; `canonicalAddress` in
   `packages/cli/lib/callable.ts` and
   `decomposeUrl` in `packages/cli/commands/piece.ts` write `//<space>/`, and
   the name alias is refused. `renderPosition` in
   `packages/cli/lib/shuttle/place.ts` delegates to `renderCellReference` — its
   scope half, `renderScope`, writes the `@scope` suffix D3 keeps. The context
   controls abbreviation: `pwd` passes no context and prints the complete form, a listing
   passes the place and abbreviates its rows, under the listing's own rule that
   a row abbreviates only where the abbreviated spelling is not itself a
   reading. That listing's round-trip check — every printed name driven back
   through `cd` onto the row it named — is the writer migration's test where it
   is used. Every address the CLI publishes is in this grammar.
3. **Documents and tests.** The live documents that quote the form: the grammar
   line in `packages/cli/README.md` and `docs/common/verbs/over-the-cli.md`; the
   examples in `docs/tutorial/06-workflow.md`; the doc comment on
   `packages/cli/lib/llm-friendly-ref.ts` and its `splitArgumentSuffix`; the
   `#argument` paragraphs and completion in `packages/cli/README.md`; the
   `//my-space/` row in `docs/plans/cli-surface-shape.md`; and
   `docs/plans/shuttle/grammar.md`, which quotes the forms `pwd` and `ls` print.
   Tests and pattern baselines that hold a rendered reference follow the writer.
4. **The specifier's pin.** [Pattern imports](pattern-imports/README.md) keep
   `@<pin>`. Revisit named qualifiers when imports need additional qualifiers.
   Changing import text changes the importing module's source identity, so a
   spelling migration needs a concrete benefit beyond consistency.

### Aliases

The named-space prefix `/@name/` is refused; callers use `//name/`.

A form a reader accepts and no writer writes, each for one reason and with its
retirement policy (R12):

| Form                                                    | Read because                                                             | Confined to                                                            | Retires when                                                                                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/@did:key:…/` space prefix                             | the writers rendered it into harness refs, stored messages, and markdown | a segment beginning `@did:`, which no scope word or qualifier name can | a migration rewrites the stored strings — harness `ref`s re-render from the fields beside them; messages and markdown are people's content, which is the real decision — or the owner rules the residue acceptable |
| the CLI's bare form, `pieceId[@scope]` and a slug alone | a typing convenience the README already calls an alias                   | slots where no path competes: `--cell`, link endpoints                 | no retirement planned; supported in these slots as a typing convenience                                                                                                                           |

## Relationship to existing decisions

| Decision                                                                                                                 | Where                                                                   | This document                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| The reference is the one syntax; the bare form is an alias that never leads                                              | `packages/cli/README.md`; `llm-friendly-ref.ts` doc comment             | confirms (R1)                                                                                                                     |
| Space by slash depth; leading `@` namespace rejected                                                                     | [Pattern imports](pattern-imports/README.md#alternatives-considered)    | confirms and extends to the reference (D1)                                                                                        |
| `@` reserved for the trailing qualifier; the pin lives there                                                             | [Pattern imports](pattern-imports/README.md#specifier-syntax)           | confirms (D2); imports keep their bare pin until additional qualifiers warrant revisiting it                                                                 |
| Scope is expressible in every layer, on a `space < user < session` lattice                                               | [Scoped cell instances](scoped-cell-instances.md)                       | confirms, and gives `inherit` its written form (D3)                                                                               |
| The space rides in front only when it differs; the scope only when not the base                                          | `createLLMFriendlyLink`; `packages/cli/README.md`                       | confirms, as the case of a context that knows the space and holds scope `space` (D7, D10)                                         |
| The positional path is a path against the target cell and never begins with `/`                                          | `packages/cli/README.md`, "Writing the target"                          | confirms as the piece-relative form (R4, D1)                                                                                      |
| A stored link with no `id` is the base cell's document, path from its root                                               | `parseLinkPrimitive` in `packages/runner/src/link-types.ts`             | confirms as a reader with a one-part context: the base cell (D10)                                                                 |
| A resolved link rendered without context states its space and scope | `canonicalRef` in `packages/cf-harness/src/handle-table.ts` | the empty context writes every known part of a resolved link (D7)                                               |
| `#argument` is the one suffix, split off before anything else parses                                                     | `splitArgumentSuffix`                                                   | confirms the token; **replaces** its slot — the member sits on the piece segment, `#` in a path is data — and adds `#result` (D6) |
| The projection grammar is its own; `--schema @` is the file form                                                         | `packages/cli/README.md`, "Shell completion"                            | confirms as out of scope; records the borrowed characters                                                                         |
| The space is written `/@<space>/`                                                                                        | `parseReferenceParts`; `createLLMFriendlyLink`                          | **replaces** (D1)                                                                                                                 |
| A bare `@word` is the whole qualifier vocabulary                                                                         | `parseScopedIdSegment`, `CELL_SCOPE_VALUES`                             | **replaces** with the named form; the bare form survives as the scope's abbreviation (D2, D3)                                     |

## Surface decisions

- **The bare alias.** `pieceId/path` on `--cell` and at a link endpoint reads
  piece-first; a positional path reads against the target cell. The argument
  slot determines the reading. Bare aliases remain supported, with no
  deprecation planned. Rooted references such as `/glaze-tracker` provide an
  explicit spelling when sharing an address.
- **A write through a trailing slash.** `/glaze-tracker/` addresses the literal
  empty-string key. Reads and writes follow normal key semantics, including
  creating that key on a write. No special restriction or confirmation applies.
- **`#` at a shell.** Keep the syntax and quote references where the shell
  requires it, as with URLs. Command-line examples quote such operands; shell
  completion supplies the necessary escaping. A leading `#` can start a shell
  comment, and zsh's `extendedglob` option also affects a mid-word `#`.
- **The projection's trailing `@`.** Projection has its own grammar, where `@`
  means "the address of this position". That spelling remains unchanged.

## Open questions

These extensions are deferred until a concrete caller needs them.

- **A host slot.** `cf://<host>/<space>/…` names a toolshed; a cell reference
  has no host. Keep host selection at the URL and connection layer. A caller
  that needs a reference to carry a host must establish the requirement before
  extending this grammar.
- **Namespaces and registered names.** Resolve provider namespaces and
  registered names at the URL and flag layer — `--url`, `--space` — before
  forming a reference. A reference carries the resolved space, not a namespace.
  Revisit this boundary only when a concrete caller cannot use it.

## Appendix: how an interactive reader supplies a context

An interactive reader — one that keeps a current position between commands and
lets the person move it — is the reader with the most to default, and the one
most tempted to let a default change what a string means. This appendix says how
such a reader reads each level of reference against what it holds, so that the
grammar stays one grammar (R1) and the string keeps deciding its own shape (R3)
while the reader still gets to be terse.

### What a context holds

A context has the shape [D10](#d10-reader-and-writer-share-one-context) gives it
— a location prefix and a scope beside it — and an interactive reader is the
reader most likely to hold all of it:

| Part     | Missing when                                                                                  |
| -------- | --------------------------------------------------------------------------------------------- |
| space    | the reader has no connection                                                                  |
| piece    | the position is at a space, not inside any piece                                              |
| document | never, once there is a piece: the result unless the position is inside the arguments document |
| path     | the position is a piece's root                                                                |
| scope    | the reader has taken no position at an instance; inside a piece it always has                 |

Where the parts come from is the reader's business: flags and environment
(`--space`, `CF_SPACE`, `--cell`), a stored position that navigation moves, or
the base cell of a stored link. The grammar sees only the values.

### Reading each level against it

D10's two rules — the first location part written cuts the context off below it;
the scope is the string's when written and the context's when not — produce this
table:

| Level          | From the string                                                    | From the context                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| complete       | space, piece, member, path                                         | scope, when the string omits it                                                                                                                                                                      |
| space-relative | piece, member, path                                                | space; scope, when omitted                                                                                                                                                                           |
| piece-relative | a path against the position, and a member or qualifier on its head | space, piece; the document unless `.#argument` or `.#result` switches it; the scope unless `.@scope` writes it; the position's path as the anchor, or above it by as many climbs as the head carries |

The string's parts are never overridden by the context, and the context's parts
are never read for a slot the string fills. That is what "defaulting is
resolution" means in practice: the reader decides _values_, never _shape_.

### What absence means here, and canonically

On a string that names a piece, the one part the two readers read differently is
the scope; on a relative reference the empty context refuses outright. D7's
empty-context rule is what makes the difference safe:

| Omitted part | Empty context                     | Interactive reader's context        |
| ------------ | --------------------------------- | ----------------------------------- |
| space        | the space the link is resolved in | the context's space                 |
| piece        | refused: nothing to resolve       | the context's piece (relative form) |
| path         | the piece's root                  | the position's path (relative form) |
| scope        | `space`, the base                 | the context's scope                 |

What an interactive reader hands out is written against the empty context
([D7](#d7-what-a-writer-writes)), so nothing it prints depends on where it was
standing, and a string that leaves it reads as the same cell everywhere. The
relative reading is for what the person types, not for what the reader shows.

### Above the piece

An interactive reader usually has a tree above the piece — a space root that
lists its pieces, by name or by id, in whatever facets the reader chooses to
offer. A bare segment read at such a position is the reader's own grammar, not
this one's: this grammar has no piece to resolve against there and refuses a
piece-relative reference, and the reader may instead read the segment as a name
in its tree. Two rules keep that layering honest:

- Inside a piece, a bare segment handed to this grammar is a key and nothing
  else: `x@user` is a key named `x@user`, and `..` from the piece's root is
  refused. A reader's line may reserve whole operands of its own before anything
  reaches the grammar — a scope move, a listing handle — and the `./` form is
  what keeps a key that collides with one reachable. A reader that continues a
  walk upward into its own tree does so knowing it has left the grammar.
- A segment the reader reads as a piece — a name in its tree — is read by this
  grammar as a piece segment, qualifiers included, so `glaze-tracker@user` names
  the user-scoped instance there and a key with the same spelling inside a piece
  does not. The position decides which reading applies, and the position is
  never ambiguous about whether it is inside a piece.

### What to refuse rather than default

- A piece-relative reference with no piece in the context.
- `..` that would leave the piece, unless the reader's own tree continues it.
- A member or qualifier anywhere in a relative reference but on its head.
  `./items@user` is a key named `items@user`; the scope move is written
  `.@user/items`, and with a climb, `..@user/items`.
- A complete reference naming a space the connection does not serve. Denoting is
  not reaching, and following the reference silently into a space the reader
  cannot read would make the same string mean two things in two sessions.

### The `./` form on an interactive line

An interactive line has verbs and bare words of its own, so a bare `items` may
be a command, a listing handle, or a key. `./items` is unambiguous everywhere:
it is a piece-relative reference and nothing else, and it means exactly what the
bare form means where the bare form is read as one. A reader that offers a bare
form should offer `./` beside it for that reason, and never give `./` a reading
of its own; `./` alone is the key `""` under the position, and `.` is the
position.
