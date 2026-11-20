---
status: historical
created: 2026-11-19
archived: 2026-11-19
reason: "Decision record for the suggestion pattern reading each context entry as a cell."
---

# Suggestion: context entries are read as cells

`system/suggestion/suggestion.tsx` declared its `context` argument as
`{ [id: string]: any }`. The compiled pattern language refuses `any`
(`subset-type:any`), so the argument is now
`Record<string, Writable<unknown>>`. That is the type `llmDialog` declares
for its own `context` (`Record<string, AnyCell<any>>`), and the pattern
passes the argument to `llmDialog` unchanged. `Record<string, unknown>` does
not type-check against that parameter.

## The break

Each entry of the argument's schema now carries `asCell`. The compatibility
proof reports `argument.context.*: asCell changed` against the three
recorded baselines.

No stored state is stranded. A stored entry is either a literal or a link to
another cell, and either one reads as a cell: a literal becomes a cell
holding it. `llmDialog` reads each entry's value to show it to the model, as
it read the value before. The suggestion tests, and the tests of
`daily-journal` and `do-list`, which embed the pattern, pass with the change.

Declared on Bernhard's decision (2026-11-19), together with the other
contracts that removing `any` from the system patterns changed. Those apply
over their recorded baselines and are recorded beside it.
