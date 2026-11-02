---
status: historical
created: 2026-11-02
archived: 2026-11-02
reason: "What starting `cf` and the Topics client cost under server execution, measured while cutting `topics new` to a few seconds"
---

# What starting `cf` and `topics new` cost, November 2026

Filing a Topic is meant to take a few seconds at most. Under server execution the
server runs the handler, and `cf piece call` sends the event and waits. That left
`topics new` at about 6 s with the cost almost entirely in the client. This
records what that cost turned out to be, on a Mac whose load average ran from 20
to 410 from other work, against a local stack with
`EXPERIMENTAL_SERVER_EXECUTION=true` and
`EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION=true`.

## Start is a module walk, not evaluation

A bare `deno run` took 30-60 ms, and the launcher 60 ms. `runtime/cli/mod.ts`
statically reached 1,464 of the 1,668 modules on its graph, and took 3.5-6 s of
wall time and 2-5 s of CPU to reach its first line at load 30.

A CPU profile of an `await import()` of that entry spent 3.6-5.2 s of its 4.4-7.1
s in `(idle)`, and at most 0.5 s in JavaScript. The thread was waiting on Deno
reading modules, so the cost was how many it read rather than what they did at
load. TypeScript, the expected culprit, evaluated in 0.15 s of CPU with a code
cache hit.

## Three things decide what is read

**A literal `import()` that is never taken.** A script holding
`if (Deno.args[0] === "go") await import(".../mod.ts")`, run without `go`, took
1.9-6.4 s. The same import through a computed specifier took 0.08-0.2 s, and the
literal one under `--unstable-lazy-dynamic-imports` 0.05-0.2 s. So deferring an
import saved evaluating the module and nothing else until that option was on.
`deno compile` follows literal imports with or without it, which the compiled
binary relies on.

**An import TypeScript erases.** `import { type X } from "y"`, and
`import { X } from "y"` where `X` appears only in type positions, are both erased
at run time and both followed by the walk. 229 files held the first kind and 71
the second. `builder/pattern.ts` importing `Runtime` for its type held 250 modules
under `storage/v2.ts`, because the runner's modules form an import cycle of 145
modules and reaching it reached what it imports.

**A barrel.** `@std/path` is 73 modules, against 16 for `@std/path/join`.
`@db/sqlite` brought a second version of it, through `executor/watermark.ts`,
whose one use of the memory engine was a function only the serving side calls.

## What each graph reads

Modules reached statically from each entry:

| Entry                                  | Before | After |
| -------------------------------------- | ------ | ----- |
| `runtime/cli/mod.ts`                   | 1,464  | 76    |
| `runtime/cli/commands/piece.ts`        | 996    | 817   |
| `runtime/cli/commands/cell.ts`         | 997    | 818   |
| `patterns/apps/topics/tools/topics.ts` | 731    | 276   |
| `runtime/runner/src/storage/v2.ts`     | 701    | 448   |

What is left under `piece` is the runner's core: 113 modules at the top of
`runner/src`, 72 under `cfc`, 55 under `builtins`, 37 under `scheduler`, and 109 of
`data-model`. A command that builds a `Runtime` reads those, so cutting further
means separating the `Runtime` from the builtins, the scheduler or the CFC
machinery.

## Results

Each row is seven pairs taken alternating, order swapping every round, after a
warm-up round that was discarded. The board grew from 40 Topics to about 115 over
the two runs. `cf cell get` read one Topic's `title`, and `cf piece call` passed
the same `--schema` on both sides. Times are medians in seconds, and CPU is user
plus system.

First run, load median 257:

| Command         | Wall before | Wall after | CPU before | CPU after |
| --------------- | ----------- | ---------- | ---------- | --------- |
| `bin/cf --help` | 14.41       | 0.58       | 5.30       | 0.27      |
| `cf cell get`   | 14.58       | 7.67       | 4.01       | 2.32      |
| `cf piece call` | 14.63       | 12.25      | 3.30       | 2.55      |
| `topics new`    | 32.29       | 11.62      | 7.99       | 2.91      |

Second run, load median 161:

| Command         | Wall before | Wall after | CPU before | CPU after |
| --------------- | ----------- | ---------- | ---------- | --------- |
| `bin/cf --help` | 7.36        | 0.52       | 2.75       | 0.19      |
| `cf cell get`   | 4.99        | 3.98       | 2.21       | 1.52      |
| `cf piece call` | 9.09        | 7.04       | 2.77       | 1.61      |
| `topics new`    | 15.60       | 8.44       | 4.61       | 2.89      |

Single runs of the new client at load 90-130 took 2.3-3.9 s for `topics new`, 1.6 s
for `cf piece call`, and 0.2-0.5 s for `bin/cf --help`.

One `topics new` at load 90, in milliseconds since its process started: modules
loaded at 220-370, `cf` spawned straight after and finished at 2,080-2,230, the
copy refreshed by 2,240-2,380. Inside a 1.6 s `cf piece call`, about 800 ms is the
launcher and loading `piece`, 150 ms is `loadPieces`, 400-480 ms is
`executeCallable.handled`, the wait for the server, and 4-10 ms is the selection.

## Candidates that did not hold up

`computeCompilerFingerprint` does not run in `cf piece call` or `cf cell get`.
`getCompileCacheRuntimeVersion()` is already lazy and memoized, and these commands
do not reach it under server execution. A probe in it fired on `cf piece ls`, so it
was armed, and did not fire on those two.

`deriveSelectedValue` stays as it is. Its graph is how a filter taints membership
and how a projection reads through the source's schema, and it cost 130-340 ms.
`topics new` no longer enters it: a selection of nothing but addresses already
returns from the stored links, and the client now asks for only the address and
takes the Topic's number from its refreshed copy.

`topics` still spawns `cf`. In process, it would save the launcher, one process
start and reading the 276 modules the two share, which is an estimated 0.3 s of the
2.4 s, and it would take on `cf`'s `Deno.exit`, its stdout, its process-wide log
and color state, its environment reads at load, and a runtime it never disposes.

## Measuring this

V8's code cache makes these numbers bimodal. `npm:typescript` took 0.15 s of CPU
with a hit and 1.59 s with `--no-code-cache`. A `--jitless` run moved the next plain
run from 0.15 s to 0.40 s, and one of three such sequences ended on a run of 1.59 s.
`--max-old-space-size` moved nothing. Other sessions on this machine were running
with `--jitless`, which is the likely reason `before` arms sometimes read several
times higher than their minimums, though that was not isolated. CPU separates work
from contention better than wall time here, but not cleanly.

Wall time at these loads is mostly waiting for a core, including the server's
wait, so the wall ratios above understate what the change does on a quiet machine,
and neither run measures one.

## Left over

- `cf cell get` on a board's root takes 1.8-3 s in `getCellValue.result.get`, since
  `resolveCellPath` materializes the whole root to preserve ancestor branch choices.
  That scales with the board, and `topics new` does not take this path.
- `cf completion` still loads the whole tree through `commands/main.ts`. It could
  load only the command on the line.
- `cf piece ls` still computes the fingerprint.
- The FUSE exec shim, `tasks/integration.ts` and `cf-profile.ts` start `cf` without
  the option, so they read everything and evaluate only what they address.
