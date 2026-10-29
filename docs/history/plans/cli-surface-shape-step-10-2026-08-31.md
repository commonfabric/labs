---
status: historical
created: 2026-08-31
archived: 2026-08-31
reason: "Record of step 10's execution and the trade it made; the plan it came from stays live for steps 9 and 11."
---

# Step 10 of the CLI surface shape: what the sweep cost, and what it traded

A record of executing step 10 of
[CLI surface shape](cli-surface-shape.md) — the step that made the
verb open the callable's section and `--` close it, so a projection is written
after the verb it shapes rather than before.

## The sweep

The step's documentation sweep ran to twenty-one files, across `docs/`,
`skills/`, `packages/cli/README.md`, and the CLI's own tests and integration
scripts.

The count is worth recording because the estimate written before the sweep was
twelve. The estimate was built from a `git grep -E` pattern that used `\b` for
a word boundary, and on the machine the sweep ran on that pattern matched
nothing at all — no output and exit 1, which is exactly how the same command
reports a pattern with no matches in the tree.

The measurements behind that, taken on the same machine and the same checkout:
`git grep -cE '\bcall\b' -- packages/cli/README.md` finds nothing, while
`git grep -cE 'call'` on that file finds 87 lines, `git grep -cP '\bcall\b'`
finds 43, `git grep -cE '[[:<:]]call[[:>:]]'` finds 43, and the system's own
`grep -cE '\bcall\b'` over the same file finds 43. So the corpus was there and
the pattern was not reaching it, and `\b` is not simply unsupported on this
machine — it works in `grep -E` and fails in `git grep -E`, one command apart.

What is load-bearing is not which engine does what. It is that a pattern whose
meaning varies between two tools on one machine — and, being an escape a regex
dialect may or may not define, between platforms — is not a pattern to build an
estimate on. And that this one failed in the one shape that cannot be noticed:
a count of nothing, reported the way a true count of nothing is reported.

Two of the twenty-one were the verb session documents, whose commands
`deno task check-verb-session-sync` holds to what
`packages/cli/integration/verb-session-demo.sh` runs. Those changed in the same
commit as the script, because the gate compares them.

## The trade

Before this step, the read options could precede the positional on all six
commands that read. That was the one spelling a caller could carry between
them, and step 10 took it away: a projection written before the verb is
refused.

What replaced it is a spelling that also works on all six — the read options
after the thing they shape, with `--` closing a callable's section wherever one
stands in between. So the property survived the change and the syntax carrying
it did not, which is the trade the step made rather than a cost it overlooked.
Every refusal prints the corrected line, because the caller meeting one wrote a
spelling that used to work.
