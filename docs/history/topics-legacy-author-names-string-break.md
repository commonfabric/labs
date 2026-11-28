---
status: historical
created: 2026-11-19
archived: 2026-11-19
reason: "Decision record for the Topic contract break that declares the legacy author-name keys `createdByName` and `comments[].authorName` as strings, to fit Topics to the compiled pattern subset."
---

# Topic legacy author-name keys declared as strings

`TopicInput.createdByName` and the `authorName` of a stored comment in
`patterns/apps/topics/topic.tsx` are declared `string`, optional. Both were
declared `unknown`. They are keys of older data: the ordered upgrade of a topic
reads them once, to fill in a structured author where an older version recorded
only a name.

## The decision

The owner accepted the break on 2026-11-19, as part of rewriting the source of
Topics to the subset of the compiled pattern language. In that subset a body
handed a data position typed `unknown` holds a reference and nothing more: a
kind test such as `typeof x === "string"` narrows nothing, and a key of older
data that code reads as a string is declared `string`
(`docs/specs/compiled-pattern-language/language-subset.md`, §7.8, on the
branch of the design pull request #9788, not on the main branch when this was
written). The upgrade read both keys after a `typeof` test, which the subset
refuses. The prototype's compiler, `base/pattern-compiler` in #9942 and the
pull requests stacked on it, reports that read as
`schema:unknown-type-access`.

Before the rewrite the source kept the contract `unknown` and read the two keys
under a schema of its own: the upgrade's state declared each as
`type: ["string", "unknown"]`, a string where one is stored and a reference
otherwise. The subset has no form for that. A read-only handle of
`string | undefined` bound to a place typed `unknown` is refused, since a
read-only handle is covariant in its type (`language-subset.md`, §7.5.1).

The alternative was to change that rule, so that a read-only handle may declare
a type narrower than a place typed `unknown`, a stored value outside the type
reading as `undefined`. That keeps the contract and needs a change to the
specification. It was not taken.

## What the declaration does not change

What the upgrade does with a stored value. A stored string supplies the name, as
before. A stored value of another type reads as absent, where before it read as
a reference that the `typeof` test turned away; either way the upgrade completes
the topic with no name from that key. `author-migration.test.tsx` holds the
case: a topic stored with `createdByName: 42` and a comment with
`authorName: false` completes its upgrade with an empty creator name and no
comment author, before the change and after it.

## What broke, on purpose

Over the 18 baselines from `20260911T185348Z-TLZ8gBXbqm4PebTM` to
`20261127T211045Z-bY22_7B0dqerK1Os`, the compatibility proof reports two paths,
each with "the candidate no longer accepts every previous type":

- `argument.createdByName`
- `argument.comments[].authorName`

Every path the proof reports against those baselines is one of the two. The
older baselines report neither.

`deno task pattern-vintage` passes. Its report differs from a replay of the
source before the rewrite in one respect: two hoisted sub-patterns of
`topic.tsx` in the fixture of 2026-11-16 have stored arguments today's schema
refuses, and the gate holds them back by its rule for a hoist, whose arguments
the updated source supplies again. Every line naming a changed value is the
same in both replays, so no state is stranded.

## Disposition of deployed pieces

The updater proves the same compatibility, so a Topic deployed at the `unknown`
declaration takes this one update forced, as with the profile-picture narrowing
(`docs/history/topics-profile-picture-forced-update.md`), and every update after
it is proven again. The forced update was not rehearsed in this change.
