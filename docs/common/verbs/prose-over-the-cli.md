# An author's prose, over the CLI

What a pattern's author writes in a doc comment, and how it reaches someone
driving that pattern through `cf`. The short version is that a caller's tools
read **two documents** — the schema the piece serves on the wire, and the
compiled pattern behind it — and knowing which carries what is the difference
between finding an author's sentence and concluding it was never written.

[A verb session, end to end](session-walkthrough.md) is the session this
supports; its step 3 renders the help page these rules produce, and points
here rather than restating them.

## What the served schema carries

A verb dispatches through a callable cell, and that cell takes its schema from
the link chain it resolves through ([`cell.ts:asSchemaFromLinks`][cell]). For a verb
that link is the handler node's `$event` input — which, under the
[verb input contract](../../history/plans/verb-input-contract.md), is the author's
event type rather than a summary of what the handler body reads. So a declared
field the body never mentions is served like any other, and the field comments
beside those fields travel with it.

Two things do not travel with it.

**A comment on the verb** describes the verb, not its event. It lives on the
pattern's result schema, beside the `$ref` naming the event type, and never
rides the event schema at all.

**Capability markers**, all but `stream`. Link sanitization strips them
(`sanitizeSchemaForLinks`, `KeepAsCell.OnlyStream`), so a position an author
declared `Writable<T>` arrives shape-intact and marker-less. That is why the
dispatch gate reads the compiled pattern to decide which positions declare a
reference, rather than trusting the schema in front of it.

## Where each level compiles to

| An author writes… | Where the compiled pattern keeps it |
| --- | --- |
| a comment on the **verb itself** | `resultSchema.properties.<verb>.description`, a sibling of the `$ref` naming its event |
| a comment on an **event field** (what `title` means) | `$defs.<Event>.properties.<field>.description` |
| a comment on the **event interface** | nowhere — this one does not compile ([#5937](https://github.com/commonfabric/labs/issues/5937)) |

`cf piece verbs` and `cf piece call <verb> --help` already load the compiled pattern
to report what a verb hands back, so both read the prose from the same load.
The verb's own comment becomes the listing row's `description` and the help
page's summary line. The event fields' comments are folded into the input
schema the page renders flags from, at the positions that schema already has.

## Why the fold walks two documents

The served schema and the declared one need not agree structurally. A handler
with an authored event type serves that type, so the two line up by
construction. A handler written without one has only the inferred summary, and
there they diverge: the same field can be a `$ref` in one and an inline object
in the other, and a union the declared side spells as `anyOf` can arrive as one
merged object. A walk that stepped through `properties` key-for-key would find
a bare `$ref` on one side with no `properties` under it, or a field whose prose
sits inside an arm that does not exist on the other side, and stop short of the
words in both cases.

Both sides' references are followed for that reason, and a declared combinator
is read through to its members. A served reference is followed *without* being
inlined, and a served combinator is never flattened: a caller's tooling reads
that shape, and a definition several positions share is not one position's to
rewrite. A field's own prose is therefore written where the field is, never
into the definition it points at — which would attribute one position's
sentence to every other holder of the same type. The precise list of positions
the fold walks is on `withDeclaredFieldProse` ([`packages/cli/lib/piece.ts`][piece-lib]),
enumerated rather than summarized, along with the keywords it leaves alone.

## Folded in, never substituted

Only `description` annotations cross between the two documents. The served
schema stays the authority on shape and takes only the words.

Substituting one document for the other would describe the source rather than
the piece being talked to — which is the rule even where an authored event
makes the two agree, because the piece in front of a caller may be running an
older pattern than the source in the checkout.

<!-- Source links resolve against the repository's default branch, so they
     follow head rather than pinning a revision this document would outlive. -->

[cell]: https://github.com/commonfabric/labs/blob/main/packages/runner/src/cell.ts
[piece-lib]: https://github.com/commonfabric/labs/blob/main/packages/cli/lib/piece.ts
