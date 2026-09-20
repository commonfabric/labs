import {
  debugStr,
  FabricInstance,
  FabricPrimitive,
  type FabricValue,
  isValidFabricValue,
} from "@commonfabric/data-model";
import {
  Cell,
  JSONSchema,
  KeepAsCell,
  parseLink,
  Runtime,
  SigilLink,
} from "@commonfabric/runner";
import {
  type CfcCellLinkRefPayload,
  cfcLabelViewForCell,
  redactCaveatSourcesForDisplay,
  stripSigilCfcLabelViews,
} from "@commonfabric/runner/cfc";
import {
  isSigilLink,
  linkRefFrom,
  refuseFabricInstance,
} from "@commonfabric/runner/shared";
import { IndexTrackingStack } from "@commonfabric/utils/index-tracking-stack";
import type { LoggerFlagsBreakdown } from "@commonfabric/utils/logger";

import { isCellRef } from "@/protocol/mod.ts";
import { CellRef, type LoggerFlagsData, PieceRef } from "@/protocol/types.ts";

/**
 * Converts a value arriving over the connection into the form the worker
 * writes: every `CellRef` in it becomes a `SigilLink`, and every raw
 * `SigilLink` loses its label view.
 *
 * A cell's value is a `FabricValue`, as are a `CellRef` and a `SigilLink`, so
 * the conversion moves within that type. The result holds no `CellRef`.
 *
 * A value that contains itself is refused, with the path at which the cycle
 * closes. A subtree reachable from two positions is shared rather than
 * cyclic, and is walked at each.
 *
 * @throws If the value contains a cycle, or a `FabricInstance`.
 */
export function mapCellRefsToSigilLinks(value: FabricValue): FabricValue {
  return mapOne(value, [], new IndexTrackingStack<object>());
}

/**
 * Recursive worker for {@link mapCellRefsToSigilLinks}, carrying the state of
 * the walk in progress. `path` is the way from the root to `value`, held as
 * one array the walk pushes to and pops from. `ancestors` holds the containers
 * the walk is inside, so that what it recognizes is a cycle: an entry sits
 * there only while the walk is inside it, and a container reached again by a
 * different path is not there any more.
 */
function mapOne(
  value: FabricValue,
  path: string[],
  ancestors: IndexTrackingStack<object>,
): FabricValue {
  if (
    typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (isCellRef(value)) {
    return cellRefToSigilLink(value);
  } else if (isSigilLink(value)) {
    // A RAW sigil link in an inbound value bypasses the CellRef branch above
    // (hand-crafted JSON, or a CellHandle serialized into CustomEvent.detail
    // via toJSON). Its label view is a main-thread display artifact like a
    // ref's (inv-12 Stage 0) — drop it so it never becomes a link-write
    // policy input.
    //
    // `stripSigilCfcLabelViews()` reports `unknown`, being general over what it
    // walks. Narrowed here by what it does: it removes a property from each
    // link payload it finds, so given a link it returns one.
    return stripSigilCfcLabelViews(value) as SigilLink;
  } else if (value instanceof FabricPrimitive) {
    // Atomic, so there is nothing under it to map. It goes _before_ the record
    // branch: one is also a record, and that branch rebuilds from enumerable
    // own properties a fabric class does not have, which would put `{}` here in
    // place of the value.
    return value;
  } else if (value instanceof FabricInstance) {
    // A `FabricInstance` is refused. Its codec contents can carry a link, and
    // those contents are not reachable by property name -- so the record
    // branch below would rebuild one from enumerable own properties it does
    // not have, yielding `{}` and losing whatever it holds, and passing it
    // through whole would leave any link inside it unmapped.
    //
    // Nothing reaches this in production today, de facto rather than by
    // construction: no flag gates it. What keeps it unreachable is the
    // refusal at the other end of the same crossing -- `CellHandle.serialize()`
    // in `../cell-handle.ts` refuses a `FabricInstance` before the value is
    // sent, so neither caller here can be handed one. The transport itself no
    // longer helps: the envelope's encoding carries an instance across with
    // its class, where structured cloning used to strip it to `{}`.
    //
    // The two refusals are a matched pair and move together, along with
    // `convertCellsToLinks()`'s in `@commonfabric/runner`, which is the same
    // refusal on the outbound side. Lifting one alone would leave an instance
    // able to reach a walk that cannot descend it.
    //
    // TODO(danfuzz): descend by codec-mediated traversal into instance state,
    // at which point this becomes a walk rather than a refusal.
    refuseFabricInstance(value, "when mapping cell refs to sigil links");
  } else if (typeof value === "object" && value) {
    // A container. It goes onto `ancestors` for as long as the walk is inside
    // it, and every way out below clears it again.
    if (ancestors.has(value)) {
      throw new Error(
        "Cannot map cell refs to sigil links in a value with a cycle; " +
          `the cycle closes at path \`${path.join(".")}\`.`,
      );
    }
    ancestors.push(value);

    try {
      if (Array.isArray(value)) {
        return value.map((item, index) => {
          path.push(String(index));
          const next = mapOne(item, path, ancestors);
          path.pop();
          return next;
        });
      }

      const out: Record<string, FabricValue> = {};
      for (const [key, item] of Object.entries(value)) {
        path.push(key);
        out[key] = mapOne(item, path, ancestors);
        path.pop();
      }
      return out;
    } finally {
      ancestors.popExpect(value);
    }
  }
  return value;
}

/**
 * Asserts that a logger flag breakdown is carriable on the connection. Its
 * shape is the declaration's -- `getLoggerFlagsBreakdown()` reports records to
 * the leaf -- and what the declaration leaves open is the leaves themselves,
 * `Logger` taking a `Record<string, unknown>` and constraining it no further.
 * So the whole question is whether the breakdown is a `FabricValue`.
 *
 * A breakdown that is not one throws rather than travelling with the offending
 * metadata dropped. Dropping it would leave the payload reporting a flag whose
 * metadata had silently gone, which is the loss "Death before confusion!"
 * rules out.
 *
 * Nothing reaches the throw today, de facto rather than by construction: no
 * flag gates it, and every producer that raises a flag with metadata passes
 * a `FabricValue` -- one of them a cell's own raw value.
 */
export function assertFabricLoggerFlags(
  breakdown: LoggerFlagsBreakdown,
): asserts breakdown is LoggerFlagsData {
  if (isValidFabricValue(breakdown)) return;

  throw new Error(
    "Cannot send logger flags on this connection, not being a " +
      debugStr`\`FabricValue\`: $quote${breakdown}`,
  );
}

export function cellRefToSigilLink(cell: CellRef): SigilLink {
  // A `cfcLabelView` on an inbound CellRef is deliberately NOT forwarded
  // (inv-12 Stage 0 / SC-25): it round-tripped through the main thread
  // (CellHandle.deserialize keeps the view on the ref) and is
  // main-thread-influenceable — an untrusted display artifact. Forwarding it
  // onto the written sigil link previously made it a link-write policy input
  // that prepareBoundaryCommit persisted as link-origin labels; the worker
  // re-derives those from its own stored source metadata instead.
  return linkRefFrom<CfcCellLinkRefPayload>({
    id: cell.id,
    space: cell.space,
    scope: cell.scope,
    path: cell.path,
    ...(cell.schema !== undefined && { schema: cell.schema }),
    ...(cell.overwrite !== undefined && { overwrite: cell.overwrite }),
  });
}

export function createCellRef(cell: Cell<unknown>, schema?: unknown): CellRef {
  const link = parseLink(
    cell.getAsLink({
      includeSchema: true,
      keepAsCell: KeepAsCell.All,
    }),
  );
  // Check before casting to a NormalizedFullLink
  if (!link.id || !link.space) {
    throw new Error("Serialized links must contain id and space.");
  }
  const cellRef: CellRef = {
    id: link.id,
    space: link.space,
    scope: link.scope === "inherit" || link.scope === undefined
      ? "space"
      : link.scope,
    path: link.path,
  };
  if (link.schema != null) cellRef.schema = link.schema;
  if (link.overwrite != null) cellRef.overwrite = link.overwrite;
  if (schema !== undefined) {
    cellRef.schema = schema as JSONSchema;
  }
  const cfcLabelView = cfcLabelViewForCell(cell);
  if (cfcLabelView !== undefined) {
    // Ref-attached views are main-thread display copies like the in-value
    // sigil views: redact Caveat.source before they cross (inv-12 Stage 0).
    // The worker never re-imports them (see getCell / cellRefToSigilLink),
    // so the redacted copy cannot round-trip into label state.
    cellRef.cfcLabelView = redactCaveatSourcesForDisplay(cfcLabelView);
  }
  return cellRef;
}

export function createPieceRef(cell: Cell<unknown>): PieceRef {
  return {
    cell: createCellRef(cell),
  };
}

export function getCell(runtime: Runtime, ref: CellRef): Cell<unknown> {
  // We explicitly do not pass in `schema`, as this function applies
  // the schema to `schema`, and cell refs already contain all this
  // information. Maybe the upstream function should change.
  //
  // `ref.cfcLabelView` is deliberately NOT seeded into the worker cell
  // (inv-12 Stage 0 / SC-25): an inbound view is a main-thread display
  // artifact, not worker label state. The worker derives label views from
  // its own stored metadata (`cfcLabelViewForCell`); outbound refs still
  // carry a view for the client's display. Stripped from the ref object
  // itself because getCellFromLink also reads the property off
  // normalized-link-shaped inputs.
  if (ref.cfcLabelView === undefined) {
    return runtime.getCellFromLink(ref);
  }
  const { cfcLabelView: _cfcLabelView, ...cleanRef } = ref;
  return runtime.getCellFromLink(cleanRef);
}
