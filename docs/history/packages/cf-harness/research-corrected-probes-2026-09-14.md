---
status: historical
created: 2026-09-14
archived: 2026-09-14
reason: "Corrected callable research probes: valid handle admission and executable indexed composition, with citation-copy failures causing repeated research."
---

# Corrected callable research probes

The repeated inbox probe preserved and admitted its real email handle. The
dinner-preparation probe produced a complete kit whose unchanged example
compiled, imported two indexed components, rendered, and calculated `$7.25` from
synthetic costs. Whole-turn cost increased for both tasks. Incorrectly copied
citation IDs caused strict admission to reject otherwise usable recipes and the
parent to repeat research.

These runs repeated the exact instructed tasks from the
[first callable probes](research-callable-probes-2026-09-14.md). They tested the
corrected callable service, not automatic startup or ordinary app creation.

## Configuration and scope

The implementation was committed as `af916cf0cc79377deeeb4e2707bd66794308acd8`
after these runs. Its parent was `314e4e88621c99306b2effb6d7d2723055aa4ffb`. The
owned console used port `8186`, parent `gpt-5.6-sol`, and private researcher
`gpt-5.6-luna`. The user explicitly approved transmitting connector schemas and
row/fill counts to the configured `chatgpt.com` endpoint. The tasks did not
query raw email or transaction contents, run patterns, publish, or assign slugs.

Tasks ran serially against Ben's toolshed on port `8001`, reporting revision
`be73306e5ee16d0e5a26fd8c6c9d1e29c6c5c19d`. The preflight recorded the diverged
revision. The discoverable index contained 41 entries before and after. No
existing Fabric store or index entry was changed. Compilation and rendering
checks ran separately in an isolated in-memory runtime.

## Measurements

| Measurement             | Inbox                                  | Dinner preparation                     |
| ----------------------- | -------------------------------------- | -------------------------------------- |
| Root run                | `825770f4-4a50-44d2-a4a4-94a90e11817d` | `89a8e0ee-8a6a-4e8b-a265-42afe0a5addf` |
| Whole turn              | 212.813 seconds                        | 289.340 seconds                        |
| Previous probe          | 177.399 seconds                        | 126.348 seconds                        |
| Whole-turn tokens       | 262,526                                | 321,565                                |
| Previous probe tokens   | 144,009                                | 121,148                                |
| Parent tokens           | 70,363                                 | 42,310                                 |
| Private research tokens | 192,163                                | 279,255                                |
| Cached input tokens     | 126,336                                | 98,688                                 |
| Parent model turns      | 4                                      | 4                                      |
| Research invocations    | 2                                      | 3                                      |
| Research durations      | 54.457 / 73.181 seconds                | 92.503 / 88.378 / 64.184 seconds       |
| Final admitted kit      | Incomplete                             | Complete                               |
| Live pattern attempts   | 0                                      | 0                                      |

Private tokens are total usage minus parent usage; cached input is already
included in total tokens. These single repeats establish the observed costs, not
a controlled estimate of model variance or a speed improvement.

## Findings

The inbox kit bound `mail` to the successfully described `cfh:a:vs8sf` token.
Its conditional example required an explicit `inboxLabelId`, joined messages,
labels, and participants, and included loading, error, and empty states. It
compiled unchanged, without executing a query against email. Its final
incomplete status included an unread example citation; a handle description's
`outputId` had also been incorrectly used as citation provenance.

No indexed mail component was actually imported by that example. Its commented
import was counted by the existing import-discovery helper, so that helper's
reported ID is not evidence of executable reuse. The parent also repeated the
incorrect claim that the monthly reader depends on populated `received_at`; the
published SQL falls back to `sent_at` and `internal_date`. Source access alone
did not guarantee correct interpretation.

The dinner example genuinely imported and called the checklist
`dZt8I5yIWD2g6NeftbKv-3ZouzZ2LGCSEhT8ij7wGV0` and amount ledger
`DRCFljoU1NSWQ8pt8dvVa-mG5cld1tj5J46iq7L7-VE`. All three kits correctly used
`inputs: []`. Its final source compiled and rendered unchanged with one
synthetic preparation item and ingredient amounts `4.50` and `2.75`, returning
`total: 7.25` and `formattedTotal: "$7.25"`. This checked initial rendering and
arithmetic, not browser editing or persistence. A storage-close diagnostic
appeared during probe teardown after successful rendering.

The first dinner invocation opened `section-176`, received
`documentation:4a7cec6bdb34f84d`, and cited the value without its final
character. The second passed a citation ID where `open_doc_section` required a
`section-N` selector, then transposed characters in another citation. Admission
correctly rejected both. The third invocation reopened ten sources using fifteen
private tool calls before producing a complete kit. Across the three calls,
private research used 63 tool calls. The first call had used seven of eight
model turns, leaving room for a bounded citation correction without reopening
anything.

The first probe report incorrectly characterized `new Writable(...)` itself as
invented syntax. It is a supported API; the corrected example's use compiled.
The relevant failure here was citation and binding guidance, not that spelling.

## Next smallest cut

Echo the documentation selector on reads, distinguish selectors from citation
and binding IDs, and provide an exact current-source catalog at synthesis. Allow
one tool-free citation correction within the existing eight-turn budget. Keep
strict fresh-read admission. Then exercise automatic research on a bare task,
including inherited author context, actual indexed imports, compilation
attempts, and browser behavior in a separate local Fabric store.

## Artifacts

The host artifact root was
`/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/`:

- `research-callable-live-2/explicit-run-measurements.json` and the two run
  reports contain measurements. The batch's task matcher again mistook the
  initial grant announcement for the task, so its zero measurements are not used
  here.
- `research-console/runs/<run-id>/` contains transcripts, run state, and exact
  private research evidence inside tool-output artifacts.
- `research-corrected-inbox-example.tsx` and its `.check.json` record unchanged
  compilation and the commented-import measurement limitation.
- `research-corrected-composition.tsx`, `.html`, and `.check.json`, together
  with `research-corrected-dinner-fixture.json`, record the synthetic render.
- `check-research-example.ts` is the isolated compilation/rendering procedure.
