---
status: historical
created: 2026-09-16
archived: 2026-09-16
reason: "Matched before/after experiments for scoped CF research, with bounded follow-up and persistence corrections."
---

# Scoped research: implementation and matched comparison

The orient/answer/recipe bundle improved the simple checklist and missing-input
tasks, preserved indexed composition, and corrected misleading input guidance.
It did not establish an overall performance improvement. Composition and inbox
authoring became slower, and the inbox recipe still supplied type-invalid code.
The complete bundle should remain staged for review before a Weaver rollout.

## Implementation

One public `research` tool has three explicit purposes. `orient` returns a small
resource map and unverified leads within three model turns, six tool calls, and
12,000 read characters. `answer`, the default explicit call, resolves one
question within five turns, twelve calls, and 32,000 characters. `recipe` keeps
the eight-turn, twenty-four-call, 96,000-character ceiling for a complete
implementation. Code is not required for an orientation or answer.

Source inspection is unavailable in orientation, including host-side refusal if
the model invents that call. Confirmed patterns remain separate from leads.
Follow-ups can name an earlier result and receive bounded findings with exact
reopenable source locations, rather than an old full recipe. Current handles
remain authoritative; prior source IDs still require fresh reads before reuse as
citations.

Documentation search carries document titles and heading ancestry and can be
restricted by path. Recipe prompts expose canonical pattern-development guide
leads and distinguish ordinary CF patterns from iframe React code. This does not
preload the entire pattern-dev skill or supply a new canonical example library.
Direct-run recipes request a structured invocation using the shared run-pattern
schema; the host serializes its public JSON example. Source recipes retain
syntax-only checking, not type or runtime validation.

Chats retain selected research and accumulated CFC influence with completed
history. Old bindings are historical and do not automatically transfer to
children. After the first experiment, automatic orientation was restricted to
fresh CLI tasks and chats without retained research. A subsequent child-context
fix restricts its orientation inventory to the child's own handles. A restart
fix stores the existing omission format alongside SQLite transcripts and
restores annotations only when result identities match. No new policy system or
omission format was introduced.

## Conditions and limits

Both checkouts started at Labs `59e8a2540cf212f98e19e3c9d0919f7c4b460c71`. The
control was its unmodified full opening research, not research disabled. The
changed checkout was frozen for all ten initial turns. Parent and author used
`gpt-5.6-sol`; private research used `gpt-5.6-luna`, through the same local
owner-authenticated Codex provider. Runs were serial and interleaved:
`a1,b1,a6,b6,b2,a2,a3,b3,b5,a5`.

The index was a frozen nine-pattern public-source fixture from Labs
`8243893d50c864af73473b9b32ed43bb08ac99f2`, served through the index's handler
implementation over its test store. Its SHA-256 was
`0a89f2399381eeee2211972ca94130951c5b06771ddf6469eaf7c63afa7a60f7`. Each
condition used separate synthetic Fabric spaces on the same isolated toolshed.
No real mailbox, connector content, publication, or index mutation was involved.
This is a local harness integration comparison, not a production Weaver trial or
an estimate of search quality across the full deployed index.

There was one observation per task per condition. Provider variation, cache
state, different author decisions, and the combined changes prevent attributing
a speed difference to any individual change. Wall time is the run-report
created-to-ended interval; tokens include private research and delegated work.

## Initial matched results

| Task                                       | Before seconds | After seconds | Before tokens | After tokens | Research calls before/after |
| ------------------------------------------ | -------------: | ------------: | ------------: | -----------: | --------------------------: |
| Indexed grocery checklist                  |         59.946 |        31.739 |        57,556 |       24,355 |                       1 / 1 |
| Follow-up about checklist storage          |         36.311 |        58.388 |        26,263 |       31,501 |                       1 / 2 |
| Two counters, total, and checklist         |        113.531 |       170.340 |       119,947 |      143,055 |                       1 / 2 |
| Typed inbox with filtering and empty state |         94.571 |       256.643 |        80,676 |      225,159 |                       1 / 3 |
| Missing mailbox input                      |         39.821 |        11.762 |        30,228 |        4,996 |                       1 / 1 |
| Total for these five tasks                 |        344.180 |       528.872 |       314,670 |      429,066 |                       5 / 9 |

Both checklist runs executed the indexed CheckList. Both composition runs
imported and invoked Counter and CheckList; the control used named imports and
the changed run used default imports. A first measurement script missed named
imports. A TypeScript AST inspection replaced that approximation and verified
both forms and their call sites. There is no measured index-reuse advantage in
this pair; the valuable composition behavior was preserved.

Both inbox runs correctly authored a component for the supplied typed collection
rather than force-fitting the indexed month-scoped SQLite reader. The changed
run's answer explicitly established the mismatch. The later recipe nevertheless
emitted `justify="space-between"`, a `.get()` call on a computed array, and a
literal `"[UI]"` key. The author corrected the UI key, retained the first two
mistakes, and added an unsupported badge attribute. The compiler rejected that
submission; the next submission succeeded. Syntax admission was accurate about
its limited scope, but a complete recipe was not type-correct.

The missing-input control unnecessarily required a `SqliteDb` containing
particular connector tables. The changed answer asked for a supported mailbox
connection or existing email-data handle with read permission. Neither invented
messages. The control's checklist follow-up incorrectly described Writable state
as in-memory/session-local unless separate persistence was added. Browser reload
verified persistence without an added database. The changed follow-up did not
repeat that false prerequisite.

All six created apps passed functional browser acceptance. Checklists retained
Bread after Apples was completed and cleared. Both compositions retained
Adults=3, Children=5, total=8, and a checked preparation item after reload. Both
inboxes displayed the three expected messages across months in descending order,
excluded archived/deleted messages, updated to an empty state, and restored the
expected list after data restoration and reload. The fixture contained header
fields, not message bodies; this is not a body-confidentiality test. Screenshots
also show poor heading contrast in the changed composition and inbox under the
current shell theme; functional acceptance is not a claim of visual polish.

## Corrections after the initial comparison

The storage follow-up paid for orientation and then a focused answer. Removing
automatic orientation when a chat already has findings was tested by forking the
original first-turn transcript and research checkpoint, excluding the first
follow-up's answer. The same question then took **33.139 seconds and 21,078
tokens**, with one `answer` call, three private turns, two reads/calls, and
6,876 read characters. It made no app mutation. This is a separate bounded
recheck, not a replacement for the 58.388-second initial result.

The live audit found an orientation inventory carrying the parent's piece
registry token into a child that did not hold that handle. Resolution remained
denied; the inventory was misleading. The final projection filters that field
against the child's actual table while preserving the raw parent evidence. A
regression test verifies the selected token remains, the unrelated token is
absent, and the retained research record is unchanged.

Restarting from SQLite also lost nonenumerable omission annotations from earlier
messages. This caused four missing AUD-20 entries in the follow-up recheck. The
persistence regression failed before the fix and passed afterward. The final
code retains the existing omission record in a separate SQLite column and
restores its host-only annotations with exact identity checks. An offline
round-trip of the actual first checklist transcript preserved all four result
joins and identical serialized model messages. Historical live artifacts were
not rewritten to make their audit pass.

The final inventory and SQLite corrections were checked deterministically; no
additional live model matrix was run after them. The experiment therefore has
three meaningful source checkpoints: the initial ten-turn bundle, the bounded
follow-up correction, and the final handoff/persistence corrections.

## Verification and unresolved limits

The final package test suite, root typecheck, formatting, lint, documentation,
and history-index checks passed. Exact logs are retained with the experiment.
The first frozen bundle's 148 changed assertion inversions all failed as
intended; twelve wrapped assertion failures required classification from their
preserved error text. Later session assertions passed 19/19 inversions and
child-handoff assertions passed 17/17. These latter totals include reruns of
earlier assertions and are not additional unique counts.

Opening order, private transcript exclusion, child startup exclusions, and
omission joins were inspected across the initial twelve run artifacts. Their
AUD-20 checks passed. The broader audit was not wholly green: AUD-21/22
identified authority/posture gaps in both conditions, and the changed inbox's
AUD-5 and restarted follow-up's AUD-20 findings motivated the bounded fixes
above. These experiments are not a complete CFC security certification.

The remaining authoring problem is concentrated in recipe scope and quality.
Orientation alone reduced simple-task overhead, but a source-checking answer
followed by another full recipe and delegated UI authoring added substantial
cost. Several orientations also called themselves incomplete solely because
source inspection was deferred, despite the scoped contract allowing leads. The
next experiment should make recipe requests smaller, keep UI polish with the
author, and supply compact, tested examples for collection rendering and
composition. Increasing the general research task or giving Luna more iteration
is not supported by these observations.

The last local Loom check remained at
`0c3b11314f9adb461edb2f58a0f6e910d2d6f93b`, selecting
`loom-stable-2026-09-15-3`; its vendored Labs was
`1c6eeb209afbf366511a399b381ba7fa5b5820c9`. No Loom file, tag, adoption pin,
remote branch, or deployment was changed. App modification/reset reliability
remains owned by the separate investigation rather than this comparison.

## Evidence

Local evidence root:
`/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/targeted-research/`.

- `tasks.json`, `public-index-snapshot.json`, `source-digests.txt`,
  `source-cut-1/`, and `source-cut-2-digests.txt` identify the measured inputs
  and source checkpoints; `final-source-digests.txt` identifies the handoff.
- `comparison-summary.json`, `trial-summary.json`, and `source-reuse.json` hold
  exact run IDs, reports, private budgets, errors, and AST-verified reuse.
- Each `a*-console/runs/` or `b*-console/runs/` directory retains full run
  state, transcript, model attempts, tool outputs, and private research.
  Follow-up six uses the corresponding checklist console.
- `followup-recheck/checkpoint-fork.json` and `followup-recheck/summary.json`
  identify the separate checkpoint recheck and its source task.
- `*-browser-verdict.json`, `*-browser-reload.txt`, screenshots, and inbox
  empty-state captures hold the acceptance evidence.
- `final-live-audit.json`, `omission-restart-before.log`,
  `omission-restart-after.log`, and `omission-live-roundtrip.json` preserve both
  the detected gaps and the deterministic persistence correction.
- `complete-package-tests.log`, `complete-typecheck.log`, `final-checks.log`,
  and the three `*assertion-mutations.json` records hold the final gates.

One A3 launch used a slug where the input-cell API required an explicit handle
and was refused before any model call. Its rejected request and driver output
were preserved, then the setup was corrected for both inbox conditions. A
custom-element text wait and off-screen coordinate clicks also needed browser
driver corrections; keyboard activation and fresh snapshots established the
actual app behavior. These setup and acceptance steps are outside model-run
timings.
