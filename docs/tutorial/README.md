# The Common Fabric Tutorial

This is a guided tour of the Common Fabric system for an engineer who is
comfortable with programming and technical systems but has never seen this
codebase. It is written to be read in order, but it is split into two parts so
you can stop at the depth you need.

**Part I — Using the system (the contract).** What problem Common Fabric
solves, the concepts you program against, and everything you need to write,
test, and deploy patterns. After Part I you can build real things without
knowing how any of it is implemented.

**Part II — How it works (the mechanism).** The same system revisited
subsystem by subsystem: the compiler pipeline, the reactive scheduler, the
storage and sync protocol, identity and isolation, and the deployed topology.
After Part II you can reason about behavior, performance, and failure modes,
and debug surprises.

Each Part I chapter ends with a pointer to its Part II counterpart, so you can
also read "vertically": learn a concept, then immediately open the hood on it.

## Reading map

| | Chapter | You'll learn |
|---|---|---|
| **Part I** | [1. The problem and the big picture](01-big-picture.md) | Why this exists; the five-layer shape of the solution; core vocabulary |
| | [2. Cells: reactive, durable state](02-cells.md) | The unit of state; `Writable<>`, `Default<>`, scoped state |
| | [3. Patterns: programs as reactive graphs](03-patterns.md) | `pattern()`, `computed()`, `action()`/`handler()`; a full working example |
| | [4. UI: rendering and binding](04-ui.md) | JSX, the `cf-*` component library, two-way binding, lists and conditionals |
| | [5. Composition, pieces, and capabilities](05-composition-and-pieces.md) | Sub-patterns, deployed pieces, linking, navigation, built-in LLM calls |
| | [6. The development workflow](06-workflow.md) | `cf check`/`piece new`/`call`/`test`; the gotcha checklist |
| **Part II** | [7. From TypeScript to a runnable graph](07-compilation.md) | The transformer pipeline; how types become JSON schemas |
| | [8. The reactive runtime](08-runtime-internals.md) | What a Cell really is; the scheduler; transactions and retries |
| | [9. Storage and sync](09-storage-and-sync.md) | The commit protocol, conflict detection, subscriptions, SQLite layout |
| | [10. Identity, authorization, and isolation](10-identity-and-security.md) | DIDs, passkeys, signed sessions, sandboxing untrusted code |
| | [11. The deployed system, end to end](11-deployed-system.md) | Toolshed and the shell; one click traced through every layer |

## How to choose your path

- **"I want to build a pattern this afternoon."** Read chapters 1–6, keep
  [chapter 6](06-workflow.md) open while you work, and skim the gotchas list
  before your first deploy. The repo-local skill `skills/pattern-dev/SKILL.md`
  is the operational companion to this tutorial.
- **"I'm joining the runtime team."** Read all of Part I quickly for
  vocabulary (don't skip it — Part II assumes it), then read Part II
  carefully. Chapter 11 ties the layers back together.
- **"I just need to evaluate the architecture."** Read chapters 1, 8, 9,
  and 11.

## Conventions in this tutorial

- File references like `packages/runner/src/scheduler.ts` are relative to the
  repository root and are the ground truth; when this tutorial and the code
  disagree, the code wins.
- Code in patterns imports from the `commonfabric` module.
- This tutorial uses the current names, **pattern** and **piece**. An older name
  for pattern, *recipe*, survives only in a few stale comments and test
  fixtures.
