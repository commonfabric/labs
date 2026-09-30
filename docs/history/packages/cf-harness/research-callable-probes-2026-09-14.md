---
status: historical
created: 2026-09-14
archived: 2026-09-14
reason: "First live contract probes of the callable CF research tool, before the resulting handle and kit-guidance corrections."
---

# First callable research probes

Two research-only tasks exercised the first implementation of `research` against
the existing pattern index. Both reached indexed source and returned complete
source examples that compiled unchanged. The dinner-preparation example imported
the existing checklist and amount ledger, rendered without reconciler errors,
and calculated `$7.25` from synthetic costs of `4.50` and `2.75` in an isolated
runtime.

Both research kits were marked incomplete. The probes found a harness bug that
expanded handle tokens before research received them, an ambiguous input-binding
schema, and advice that misread indexed source or treated routine choices as
blockers. These are observations of this implementation snapshot, not proof that
the corrected tool completes the tasks or that automatic startup improves them.

The [live plan](../../../plans/cf-harness-inbox-reliability.md) describes the
intended work. The [Weaver inbox analysis](weaver-inbox-run-2026-09-14.md)
records the earlier failure that motivated it.

## Experiment

The parent model was `gpt-5.6-sol`; the private researcher was `gpt-5.6-luna`.
The console ran from the working tree on port `8186`, with publication disabled
and its own artifact directory. Tasks ran serially. No pattern was run,
published, or assigned a slug by either live task. The index listed 41
discoverable entries before and after; none were added, removed, or rescored.

The toolshed reported `be73306e5ee16d0e5a26fd8c6c9d1e29c6c5c19d`, the same
revision as the earlier Weaver run. The measurement preflight required an
explicit `--allow-diverged` because that deployed revision was off current main.
The first refused preflight is retained separately and spent no model calls.

Unlike the earlier Weaver run, these runs received the piece registry, email,
and finance grants. No grant implementation was changed. The changed available
state, different task instructions, and research-only scope prevent treating the
timings as a controlled before-and-after comparison.

The exact tasks were:

> Use the CF research tool to work out how to give me a simple list view of my
> email inbox with the references actually available to this task. Return an
> implementation kit with exact APIs, indexed components and import examples
> where appropriate, and explicit missing inputs or components. Check the source
> of candidate components to establish their actual behavior. This is a
> research-only task: do not author, run, publish, or slug a pattern.

> Use the CF research tool to work out exactly how to make a dinner-party
> preparation page with a checklist of what I need to prepare and a running
> total of ingredient costs. Return an implementation kit with concrete
> component imports, input/output wiring, and a complete minimal composition
> example. This is a research-only task: do not author, run, publish, or slug a
> pattern.

These prompts test an explicitly requested tool. They do not measure spontaneous
index discovery or automatic research on a bare task.

## Cost and result

| Measurement                  | Inbox                                  | Dinner preparation                     |
| ---------------------------- | -------------------------------------- | -------------------------------------- |
| Root run                     | `69be4992-f16e-4ef5-ad57-a03d4b1370da` | `63de92e2-6eab-4a50-8e9b-1e7d7622b2f4` |
| Whole turn                   | 177.399 seconds                        | 126.348 seconds                        |
| Research tool                | 95.928 seconds                         | 88.903 seconds                         |
| Parent model turns           | 3                                      | 2                                      |
| Private research model turns | 6                                      | 7                                      |
| Private tool calls executed  | 24                                     | 24                                     |
| Exact read characters        | 42,604                                 | 48,722                                 |
| Whole-turn tokens            | 144,009                                | 121,148                                |
| Private research tokens      | 95,326                                 | 107,957                                |
| Whole-turn cached input      | 62,208                                 | 54,272                                 |
| Admitted kit                 | Incomplete                             | Incomplete                             |
| Live `run_pattern` calls     | 0                                      | 0                                      |

Private tokens are the run report's total usage minus its parent usage. Cached
input is already included in the total-token count. The provider supplied no
price estimate. Neither the tool's `ok` status nor the turn's completion changes
the kit's incomplete status.

## What the evidence established

The inbox researcher opened the monthly mailbox reader and sortable table,
including their complete source files. It also found the SQLite input, query,
row-bound, and tombstone documentation. It distinguished a calendar-month reader
from an inbox, but incorrectly claimed that the reader depended on populated
`received_at`. Its SQL actually falls back to `sent_at` and `internal_date`.
Opening a source file did not prevent a wrong interpretation of it.

The parent had described the email handle before calling research. The harness
then expanded the task's `cfh:a:` token to its address. The private model used
that address as its proposed binding and did not describe it through the private
tool. Host admission removed the binding. It also caught an unread citation. The
parent's final response restated the kit without clearly preserving those
admission failures.

The dinner researcher opened these source programs:

- Checklist: `dZt8I5yIWD2g6NeftbKv-3ZouzZ2LGCSEhT8ij7wGV0`.
- Amount ledger: `DRCFljoU1NSWQ8pt8dvVa-mG5cld1tj5J46iq7L7-VE`.

Its source example imported both and passed shared cells into them. The model
also put strings such as `Writable<CheckItem[]>` into the handle-token field,
which admission correctly refused. It treated optional decisions about editing,
currency, and ownership as missing requirements. A commented host-wiring example
invented `new Writable(...)`; that comment is not validated by compiling the
pattern body.

The separate compiler probe used `resolveLocalProgram`,
`materializeComposedPatterns`, and `compileAndSavePattern` in the existing
in-memory probe runtime. Both imported programs resolved under their published
identities. The unchanged composition compiled and rendered with empty inputs. A
second instance given a synthetic preparation item and two cost entries returned
`total: 7.25` and `formattedTotal: "$7.25"`, with no render errors. The inbox
example compiled without being connected to email data or executed. These probes
establish executable composition and a correct initial total; they do not
establish real inbox behavior or test every editing interaction.

## Corrections and measurement limits

The implementation thread added research to the token-preserving input path, put
the authoritative token inventory in the private opening context, and required a
successful handle description before admitting a binding. It clarified that
bindings name existing external handles, while local state and defaults belong
in the recipe. Additional guidance distinguishes actual blockers from routine
assumptions and tells the caller to retain incomplete status. These corrections
passed focused local tests; this report contains no repeated live result for
them.

The batch runner failed to associate either completed turn with its root run: it
matched the task against the first user transcript message, which was the grant
announcement. Its generated report therefore said neither task was measured.
Explicit run-ID measurement and direct run-report reads supplied the figures
above. Private index searches also do not appear in the existing
`search_patterns` count. Actual imports in the isolated probe are reported here
separately from the zero live `run_pattern` calls.

Automatic approval review rejected a repeat after the corrections because it
would transmit live connector metadata to the research model endpoint without
specific approval for that destination. No task ran in that repeat, and the
owned console was stopped. Local tests and synthetic compiler probes remained
available. Automatic root-task research, end-to-end authoring, and publication
provenance on the index were not exercised by this experiment.

## Artifacts

The artifact directory on the test host was
`/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/`:

- `research-tool-suite.json` and `research-tool-cell-spec.json`: exact inputs
  and expected console configuration.
- `research-callable-live-1/`: index snapshots, preflight, batch report, and
  `explicit-run-measurements.json`.
- `research-console/runs/<run-id>/`: run state, run report, parent transcript,
  and tool outputs containing the complete private research records.
- `research-callable-live-tracked.patch` and
  `research-callable-live-new-sources.tar`: implementation snapshot for the live
  probes. The checkout's base was `314e4e88621c99306b2effb6d7d2723055aa4ffb`.
- `research-callable-inbox-example.check.json`: unchanged-source compile result.
- `research-callable-composition-example.*` and
  `research-callable-composition-populated.*`: exact source, render, and check
  results for the isolated composition probes.
- `check-research-example.ts` and `research-dinner-fixture.json`: probe
  procedure and synthetic inputs.
