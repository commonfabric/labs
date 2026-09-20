# Code comment style

How a comment in this repository is written: what earns one, what belongs
inside it, how it is marked up, and the shapes that quietly turn a comment into
a liability. This covers both kinds — the `//` comment that explains local
mechanics, and the JSDoc doc comment that states a contract.

Neighboring guidance: [`../README.md`](../README.md) governs the documentation
tree, and [`DEVELOPMENT.md`](DEVELOPMENT.md) carries the rest of the coding
standards — the 80-column line width among them, and the
[word choice](DEVELOPMENT.md#word-choice) a comment is held to, American
spelling included. The `describe()` and `it()` description
strings of a test have their own guide,
[`unit-test-coding-style.md`](unit-test-coding-style.md), which governs how
they are worded. What they take from here is the markup below, and the rule
that they describe the system as it stands.

Not every comment in the tree follows this guide, so a neighboring file is not
evidence of what to write. New code follows it closely. An edit to existing code
conforms the area around the edit; converting a whole file is its own change,
made deliberately rather than as a side effect.

## What earns a comment

The code already says what it does. A comment earns its keep by carrying what
the code cannot say on its own: an invariant that is not visible locally, the
reason a constraint exists, a trade-off deliberately taken, a pointer to the
part of a specification that decides the behavior.

Two things beat a comment whenever they apply.

A well-named helper or a better identifier says the same thing in the code
itself, where it cannot drift out of agreement with what it describes. When a
chunk of logic needs an inline comment to be readable, first ask whether naming
it would do the job instead.

And when the reasoning outgrows what a comment can hold, it belongs in a
document under [`../features/`](../features/README.md), with the comment naming
that document. Several invariants here are held that way. The pairing is what
keeps a subtle constraint from being edited away by someone who never saw the
argument for it.

A stale comment is worse than no comment, because it is believed. Changing code
means changing the comments that describe it.

## Describe the system as it is

A comment describes the system as it stands, for a reader who has the code in
front of them and no other context — not the conversation that produced the
code, and not the one that produced the comment. That one rule generates most
of what follows, and the sections below are the shapes it rules out, each of
which feels helpful while being written.

### Not the code's own past

Do not compare the code to a previous version of itself. "Preserving prior
behavior", "this used to collapse to `{}`", "no longer coerced", "now
simplified" — all of it is history. History is valuable, and its home is the
commit message and the pull request body, which is where a reader goes when the
question is how the code got this way.

State the present-tense fact and stop:

```ts
// Shown as alternative snippets.

// Wrong: half of this describes code that is not here.

/**
 * Freezes `donut` if it is not already frozen. Previously this returned
 * `undefined` for an already-frozen donut; it now returns the donut itself,
 * preserving the old caller's expectations.
 */
function freezeDonut(donut: object): object {
  return Object.isFrozen(donut) ? donut : Object.freeze(donut);
}
```

```ts
// Shown as alternative snippets.

// Right: what a caller needs, and nothing about how it came to be.

/**
 * Freezes `donut` if it is not already frozen, and returns it either way.
 */
function freezeDonut(donut: object): object {
  return Object.isFrozen(donut) ? donut : Object.freeze(donut);
}
```

This reaches test files, and the description strings in them as much as the
comments. A test added in response to a bug reads like every other test: it
states the behavior being pinned. "Regression test for the case where …"
explains why the test was written, which is again pull request material.

### Not the road not taken

State the requirement. The argument for it against some alternative that was
considered and rejected is a record of a decision, and belongs where decisions
are recorded.

"Being total is also what keeps it honest, since the alternative is collapsing
an unknown flavor into a catch-all" is a sentence about a discussion. "Every
flavor maps to a distinct key; a collision here would silently merge two
orders" is a sentence about the code.

### Not the neighbors

A comment is about the code it sits next to. Whatever is true of another module
is that module's business, and a criticism of it planted here is a claim nobody
maintaining either file will think to revisit. "`glazeOf()` tolerates some of
these today, but that tolerance is a bug rather than a contract" is a comment in
the wrong file, and possibly a bug report that was never filed.

Noting a genuine present-tense inconsistency _within_ the current system is
fine, because that is the system as it is: "the opposite of the
`undefined ≈ true` convention used elsewhere in this file" tells a reader
something true and useful.

### Not a survey of the rest of the system

Claims about the wider codebase rot silently, because nothing about editing the
far end of the claim brings anyone back here. "As all current callers do", "the
only caller", "there are three such sites" — each is one refactor away from
being false, and the refactor will not fail any check.

If a property matters, assert it locally: guard it, type it, or state it as the
contract the code enforces. Code search answers the cross-reference questions.

A doc comment may mention callers only when they are local to its own file —
that is, when the thing is not exported and the file bounds the claim.

### Not a rollout plan

Terms like "Stage 3", "the expand-acceptor step", or "parallel-change" name a
plan for getting somewhere. They have no referent for someone reading the code
later, at which point the plan is either finished or abandoned. The same goes
for issue numbers, tracker identifiers, and pull request numbers: the commit
message and the branch name carry that trail, and they stay accurate when the
tracker is replaced.

What survives the plan is why the code has the shape it has. Write that, and
give the eventual cleanup a `TODO` phrased as a condition on the world:

```ts
// Shown at module scope.

// The legacy branch exists so that orders naming a glaze by number still
// resolve.
// TODO(DonutFry99): Remove once every deployed fryer names glazes by string.
export const acceptNumberedGlazes = true;
```

Note the shape of that `TODO`: it names the fix and names the blocker. Removing
process residue is subtraction, and subtraction alone can leave a comment worse
than it found it — a vague `TODO(DonutFry99): Fix the problem.` is what
remains when a tracker identifier is deleted and nothing takes its place. Say
the thing, rather than only striking the part that cannot stay.

Note the tag, too. Every `TODO` names whoever is on the hook for it, and a bare
`TODO:` fails `deno lint`, which runs the `ban-untagged-todo` rule across the
repository. That rule also accepts an issue reference in the tag position,
which does not make one a good idea here: an issue number is exactly what this
section says to leave out of a comment. Tag a person.

### The check that finds these

Self-review does not reliably catch any of the above, because each shape reads
as helpful in the moment it is written. Grep the added comment lines of the diff
instead:

```text
before|used to|previously|no longer|formerly|the alternative|rather than the old
```

That list is a starting point, not a specification of the rule. It leans toward
the past-tense shapes, and has nothing in it that would catch a rollout stage, a
count of callers, or a complaint about a neighbor; the sections above are the
rule. Nor is every hit wrong — "before" has honest uses. Each one is a place to
ask which system the sentence describes: the one in the file, or one that is
gone.

The list is meant to grow. When a comment of one of these shapes gets past it,
add the wording that would have caught it.

## Removing code removes its comments

When a conditional or a block goes away, the comments that annotate it go with
it. Comments that annotate surviving context nearby stay. The discriminator is
whether the comment describes the thing being removed or something else that is
still there.

- A `// frozen means terminal` premise on an `if (Object.isFrozen(donut))`
  short-circuit goes when the short-circuit goes.
- A `// TODO(DonutFry99): This copy should not be necessary.` on a
  `copyIfNecessary(...)` call goes when the call goes.
- A comment describing the unbox-fill-rebox cycle around them stays, because
  it describes behavior that remains.

A premise left behind after its conditional is deleted is the most misleading
comment there is: it is well written, it is in the right place, and it is about
nothing.

## Markup

Comments are marked up as Markdown, and so are error messages and log messages
(see below).

**Backticks around code and code-like things.** This covers identifiers, literal
values (`914`, `NaN`, `undefined`, `true`), keywords and operators (`export`,
`===`), and snippets (`flavor != "chocolate"`, `fryTime: 200`). Backtick a
keyword or a constant whenever it can reasonably be read as naming the language
construct rather than as plain English; on a close call, backtick it.

A literal string is written without its quotes, so `frosted` rather than
`"frosted"`, unless dropping them would be confusing in context.

Avoid two backticked spans in a row. They are hard to read and often ambiguous,
and there is nearly always a single-span phrasing that says the same thing:
write ``when `name === null` `` rather than ``with a `null` `name` ``.

**Underscores for emphasis.**

```ts
// Shown at module scope.

// Three donuts is not enough, but _four_ should be sufficient.
export const donutCount = 4;
```

**Callables get trailing parentheses, properties get a leading dot.** Write
`eat()` for a function or method. Write `.name` for a getter or non-method
property being named without a salient receiver in context.

**The royal "we" for process.** The reader and the code are on a journey
together: "we count the `donuts` here, because one might have gone missing while
we were not looking."

## Section markers

Section markers separate major portions of a file or class. They are not
headers for individual functions and their helpers — doc comments already
carry that structure, and a reader navigating by rendered documentation never
sees the marker at all. They are not, as a rule, headers for individual test
blocks either;
[`unit-test-coding-style.md`](unit-test-coding-style.md#commenting-a-block)
says where a comment about one of those goes.

Where `//` comments can be used, mark a section of a file or a class with a
`//` comment block that opens and closes with a line holding nothing but `//`.
It carries a noun-phrase title, and optionally a fully grammatical description
after a blank line:

```ts
// Shown at module scope.

//
// Exported donut handlers
//
// These cover all currently-known types of donuts, including crullers and
// fritters.
//

export function fry(): void {}
```

A blank line sets the frame off above as well as below. Without the one above,
the marker runs into whatever comment precedes it and the two read as one
comment; without the one below, the frame reads as a note on the declaration it
touches rather than as a heading over what follows.

Directly under an opening bracket there is nothing above to separate from, and
`deno fmt` removes a blank line there in any case. A frame there takes no blank
line above it, and reads as the first region of the block rather than as a note
on it. Where the block opens with shared setup instead, the region's first
marker goes after it.

**A region has an end, and writing the marker is choosing it.** A marker opens
a region that runs to the next marker at the same level, or to the end of the
enclosing block or file. Read what sits between the marker and that point and
check the title covers all of it. Where the material the title owns stops before
the enclosing block does, put a marker there titling what follows. A file whose
last marker does not head the file's last section has a region whose end nobody
chose.

**A title is a claim about everything in its region**, not an introduction to
what comes next. The same words that pass as a label above the first of a run
become false as a title over a region holding more than they name: "the two
things that are not values" is a fact about a region with two of them in it.
When a region grows, its title is read against it again.

A title can be wrong by being too narrow as easily as too wide. Where the
subject it names also appears outside its region, either the region is in the
wrong place or the title names something smaller than its subject.

**A region holds more than its blocks.** Everything between the marker and the
region's end falls inside it: a helper function, a fixture constant, a
`beforeEach()`. A helper that serves the whole file but happens to sit inside
one region reads as belonging to that region, so shared setup goes above the
first marker.

**CSS takes a block comment.** CSS has no line comments, so a section marker in
a `.css` file, a `css` template literal, or a `<style>` block is a `/* */`
block, with each delimiter on its own line and every line at the same
indentation. Each line between the delimiters opens with `**`, which tells a
marker apart from an ordinary comment:

```css
/*
** Frosting variants
**
** One per glaze the fryer supports, in the order the menu lists them.
*/
```

That flush indentation is what `deno fmt` settles a continuation line on inside
a `css` template literal, so the single form holds wherever the CSS lives.

**No horizontal rules.** Do not put long runs of dashes, equals signs, or other
repeated characters into a comment, whether or not as part of a section marker.
The exception is a table, where they are part of the layout.

## Doc comments

### Format

This project uses JSDoc-style comments: open them with `/**`, and close them
with `*/`.

If a doc comment would fit in the 80-column line width limit including
indentation and comment markers, then it should be written on a single line,
e.g.:

```ts
// Indented as if it were a doc comment on an inner declaration.

    /** Desired fryer temperature, in Kelvin. */
```

For any other doc comment, the opener and closer go on their own lines, with
a `*` on continuation lines aligned with the _first_ opener `*`, e.g.:

```ts
// Indented as if it were a doc comment on an inner declaration.

    /**
     * A `FryerCat` is twelve cats in a trenchcoat, who operate donut fryers.
     */
```

Note that if the comment above were formatted as a single line, that line would
exceed the line width limit. This is why it is rendered as a multiline comment.

As a _counterexample_, do not make multiline doc comments where either the
open or close marker is _not_ on its own line, e.g. don't do this:

```ts
// Shown as alternative snippets.

// Wrong: Multiline comment whose delimiters are on lines with text.

/** Full list of all known donut styles, whether or not the system is capable of
 *  constructing them. */
```

```ts
// Shown as alternative snippets.

// Right: Multiline comment whose delimiters are each on their own line.

/**
 * Full list of all known donut styles, whether or not the system is capable of
 * constructing them.
 */
```

### Where one goes

A doc comment binds to whatever follows it. Nothing comes between one and the
declaration it documents: no blank line, no `//` comment, no second doc
comment, and above all no other declaration. Tooling associates the two by
adjacency, and so does a reader.

Three shapes break this, each of which looks harmless while being written:

- **A `//` note about the whole declaration, where the declaration has a body
  to hold it.** The doc comment reads as a description of the note, and the
  contract is visually detached from the thing it is a contract for. Open the
  body with the note instead — a `TODO` about a function goes inside the
  function.
- **A new definition placed directly under an existing doc comment.** The doc
  comment now documents the new definition, and the declaration it was written
  for is left with none. Adding a definition means placing it after the whole
  of the declaration above it, doc comment included.
- **Two doc comments in a row.** TypeScript keeps only the one nearest the
  declaration, so the other is invisible wherever documentation is rendered.
  Merge them if both say something worth keeping.

Three things are exceptions. A tool directive — `// deno-lint-ignore`,
`// deno-fmt-ignore`, `// @ts-types` — has to sit on the line immediately
before the code it governs, and so has nowhere else to go.

The second is mechanics with no body to go in. A type, an interface property,
or an overload list has no inside, so a `//` note about how that declaration
is put together stays beside it. Do not fold it into the doc comment to get it
out of the way: the split this document opens with holds here too, and a
caller reading the rendered documentation is owed the contract and nothing
else. What folds in is a note that turns out to be contract after all — what
the type admits, what a caller may pass.

Such a note goes below the doc comment rather than above it. A doc comment is
a header, so a `//` sitting on top of one reads as a remark about the header
instead of about the code underneath.

The third is narrower than it first sounds. One doc comment covers a whole
overload set, and `//` labels say which signature is which. Every label but
one follows a declaration, so the rule never reached them; the exception is
for the first label alone, which has nowhere to sit but between the doc
comment and the first signature:

```ts
// Shown at module scope.

/**
 * Reads a topping off a donut, by one key or by two.
 *
 * One signature per depth, so that type evaluation cannot recurse without
 * bound.
 */
// One key.
export function topping<T, K1 extends keyof T>(donut: T, k1: K1): T[K1];
// Two keys.
export function topping<T, K1 extends keyof T, K2 extends keyof T[K1]>(
  donut: T,
  k1: K1,
  k2: K2,
): T[K1][K2];
// deno-lint-ignore no-explicit-any
export function topping(donut: any, ...keys: PropertyKey[]): any {
  return keys.reduce((value, key) => value[key], donut);
}
```

A label earns that place by saying which member this is, in a list where the
signatures are hard to tell apart at a glance. One that only restates the
signature beneath it is not doing that work, and goes — even if it leaves the
rest of a numbered series behind, because the numbering was never the point.

A remark about the list itself — why it is written as five signatures rather
than one recursive type, or that a second copy of it elsewhere has to be kept
in step — stays with the list too. It is not a label, but it is mechanics, and
what a caller needs is the only thing the doc comment owes them.

A doc comment with no declaration under it at all is the same defect from the
other direction, with one exception: the file header documents the file rather
than any declaration in it, and is written as a doc comment for that reason;
see [File headers](#file-headers) below. Everything else in that shape is the
defect. To title a region of a file or a class, use a section marker; see
[Section markers](#section-markers) above.

### The blank line above

A doc comment takes a blank line above it, except where it is the first thing
in its file or bracketed block, and except in the three constructs `deno fmt`
will not keep one in.

That blank line is what separates a documented declaration from whatever
precedes it, and within those bounds it holds uniformly: a function after
another function, an interface property after another property, an array
element after another element.

Three positions have nothing above to separate from, and so take no blank line:

- **The first line of a file**, where a file header opens the file. A shebang
  or a file-scoped pragma is something above, though, and takes the blank line
  like anything else.
- **Directly under an opening bracket** — `{`, `(`, or `[` — where the doc
  comment belongs to the first member, parameter, or element of the block. The
  bracket is the separator.
- **Directly under the `=` of a type alias**, where the doc comment belongs to
  the first arm of the union or intersection that follows. The `=` opens the
  declaration the way a bracket opens a block, and the arms after the first are
  exempt under the formatter rule below. Note that `deno fmt` will keep a blank
  line in this one position, so the convention is the whole of what holds it.

The dense cases are the ones the rule is for. An interface whose properties
each carry a one-line doc comment reads as an undifferentiated run of lines
without it, and pairing each comment to its property is work left to the
reader:

```ts
// Shown at module scope.

/** Everything known about one donut. */
export interface Donut {
  /** Style, such as `cruller` or `fritter`. */
  readonly style: string;

  /** Desired fryer temperature, in Kelvin. */
  readonly temperature: number;

  /** Toppings, in the order they are applied. */
  readonly toppings: readonly string[];
}
```

Three constructs are exempt because the formatter overrules the rule there.
`deno fmt` removes a blank line between two items of a parenthesized list,
between two items of a type parameter list, and between two arms of a union or
intersection type, so a documented parameter list, argument list, type parameter
list, or union runs unbroken:

```ts
// Shown at module scope.

/** Fries one donut to order. */
export function fry(
  /** Style to fry. */
  style: string,
  /** Desired fryer temperature, in Kelvin. */
  temperature: number,
): void {}

/** What a fryer is doing right now. */
export type FryerState =
  /** Idle, at whatever temperature it last held. */
  | { readonly kind: "idle" }
  /** Coming up to temperature, with the shortfall in Kelvin. */
  | { readonly kind: "heating"; readonly shortfall: number }
  /** Frying, with the count of donuts in the basket. */
  | { readonly kind: "frying"; readonly count: number };
```

Object types, tuple types, array literals, and class and interface bodies all
keep their blank lines, so the rule holds in full there.

### The blank line below

A documented declaration takes a blank line after it as well. The rule above
separates a doc comment from what precedes it; this one bounds what it covers.

Without that blank line a doc comment reads as a header over everything down to
the next one, and whatever sits under the declaration it was written for looks
documented when it is not:

```ts
// Shown as alternative snippets.

// Wrong: `humidity` reads as covered by the comment above `temperature`.

interface Reading {
  /** Fryer temperature, in Kelvin. */
  readonly temperature: number;
  readonly humidity: number;
}
```

```ts
// Shown as alternative snippets.

// Right: the blank line ends the doc comment's reach.

interface Reading {
  /** Fryer temperature, in Kelvin. */
  readonly temperature: number;

  readonly humidity: number;
}
```

Anything following takes the blank line, not only another declaration. A
statement under a documented local is the same shape and gets the same
treatment.

The exemptions mirror the ones above. A declaration with nothing after it in
its file or bracketed block takes no blank line: the closing bracket, or the
end of the file, is the separator, exactly as the opening bracket is on the
other side. And the three constructs `deno fmt` will not keep a blank line in
are exempt here for the reason they are exempt there — the formatter strips one
after a documented parameter, type parameter, or union arm just as it strips one
before.

The rule reaches documented declarations only. Two adjacent members carrying no
doc comment between them leave no comment's scope in doubt, and stay as they
are.

For this rule an overload set is one declaration. Its signatures and the
implementation carrying the code are a single thing to a caller and a single
thing to the doc comment above them, so no blank line falls between one part of
the set and the next; the one that closes the set goes after the implementation.
The blank lines inside the implementation's own body are statement spacing and
are not what this means.

A set with no implementation to close it — in an interface, or in ambient
`declare` form — is an overload set all the same, and closes after its last
signature. `deno fmt` keeps a blank line between two signatures, so this is a
convention no gate will raise.

### What gets one

- Every file, as a header, except for the kinds listed under
  [File headers](#file-headers) below.
- Every exported symbol: variable, function, class, type.
- Every class and every public member of one, including the constructor,
  whether or not the class is exported.
- Every `type` and `interface` declaration and every member of one, whether or
  not the declaration is exported.
- Every non-trivial internal function.

Anything else may have one, and the bar is low. Err toward writing one for all
but the most trivial definitions.

### What goes in one

A doc comment that restates the name and the type signature has added nothing.
Reach for three things:

- **What** it does or represents, adding the context the name alone does not
  carry.
- **Why** it exists, or a pointer to the part of a specification that decides
  its behavior, or both.
- **The bound on any guarantee it claims.** When a comment says a check catches
  something, say what it does not catch. A reader takes "catches drift" to mean
  "catches drift", and the unstated half is exactly where a check that works
  gets trusted past its range. A `satisfies` pin, for instance, catches a
  missing or mistyped member and is blind to an extra one, because
  assignability permits extras.

A doc comment states the contract, and states it accurately. Accuracy here
means not overclaiming: a function that is safe to call on a frozen input but
that does freeze what it is given says so, rather than claiming it never
mutates.

```ts
// Shown at module scope.

/**
 * Canonicalizes `order`, returning an instance equivalent to it which is safe
 * to share. Safe on a frozen or a mutable argument, and never requires a
 * mutable one, though it may freeze the argument in place.
 */
export function canonicalizeOrder<T extends object>(order: T): T {
  return Object.freeze(order);
}
```

Keep it tight. A sentence or two usually does it. The goal is for a reader —
human or agent — to understand the intent without reading the implementation.

Contracts go in the doc comment, not in inline exhortations. An inline comment
explains local mechanics; the doc comment says what a caller can rely on.

### When one is also data

A doc comment on a type that reaches the schema generator does not stay
documentation. It attaches to the generated schema as its `description`, and
any `#hashtag` in that text is mirrored into a `tags` array, lowercased and
deduped. Where two declarations of the same thing carry conflicting docs, the
first wins and the conflict is recorded in `$comment`.

On such a type, then, a doc comment is program output, and a `#hashtag` written
as an aside becomes a tag whether or not one was meant. Which comment attaches
where is settled by section 12 of
[the type mapping spec](../specs/schema-generator/ts_to_json_schema_mapping.md).

### How one starts

**Functions and methods** start with a subjectless third-person singular verb
phrase: `Writes the donut preferences to stable storage.` Special cases:

- **An internal helper** starts `Helper for <the thing being helped>, which
  <verb phrase as above>.`
- **A variation on a theme** may be stated against its baseline:
  `Like <baseline>, except <difference>.`
- **A constructor** starts with the words `Constructs an instance`, with any
  salient detail in that same sentence: `Constructs an instance which keeps
  track of donut staleness.` A constructor that genuinely needs no further
  detail gets exactly `Constructs an instance.`, which shows the documentation
  was not left out by oversight.
- **An override or interface implementation** needing no further detail gets
  exactly `/** @inheritDoc */`, which likewise shows the absence of detail is
  deliberate.

**Variables and properties** start with a noun phrase, usually without an
article: `Special designation category of the donut.` Use "the" for something
singleton-ish: `The cache of all known donut manufacturers.`

### File headers

A file gets a doc comment of its own, and it goes at the very top: above the
first `import`, above the first `export`, above every declaration, with nothing
between it and them but a blank line. Only a shebang or a file-scoped pragma
such as `deno-lint-ignore-file` precedes it.

It is the one doc comment whose subject is the file rather than the code
beneath it, which is why [Where one goes](#where-one-goes) excepts it and
nothing else. The blank line is load-bearing for that same reason: it is what
keeps the header from being read as the doc comment of the first declaration
under it.

Every file gets one, except for the four kinds below.

**A file that defines a single thing.** Where the whole content of a file is
one declaration — one class, one function, one type — along with the imports
and the private helpers serving it, that declaration's own doc comment is the
file's documentation, and a header above it can only duplicate it or drift
from it.

What would otherwise have felt file-scoped goes into that doc comment, so long
as it is contract: why the thing exists at all, what a caller has to know that
the signature does not carry. Keeping it there is what puts it in front of a
reader who arrives at the declaration, and in front of one reading rendered
documentation, which never shows a file header at all — the same reason two
doc comments in a row lose one of themselves.

The fold is bounded by [Where one goes](#where-one-goes), which is not relaxed
here. Mechanics still do not belong in a contract, and a single-declaration
file always has a body to put them in.

Comparison against a neighboring module is bounded too. A header could get
away with "unlike the other one, this buffers", because a header answers to
nobody; a doc comment saying it is making a claim about a file that can change
without anyone coming back here, which is what
[the rule against surveying][survey] the rest of the system exists to stop.
State the difference as a property of this declaration instead, in
the `Like <baseline>, except <difference>.` form that
[How one starts](#how-one-starts) gives.

Where the single declaration is a type that reaches the schema generator, the
fold does not happen at all: that doc comment is program output, as
[When one is also data](#when-one-is-also-data) explains, and module rationale
shipped as a schema `description` is worse than a file header. Such a file
keeps its header.

The exception ends where the file does. A second exported declaration, or
module-level machinery that is not simply in service of the one, and the file
has something to say about itself again.

**A unit test file.** Its name says what it tests, and its one top-level
`describe()` says it again, so the header a typical one could carry is either
``Unit tests for `fryer.ts`.`` or a restatement of the contract that the code
under test already documents. Neither is worth the slot, and a file whose
header would be one of those has none.

The exemption is narrower than its name, in two ways. It covers the unit test
file itself, `.test.ts` or `.test.tsx`, and nothing beside it: a helper module
under `test/` — shared setup, a fake, a builder for test values — is an
ordinary file, and gets a header on the ordinary terms. A pattern test is a
different form, as [`unit-test-coding-style.md`](unit-test-coding-style.md)
says, and is not what this names. And it is a default rather than a bar. A test
file that does something a reader would not guess from its name — walks a
generated corpus, drives the code under test from a second runtime, checks two
implementations against each other — has something to say about itself that no
declaration in it says, and a header is where that goes.

**A re-export barrel.** Its whole content is the list of what it re-exports,
and each entry carries its own doc comment where it is declared. A header
could only repeat the list, and would stop matching it at the next line added
to the file.

**A test fixture whose content is the point.** The file is an input a test
feeds to the code under test, or an output it compares against, and what it
is for is stated in the test that reads it. A header inside it would be part
of the content, and where the fixture is source that a compiler or transformer
takes in, part of what the test measures.

Two placements look close enough to pass and are not. A `//` block is not an
alternative form of a header: it reads as a note about the line beneath it,
which is what makes it right for local mechanics and wrong for a statement
about the whole file. And a header below the import block fails twice over — it
is separated from what it describes by the longest stretch of unrelated text in
the file, and it sits exactly where a reader expects the doc comment of the
first declaration.

A file header takes the same three things as any other doc comment: what the
file is, why it exists, and the bound on anything it claims. Two shapes waste
the slot:

- **A title.** `Shopping List Pattern` above `shopping-list.tsx` restates the
  filename, and a doc comment that restates the name has added nothing. Open
  with a claim, in a full sentence.
- **Tag scaffolding.** No `@fileoverview` and no `@module`. Which file the
  comment heads is not in doubt, and the tags crowd out the sentence that would
  have carried the content.

```ts
// Shown for illustration only.

// Wrong: below the imports, in the `//` form, and titled rather than stated.

import { FryerCat } from "./fryer-cat.ts";

// Fryer Scheduling
```

```ts
// Shown for illustration only.

// Right.

/**
 * Assigns donuts to fryers. The order is not first-come: a fritter leaves the
 * oil unusable for anything else in the same shift, so fritters are batched
 * last. Scheduling only — nothing here starts a fryer.
 */

import { FryerCat } from "./fryer-cat.ts";
```

## Error and log messages

The text of a thrown error or a log message follows the same markup rules as a
comment: backticks around code and code-like things, and the same conventions
for naming functions, methods, and properties.

```ts
// Shown at module scope.

export function checkFlavor(flavor: string): void {
  if (flavor !== "chocolate") {
    throw new Error(`Unsupported flavor: \`${flavor}\``);
  }
}
```

### Putting a value into a message

The example above puts backticks around a string by hand, which is fine for a
value known to be a short string with no backtick in it. Most values a message
reports are not that. A value may be an object, a `FabricValue`, a symbol, or
something whose `toString()` throws. Its rendering may hold a backtick, which
ends a hand-written code span early, and it may run to thousands of characters.

Compose such a message with the `debugStr` template tag from
`@commonfabric/data-model`. A _directive_ right before a substitution, a dollar
sign and then comma-separated words, asks for the value's debug rendering,
quoted and cut to length:

```ts
// Shown at module scope.

import { debugStr } from "@commonfabric/data-model";

export function checkTopping(topping: unknown): void {
  if (typeof topping !== "string") {
    throw new Error(debugStr`Not a topping: $quote${topping}`);
  }
}
```

The words a directive can hold:

| Words | Rendering of the value |
| --- | --- |
| `quote` | compact, cut to 50 characters, as a Markdown code span |
| `quote,long` or `quote,xlong` | the same, cut to 500 or 5000 characters |
| `short`, `long`, `xlong` alone | compact and cut as above, without the quoting |
| `indent` | indented, cut to 5 lines, or with `long` to 50, or with `xlong` to 500 |
| `quote,indent` | the same, as a Markdown fenced code block on lines of its own |

Reach for `$quote` by default. Use `$quote,long` when the reader has to
recognize which value it was, compare two renderings, or read a list to its
end. A substitution with no directive before it converts the way a template
literal converts one, except that the conversion never throws. A backslash
before the dollar sign, as in `\$quote${value}`, keeps directive-like text
literal.

How a value renders is not a contract: the renderings are for a person reading
a diagnostic, and they change as that reading is improved.

The `cf-debug-str/valid-directive` lint rule (`tasks/lint-debug-str.ts`,
registered in the root `deno.jsonc`) reports a directive holding a word other
than these, or more than one of the size words. At run time such a directive
stays in the message as text and the value gets the default rendering, so a
message composed on an error path still says something.

Two pairs of functions serve the cases a template does not fit.
`backtickQuote()` and `backtickFence()` from `@commonfabric/utils/markdown`
quote text of any content as a code span or a fenced block.
`toCompactDebugString()` and `toIndentedDebugString()` from
`@commonfabric/data-model` render a value where the rendering is handed on as
a value rather than placed in a message.

[survey]: #not-a-survey-of-the-rest-of-the-system
