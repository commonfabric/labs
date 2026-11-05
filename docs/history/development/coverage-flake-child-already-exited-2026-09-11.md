---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "Investigation record: the one uncovered line that moved the `packages/connectors` coverage count between a `main` run and the pull request measured against it."
---

# The SIGTERM that arrived after the child was reaped, September 2026

## Conclusion

[PR #7290](https://github.com/commontoolsinc/labs/pull/7290) changed no line of
`packages/connectors/agents/connector/src/drivers/codex-jsonl-client.ts`, and
its Coverage Check job reported `packages/connectors` at 640 uncovered lines
against a `main` baseline of 639. The one line was charged to a pull request
about import statements.

It is line 172 of `codex-jsonl-client.ts` as that file stood at the measured
commit — the end of the empty `catch` beside the signal that `#terminate()`
sends:

```ts
try {
  child.kill("SIGTERM");
} catch {
  // Child already exited.
}
```

`Deno.ChildProcess` waits for its child from the moment the child is spawned,
and `kill()` throws `TypeError: Child process has already terminated` once that
wait has resolved. Neither half of that depends on anyone reading `status`. So
the `catch` runs when a child exited far enough ahead of the stop for the
runtime to have reaped it first, and nothing runs in its place when the child
was still there. Whether the exit got in first is decided by how the event loop
interleaved it with the end of the stdout stream the read loop is terminating
on, and nothing in the suite asks for either order.

## What the runs measured

The baseline is
[run 34543456128](https://github.com/commontoolsinc/labs/actions/runs/34543456128),
`main` at `3aee034a`. The pull request is
[run 34548630618](https://github.com/commontoolsinc/labs/actions/runs/34548630618),
which merged into `b18d90b6`. `codex-jsonl-client.ts` is untouched by the pull
request, so line numbers and counts compare directly.

Each run uploads 151 coverage artifacts. Four of them measure this file, and
one of the four runs anything in it: `coverage-profile-workspace-8`, the
workspace shard this driver's test file landed on. The other three report two
nonzero lines apiece, from the module's top-level declarations. The same shard
carried the file in both runs, and reached the signal the same number of times
in each, so nothing about how the suite was distributed changed between them.

| line | what it is | baseline | pull request |
| --- | --- | --- | --- |
| 153 | the method's first statement | 60 | 59 |
| 159 | the `if (!child)` early return | 60 | 59 |
| 160–166 | the body past that return | 27 | 27 |
| 167–170 | the writer close, the `try`, and the `kill()` | 60 | 59 |
| 172 | the end of the `catch` | 1 | 0 |
| 173–181 | the cleanup the method returns | 27 | 27 |

Twenty-seven of the sixty calls got past the early return in both runs, and
those are the calls that reached the signal. On the baseline one of them landed
on a child the runtime had already reaped; on the pull request none of them
did. One call in twenty-seven is what separated a green Coverage Check from a
red one.

The 59 and 60 on the lines that hold the signal are the enclosing method's own
count rather than a second population of calls. Deno projects V8's block ranges
onto lines, and a line with no narrower range of its own is credited with the
count of the range around it. A local run of the same test file with a counter
in place of the signal confirms the reading: the signal is sent once per call
that got past the early return, and the number the report gives its line is the
method's.

## The identical arms next door

The same arm was written out twice more in the same package, once at each of
the other two places it takes down a child it spawned.
`packages/connectors/agents/connector/src/drivers/acp.ts` held it in its
transport's `stop()`, at line 226, and
`packages/connectors/agents/connector/src/git-context.ts` held it in the abort
listener of the function that runs `git`, at line 46, spelled with `kill()`'s
default signal rather than a named one. Both report zero in every artifact of
both runs, across all eight workspace shards.

Neither was movement: both were permanent debt. The git one sits further from
anything a run reaches, in a closure that only an aborted git command enters.
The function around that closure does run — three shards report its spawn at
lines 35 to 40 — so what is missing is a test that aborts one, not a test that
runs one. The acp copy is the one that was positioned to flap next: its driver
takes its child down the same way this one does, and only one of the two had
ever been on the right side of the race.

## What was done

A child the runtime has already reaped can be had on purpose: spawn one, await
its status, and `kill()` throws every time. What cannot be had on purpose is
that child *where the branch sits*. `CodexJsonlClient` spawns its own child and
takes it down itself, so a test driving the client has no argument it can pass
to ask for one order or the other, and could only hope for the one it wanted.

What it can construct at the branch is the thing the branch responds to, which
is what `kill()` does when it is called. `terminateChildProcess()` in
`packages/connectors/agents/connector/src/child-process.ts` takes only the part
of the child it touches:

```ts
export function terminateChildProcess(
  child: Pick<Deno.ChildProcess, "kill">,
): void;
```

All three places call it in place of the arm each of them held, so three copies
became one, and an object literal satisfies the parameter.
`packages/connectors/agents/connector/test/child-process.test.ts` states the two
arms over it: that a running child is sent `SIGTERM`, and that a child whose
`kill()` throws is asked and the call returns anyway.

Only the signal was extracted, not the teardown around it. The arm was all the
three shared: one waits for the process through `Promise.allSettled`, one
through `child.status.catch()`, and one through `child.output()`, so a function
that also waited would have fitted none of them without an argument saying how.

Measured from that test file alone, every line of `child-process.ts` reports a
nonzero count, the `catch` among them. Removing the already-reaped case takes
that line back to zero, which is what says the case is what covers it.

Three mutations confirm the cases are not passing on the strength of code
elsewhere, and each is caught by the case it belongs to. Dropping the
`try`/`catch` fails the already-reaped case. Sending `SIGKILL` fails the signal
case. Sending no signal at all fails both.
