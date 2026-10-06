import type { JSONSchema, Pattern } from "../builder/types.ts";
import type { Cell } from "../cell.ts";
import { resolveLink } from "../link-resolution.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { listElementKeys } from "./list-element-keys.ts";
import { listElementLink } from "./list-element-link.ts";
import { inferListOpArgumentUsage } from "./list-op-argument-usage.ts";
import { listResultSchema } from "./list-result-schema.ts";
import { resolveOpPattern } from "./op-pattern-ref.ts";
import { ownedCell } from "./runtime-owned-store.ts";
import { narrowestCellScope, outputSpotFromBinding } from "./scope-policy.ts";

/** The three list coordinators, by the builtin ref name each registers. */
export type ListOp = "map" | "filter" | "flatMap";

/**
 * Everything a list coordinator derives before it touches an element: the
 * identity of its result container and of each per-element child run.
 * Shared between a coordinator's reconcile and the resume pre-sync, which
 * names those children before the parent instantiates, so the two mint
 * ONE set of identities by construction.
 */
export type ListCoordinatorPlan = {
  opPattern: Pattern;
  argumentUsage: ReturnType<typeof inferListOpArgumentUsage>;
  /** The list entity itself, the cell `array` callback arguments observe. */
  listCell: Cell<any>;
  /** One cell per slot, built from the slot links alone; undefined while the
   * input has no value, and a non-array passes through for the caller's
   * guard. */
  list: Cell<any>[] | undefined;
  /** Raw list value, retained so unavailable markers remain distinguishable. */
  rawList: unknown;
  /** The scope the result container is bound to. */
  scope: ReturnType<typeof narrowestCellScope>;
  /** The scoped result container, bound to the plan's transaction. */
  container: Cell<any[]>;
  /** Element identity keys by position (empty when `list` is not an array). */
  elementKeys: Map<number, string>;
};

/**
 * Derive a list coordinator's plan from its inputs.
 *
 * The reads here are the coordinator's own and journal exactly as they did
 * inside its reconcile. `op` is read through the coordinator's input
 * schema; the list is materialized identity-only — the raw slots are read
 * (the list-doc read that journals membership and order, which ARE the
 * list's content) and each element cell is built from its slot link
 * without dereferencing element content. An `asCell` traversal of the
 * array would instead journal a content read of every element doc the
 * coordinator never consumes, and under flow labels join every element's
 * whole-doc label into the coordinator's per-transaction join, smearing
 * member content onto the result container's structure label. The slot
 * resolutions are link-resolution probes, which flow derivation treats
 * as resolution machinery rather than observations.
 *
 * The result container is keyed on the node's reserved output spot — a
 * stable, position-derived, program-independent identity (CT-1623) —
 * rather than the serialized op or inputs, both of which carry the
 * session-varying program and would churn the container id, and every
 * per-element id derived from it, across reloads. `map` binds the
 * container to the list's own scope (`writeRedirect` resolution of the
 * list input); `filter` and `flatMap` bind it to the narrowest scope of
 * everything an element run may observe.
 */
export function listCoordinatorPlan(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  op: ListOp,
  inputsCell: Cell<any>,
  inputSchema: JSONSchema,
  parentCell: Cell<any>,
  outputBinding: NormalizedFullLink | undefined,
): ListCoordinatorPlan {
  const opCell = inputsCell.asSchema(inputSchema).withTx(tx).key("op").get();
  const sourceListCell = inputsCell.key("list");
  const listTarget = op === "map"
    ? resolveLink(
      runtime,
      tx,
      sourceListCell.getAsNormalizedFullLink(),
      "writeRedirect",
    )
    : undefined;
  // `array` callback arguments should observe the actual list entity, not
  // the alias/boxed reference used to pass that list into the builtin.
  const { listCell, rawList, slots } = listSlotResolutions(
    runtime,
    tx,
    inputsCell,
  );
  const list: Cell<any>[] | undefined = rawList === undefined
    ? undefined
    : !Array.isArray(rawList)
    ? rawList as unknown as Cell<any>[] // non-array: the caller's guard
    : slots.map((resolved) => runtime.getCellFromLink(resolved, undefined, tx));
  // `.getRaw()` because the pattern itself is wanted, not what its aliases
  // reach: a compact `{ $patternRef }` sentinel (resolved to the live
  // canonical pattern by identity) or, on the legacy path, the embedded
  // pattern graph itself.
  const opPattern = resolveOpPattern(runtime, opCell.getRaw(), op, inputsCell);
  const argumentUsage = inferListOpArgumentUsage(opPattern);
  const scope = op === "map" ? listTarget!.scope : narrowestCellScope(
    runtime,
    tx,
    [
      inputsCell.key("list"),
      ...(Array.isArray(list) && argumentUsage.usesElement ? list : []),
      argumentUsage.usesArray ? inputsCell.key("list") : undefined,
      argumentUsage.usesParams ? inputsCell.key("params") : undefined,
    ],
  );
  const outputSpot = outputSpotFromBinding(outputBinding);
  if (!outputSpot) {
    throw new Error(
      `${op}: result container requires a write-redirect output binding`,
    );
  }
  const resultSchema = op === "map"
    ? listResultSchema(opPattern.resultSchema)
    : listResultSchema();
  const container = ownedCell<any[]>(
    runtime,
    tx,
    parentCell,
    { [op]: parentCell.entityId, outputSpot },
    resultSchema,
    scope,
  );
  const elementKeys = Array.isArray(list)
    ? listElementKeys(list)
    : new Map<number, string>();
  return {
    opPattern,
    argumentUsage,
    listCell,
    list,
    rawList,
    scope,
    container,
    elementKeys,
  };
}

/**
 * A list input's entity and the value resolution of each of its slots — the
 * cells a coordinator's element keys are built from. One derivation, shared
 * by the plan and by the resume pre-sync: a slot's value chain is followed
 * only through documents that are local, so the identity it ends on depends
 * on what has arrived (a slot holding a cell whose stored value redirects to
 * a piece resolves to the piece when warm and to the cell when cold), and a
 * key derived from a cold chase names a child the warm coordinator never
 * mints. The pre-sync therefore pulls what each round of this resolution
 * ends on, until a round ends where the last one did, before deriving a
 * plan. `slots` is empty when the list is not an array.
 */
export function listSlotResolutions(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  inputsCell: Cell<any>,
  listKey = "list",
): {
  listCell: Cell<any>;
  rawList: unknown;
  slots: NormalizedFullLink[];
} {
  const listCell = inputsCell.key(listKey).withTx(tx).resolveAsCell();
  const rawList = listCell.withTx(tx).getRaw() as unknown;
  const listBase = listCell.getAsNormalizedFullLink();
  const slots = Array.isArray(rawList)
    ? rawList.map((slot, i) =>
      resolveLink(runtime, tx, listElementLink(listBase, slot, i), "value")
    )
    : [];
  return { listCell, rawList, slots };
}

/**
 * The result cell of one per-element child run: deterministic in the
 * coordinator's container and the element's identity key, at the container's
 * scope, so a reload resumes the same child and a pre-sync can name it before
 * the reload's
 * reconcile runs it.
 */
export function listElementResultCell(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  op: ListOp,
  container: Cell<any[]>,
  elementKey: string,
): Cell<any> {
  return runtime.getCell(
    container.space,
    { [op]: container, elementKey },
    undefined,
    tx,
    container.getAsNormalizedFullLink().scope,
  );
}
