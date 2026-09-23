---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "F3 of the lazy-materialization fast-follow: the default-on rollout evidence assembled for the flag owner's retirement decision."
---

# Lazy materialization: default-on rollout evidence

This is the F3 record for the
[lazy materialization fast-follow](../../plans/lazy-materialization-fast-follow.md).
It assembles what is known about `lazyMaterialization` running on by default,
so that the flag's owner can decide whether the lift path's rollout switch is
retired (F4). It records no decision itself, and it mutates no live data.

## Revisions and observation period

| Item                               | Value                                                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| View landed, flag off              | `cd5510583b`, 2026-08-12                                                                                                                                                                              |
| Flag default flipped on            | `3c36680eba`, 2026-08-12, the same day                                                                                                                                                                |
| Revision this evidence             | `8551bd82b8`, 2026-09-11, on top of `a44d9389c3`                                                                                                                                                      |
| Observation period                 | 2026-08-12 to 2026-09-11, thirty days of `main` at the default-on posture                                                                                                                             |
| Rollback override in tracked files | None. No workflow under `.github/`, deployment configuration, or package manifest sets `EXPERIMENTAL_LAZY_MATERIALIZATION`. A process environment supplied outside the tree is not observable from it |

Elapsed time is not acceptance. What the period covers is stated under
[Covered workloads](#covered-workloads), and what it does not under
[Limits](#limits).

## Posture per process

The [F0 baseline](2026-09-11-lazy-materialization-f0-baseline.md) records how
each process resolves the flag. The parts that matter to a retirement
decision:

- **Toolshed, the background piece service, and `cf check`** read the
  variable from their own environment through `experimentalOptionsFromEnv`
  and resolve an unset one to on. An explicit `false` there is the rollback
  route the registry names; no tracked file supplies one. The flag is
  server-authoritative in `EXPERIMENTAL_FLAG_AUTHORITY`, because the read
  set a commit declares is what the server admits against, so a server-side
  rollback is meant to carry its clients with it. It carries the deployed
  `cf` and not the browser, since the shell has no define to receive it, and
  nothing in the runtime client refuses a posture split on this flag as it
  does for `serverExecution`. A toolshed rolled back would serve browsers
  running the other arm, silently.
- **A deployed `cf`** resolves the flag through
  `experimentalOptionsForDeployedClient`: an explicit value in its own
  environment wins, otherwise the posture its server publishes, otherwise the
  built-in default; with `CF_ADOPT_SERVER_FLAGS=false` it reads its
  environment alone and a server's rollback does not reach it.
- **The browser shell has no rollback route.** Its build-time defines cover five
  other experimental flags and not this one, so every shell build since
  2026-08-12 has run the view on with no way to turn it off short of a code
  change.

So every shell build in the period could run only the on arm, and whatever
browser use there was in the period was on-arm use; how much there was, this
record cannot say, since it has no deployment observation or telemetry.
Whether any server or `cf` ran the off arm through an environment supplied
outside the tree is not visible from the tree either.

## Covered workloads

- **Continuous integration.** Every merge to `main` since 2026-08-12 ran the
  runner unit suite and the integration suites at the default-on posture. No
  CI lane sets the flag off; the only experimental variable the workflows set
  is `EXPERIMENTAL_SERVER_EXECUTION`, for that flag's lanes and its benchmark
  run.
- **The pattern computation-cost arc**, in the records dated 2026-09-10 to
  2026-09-12 (the last a UTC date on a run taken inside this record's
  period): the
  [controlled lunch-poll baseline](2026-09-10-lunch-poll-read-baseline.md)
  and the
  [representative-copy rehearsal](2026-09-12-representative-lunch-poll-rehearsal.md)
  ran with the view on and record their read counts under it; the
  [reactive rows acceptance](2026-09-11-reactive-lunch-rows.md) ran the
  pattern suite at the default posture and records render budgets, not
  reads.
- **The scalar read width baseline**
  ([record](2026-09-11-lazy-scalar-read-width.md)) measured both postures on
  the same schema and rows and verified every result.
- **The F0 handler dispatch benchmark** ran six handler variants at three
  sizes at the default posture, which reads a handler's context eagerly
  either way; the F1 prototype's posture runs exercised lift-style views
  inside handler bodies in both postures and verified every result.

## Both postures on the test suites

The runner unit suite is the suite that holds the view's equivalence,
refusal, snapshot, and dependency tests. Its tests construct their runtimes
directly and pass no experimental options unless a case is about one, and
`Runtime` reads no environment, so the environment variable does not put the
suite in the off posture; only the built-in default does. The off run below
therefore flips that default at its source — the
`this.experimental.lazyMaterialization ??= true` in `runtime.ts` changed to
`false` — as an uncommitted edit in a worktree whose tree is the F0 record's
change at `8551bd82b8` plus the lift-path fix, the tree
`codex/lift-refusal-disposition` holds at `f3872d5737`. Every runtime the
suite builds without an explicit value then runs off, and a case that names
the posture explicitly keeps the posture it names.

| Posture                                      | Result                                                                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| On (the built-in default; every CI run)      | The runner unit and integration suite lanes are green in CI on `main` at `a44d9389c3` (whose one failed lane is the benchmark run) and no lane failed on the F0 change at `b0324aff36` |
| Off (built-in default flipped at the source) | `FAILED`: 1,378 tests passed, 5 failed (9 steps), 1 step ignored, in 13 minutes 22 seconds, locally                                                                                         |

The five failing tests, with the assertion each fails on:

- `aggregate.test.ts`, three steps, "updates reduce with N independently
  linked values": the computed's run registered at least N proxy accesses.
  A lazy-posture expectation — an eager value produces no proxy accesses
  ([read accounting](../../../features/read-accounting.md)) — and the
  value assertion beside it, that the sum updated, passed.
- `collection-index-lookup.test.ts`, "preserves linked group rows without
  rerunning lookup on a non-key field edit": the lookup re-ran once where
  the test expects no re-run. An eager read of a row depends on every field
  of it, so a non-key edit re-runs the lookup; a view depends on the key
  alone. A lazy-posture expectation about frugality, not a wrong value.
- `executor-dprime-w0.test.ts`, "OW51 refusal re-trigger": a served run
  disposed of by a refusal re-fires when the awaited document arrives. The
  unresolved-input refusal is the view's, so the eager posture never
  produces the refusal the case waits on.
- `unresolved-input-lift.test.ts`, "a hop-target dead-end DISPOSES the run":
  under the eager posture the body ran with `undefined` in a slot its schema
  promised a value for and threw
  `TypeError: Cannot read properties of undefined (reading 'split')`. That is
  the crash the unresolved-input refusal exists to prevent, and the eager arm
  still carries it.
- `experimental-options.test.ts`, two steps, "respects explicitly-set flags
  (all true)" and "merges provided flags with defaults": both assert the
  built-in default is `true`, which the method of this run changed. An
  artifact of the method, not of the posture.

The test names above are abbreviated; each is a unique prefix or fragment of the
name in its file, except that the aggregate name is templated over three sizes,
so its `N` is this record's variable.

The counts above include the parents those steps fail. Three of the five are
contracts the view holds and the eager path does not; one is a crash the
eager path keeps; one is the method. Nothing else in the suite differs
between the postures.

An earlier run with `EXPERIMENTAL_LAZY_MATERIALIZATION=false` in the
process environment passed, 1,383 tests and 0 failures, but for the reason
above it exercised the off posture only in the cases that set the option
themselves, and it is not counted here.

Files that exercise the view's behavior at both postures within one run:
`lazy-materialization-runner.test.ts`; `lift-refusal-disposition.test.ts`, on
`codex/lift-refusal-disposition` at `f3872d5737`; and
`handler-lazy-context.test.ts`, on `codex/lazy-handler-context-prototype` at
`b8da502953`. `patterns-lift.test.ts` is posture-adaptive instead: its
forwarding-lift case expects one run under the view and two eager, whichever
posture the ambient runtime resolved.

## Changes to the view in the period

Every commit that touched the view's two files, `schema-view.ts` and
`query-result-proxy.ts`, between the default flipping on and the revision of
this evidence, oldest first. The kind is the subject's prefix with its scope
dropped and its `!` kept, and the subject is quoted without its pull request
number; two subjects carry no prefix. The transaction mark, declared in
`storage/interface.ts`, and the sites that read it, in
`extended-storage-transaction.ts`, `schema.ts`, and `runner.ts`, are outside
this table; two commits in the period edited that machinery, `129215d4c6` on
2026-08-18, which the table also lists, and `4e345c893e` on 2026-08-28, which it
does not, and both predate the last row.

| Date       | Commit        | Kind      | Subject                                                                                              |
| ---------- | ------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| 2026-08-13 | `572a477c27`  | refactor  | name each object-shape predicate for the array case                                                  |
| 2026-08-14 | `401df0d11d`  | docs      | say "returns" where "answers" was doing the work, in `src`                                           |
| 2026-08-15 | `720c03243c`  | refactor  | conform imports in `runner/src` and `runner/integration`                                             |
| 2026-08-17 | `a3fcd6047a`  | (none)    | A transaction resolves a link once, not once per element read                                        |
| 2026-08-17 | `8ca18b71e1`  | fix       | an `unknown` field keeps the reference it holds                                                      |
| 2026-08-17 | `9c0881506b`  | fix       | the proxy value cache answers for the writability asked for                                          |
| 2026-08-17 | `0c9ea8a8a0`  | refactor! | remove `{ proxy: true }` and writability in query-result proxies                                     |
| 2026-08-18 | `129215d4c6`  | feat      | a materialized read describes the instant it was taken                                               |
| 2026-08-19 | `4543e4dfcd`  | refactor  | a validator is named after the type it guards                                                        |
| 2026-08-21 | `90b0996722`  | (none)    | OW51 unresolved-input semantics: the RULED option-3 build [HOLD — coordinator delta review pending]  |
| 2026-08-26 | `7789adb5ca`  | refactor  | `data-model-schema`, and `data-model` stops importing `api`                                          |
| 2026-08-28 | `8acda7a358`  | feat      | reader schema takes precedence over link schemas on hops                                             |
| 2026-09-01 | `14bc4ecc9e`  | refactor  | the `FabricValue` surface is the package's main export                                               |
| 2026-09-09 | `fda353d69b`  | fix       | the walks admit fabric special objects                                                               |
| 2026-09-09 | `818af09978`  | fix       | an empty write batch keeps the transaction's read caches                                             |
| 2026-09-10 | `89e5524c23`  | feat      | expose pattern computation read costs                                                                |
| 2026-09-10 | `e70704f206`  | fix       | preserve read accounting across transaction and test boundaries                                      |
| 2026-09-10 | `10a780d064`  | fix       | carry enclosing `$defs` into sub-schemas through one shared helper                                   |
| 2026-09-11 | `5347f7da45`  | fix       | resolve `#/$defs/<name>` against the document root                                                   |

Separately from these two files, the lift path's disposition of a
synchronous refusal in `runner.ts` has a fix on
`codex/lift-refusal-disposition`, held for the pattern vintage gate's owner
because the fix changes a derived value the gate holds for the lunch poll.
This fast-follow found the defect by reviewing the F0 record rather than by
a failure in the field: `lift-refusal-disposition.test.ts` fails at the
pinned revision with the flag on and the previous result standing, passes
with it off, and passes in both postures with the fix. The
design's Stage 5 claim that a thrown refusal writes an undefined result was
true only of the asynchronous case.

What the list does not contain: a report of a lift running where an eager
read would have refused, which is the one behavior change the design names
as observable.

## Limits

- Neither arm has field evidence this record can see. The on arm's usage in
  browsers is inferred from the absence of a define, not observed; the off
  arm cannot have run in a browser since 2026-08-12, and no tracked file
  sets the override for any other process. The off arm's evidence is the
  runner suite run with the default flipped and the both-posture test files
  above.
- The off-posture run's tree carries the lift-path fix, which changes only
  how a lift disposes of a synchronous refusal. Of the five failures, the two
  refusal cases wait on an unresolved-input refusal the eager posture never
  raises, so they do not reach that path; the run was not repeated at the
  base.
- The integration suites were not run at the off posture for this record.
  They launch browsers, which this record's author could not do from the
  session it ran in; a retirement decision that wants them run at the off
  posture should say so.
- Production-like client and server behavior on isolated data at both
  postures was exercised only by the runner suite's two-runtime and
  served-dispatch tests, not by a deployed pair.
- Thirty days of soak on a fast-moving `main` is thirty days of that
  `main`; the view's files changed nineteen times in it. The relevant
  question for retirement is whether the last change's revision has soaked,
  and it has not: `5347f7da45` was about seven hours old at this evidence's
  revision.

## What a retirement decision needs to name

- Whether the off arm's absence in the browser since 2026-08-12 is accepted
  as soak evidence, or whether a build define is wanted first so the arm can
  be exercised, given that retirement deletes the switch anyway.
- The rollback route after retirement, which can only be a revert of the
  removal commit.
- Whether the integration suites are to be run at the off posture before
  removal, and by whom.
- That a server-side rollback today splits the fleet, browsers staying on
  while the server and the deployed `cf` go off, and whether that is
  acceptable for the window between a rollback and a redeploy.
