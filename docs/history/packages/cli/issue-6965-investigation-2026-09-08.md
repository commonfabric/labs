---
status: historical
created: 2026-09-08
archived: 2026-09-08
reason: "Investigation of forced links, input visibility, and source preflight at ada72e0ca."
---

# Issue #6965: forced links and source preflight

Investigated [#6965](https://github.com/commontoolsinc/labs/issues/6965) against
`ada72e0ca513826095c815f27f6e458a1d323fae` (current `main` when fetched), on
macOS with Deno 2.9.4. Production code was unchanged. The reproduction uses
compiled patterns, the production CLI library helpers and piece controllers,
and multiple runtime replicas over one emulated Memory v2 server. It does not
use a live space or the full Topics board.

## Findings

The silent write and contradictory reads reproduce. The array error also
reproduces, with a qualification: it is a fresh-replica **preflight** failure.
An actual source update succeeds in the minimal reproduction, including from
a fresh replica. The observation does not establish that the forced link
inherently makes the piece impossible to update.

The fixture producer derives `namesTable: string[] | Default<[]>` containing
`["Ada"]`. The older consumer declares only `title: string`. Its candidate
adds `boardNames?: ReadonlyCell<string[] | Default<[]>>`, matching the outer
shape of the Topics input but omitting the board's member graph.

| Operation | Observed result |
| --- | --- |
| Link to the older consumer without the flag | Refused; argument unchanged |
| Same link with `allowNonExisting: true` | Write receipt; raw argument contains the link |
| Whole-input read afterward | `{ title: "Topic" }` |
| Targeted `boardNames` input read | `["Ada"]` |
| Old pattern result | `{ title: "Topic" }` |
| Fresh-replica candidate check before the bind | Compatible |
| Fresh-replica candidate check after the bind | `boardNames: value does not match type array` |
| Read the link, then check again in that replica | Compatible; stored argument unchanged |
| Update the consumer first, then bind without the flag | Fresh-replica check passes |
| Actual candidate update from a fresh replica after a forced bind | Commits, refresh completes, input and output expose `["Ada"]` |

The fresh failing check also reports an unconstrained retained-link schema at
`boardNames` in this fixture. Both problems disappear after the linked value
is read in the same replica. This differs from the issue's unrelated
`mentionable[].piece` refusal, which this fixture intentionally does not carry.

## Code path

1. [`linkPieces`](https://github.com/commontoolsinc/labs/blob/ada72e0ca513826095c815f27f6e458a1d323fae/packages/cli/lib/piece.ts#L3853)
   puts every endpoint check inside `!options?.allowNonExisting`. Without the
   flag, it tests current materialized values, not schema admission, and
   appends the override suggestion to every endpoint validation failure.
2. [`PiecesController.link`](https://github.com/commontoolsinc/labs/blob/ada72e0ca513826095c815f27f6e458a1d323fae/packages/piece/src/ops/pieces-controller.ts#L1778)
   follows the destination's argument metadata link and calls
   `key(...targetPath).setRawUntyped(...)`. This writes a durable key without
   adding it to the old pattern's schema or computation graph. The CLI then
   [prints `Linked`](https://github.com/commontoolsinc/labs/blob/ada72e0ca513826095c815f27f6e458a1d323fae/packages/cli/commands/piece.ts#L3055).
3. [`PiecePropIo.get`](https://github.com/commontoolsinc/labs/blob/ada72e0ca513826095c815f27f6e458a1d323fae/packages/piece/src/ops/piece-controller.ts#L2848)
   uses the schema-filtered root for whole-input reads, but a targeted read
   starts with `targetCell.key(...path)`. `Cell.key` uses
   `getSchemaAtPath`, whose missing-property default is permissive; the root
   schema view uses exclusion sentinels instead. The targeted read can
   therefore expose a stored key absent from the root projection.
4. [`pieceSourceCompatibilityReview`](https://github.com/commontoolsinc/labs/blob/ada72e0ca513826095c815f27f6e458a1d323fae/packages/piece/src/ops/piece-controller.ts#L4844)
   awaits `argumentCell.sync()` under the **old** schema, then immediately
   reads `argumentCell.asSchema(undefined).get()` and validates that wider
   read against the candidate schema. The old demand never loaded
   `boardNames`' linked payload. In the failing probe the raw key exists,
   while its untyped materialization reads as `undefined`; retaining that
   present key also prevents its array default from filling it. The validator
   reports a type error for data this replica has not materialized.
5. [`setPattern`](https://github.com/commontoolsinc/labs/blob/ada72e0ca513826095c815f27f6e458a1d323fae/packages/piece/src/ops/piece-controller.ts#L4496)
   explicitly avoids using this aggregate review as its acceptance gate.
   It checks contracts and validates at setup instead. That difference is why
   the preflight and actual update can disagree.

## Recommended fix boundaries

- Have piece linking check that the destination path is reachable through the
  current input schema even when the flag is present. Distinguish undeclared
  fields from declared optional slots, array elements, and dynamic record
  keys. Preserve the raw-cell linking use case deliberately. A successful
  schema lookup using the current permissive missing-property defaults is
  insufficient to implement this guard.
- Report an undeclared input with a source-update instruction, rather than
  recommending the override. Keep any remaining override help precise about
  what absence it permits.
- Make targeted piece-input reads respect the same visibility boundary as
  whole-input reads, or explicitly identify a raw argument read. Preserve
  narrow reads so inspecting one field does not fetch the entire board.
- Make source preflight validate settled candidate-relevant data or preserve
  opaque links with the appropriate contract proof. It must distinguish
  unloaded data from schema-invalid data, and agree with actual update
  acceptance. Fetching the entire untyped argument graph is not an adequate
  general remedy for a board with a large linked graph.

For the minimal case, the verified ordering is to update the consumer source
and then bind normally. The full Topics migration still has its separate
retained-link incompatibility; the successful minimal update does not waive
that check or establish that migration's safety.

## Reproduction and validation

[The local characterization test](../../../../runtime/cli/test/piece-link-input-visibility.test.ts)
contains four cases: contradictory reads, a fresh before/after preflight,
source-update-first control, and a fresh actual update. Its passing assertions
describe the observed bugs and controls; they are investigation evidence, not
assertions of the desired fixed behavior.

From `packages/cli`:

```sh
deno test --no-check --allow-env --allow-ffi --allow-read --allow-write \
  --allow-run --allow-net=127.0.0.1 test/piece-link-input-visibility.test.ts
```

All four cases passed. The fixtures are compiled by the pattern compiler in
the test. No production code, live space, or GitHub discussion was modified.
