# Type-checking doc code blocks

`docs/check.sh` (which runs `docs/check.ts`) type-checks the TypeScript and TSX
code blocks embedded in the Markdown under `docs/`, except `docs/history/` —
archived documents keep the API of their era and are not kept compiling. It
runs in CI as the `check-docs` gate of the `repo-gates` suite in the test
topology. Run it locally with:

```text
deno task check-docs            # all of docs/ (minus history/)
deno task check-docs tutorial   # just docs/tutorial/
```

## How a block is checked

Most snippets are fragments — the body of a pattern, a piece of JSX, a few
interface members — that lean on identifiers the surrounding (elided) code would
provide. A block opts into a context by starting with one of these comments, and
the checker splices the block into the matching scaffold before running
`deno check`:

```text
// Shown at module scope.                 top level of a module
// Shown inside a pattern body.           inside a function body
// Shown as JSX element children.         inside a JSX fragment (must contain JSX)
// Shown as interface or class members.   inside an interface / class body
// Shown as alternative snippets.         "wrong then right" variants, each in
//                                        its own scope so a name can recur
// Shown for illustration only.           not type-checked (pseudocode)
```

A block with no marker is checked as a standalone module (the previous
behavior). The scaffold supplies the `commonfabric` surface and ambient
declarations for the example identifiers listed in `check.vocabulary.json`.

## When the check fails on a block you added

Pick whichever applies:

- The snippet is a fragment that needs a surrounding context — add the matching
  marker as its first line.
- The snippet references an example variable defined in elided code — add the
  identifier to `others` in `check.vocabulary.json`.
- The snippet is illustrative pseudocode (placeholders, `...`, a wrong-then-right
  pair) — mark it `// Shown for illustration only.`
- The snippet is a verbatim citation of repository source, in a document whose
  purpose is to quote source — see the next section.

## Documents that quote source verbatim

A few documents exist to show what the repository actually contains: they cite
real declarations from real files so a reader can go check them. Their blocks
are excerpts, not examples. An excerpt of a function body has no imports and no
surrounding scope, so it cannot compile in isolation and no context marker can
rescue it. Such a document opts out as a whole by putting

```text
<!-- check-docs: excerpts -->
```

on its own line, anywhere in the file.

This is not a lighter form of `// Shown for illustration only.`, and it is not
counted by the TODO below. An illustrative block has no source of truth and can
drift into fiction unnoticed; an excerpt has one named file behind it and is
wrong the moment it stops matching that file. The failure mode is real but
different, and the fix is different too — reread the source, not the scaffold.

Use the declaration only when a document's blocks really are citations. If a
block is your own example that merely needs surrounding scope, give it a context
marker instead.

## TODO: drive the skipped count to zero

Every `// Shown for illustration only.` block is a snippet the check does not
verify, so it can rot silently. The goal is to have none. As the contexts and
vocabulary grow and snippets are tidied up, each illustrative block should either
become checkable in a real context or be rewritten so it compiles. Treat the
skipped count as a number to drive down to zero over time.
