/**
 * What a typed Weaver command's settlement becomes on the console's side: the
 * record a `client_action_resolved` event carries, the view the model reads,
 * and the provenance its result is held under. The model and the event log
 * both see the outcome's metadata and never its body; the body lives in the
 * session's handle table, behind the token both are given.
 */

import type { JSONObject } from "@commonfabric/api";
import {
  type HarnessCommandAttribution,
  type HarnessCommandCatalog,
  type HarnessCommandCatalogEntry,
  harnessCommandJsonBytes,
  type HarnessCommandOutcome,
  harnessCommandOutcomeRecord,
  type HarnessCommandResultProvenance,
  type HarnessCommandSettlement,
  type HarnessCommandSettlementRecord,
  type HarnessTypedClientAction,
  legacyOutcomeOfHarnessCommandSettlement,
  readHarnessCommandResultProvenance,
} from "../contracts/client-command.ts";
import type { HarnessClientActionOutcomeKind } from "../contracts/client-action.ts";

/** An outcome as the model reads it: everything but the body. */
export type HarnessCommandModelOutcome = Omit<HarnessCommandOutcome, "body">;

/**
 * A typed settlement as the model reads it. An executed command carries its
 * outcome's metadata and the token its body is held under; a catalog comes
 * back whole when it fits {@link HARNESS_COMMAND_CATALOG_MODEL_MAX_BYTES},
 * and with the schemas and descriptions of the entries past that point left
 * out when it does not.
 */
export type HarnessCommandModelSettlement =
  | {
    status: "executed";
    attribution: HarnessCommandAttribution;
    outcome: HarnessCommandModelOutcome;

    /** The `cfh:v:` token the outcome's body is held under. */
    handle?: string;
  }
  | {
    status: "executed";
    catalog: { entries: HarnessCommandModelCatalogEntry[] };

    /** How many entries came back without their schema and description. */
    compacted?: number;
  }
  | Extract<
    HarnessCommandSettlement,
    { status: "declined" | "failed_to_deliver" | "interrupted" }
  >;

/** A catalog entry as the model reads it, its schema absent when compacted. */
export type HarnessCommandModelCatalogEntry =
  | HarnessCommandCatalogEntry
  | Omit<HarnessCommandCatalogEntry, "inputSchema" | "description">;

/**
 * Largest catalog the model reads whole, as UTF-8 bytes of its JSON text.
 * The contract bounds each entry; this bounds what one answer adds to the
 * model's context.
 */
export const HARNESS_COMMAND_CATALOG_MODEL_MAX_BYTES = 32 * 1024;

/**
 * Holds a command's result body in the run's handle table under its
 * provenance, and answers the token. Supplied by the tool from its run, so a
 * session's results live in the table its later turns read.
 */
export type HarnessCommandResultHolder = (
  result: { value: JSONObject; provenance: HarnessCommandResultProvenance },
) => Promise<string>;

/**
 * Bounds a catalog for the model. Entries keep their order; once the running
 * size passes the limit, the remaining entries keep their summary and lose
 * their schema and description, which a later request naming them in
 * `detail` brings back.
 */
export const boundHarnessCommandCatalog = (
  catalog: HarnessCommandCatalog,
): { entries: HarnessCommandModelCatalogEntry[]; compacted?: number } => {
  if (
    harnessCommandJsonBytes(catalog) <= HARNESS_COMMAND_CATALOG_MODEL_MAX_BYTES
  ) {
    return { entries: catalog.entries };
  }
  const entries: HarnessCommandModelCatalogEntry[] = [];
  let size = 0;
  let compacted = 0;
  for (const entry of catalog.entries) {
    const whole = harnessCommandJsonBytes(entry);
    if (
      compacted === 0 && size + whole <= HARNESS_COMMAND_CATALOG_MODEL_MAX_BYTES
    ) {
      entries.push(entry);
      size += whole;
      continue;
    }
    const { inputSchema: _schema, description: _description, ...summary } =
      entry;
    entries.push(summary);
    compacted += 1;
  }
  return { entries, compacted };
};

/**
 * The provenance a command's held result carries: the command, who it ran
 * as, the loom it named, the version the command answered with, and the loom
 * the session was asked from. Undefined when the parts do not make a
 * provenance the handle table accepts, which the contract's readers rule out
 * for any settlement they admitted.
 */
export const harnessCommandResultProvenance = (
  invocation: Extract<
    HarnessTypedClientAction,
    { kind: "invoke_command" }
  >["invocation"],
  attribution: HarnessCommandAttribution,
  outcome: HarnessCommandOutcome,
): HarnessCommandResultProvenance | undefined => {
  const version = outcome.outputs?.version;
  return readHarnessCommandResultProvenance({
    command: invocation.command,
    actor: attribution.actor,
    ...(invocation.target !== undefined
      ? { loomId: invocation.target.loomId }
      : {}),
    ...(Number.isSafeInteger(version) && (version as number) >= 0
      ? { version }
      : {}),
    ...(attribution.originLoomId !== undefined
      ? { originLoomId: attribution.originLoomId }
      : {}),
  });
};

/** What a typed settlement writes to the log and hands the model. */
export interface HarnessCommandSettlementProjection {
  /** The final-action word a reader knowing only those three clears it by. */
  outcome: HarnessClientActionOutcomeKind;

  /** The person-facing text: the receipt, or the reason it did not run. */
  result?: string;

  record: HarnessCommandSettlementRecord;
  model: HarnessCommandModelSettlement;
}

/**
 * Projects a typed settlement onto the resolved event and the model's view.
 * The receipt goes to the event, for the person; the model reads the
 * outcome's metadata and the handle, never the receipt or the body.
 */
export const projectHarnessCommandSettlement = (
  settlement: HarnessCommandSettlement,
  handle: string | undefined,
): HarnessCommandSettlementProjection => {
  const outcome = legacyOutcomeOfHarnessCommandSettlement(settlement);
  if (settlement.status === "executed") {
    if ("catalog" in settlement) {
      const bounded = boundHarnessCommandCatalog(settlement.catalog);
      return {
        outcome,
        record: {
          status: "executed",
          catalogEntries: settlement.catalog.entries.length,
        },
        model: {
          status: "executed",
          catalog: { entries: bounded.entries },
          ...(bounded.compacted !== undefined
            ? { compacted: bounded.compacted }
            : {}),
        },
      };
    }
    const { body: _body, ...metadata } = settlement.outcome;
    return {
      outcome,
      ...(settlement.receipt !== undefined
        ? { result: settlement.receipt }
        : {}),
      record: {
        status: "executed",
        attribution: settlement.attribution,
        outcome: harnessCommandOutcomeRecord(settlement.outcome),
        ...(settlement.receipt !== undefined
          ? { receipt: settlement.receipt }
          : {}),
        ...(handle !== undefined ? { handle } : {}),
      },
      model: {
        status: "executed",
        attribution: settlement.attribution,
        outcome: metadata,
        ...(handle !== undefined ? { handle } : {}),
      },
    };
  }
  const result = settlement.status === "interrupted"
    ? settlement.reason === "restart" ? "interrupted" : settlement.reason
    : settlement.reason;
  return {
    outcome,
    ...(result !== undefined ? { result } : {}),
    record: settlement,
    model: settlement,
  };
};
