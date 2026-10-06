---
paths:
  - ".claude/rules/**"
---

# Path-scoped rules

Each file here carries guidance for one kind of file. The `paths` list in a
rule's front matter decides when it loads: Claude Code pulls the rule into
context when it reads a file matching one of those globs, and otherwise leaves
it out. That is the difference between this directory and `AGENTS.md`, which is
loaded in full at the start of every session whatever the session turns out to
be about.

Use that difference. A rule can afford to be specific — name the check that
fails, name the helper to reach for, name the file to edit — because nobody
pays for it while working on something else. `AGENTS.md` cannot, and should
carry only what a contributor needs before they know what they are working on.

A rule names things rather than restating them. Where the authority is a
document, cite it and say only the part that is easy to miss. A rule that
paraphrases a document is a second copy, and the two will disagree eventually.
`deno task check-skill-facts` covers the mechanical half of that: it fails when
a path or import specifier cited here stops resolving. The half it cannot see —
a summary that still resolves and is no longer true — is why a rule should stay
short enough to re-read in full.

This file is a rule too, scoped to the directory it sits in, so it arrives when
someone works on the rules and stays out of the way otherwise. Give every rule
a `paths` list: one without it loads unconditionally, which puts it back in the
always-on budget this directory exists to stay out of.

## Adding a rule

A rule earns its place when all of these hold. It applies to a recognizable set
of files rather than to the repository as a whole. It is specific enough that
you could tell whether a change obeyed it. And getting it wrong costs something
real: a failing gate, a silent regression, a design that has to be unwound.

Scope by file type or by name, not by directory. A directory already has two
better mechanisms: an `AGENTS.md` in it, which every agent reads, and a
`README.md`, which people read too.

## Why a rule is not a symlink to the document it cites

Claude Code follows symlinks out of this directory, so a rule could be a link
to an existing document with a `paths` list added to that document's front
matter — one file instead of two, and nothing to drift. It does not work here,
for four reasons worth writing down so the idea is not re-tried blind.

A rule loads whole, and the documents these rules cite are an order of
magnitude longer than the rules. Linking the test rule at
`waiting-in-tests.md` would put well over a thousand lines into context on
every test file opened, at the one moment the guidance most needs to be short
enough to scan.

No rule here has a single target. Each is a synthesis: the test rule draws on
the waiting document, the shadow-DOM document, the browser helpers, the
allowlist in the check itself, and a skill. A symlink can only point at one.

Linking a document in enrols it in whatever governs this directory.
`check-skill-facts` covers everything here, so a linked document is scanned
under two names at once, and its relative citations resolve against
`.claude/rules/` rather than its own directory. Tried against
`skill-authoring.md`, this fails immediately on an illustrative specifier the
document was never written to satisfy.

Finally, `paths` is one tool's configuration. Keeping it in `.claude/` keeps it
out of documents that Codex and people also read.

## The gap this does not close

`.claude/rules/` is Claude Code's mechanism. Codex has nothing equivalent: it
composes the `AGENTS.md` files from the repository root down to the working
directory, so its only file-type-aware channel is the root `AGENTS.md`, and a
nested `AGENTS.md` reaches it only when the working directory is inside that
subtree — which it usually is not.

So a rule here is a way to say more, at the moment it matters, to one agent. It
is not a way to move something out of `AGENTS.md`. Anything an agent must not
get wrong still needs a line in the root `AGENTS.md`, where every agent sees
it. Each rule here expands on one of those lines: the "Automated gates"
section holds the ones a check enforces, and the engineering-practice sections
hold the ones only a reviewer will catch.

## The rules

| Rule                              | Covers                                         |
| --------------------------------- | ---------------------------------------------- |
| `source-code.md`                  | every `.ts` and `.tsx` file                    |
| `tests.md`                        | test, bench, and integration files             |
| `workspace-packages.md`           | `deno.jsonc`, at the root and in every package |
| `documentation.md`                | everything under `docs/`                       |
| `github-workflows.md`             | `.github/workflows/`                           |
| `skills.md`                       | `skills/`                                      |
| `pattern-visible-declarations.md` | `packages/api`, and what mirrors it            |
| `cfc.md`                          | the CFC runtime sources and tests, the render boundaries, the harness's CFC enforcement, and `docs/specs/cfc-*.md` |
