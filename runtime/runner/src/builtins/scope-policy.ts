import type { Cell } from "../cell.ts";
import { createCell } from "../cell.ts";
import {
  factoryStateOf,
  isAdmittedFabricFactory,
  mapFactoryStateValues,
} from "@commonfabric/data-model/fabric-factory";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { CellScope, Pattern } from "../builder/types.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { RawNodeCause } from "../module.ts";
import { readMaybeLink, resolveLink } from "../link-resolution.ts";
import {
  ignoreReadForScheduling,
  linkResolutionProbe,
  machineryRead,
} from "../storage/reactivity-log.ts";
import { narrowestScope, scopeRank } from "../scope.ts";
import {
  createSigilLinkFromParsedLink,
  getMetaLink,
  isCellLink,
  parseLink,
} from "../link-utils.ts";
import { rawMetaWriteAuthorization } from "../meta-seam.ts";

export function resolvedCellScope(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cell: Cell<any>,
): CellScope {
  return resolveLink(runtime, tx, cell.getAsNormalizedFullLink()).scope;
}

export function scopedCell<T>(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cell: Cell<T>,
  scope: CellScope,
): Cell<T> {
  const link = cell.getAsNormalizedFullLink();
  if (link.scope === scope) {
    return cell;
  }
  return createCell<T>(runtime, { ...link, scope }, tx);
}

/**
 * The position-derived identity coordinates (`space`/`id`/`path`) of a node's
 * resolved output binding — the stable, program-independent cause that
 * map/filter/flatMap key their result container on (CT-1623). Deliberately
 * drops `scope`/`schema` so the identity stays scope-independent (a scoped vs
 * unscoped container at the same spot share one id; scope re-addresses the
 * instance, it does not fork identity).
 */
export function outputSpotFromBinding(
  binding: NormalizedFullLink | undefined,
): { space: string; id: string; path: readonly unknown[] } | undefined {
  if (!binding) return undefined;
  return { space: binding.space, id: binding.id, path: [...binding.path] };
}

/**
 * Returns an expression builtin's result-store cause from its operation,
 * owning piece, and output coordinates. The cause stays equal across changes
 * to the serialized inputs while the owning piece and output spot are
 * unchanged.
 *
 * Throws if the node's output binding has no write redirect.
 */
export function ownedResultCause(
  op: "ifElse" | "when" | "unless",
  cause: RawNodeCause,
  parentCell: Cell<any>,
): Record<string, unknown> {
  if (!cause.outputSpot) {
    throw new Error(
      `${op}: result store requires a write-redirect output binding`,
    );
  }
  return { [op]: parentCell.entityId, outputSpot: cause.outputSpot };
}

export function cellIdentityKey(cell: Cell<any>): {
  dedupKey: string;
  linkKey: readonly unknown[];
} {
  const { space, id, path, scope } = cell.getAsNormalizedFullLink();
  const linkKey = [space, id, scope, path] as const;
  return {
    dedupKey: JSON.stringify(linkKey),
    linkKey,
  };
}

export function narrowestCellScope(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cells: Iterable<Cell<any> | undefined>,
): CellScope {
  return narrowestScope(
    Array.from(
      cells,
      (cell) =>
        cell === undefined ? undefined : resolvedCellScope(runtime, tx, cell),
    ),
  );
}

/** Scope imposed by a canonical bound list callback's selected factory value. */
export function boundPatternFactoryScope(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  pattern: Pattern,
  sourceLink: NormalizedFullLink,
): CellScope {
  const scopes: Array<CellScope | undefined> = [
    resolvedCellScope(
      runtime,
      tx,
      runtime.getCellFromLink(sourceLink, undefined, tx),
    ),
  ];
  const seen = new Set<object>();

  const visit = (value: unknown, base: NormalizedFullLink): void => {
    if (value === null || value === undefined) return;
    if (isCellLink(value)) {
      const link = parseLink(value, base);
      if (link?.space !== undefined && link.id !== undefined) {
        scopes.push(resolveLink(runtime, tx, link as NormalizedFullLink).scope);
      }
      return;
    }
    if (isAdmittedFabricFactory(value)) {
      const key = value as unknown as object;
      if (seen.has(key)) return;
      seen.add(key);
      const state = factoryStateOf(value);
      if (state.kind !== "handler") scopes.push(state.defaultScope);
      mapFactoryStateValues(state, (nested) => {
        visit(nested, base);
        return nested;
      });
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const nested of value) visit(nested, base);
      return;
    }
    for (const nested of Object.values(value as Record<string, unknown>)) {
      visit(nested, base);
    }
  };

  if (isAdmittedFabricFactory(pattern)) {
    const state = factoryStateOf(pattern);
    if (state.kind !== "pattern") {
      throw new TypeError(
        "bound list callback must carry pattern factory state",
      );
    }
    scopes.push(state.defaultScope);
    if ("params" in state) visit(state.params, sourceLink);
  } else {
    scopes.push(pattern.defaultScope);
    visit(pattern, sourceLink);
  }
  return narrowestScope(scopes);
}

/**
 * If the cell contains a top level link, and its scope is narrower than the
 * cell's scope, create a copy of the cell.
 *
 * Copy over the value and the "result" meta link.
 */
export function exposedResultCell<T>(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cell: Cell<T>,
  minimumScope?: CellScope,
): Cell<T> {
  // Ideally, we'd just call getRaw on the cell, but since that may be a link,
  // we need to know the base to use to parse that link.
  // Coordinator scaffolding (machineryRead): the redirect resolution reads
  // link topology only and must not consume `*`-path membership templates
  // on plumbing containers (template-population §6). The value COPY below
  // stays unmarked — the exposed cell genuinely depends on it.
  const target = tx.runWithAmbientReadMeta(
    { ...ignoreReadForScheduling, ...machineryRead },
    () =>
      resolveLink(
        runtime,
        tx,
        cell.getAsNormalizedFullLink(),
        "writeRedirect",
      ),
  );
  const initialCell = cell.withTx(tx);
  // Resolve topology without reading a scalar result's content. Observing
  // the value here would subscribe the list coordinator to every child value.
  const link = tx.runWithAmbientReadMeta(
    {
      ...ignoreReadForScheduling,
      ...linkResolutionProbe,
      ...machineryRead,
    },
    () => readMaybeLink(tx, target) ?? target,
  );
  const exposedScope = narrowestScope([link.scope, minimumScope]);
  if (
    scopeRank(exposedScope) <= scopeRank(cell.getAsNormalizedFullLink().scope)
  ) {
    return cell;
  }

  const exposed = scopedCell(runtime, tx, cell, exposedScope);
  // Copy the value and result linkage into the new exposed cell
  const resultLink = getMetaLink(initialCell, "result");
  if (resultLink !== undefined) {
    exposed.setMetaRaw(
      "result",
      createSigilLinkFromParsedLink(resultLink, {
        base: exposed,
        includeSchema: true,
      }),
      rawMetaWriteAuthorization,
    );
  }
  const value = initialCell.get();
  if (value !== undefined) {
    exposed.withTx(tx).set(value);
  }
  return exposed;
}
