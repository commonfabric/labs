import { type Cell, isCell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  CONF_LABEL_NOT_AVAILABLE,
  type ConfLabelQuery,
  type InspectConfLabelResult,
  inspectStoredConfLabel,
} from "../cfc/label-introspection.ts";
import { ownedCell } from "./runtime-owned-store.ts";
import { resolvedCellScope } from "./scope-policy.ts";

// Inv-12 Stage 2 (spec §4.6.4.1; docs/specs/cfc-label-metadata-confidentiality
// .md §3): `inspectConfLabel` — one of the pattern-facing surfaces for
// label-metadata introspection. It is a builtin node (not a Cell method, not
// an IPC seam) deliberately: the node runs inside the scheduler's transaction —
// so the observations it consumes are journaled/recorded in the SAME
// transaction whose writes the flow derivation labels — and the surface stays
// additive (nothing existing gains a new power; the display path
// `getCfcLabel` is untouched).
//
// The action is deliberately BLIND toward the target's payload: the target
// arrives `asCell` (never a value read) and only its resolved envelope
// metadata is consulted, through the internal verifier seam, so inspecting a
// label never consumes the labeled VALUE — consumption is exactly the
// §4.6.4.2-labeled metadata observations `inspectStoredConfLabel` records.

const TARGET_CELL_SCHEMA = {
  type: "object",
  properties: {},
  asCell: ["cell"],
} as const;

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    target: TARGET_CELL_SCHEMA,
    path: { type: "string" },
    query: {
      type: "object",
      properties: {
        atomType: { type: "string" },
        caveatKind: { type: "string" },
        source: { type: "unknown" },
        resourceClass: { type: "string" },
        policyName: { type: "string" },
        originUri: { type: "string" },
      },
    },
  },
} as const;

export function inspectConfLabel(
  inputsCell: Cell<{
    target: unknown;
    path?: string;
    query?: ConfLabelQuery;
  }>,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<unknown>[],
  parentCell: Cell<unknown>,
  runtime: Runtime,
): Action {
  return (tx: IExtendedStorageTransaction) => {
    const inputsWithTx = inputsCell.withTx(tx);
    // Scope the result to the resolved TARGET slot's scope (the `when`
    // idiom): metadata about a session-scoped target stays session-scoped.
    const resultScope = resolvedCellScope(
      runtime,
      tx,
      inputsWithTx.key("target"),
    );
    const result = ownedCell<InspectConfLabelResult>(
      runtime,
      tx,
      parentCell,
      { inspectConfLabel: cause },
      undefined,
      resultScope,
    );
    sendResult(tx, result);

    const inputs = inputsWithTx.asSchema(INPUT_SCHEMA).get() as {
      target?: unknown;
      path?: string;
      query?: ConfLabelQuery;
    } | undefined;
    const target = inputs?.target;
    let outcome: InspectConfLabelResult;
    if (!isCell(target)) {
      // No target (yet): indistinguishable from an unobservable one.
      outcome = CONF_LABEL_NOT_AVAILABLE;
    } else {
      // Follow the link chain to the doc the reference names. Resolution is
      // pointer topology (followRef-class probe reads), never a content
      // read of the target's payload.
      const resolved = target.withTx(tx).resolveAsCell()
        .getAsNormalizedFullLink();
      outcome = inspectStoredConfLabel(
        tx,
        resolved,
        inputs?.path ?? "",
        inputs?.query ?? {},
      );
    }
    // Set the outcome directly: the write boundary owns normalization and
    // copies by value (deep-frozen FabricValue trees — the stored-form atoms
    // and the frozen notAvailable constant — are accepted as-is, IWritable
    // contract). A JSON round-trip here would corrupt or throw on any
    // non-JSON-safe `FabricValue` a stored atom might carry, breaking the
    // stored-form-verbatim promise (codex/cubic P2 on the Stage 2 PR).
    result.withTx(tx).set(outcome);
  };
}
