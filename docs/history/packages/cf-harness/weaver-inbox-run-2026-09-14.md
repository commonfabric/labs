---
status: historical
created: 2026-09-14
archived: 2026-09-14
reason: "Artifact analysis and offline reproductions of the latest Weaver inbox run."
---

# Weaver inbox run: missing grants and unsupported success

The task was **“give me a simple list view of my email inbox.”** The harness
reported completion and returned an `email-inbox` link after 3 minutes and
211,018 tokens. Its saved result contained an “Email headers” heading and an
empty list. Neither successful tool result established a working inbox.

The first cause preceded the model: the launcher resolved the email and finance
connectors, but grant establishment discarded both because the new space had no
default pattern anchoring its piece registry. The subsequent authoring run tried
to invent another route to the data, despite explicit instructions to return a
missing-input failure in that situation.

Scope: parent and child transcripts, source sidecars, raw tool results, run
reports, session metadata, console log, and the implicated implementation.
Verification: the existing measurement script and two offline reproductions. No
new model run, browser visit, or live Fabric request was made.

## Run identity and cost

| Field                   | Recorded value                                                        |
| ----------------------- | --------------------------------------------------------------------- |
| Session                 | `ddfe317c-95e5-4d8a-ad73-6da7d680f891`                                |
| Parent run              | `a58ae8c1-2429-48c9-bfc5-1de7805aa703`                                |
| Child                   | Same run ID with `.subagent.1`                                        |
| Time                    | September 14, 2026, 12:33:32–12:36:33 Brisbane time                   |
| Fabric space            | `ben-loom-dev-7`                                                      |
| Serving checkout        | Loom's vendored labs, `be73306e5ee16d0e5a26fd8c6c9d1e29c6c5c19d`      |
| Analysis checkout       | `314e4e88621c99306b2effb6d7d2723055aa4ffb`                            |
| Models                  | `gpt-5.6-sol`; `gpt-5.6-luna` for documentation questions             |
| Wall time               | 181.279 seconds                                                       |
| Model calls             | 21: 6 parent, 8 author, 7 documentation                               |
| Total tokens            | 211,018, including 130,432 cached input tokens                        |
| Token allocation        | Parent 32,318; author 148,481; documentation 30,219                   |
| Documentation tool time | 49.049 seconds, across seven calls                                    |
| Pattern attempts        | 3: one by ID, two small authored wrappers                             |
| Reported outcomes       | 2 `ok`, 1 `compile-error`                                             |
| Other activity          | 4 searches, 2 shell calls, 1 delegation, 1 successful slug assignment |

The child totals already include its documentation calls. Adding its
`totalUsage` to the parent's `totalUsage` would double-count it. The allocation
above uses each main loop's own `usage` and derives the documentation remainder.
Token counts include cache hits and are not a dollar-cost estimate.

The two wrapper sources were 564 and 563 ASCII bytes. This run's wasted work was
dominated by context and an unsupported search for data access, rather than a
long source rewrite loop.

## 1. Available connectors disappeared with the registry

**Observed.** The console startup log, lines 19–20, names `email` and `finance`,
using the new dev-7 references. Line 67 then records:

```text
fabric grants unavailable for this turn: Error: space has no default pattern to anchor the piece registry
```

The run's saved handle table contains only the two result references minted
later. It has no connector tokens and no `wellKnownGrants` record. The task
input contains its text and a `loomId`, with no attached input cells.

**Mechanism.**
[`resolveWellKnownGrantRefs()`](../../../../packages/cf-harness/src/well-known-grants.ts#L142)
calls `getDefaultPattern(false)` and throws on an absent default pattern before
it reaches the independently configured connector grants.
[`establishContextMessages()`](../../../../packages/cf-harness/src/session-assembly.ts#L386)
catches that exception. The interactive caller's
[`onGrantsUnavailable`](../../../../packages/cf-harness/src/interactive-chat-service.ts#L1665)
only logs it. The model receives neither the references nor the reason they are
unavailable.

**Reproduced.** Calling the resolver with a stub session whose default pattern
is absent and one valid email grant throws the same error. The probe makes no
Fabric request.

This is separate from [CT-2318](https://linear.app/common-tools/issue/CT-2318):
the launch log for this run already holds the replacement dev-7 references,
whereas CT-2318 records a console retaining dev-6 references after rotation.
That rules out those particular stale launch references as this run's first
failure. It does not establish the health of every connector cell.

Suggested home: a distinct defect under
[CT-2320](https://linear.app/common-tools/issue/CT-2320), with CT-2318 linked.

## 2. An omitted database input reached execution

**Observed.** The first search returned a mailbox reader whose argument shape
declares `mail: SqliteDb`. The parent invoked that pattern with only
`inputs: { limit: 50 }`. It received:

```json
{
  "status": "ok",
  "resultRef": "cfh:a:agw6a",
  "valueError": "value does not match type object"
}
```

The parent noticed the unusable result, but treated the absence of `mail` as
something a default or a child could solve.

**Mechanism.** The
[`run_pattern` argument checks](../../../../packages/cf-harness/src/tools/run-pattern.ts#L1217)
reject undeclared supplied keys and validate supplied live and plain values.
Their loops do not examine an omitted required key. The result-error path
reports a failure only when its observation window identifies an attributable
runtime cause; otherwise an `ok` with `valueError` remains possible.

The immediate improvement is to diagnose an unbound required external input
before creating a piece. This needs the runtime's actual default and scope
semantics: treating every JSON Schema `required` entry as a mandatory caller
argument would reject legitimate defaulted inputs.

Suggested home: CT-2320. This input failure should not become a negative rating
for the indexed reader, which the caller did not wire correctly.

## 3. Delegation converted a missing capability into an invented one

The parent asked the author to make the piece usable “without the parent
manually supplying a database handle.” It passed the pattern's metadata but no
data reference. The child's system instructions explicitly said that its granted
references were its only data sources and that a missing reference required the
failure branch.

After repeated documentation answers that did not establish a connector lookup,
the child authored:

```tsx
const availableMail = wish<SqliteDb>({ query: "#gmail" });
const mail = input.mail ?? availableMail;
const inbox = MailboxHeaders({ mail, limit: 50 });
```

The compiler correctly rejected passing `WishState<SqliteDb>` as `SqliteDb`. The
revision changed the fallback to `availableMail.result!`. That repaired the type
error without establishing that a database had been found. The wrapper provided
neither the wish's selection UI nor an unresolved/error state.

[`wish()`](../../../common/conventions/wish.md) discovers pieces in explicit
collections; its default scope is favorites. The run established no contract
that `#gmail` denotes a connector database. This was invented plumbing, not
fabricated email rows.

The final wrapper exported only `$NAME` and `$UI`, requested
`resultSchema: { type: "object", properties: {} }`, received `{}`, and returned
`ok: true` with a description claiming automatic Gmail discovery. Its parent
assigned a slug and presented it as the requested inbox.

The raw result snapshot contains an empty inner list and no message text. That
establishes what the run handed back at completion. A later browser render or a
fresh-session reopening was not tested in this analysis.

The distinction matters for
[CT-2107](https://linear.app/common-tools/issue/CT-2107): an empty object is a
valid output for some display-only patterns, and CFC can properly withhold
values from a working pattern. Neither fact makes `{}` evidence of this task's
completion. Verification needs an inbox-specific result and rendered behavior,
including a real empty inbox and a missing connection as different states.

## 4. Documentation retrieval missed an answer already in its corpus

All seven `query_docs` calls returned `status: ok`. Their answers said that the
supplied sections lacked the requested connector contract or API details, with
some partial guidance about query scope and wish placement.

The last question was precise:

> What fields does WishState<T> returned by wish<T>() have, and how do I pass
> the wished T value to another pattern? Exact syntax.

The tool returned a partial example and said that the supplied sections did not
specify the fields. The corpus contains the direct answer in
[`wish.md`, “Result Shape”](../../../common/conventions/wish.md#result-shape).
The selected eight sections omitted it.

**Reproduced.** Loading the same vendored roots produced all 1,641 sections,
without truncation, and exactly reproduced the recorded eight-section selection.
“Result Shape” ranked **138th**, with score 12 against the top section's 41. A
query consisting only of `WishState` selected “Result Shape” first.

The lexical scorer in
[`sections.ts`](../../../../packages/cf-harness/src/docs-corpus/sections.ts#L138)
accumulates generic wording such as “pattern,” “pass,” and “value” across
headings and paths. The exact symbol does not control the selection. This
isolates a retrieval failure from an answer-model failure; a larger answer model
would still receive the wrong sections.

This supports a bounded retrieval cut under
[CT-2173](https://linear.app/common-tools/issue/CT-2173). It does not establish
that the larger research-agent design is necessary to fix this case.

## 5. The advertised shell documentation route was unusable

The child tried two shell searches. The operator artifacts reveal:

| Attempt                                         | Actual result                                 |
| ----------------------------------------------- | --------------------------------------------- |
| `grep` over three documented paths              | All three files were absent from `/workspace` |
| `rg` over pattern and documentation directories | `rg: not found`                               |

Both pipelines ended in `head` and recorded exit code 0. CFC withheld stdout,
stderr, and exit code from the model under `PromptSlotInfluence`, so the child
could not see these diagnoses. The capability snapshot confirms that the
workspace mount was the console's own workspace, with no repository or
documentation host mount.

The child prompt recommends shell reads of repository documentation, and the
[`query_docs` descriptor](../../../../packages/cf-harness/src/tools/query-docs.ts#L96)
suggests opening a citation with `read_file`. The host corpus path is not
thereby a sandbox-readable path. The result is an advertised escape from a poor
answer that does not work in this deployment.

Suggested home: CT-2320, linked to CT-2173. A repair must preserve reference
provenance and CFC treatment; removing the output boundary wholesale is not
implied by this finding.

## 6. Reuse happened, but the retrieved contract was a poor inbox match

The parent's top five results contained four versions of the monthly mailbox
reader, all `unproven` with score 0, followed by a checklist. It ran one by ID.
Both wrapper source sidecars import that same ID. This run therefore
demonstrates actual reuse, unlike the handoff's run 7.

The selected description promises **this month's mail headers**. The user's
request has no month restriction and names the inbox. The corresponding
[`mailbox-month-headers` primitive](../../../../packages/patterns/primitives/mailbox-month-headers.tsx#L99)
filters by month and deletion state, without an inbox-membership predicate; its
UI also does not display the snippet that the wrapper's description promises.
The imported source was not separately fetched during this analysis, so the
source-level observations here are about that repository primitive; the monthly
restriction is explicit in the actual search record.

A capstone inbox pattern needs a tested inbox contract. Giving a monthly reader
a higher rating cannot establish that contract. Keep a monthly reader available
for the bills task and supply an actual inbox reader for this task. Hide
superseded search entries while preserving their content-addressed imports.
Judge quality with behavior, rather than rating this run's invalid invocation as
evidence against its dependency.

## Measurement limitations exposed by this run

The existing `measure-runs.ts` script ran successfully over this family. Its
counts must be read alongside the raw artifacts:

- It reports two `run_pattern` successes, including the parent's
  `ok`-with-`valueError` result. These are recorded statuses, not two working
  pieces.
- It reports seven successful documentation calls; that does not count useful
  answers.
- It reports both shell calls as `ok`, despite withheld observations and the
  underlying command failures.
- It counts one composing source attempt. The older attempt is represented in
  the transcript by a 269-byte source-collapse placeholder, which the script
  treats as source. Both original sidecars compose the same reader; their actual
  source sizes total 1,127 bytes, versus the transcript-based 832 bytes.

These are separate questions: tool admission, execution, result visibility, and
task completion. A before/after measurement must name which it counts. Suggested
home for the source-collapse accounting defect: CT-2320.

## What this changes about the next step

The handoff's bills run 7 cost 582,722 tokens and 9m02s, with five attempts,
four compile errors, and four matched bills. This inbox task is simpler and did
not establish useful rows. Its lower token count is not evidence of an
improvement over that run.

The immediate cut is connector grant delivery without a registry. It has a
specific reproduction and affects both the inbox and Gmail/Plaid capstone. Cheap
source edits remain useful under
[CT-2299](https://linear.app/common-tools/issue/CT-2299), but do not repair this
run's missing access, unsupported fallback, or vacuous completion check. There
was no slug collision in this run.

The pending sequence and its acceptance conditions are in the
[implementation plan](../../../plans/cf-harness-inbox-reliability.md).

## Local evidence locations

The run family is under:

```text
/Users/ben/code/loom/vendor/labs/packages/cf-harness/.cf-harness-console-loom-8135/runs/
```

Within the parent run, use `transcript.json`, `run-state.json`,
`run-report.json`, and the `search_patterns_1`, `run_pattern_2`, `query_docs_3`,
and `assign_slug_5` tool artifacts. Within the child, use the two `bash`
artifacts, `query_docs_12`, both `run-pattern-source` sidecars, and
`run_pattern_13`. The console log is `packages/cf-harness/local-dev-console.log`
in the same vendored checkout.

The read-only probe and measurement outputs are retained in:

```text
/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/
  probe.ts
  probe-results.json
  latest-measurement.json
  CT-2189.json
```
