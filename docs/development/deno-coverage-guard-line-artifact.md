# deno coverage: one-line guard reported uncovered when its branch is not taken

A one-line conditional guard — `if (cond) return …;`, `if (cond) throw …;`, or
`if (cond) continue;` — is reported by `deno coverage` as **0 hits** whenever the
function runs but the guarded branch is never taken, even though the `cond`
condition is evaluated on every call.

This is expected. V8 collects coverage at block (byte-range) granularity rather
than per line: the guard's body (`throw …`, `return …`, `continue`) is its own
range with its own execution count, and a branch that is never taken legitimately
has a count of 0. The V8 blog post
["JavaScript code coverage"](https://v8.dev/blog/javascript-code-coverage)
describes this directly — "block coverage could detect that the `else` branch …
is never executed." A whole-line hit count is a projection of those block ranges
onto lines, and the blog does not specify how that projection should work; it is
the coverage tool's job. When a single line holds both the executed condition and
the un-taken body, projecting it to 0 is a defensible choice, not a bug.

This note records the behavior because several deliberately-unreachable
invariant guards in the runtime are marked uncovered by it.

## Where it bites us

The mergeable-write record methods in
`packages/runner/src/storage/v2-transaction.ts` guard invariants that every
caller already establishes (each writes through the same transaction before
recording, so the target is always editable and writable):

```ts
// Shown for illustration only.
if (ready.error) throw ready.error;
if (!doc) throw new Error("append target is not writable");
```

The `buildReads` space filter in `packages/runner/src/storage/v2.ts` skips
mergeable ops belonging to another space, which only happens under multi-space
writes:

```ts
// Shown for illustration only.
if (op.space !== this.#space) continue;
```

These conditions are evaluated on every call, but their branches are not taken
in single-space, healthy-transaction tests, so deno reports each guard line as
uncovered.

## Reproduction

```ts
// guard.ts
function guarded(x: unknown): number {
  if (!x) throw new Error("e");
  return 1;
}
if (import.meta.main) {
  guarded({}); // truthy argument: the `if (!x)` branch is never taken
}
```

```
deno run --coverage=cov guard.ts
deno coverage cov --lcov | grep '^DA:'
```

```
DA:2,0   // if (!x) throw new Error("e");
DA:3,1   // return 1;
```

Line 2 holds both the condition, which is evaluated, and the `throw`, which is
not reached. The line count reports the un-taken range.

## Impact and handling

The affected guards are left as plain one-liners. Writing each invariant guard
on a single line keeps the artifact to one line per guard rather than three (the
`if`, the body, and the closing brace of a block form). The uncovered guard
lines are tracked here rather than chased with contrived error-injection tests,
since the branches are unreachable by construction.

A guard line is one of two cases where an uncovered line is expected to stay
uncovered; a block that is never invoked at all is the other, below. A third
case, a line two adjacent callbacks share, is not one of those: it is a count
that moves with how the tests are packed into lanes, and it has a remedy.
Everywhere else, a line whose coverage moves between runs, or between how tests
are packed into lanes, is a defect in the tests — see [COVERAGE.md](COVERAGE.md)
for what to do about it.

## A line two adjacent callbacks share

The third case is a line that two functions both claim. An uncalled function's
range does not stop at that function's own text: projected back onto the
original source through the source map, which names positions sparsely, it
reaches from the last named position at or before the function to the next one
after it. So it can zero the line closing the argument before it and the line
opening the argument after it.

Two callbacks passed one after another to the same call therefore share a
line, and that line is reported covered only where both callbacks ran:

```ts
// Shown at module scope.
function run(
  name: string,
  onStart: () => void,
  onRefused: (error: Error) => void,
): void {
  if (name === "start") onStart();
  else onRefused(new Error(name));
}

run(
  "start",
  () => {
    console.log("started");
  },
  (error) => {
    console.log(error.message);
  },
);
```

```
deno run --coverage=cov main.ts
deno coverage cov --lcov | grep '^DA:'
```

```
DA:10,1   // run(
DA:11,1   //   "start",
DA:12,1   //   () => {
DA:13,1   //     console.log("started");
DA:14,0   //   },                        <- closes the callback that ran
DA:15,0   //   (error) => {
DA:16,0   //     console.log(error.message);
DA:17,0   //   },
```

Line 14 closes a callback that ran. It reports zero because the callback under
it did not.

How far the reach goes depends on where the source map names positions, so
read the counts rather than predicting them. Two instances measured in
`packages/runner/src/builtins/compile-and-run.ts`: a single-line callback that
never ran zeroed the three argument lines above it, its own line, and the line
opening the callback after it; a block-bodied callback that never ran zeroed
its own five lines and nothing else.

This one is not an uncovered line that stays uncovered. Both functions run;
what decides the count is whether one measurement ran both. Continuous
integration merges the reports a run's lanes write, one per suite and workspace
member in each lane, by adding per-line counts, so the line is covered only when
both callbacks ran in the same report. Which test file lands in which lane is
not something any test asserts.

Give the second callback a name of its own and the sharing goes away:

```ts
// Shown at module scope.
declare function run(
  name: string,
  onStart: () => void,
  onRefused: (error: Error) => void,
): void;
declare function report(error: Error): void;

const onRefused = (error: Error) => {
  report(error);
};

run("start", () => {
  console.log("started");
}, onRefused);
```

Each function's lines are then its own: they are covered wherever that
function runs, and no line needs two measurements at once. A `const` holding
an uncalled function still reports its own declaration line as uncovered,
which is the ordinary reading — that function did not run.

`deno-coverage-ignore` is the wrong tool here, by this document's own bar:
both functions are reached constantly, and a test could cover every line
without changing what the lines are.
[COVERAGE.md](COVERAGE.md) has the worked instances under "A line two
callbacks share".

## A block that is never invoked: `deno-coverage-ignore`

A guard line's condition at least runs. A block that is never entered at all is
a different case, and `deno` has a directive for it. The
`FabricKeyPair` / `@commonfabric/api` constructor drift guard is the worked
example: a closure that is built, discarded, and never called, whose body
exists only so that the compiler checks each construct form the api
declaration promises.

Four spellings exist — `deno-coverage-ignore`,
`deno-coverage-ignore-start`, `deno-coverage-ignore-stop`, and
`deno-coverage-ignore-file`. **The bare form takes only the line that follows
it**, which is easy to get wrong: applied to the head of a six-line closure it
removes one line and leaves five. A block wants the `-start` / `-stop` pair.

```ts
// Shown for illustration only.
// deno-coverage-ignore-start
(() => {
  neverCalled();
})();
// deno-coverage-ignore-stop
```

The directive reaches the lcov report and not merely the terminal one, which
is what makes it usable here: the ignored lines carry no `DA:` records at all,
so `LF` falls while `LH` stays put — the lines removed were uncovered ones,
never counted in `LH` to begin with — and the coverage metric sees nothing
uncovered rather than seeing a gap it has been told to forgive.

Measure a "before" figure while the source still lacks the directive. The
ignore directives are applied when `deno coverage` builds the **report**, not
when `deno test` writes the profile, so re-running `deno coverage` over a
profile collected earlier still reports the post-directive numbers.

**What this is not for.** It suppresses a measurement, so it is only honest
where the measurement is meaningless — code that *cannot* execute, by
construction, in any test. A branch that is merely hard to reach, expensive to
set up, or currently untested is a gap, and marking it ignored converts a
number someone would have chased into silence. The bar is that no test could
cover the lines without changing what they are: if a test could reach them,
write the test.
