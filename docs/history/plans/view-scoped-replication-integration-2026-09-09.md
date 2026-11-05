---
status: historical
created: 2026-09-09
archived: 2026-09-09
reason: "Integration validation snapshot of experimental view-scoped replication."
---

# View-scoped replication integration validation

The integration campaign found blocking behavior with view-scoped replication
enabled. Environment flags reached the toolshed, shell bundle, and browser
worker. A forwarding gap in the runtime-client integration helper was fixed, and
the flag matrix passed. The complete integration campaign was not green.

The source was the uncommitted implementation on
`codex/view-scoped-client-replication`, based on
`16de7e0c871d21023111729b40876497dbaf3e36`, using Deno 2.9.4 on macOS. This was
a local validation run against fresh test databases, without deployment or
merge. The global view-scoped flag remained off by default.

## Environment forwarding

The primary run used:

```bash
EXPERIMENTAL_SERVER_EXECUTION=true \
EXPERIMENTAL_VIEW_SCOPED_REPLICATION=true deno task integration
```

The integration runner inherited the environment into its test processes and
server launcher. Felt's development build used the shell's experimental defines.
The browser regression in
`packages/shell/integration/view-scoped-replication.test.ts` checked both
`/api/meta` and the actual encoded worker initialization sent by the shell after
login. It decoded that message with the canonical realm codec and checked that
the worker initialized successfully. Each matrix row used a separate server
start and shell build.

| Server execution | Global view flag | Web override | Browser initialization |
| ---------------- | ---------------- | ------------ | ---------------------- |
| true             | true             | absent       | Passed                 |
| true             | true             | false        | Passed                 |
| true             | false            | true         | Passed                 |

The runtime-client integration helper had forwarded only `serverExecution`. It
was changed to forward all environment-selected experimental options, including
explicit false overrides. Its complete 50-step suite then passed with the global
view flag enabled and with the web override disabled.

Two runtime-client assertions needed explicit UI read schemas in the enabled arm
because the default piece handle exposes the UI tip. Their expected VNode
content was preserved. The disabled arm retained its original default-handle
reads. These changes did not relax the speculation guards or enable client
effects.

Global flag forwarding does not imply every runtime adopts web behavior. The
implementation negotiates supported client classes; the CLI and ordinary non-web
runtimes retain their existing behavior. The browser matrix above did not
exercise `serverExecution=false`; that combination had unit coverage.

## Results

| Target                              | Result after corrections and continuations                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Runner integration                  | 16 passed, 0 failed.                                                                                              |
| Runtime-client integration          | 50 steps passed with view mode enabled; 50 passed with the web override disabled.                                 |
| Shell integration, enabled          | 10 top-level tests passed; 1 failed: asynchronous runtime error display.                                          |
| Shell integration, web disabled     | All 11 top-level tests and 29 steps passed.                                                                       |
| Top-level pattern integration files | All 58 files started: 49 completed successfully, 7 failed, 2 stalled and were interrupted.                        |
| CLI integration                     | All 13 script sections covered successfully, combining the initial run and a corrected store-layout continuation. |
| Generated patterns                  | 141 passed, 5 failed. The same five assertions failed with the view flag disabled.                                |
| Authored pattern tests              | 125 files passed, 32 failed, out of 157 files, including two connector pattern files.                             |

The browser-pattern count includes existing server-execution skips: 16 steps
across chat-note, chatbot, fetch-json, and llm. A successful enclosing file does
not establish that those skipped effect scenarios passed. The separate
server-execution effect-channel, event, scale, serving-loop, and speculation
integration files completed successfully.

The root command itself exited with failure. The initial shell attempt caught a
type error while the new regression was being added; the corrected full shell
run superseded that result. The initial patterns process was interrupted after
collaborative-editor teardown stalled; remaining files ran in continuations,
with the final group running in a pool of three independent test processes.
Assertions and existing test waits were preserved. This is aggregate coverage of
the default target set, not a successful uninterrupted root invocation.

The initial CLI run stopped at the Topics restore drill because the explicitly
chosen test `DB_PATH` was a single SQLite file and the drill expected a
directory store layout. The final four sections passed against a fresh directory
store: Topics drill (16 checks), bulk-survey drill (100), shuttle (70), and
wish. This was a setup correction, not a product fix.

## Enabled and disabled comparisons

Three differences had useful controls:

- **Asynchronous error display:** the enabled shell did not display the
  fixture's server computation error and reached the existing five-minute
  condition timeout. The complete shell suite passed with the web override
  disabled. Transporting server execution errors to the shell needs
  investigation; the client no longer executing that computation is relevant,
  but is not a complete causal proof.
- **Iframe session SQLite handle:** the enabled multi-user iframe test failed
  during the second session's initial command with
  `sessionDatabase: SQLite operations require a valid SqliteDb cell handle.` The
  focused disabled control passed. General SQLite owner and read-clearance
  multi-runtime tests passed, narrowing the observed failure to this iframe
  provisioning path.
- **Collaborative editor:** the original enabled run completed all ten steps but
  stalled in teardown. A focused enabled repeat stalled while flushing an
  in-flight edit before disabling collaborative mode. The disabled control
  completed all ten steps and teardown in 16 seconds. The two enabled stalls are
  distinct observations; no common cause was established.

Other browser failures remained unresolved:

| File                                | Observation                                                                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `home-profile.test.ts`              | All four enabled steps reached their existing condition timeouts. The disabled control also failed, with `ownerPrincipal requires writeAuthorizedBy at /`, so these cannot all be attributed to view mode.      |
| `home-rehydration-churn.test.ts`    | Both steps reached their existing condition timeouts.                                                                                                                                                           |
| `lunch-poll-diagnose.test.ts`       | A test principal lacked READ permission on a referenced space.                                                                                                                                                  |
| `lunch-poll-keyed-votes.test.ts`    | The keyed-vote assertion expected 3 and observed 0.                                                                                                                                                             |
| `lunch-poll-vote.test.ts`           | Waiting for `1 joined` reached the existing condition timeout.                                                                                                                                                  |
| `profile-embed.test.ts`             | The badge did not display `Ada Lovelace` before the existing condition timeout.                                                                                                                                 |
| `topic-retraction-controls.test.ts` | Stalled after rendering the topic and was interrupted. A read-only browser probe showed all three comments still present and `Unknown profile`. No completed assertion or specific stuck await was established. |

The five generated-pattern failures reproduced with the view flag disabled:

- `counterWithDynamicHandlerList:2:slots.0.value`
- `counterNestedParameterized:5:children.1.value`
- `counterReplicator:2:replicas.0.value`
- `counterWithRichLabel:3:detail`
- `CT-1334 sub-pattern computed template + fetchJson + computed:1:pending`

Of the first 31 authored-pattern file failures, 28 also failed in a control with
the view flag disabled and server execution still enabled. Three passed on that
repeat: `examples/reactive-now.test.tsx`,
`google/WIP/google-docs-importer.test.tsx`, and
`google/core/google-calendar-importer.test.tsx`. The final failing file,
`topics/multi-user.test.tsx`, was not included in that control. These
comparisons do not establish that the failures predated this branch, nor do the
three repeat successes alone establish view-mode regressions.

## Validation and retained evidence

The changed integration files passed type checking. Runtime-client unit tests
passed (29 tests, 646 steps), and shell unit tests passed (62 tests, 242 steps).
Repository formatting, lint, and whitespace checks passed. No production fix for
the newly discovered integration failures was included in this validation work.
Test servers, continuation processes, temporary control worktrees, and owned
orphan browser processes were cleaned up.

Local logs were retained under `/tmp`; these paths are ephemeral evidence from
this machine, not repository artifacts:

- `/tmp/view-integration-all.log`: root invocation and authored-pattern results.
- `/tmp/view-integration-flags-{global,web-off,web-on}.log`: three browser flag
  matrix runs.
- `/tmp/view-integration-runtime-client-{enabled-3,web-off}.log`: corrected
  runtime-client suites.
- `/tmp/view-integration-shell-{enabled,web-off}.log`: complete shell
  comparisons.
- `/tmp/view-integration-patterns-{rest,final}.log`: browser continuations.
- `/tmp/view-pattern-files/`: final browser pool logs, one per file.
- `/tmp/view-browser-results.json`: combined browser file inventory.
- `/tmp/view-integration-iframe-{enabled,web-off}.log`: focused iframe
  comparison.
- `/tmp/view-integration-collaboration-{probe,off}.log`: focused editor
  comparison.
- `/tmp/view-integration-home-web-off.log`: disabled home-profile control.
- `/tmp/view-integration-generated-off.log`: generated-pattern control.
- `/tmp/view-integration-pattern-failures-off.log`: selected authored-pattern
  control; `/tmp/view-pattern-failures-final.txt` lists all 32 enabled failures.
- `/tmp/view-cli-{topics-drill,bulk-survey-drill,shuttle,wish}.log`: corrected
  CLI continuation.
- `/tmp/view-topic-retraction-browser-probe.log`: stalled browser observation.
