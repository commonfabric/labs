/**
 * What a typed Weaver command's settlement becomes on the console's side: the
 * record a `client_action_resolved` event carries, the view the model reads,
 * and the provenance its result is held under. The model and the event log
 * both see the outcome's metadata and never its body; the body lives in the
 * session's handle table, behind the token both are given.
 */

import type { JSONObject } from "@commonfabric/api";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  HARNESS_COMMAND_ID_MAX_LENGTH,
  type HarnessCommandAttribution,
  type HarnessCommandCatalog,
  type HarnessCommandCatalogEntry,
  harnessCommandJsonBytes,
  type HarnessCommandOutcome,
  harnessCommandOutcomeRecord,
  type HarnessCommandResultProvenance,
  type HarnessCommandSettlement,
  type HarnessCommandSettlementRecord,
  legacyOutcomeOfHarnessCommandSettlement,
  readHarnessCommandCatalog,
} from "../contracts/client-command.ts";
import type { HarnessClientActionOutcomeKind } from "../contracts/client-action.ts";

export { harnessCommandResultProvenance } from "../contracts/client-command.ts";

/** An outcome as the model reads it: everything but the body. */
export type HarnessCommandModelOutcome = Omit<HarnessCommandOutcome, "body">;

/**
 * A typed settlement as the model reads it. An executed command carries its
 * outcome's metadata and the token its body is held under; a catalog comes
 * back whole when it fits {@link HARNESS_COMMAND_CATALOG_MODEL_MAX_BYTES},
 * and otherwise bounded by {@link boundHarnessCommandCatalog}.
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

    /** How many entries the Weaver sent that the contract refused. */
    droppedEntries?: number;

    /** The ids of the first few refused entries. */
    droppedCommands?: string[];
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
 * The contract bounds each entry and the number of entries; this bounds the
 * schemas and descriptions one answer adds to the model's context beyond the
 * commands its request named.
 */
export const HARNESS_COMMAND_CATALOG_MODEL_MAX_BYTES = 32 * 1024;

/**
 * The catalog entries a settlement arrived with that the contract refused:
 * how many, and the ids of the first {@link HARNESS_COMMAND_DROPPED_NAMED}.
 */
export interface HarnessCommandCatalogDrop {
  count: number;
  commands: string[];
}

/** How many refused catalog entries a drop names. */
export const HARNESS_COMMAND_DROPPED_NAMED = 5;

/**
 * Admits a typed answer's catalog entry by entry, before the contract reads
 * the answer: each entry the contract's catalog reader refuses on its own is
 * removed and counted, so one malformed or newer-than-the-contract command
 * does not cost the whole catalog and leave the request waiting out its
 * timeout. Anything but an executed catalog settlement whose entries are an
 * array is returned unchanged, so a malformed envelope is still the
 * contract's to refuse.
 */
export const admitHarnessCommandCatalogEntries = (
  body: unknown,
): { body: unknown; dropped?: HarnessCommandCatalogDrop } => {
  if (!isObjectNotArray(body)) return { body };
  const settlement = (body as Record<string, unknown>).settlement;
  if (
    !isObjectNotArray(settlement) ||
    (settlement as Record<string, unknown>).status !== "executed" ||
    !Object.hasOwn(settlement, "catalog")
  ) {
    return { body };
  }
  const catalog = (settlement as Record<string, unknown>).catalog;
  if (!isObjectNotArray(catalog)) return { body };
  const entries = (catalog as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) return { body };
  const kept: unknown[] = [];
  const commands: string[] = [];
  let count = 0;
  for (const entry of entries) {
    if (readHarnessCommandCatalog({ entries: [entry] }) !== undefined) {
      kept.push(entry);
      continue;
    }
    count += 1;
    if (commands.length < HARNESS_COMMAND_DROPPED_NAMED) {
      const id = isObjectNotArray(entry)
        ? (entry as Record<string, unknown>).command
        : undefined;
      commands.push(
        typeof id === "string"
          ? id.slice(0, HARNESS_COMMAND_ID_MAX_LENGTH)
          : "(no command id)",
      );
    }
  }
  if (count === 0) return { body };
  return {
    body: {
      ...body,
      settlement: { ...settlement, catalog: { ...catalog, entries: kept } },
    },
    dropped: { count, commands },
  };
};

/**
 * Holds a command's result body in the run's handle table under its
 * provenance, and answers the token. Supplied by the tool from its run, so a
 * session's results live in the table its later turns read.
 */
export type HarnessCommandResultHolder = (
  result: { value: JSONObject; provenance: HarnessCommandResultProvenance },
) => Promise<string>;

/**
 * Bounds a catalog for the model. Entries keep their order. The commands the
 * request named in `detail` are kept whole, since a request naming them is
 * how the model brings back what a bounded catalog left out; the rest are
 * kept whole in order until the running size passes the limit, and every
 * one after that keeps its summary and loses its schema and description.
 * The limit bounds the entries kept whole; the summaries of the compacted
 * rest add at most what the contract's catalog limit allows.
 */
export const boundHarnessCommandCatalog = (
  catalog: HarnessCommandCatalog,
  detail: readonly string[] = [],
): { entries: HarnessCommandModelCatalogEntry[]; compacted?: number } => {
  if (
    harnessCommandJsonBytes(catalog) <= HARNESS_COMMAND_CATALOG_MODEL_MAX_BYTES
  ) {
    return { entries: catalog.entries };
  }
  const named = new Set(detail);
  let size = 0;
  for (const entry of catalog.entries) {
    if (named.has(entry.command)) size += harnessCommandJsonBytes(entry);
  }
  const entries: HarnessCommandModelCatalogEntry[] = [];
  let compacted = 0;
  for (const entry of catalog.entries) {
    if (named.has(entry.command)) {
      entries.push(entry);
      continue;
    }
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
  return { entries, ...(compacted > 0 ? { compacted } : {}) };
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
 * outcome's metadata and the handle, never the receipt or the body. `detail`
 * is the catalog request's, whose commands the model's catalog keeps whole;
 * `dropped` names the catalog entries refused on arrival, to the model and
 * in the event's result text.
 */
export const projectHarnessCommandSettlement = (
  settlement: HarnessCommandSettlement,
  handle: string | undefined,
  detail?: readonly string[],
  dropped?: HarnessCommandCatalogDrop,
): HarnessCommandSettlementProjection => {
  const outcome = legacyOutcomeOfHarnessCommandSettlement(settlement);
  if (settlement.status === "executed") {
    if ("catalog" in settlement) {
      const bounded = boundHarnessCommandCatalog(settlement.catalog, detail);
      return {
        outcome,
        ...(dropped !== undefined
          ? {
            result: `${dropped.count} catalog ${
              dropped.count === 1 ? "entry was" : "entries were"
            } dropped as malformed: ${dropped.commands.join(", ")}`,
          }
          : {}),
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
          ...(dropped !== undefined
            ? {
              droppedEntries: dropped.count,
              droppedCommands: dropped.commands,
            }
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
