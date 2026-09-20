// Runtime Actions for the SQLite builtins.
//
// Wire the builder factories (sqliteDatabase / sqliteQuery) through the module
// registry to the server-side SQLite verbs over the storage provider (which
// routes the v2 protocol to the engine, real or emulated).
//
// - sqliteDatabase yields a SqliteDb handle cell whose value is the SqliteDbRef
//   ({ id, tables }); the id is the handle cell's own (causal, opaque) entity id.
// - sqliteQuery issues a server read after commit and writes { pending, result,
//   error } back; re-runs when its `reactOn`/inputs change (it is an effect).
//
// Writes are NOT here — they are the imperative `SqliteDb.exec` (cell.ts), which
// folds a `sqlite` op into the caller's commit (atomic with cell writes), and
// shares param encoding via `encodeSqliteParams` (cell.ts). See
// docs/specs/sqlite-builtin/plans/sqlitedb-cell-type-exploration.md.
//
// `_cf_link` result columns ARE decoded here when the transformer injects a
// `rowSchema` (asCell columns -> sigil objects; see decodeRowLinkColumns). The
// multi-tab write mutex is the handle-cell `rev` bump in db.exec (cell.ts), not
// this read path.

import type { CfcAtom } from "@commonfabric/api/cfc";
import { settleAbandonedRequest } from "./abandoned-request.ts";
import { resultRowKeys } from "./sqlite/row-identity.ts";
import {
  computeRowLabelRead,
  resolveCeilingPlaceholders,
} from "./sqlite/row-label-read.ts";
import type { Action } from "../scheduler.ts";
import type { RawBuiltinResult } from "../module.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { CellScope } from "../builder/types.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import { isCellScope, narrowestScope } from "../scope.ts";
import { computeInputHashFromValue } from "./fetch-utils.ts";
import {
  effectTargetKey,
  markEffectCompletion,
} from "../executor/effect-completion.ts";
import type { CfcReadOnExceed } from "../cfc/read-ceiling.ts";
import {
  requireWaveAcceptance,
  type WaveRunContext,
  waveRunContextOf,
  waveSettlementOf,
} from "../executor/wave.ts";
import { speculationRunContextOf } from "../speculation/overlay-destination.ts";
import { parseCfLinkToSigil } from "./sqlite/cf-link.ts";
import { type IFCLabel, mergeLabel } from "../cfc/label-view-core.ts";
import {
  joinCfcObservedConfidentiality,
  meetCfcObservationCeilings,
} from "../cfc/observation.ts";
import { writeDestinationRead } from "../storage/reactivity-log.ts";
import {
  cloneIfNecessary,
  fabricFromConvertibleJsValue,
  type FabricValue,
  valueEqual,
} from "@commonfabric/data-model";
import { validateRowLabelSpec } from "@commonfabric/memory/sqlite/row-label";
import {
  columnDeclaresIfc,
  isSqliteDbRef,
  resolveScopeKey,
  type SqliteDbRef as WireSqliteDbRef,
  type SqliteParamsWire,
  sqliteRowToWire,
} from "@commonfabric/memory/v2";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import { type Cell, createCell, encodeSqliteParams } from "../cell.ts";
import type { CfcConfClause } from "../cfc/clause.ts";
import { createRef } from "../create-ref.ts";
import { stripEntityUriScheme } from "../entity-kind.ts";
import { toURI } from "../uri-utils.ts";
// The wire shape (`id`, `tables`, `scope`, `owner`) is the memory protocol's
// own `SqliteDbRef`; only `rev` is added here.
type SqliteDbRef = WireSqliteDbRef & {
  // db.exec's optimistic-concurrency revision (bumped per write, cell.ts). A
  // handle re-derivation must carry it forward: deleting it changes the handle
  // value, which every consumer hashing the handle (e.g. sqliteQuery's
  // reactOn) sees as "new inputs".
  rev?: number;
};
type WireParams = SqliteParamsWire | undefined;

const errMsg = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The read ceiling a query issued on `tx` reads under: the runtime's own
 * `cfcReadMaxConfidentiality` met with the ceiling the run's session
 * carries (`WaveRunContext.readCeiling` — the client's declared ceiling,
 * stamped by the serving loop onto every run it serves as that session),
 * so a served run is bounded by the client that demanded it exactly as the
 * client's own run would be. The mode meets toward `fail`: either side
 * saying `fail` stands, else either side's `skip`; neither source can turn
 * the other's refusal into a release. Both absent is no ceiling.
 *
 * Exported for unit testing only — not part of the builtin surface.
 */
export function effectiveReadCeiling(
  runtime: Runtime,
  runContext: WaveRunContext | undefined,
): {
  maxConfidentiality: readonly CfcConfClause[] | undefined;
  onExceed: CfcReadOnExceed | undefined;
} {
  const carried = runContext?.readCeiling;
  if (carried === undefined) {
    return {
      maxConfidentiality: runtime.cfcReadMaxConfidentiality,
      onExceed: runtime.cfcReadOnExceed,
    };
  }
  const own = runtime.cfcReadOnExceed;
  return {
    maxConfidentiality: meetCfcObservationCeilings(
      runtime.cfcReadMaxConfidentiality,
      carried.maxConfidentiality,
    ),
    onExceed: own === "fail" || carried.onExceed === "fail"
      ? "fail"
      : (own ?? carried.onExceed),
  };
}

/**
 * The acting principal THIS run carries, for the sqlite builtins' identity
 * consumptions — the db-owner mint and the read-clearance reader (OW53).
 *
 * On a SERVED (wave-stamped) run the answer is the run-carried actor —
 * the event's stamped actor, else the demanded instance's principal —
 * never the serving runtime's ambient identity, which is the SERVICE
 * (serving-loop.md §3c; protocol.md §1: identity arrives WITH the work
 * and is "carried into keys, not resolved from ambient state"). A served
 * run that carries no actor answers undefined, and each consumption site
 * fails closed rather than falling back to the service DID (the
 * `homeSpacePrincipalFor` posture).
 *
 * On an UNSTAMPED run — every client run, ON-arm speculation included,
 * and the whole OFF arm — the ambient provider IS the acting user, so
 * the answer is byte-identical to the pre-OW53 direct provider read.
 *
 * Exported for unit testing only — not part of the builtin surface.
 */
export function sqliteRunActingPrincipal(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
): string | undefined {
  const context = waveRunContextOf(tx);
  if (context !== undefined) {
    // Tripwire (flag, don't fill): every context the stamper produces
    // today derives `acting` FROM the demanded pair where both exist
    // (LT6-inherited handlers, non-attributed derivations), so the two
    // can never disagree. A future carriage that split them would make
    // this helper's answer decide WHOSE rows a cleared read admits and
    // WHOSE partition the completion lands in — an identity-model
    // decision nobody has made — so fail loud instead of picking one.
    if (
      context.acting?.user !== undefined &&
      context.scopeKeyIdentity?.principal !== undefined &&
      context.acting.user !== context.scopeKeyIdentity.principal
    ) {
      throw new Error(
        "sqlite identity consumption: the run's stamped acting " +
          `(${context.acting.user}) and demanded principal ` +
          `(${context.scopeKeyIdentity.principal}) diverge — no ruling ` +
          "says which one owns a db mint or clears a read " +
          "(verification-coverage.md OW53); refusing to guess",
      );
    }
    return context.acting?.user ?? context.scopeKeyIdentity?.principal;
  }
  return runtime.trustSnapshotProvider()?.actingPrincipal;
}

/** Allocate a result cell linked to the parent/pattern cells, at `scope` (the
 *  author-declared scope of the SqliteDb / its query result). The base entity
 *  id is scope-independent; `scope` only re-addresses which scoped instance the
 *  value lands in, matching how the server partitions the on-disk db. */
function makeResultCell<T>(
  runtime: Runtime,
  parentCell: Cell<any>,
  cause: unknown,
  label: string,
  tx: IExtendedStorageTransaction,
  scope: CellScope = "space",
): Cell<T> {
  const base = runtime.getCell<T>(
    parentCell.space,
    { [label]: { result: cause } },
    undefined,
    tx,
  );
  const link = base.getAsNormalizedFullLink();
  const cell = createCell<T>(
    runtime,
    link.scope === scope ? link : { ...link, scope },
    tx,
  );
  setResultCell(cell, parentCell);
  setPatternCell(cell, parentCell.key("pattern"));
  cell.sync();
  return cell as Cell<T>;
}

function readDbRef(value: unknown): SqliteDbRef {
  if (isSqliteDbRef(value)) {
    const ref = value as SqliteDbRef;
    return {
      id: ref.id,
      // Materialize to plain JSON: sqliteDatabase stores the handle value
      // inline (self-contained), but a handle written before that fix (or a
      // proxy-carried read) can still hold doc LINKS where the rule's AST
      // nodes should be — the wire (server provenance gate) and every local
      // consumer need the resolved spec.
      tables: ref.tables
        ? cloneIfNecessary(
          ref.tables as Parameters<typeof cloneIfNecessary>[0],
          { frozen: false },
        ) as SqliteDbRef["tables"]
        : undefined,
      // Validate at the boundary: an invalid scope value must not flow into
      // query execution / on-disk filename derivation.
      scope: isCellScope(ref.scope) ? ref.scope : undefined,
      owner: typeof ref.owner === "string" ? ref.owner : undefined,
    };
  }
  throw new TypeError("sqlite: invalid database handle");
}

/**
 * Whether a materialized `tables` value is fully RESOLVED in this runtime — no
 * table (or rule) read through a not-yet-loaded linked doc. A rowLabel rule's
 * term LIST (array of objects) splits into per-element entity docs wherever it
 * passes through a builder-frame write (e.g. pattern static data), and no
 * schema-driven sync loads those splits, so a runtime that merely LOADED the
 * pattern can deep-resolve them to `null` (the #3830 class). Materializing
 * that read would bake `allOf: [null]` into the handle — a different value
 * (and request hash) than the creator wrote. Validation is the resolution
 * probe: a resolved rule always validates; a null-riddled one never does.
 */
function dbTablesResolved(
  tables: SqliteDbRef["tables"],
): boolean {
  if (tables === undefined) return true;
  for (const t of Object.values(tables)) {
    if (!t || typeof t !== "object") return false; // an unresolved table doc
    const spec = (t as { rowLabel?: unknown }).rowLabel;
    if (spec === undefined) continue;
    const columns = Object.keys(
      (t as { properties?: Record<string, unknown> }).properties ?? {},
    );
    if (validateRowLabelSpec(spec, columns) !== undefined) return false;
  }
  return true;
}

/** Union of the per-column (Phase 2) confidentiality atoms a labeled result
 *  schema attaches — they ride every row, so a declared output ceiling must
 *  admit them too. */
function staticConfidentialityOf(
  labelSchema: Record<string, unknown> | undefined,
): CfcConfClause[] {
  const props = (labelSchema as {
    properties?: {
      result?: { items?: { properties?: Record<string, unknown> } };
    };
  })?.properties?.result?.items?.properties;
  if (!props) return [];
  const out: CfcConfClause[] = [];
  for (const p of Object.values(props)) {
    const conf = (p as { ifc?: { confidentiality?: CfcConfClause[] } })?.ifc
      ?.confidentiality;
    if (Array.isArray(conf)) out.push(...conf);
  }
  return out;
}

/**
 * Result columns to decode from a sigil-link STRING to a sigil-link OBJECT: the
 * keys the transformer-injected `rowSchema` marks `asCell`. A consumer reading
 * `q.result[i].<col>` under its own `<Row>` schema (Cell<T> -> asCell) then
 * rehydrates the object to a live Cell (link-resolution only recognizes link
 * OBJECTS, not JSON strings). Untyped queries inject no rowSchema -> no decode
 * (the column reads back as the raw sigil string; see sqlite-cf-link-decode.test).
 */
function asCellColumnsFromRowSchema(rowSchema: unknown): string[] {
  if (!rowSchema || typeof rowSchema !== "object") return [];
  const props = (rowSchema as { properties?: Record<string, unknown> })
    .properties;
  if (!props || typeof props !== "object") return [];
  return Object.entries(props)
    .filter(([, v]) =>
      !!v && typeof v === "object" &&
      Array.isArray((v as { asCell?: unknown }).asCell)
    )
    .map(([k]) => k);
}

/** Replace each asCell column's stored sigil-link STRING with the parsed sigil
 *  OBJECT. A value that is not a decodable link is left as-is (the asCell read
 *  then yields undefined rather than crashing the whole query). */
function decodeRowLinkColumns(
  rows: readonly unknown[],
  cols: readonly string[],
): unknown[] {
  if (cols.length === 0) return rows as unknown[];
  return rows.map((row) => {
    if (!row || typeof row !== "object") return row;
    const r = row as Record<string, unknown>;
    // Copy lazily: only allocate a new row object once a link column actually
    // decodes to a different value. Rows with no link columns (or only
    // null/non-link values) are returned as-is — no per-row spread on the
    // reactive read path.
    let out: Record<string, unknown> | undefined;
    for (const c of cols) {
      if (!(c in r)) continue;
      let decoded: unknown;
      try {
        decoded = parseCfLinkToSigil(r[c]);
      } catch {
        continue; // Leave a non-link value untouched.
      }
      if (decoded === r[c]) continue; // e.g. null -> null: nothing to change.
      out ??= { ...r };
      out[c] = decoded;
    }
    return out ?? row;
  });
}

interface ResultColumn {
  output: string;
  table: string | null;
  column: string | null;
}

type LabelTables =
  | Record<string, { properties?: Record<string, { ifc?: unknown }> }>
  | undefined;

/**
 * Conservative `ifc` for a result column with NO single source (`null` origin —
 * an expression, literal, or aggregate like `COUNT(*)`/`upper(x)`). We can't
 * cheaply know which columns such a value derives from, so it inherits the
 * combined label of EVERY declared labeled column in the db schema, merged with
 * the runtime's own `mergeLabel` (union of confidentiality AND integrity — the
 * same accumulation the runtime uses everywhere). A sound over-approximation:
 * never under-labels, at the cost of possible over-restriction (we bound by the
 * whole schema rather than parsing the query's FROM tables). `mergeLabel` reads
 * only the label-bearing keys, so a column's `maxConfidentiality` is ignored,
 * and it returns fresh arrays (no frozen-proxy aliasing). Returns undefined when
 * the db declares no confidentiality/integrity at all.
 */
function deriveNullOriginIfc(
  tables: LabelTables,
): (IFCLabel & { observes?: "value" }) | undefined {
  let merged: IFCLabel = {};
  for (const table of Object.values(tables ?? {})) {
    for (const col of Object.values(table?.properties ?? {})) {
      const ifc = (col as { ifc?: IFCLabel })?.ifc;
      if (ifc && typeof ifc === "object") merged = mergeLabel(merged, ifc);
    }
  }
  // Confidentiality unions across contributors (a sound over-approximation: the
  // aggregate could depend on any column). Integrity does NOT: an aggregate /
  // expression / literal is a new computed value and inherits no integrity
  // evidence. Unioning integrity would let it falsely claim an atom held by a
  // single column (§8.17.1: class-aware meet, never union; propagation classes
  // pending, so conservatively empty). [CT-1668]
  //
  // C5 (observation classes): the merge is declared `observes:"value"` — an
  // expression/aggregate computed FROM column values labels the result
  // column's CONTENT channel. Shape/enumerate consumers of the result rows
  // (length, membership — a COUNT consumer counting result rows) no longer
  // inherit the whole-schema content union; the declared entry the result
  // schema mints carries the class through (prepare.ts
  // `declaredObservesClass`). Row membership itself stays governed by the
  // per-row rule machinery (row-label-read.ts), not by column content
  // labels. Class-unaware readers treat the entry as covering — the exact
  // pre-C5 behavior.
  return merged.confidentiality?.length
    ? { confidentiality: merged.confidentiality, observes: "value" }
    : undefined;
}

type ColumnIfc = {
  confidentiality?: CfcConfClause[];
  integrity?: CfcAtom[];
  maxConfidentiality?: CfcConfClause[];
};

const unionAtoms = (
  a: CfcConfClause[] | undefined,
  b: CfcConfClause[] | undefined,
): CfcConfClause[] | undefined => {
  const out: CfcConfClause[] = [...(a ?? [])];
  for (const atom of b ?? []) {
    if (!out.some((existing) => deepEqual(existing, atom))) out.push(atom);
  }
  return out.length > 0 ? out : undefined;
};

// A write ceiling (`maxConfidentiality`) tightens only: absent = unlimited, so a
// present ceiling beats absent, and two present ceilings meet at their
// intersection (the smaller allowed set). It can never widen or be removed.
// An EMPTY intersection stays `[]`, which the verifier reads as "public only"
// (the tightest ceiling) — collapsing it to undefined would forge "no ceiling".
const tightenCeiling = (
  prior: CfcConfClause[] | undefined,
  next: CfcConfClause[] | undefined,
): CfcConfClause[] | undefined => {
  if (prior === undefined) return next;
  if (next === undefined) return prior;
  return prior.filter((atom) => next.some((n) => deepEqual(n, atom)));
};

// Integrity atoms are trust/provenance claims, NOT a confidentiality grade: a
// row read from a column carries them to satisfy downstream `requiredIntegrity`
// gates. So a re-derivation may keep or NARROW a column's integrity but must
// never MINT trust the prior store didn't already carry — unioning would let a
// re-declared `integrity: ["b"]` forge a claim the column was never trusted for
// (mirrors schema-merge.ts, where integrity is subset-clamped like the ceiling).
// Identical to `tightenCeiling` EXCEPT the prior-absent case yields undefined
// (no prior trust to inherit) rather than adopting `next` wholesale.
const clampIntegrity = (
  prior: CfcAtom[] | undefined,
  next: CfcAtom[] | undefined,
): CfcAtom[] | undefined => {
  if (prior === undefined) return undefined;
  if (next === undefined) return prior;
  const kept = prior.filter((atom) => next.some((n) => deepEqual(n, atom)));
  return kept.length > 0 ? kept : undefined;
};

const mergeColumnIfcGrowOnly = (
  prior: ColumnIfc,
  next: ColumnIfc | undefined,
): ColumnIfc => {
  const n = next ?? {};
  const merged: ColumnIfc = {};
  const confidentiality = unionAtoms(prior.confidentiality, n.confidentiality);
  const integrity = clampIntegrity(prior.integrity, n.integrity);
  const maxConfidentiality = tightenCeiling(
    prior.maxConfidentiality,
    n.maxConfidentiality,
  );
  if (confidentiality) merged.confidentiality = confidentiality;
  if (integrity) merged.integrity = integrity;
  if (maxConfidentiality) merged.maxConfidentiality = maxConfidentiality;
  return merged;
};

/**
 * Grow-only merge of a db handle's per-column `ifc` across re-derivations
 * (§8.12.1: a store's effective label is monotone — it may strengthen but never
 * weaken). `tables[].ifc` lives in mutable handle-cell value data, outside the
 * schema-envelope monotonicity the labelMap enforces, so a re-derivation reading
 * a weaker input could silently lower a column's read label or widen its write
 * ceiling (audit S8). Every column the PRIOR handle labeled keeps at least that
 * label: read confidentiality/integrity union (grow); the write ceiling tightens
 * only; a dropped table/column is restored. New tables/columns in `next` are
 * additive and pass through (a fresh column or a stricter re-declaration is
 * allowed — only weakening is clamped).
 */
export const growOnlyMergeDbTables = (
  prior: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!prior) return next;
  if (!next) return prior;
  const result = cloneIfNecessary(
    next as Parameters<typeof cloneIfNecessary>[0],
    { frozen: false },
  ) as Record<string, unknown>;
  for (const [tableName, priorTableRaw] of Object.entries(prior)) {
    const priorProps =
      (priorTableRaw as { properties?: Record<string, unknown> } | undefined)
        ?.properties;
    if (!priorProps || typeof priorProps !== "object") continue;
    const resultTable = result[tableName] as
      | { properties?: Record<string, unknown> }
      | undefined;
    if (!resultTable || typeof resultTable !== "object") {
      // Prior declared a table that `next` dropped — restore it wholesale.
      result[tableName] = cloneIfNecessary(
        priorTableRaw as Parameters<typeof cloneIfNecessary>[0],
        { frozen: false },
      );
      continue;
    }
    const resultProps = (resultTable.properties ??= {}) as Record<
      string,
      { ifc?: ColumnIfc }
    >;
    for (const [colName, priorColRaw] of Object.entries(priorProps)) {
      const priorIfc = (priorColRaw as { ifc?: ColumnIfc } | undefined)?.ifc;
      if (!columnDeclaresIfc(priorIfc)) continue;
      const resultCol = resultProps[colName] as { ifc?: ColumnIfc } | undefined;
      if (!resultCol || typeof resultCol !== "object") {
        // Prior labeled a column that `next` dropped — restore it wholesale so
        // its non-ifc structure (e.g. `type`) survives alongside the label.
        resultProps[colName] = cloneIfNecessary(
          priorColRaw as Parameters<typeof cloneIfNecessary>[0],
          { frozen: false },
        ) as { ifc?: ColumnIfc };
        continue;
      }
      resultCol.ifc = mergeColumnIfcGrowOnly(
        priorIfc as ColumnIfc,
        resultCol.ifc,
      );
    }
  }
  return result;
};

/**
 * CFC read-labeling: from each result column's TRUE origin (table, column),
 * build a schema for the result-cell's `result` array whose per-field `ifc`
 * carries the origin column's declared confidentiality — so a consumer reading
 * `q.result[i].<col>` inherits it (re-establishing label propagation across the
 * opaque SQLite boundary).
 *
 * A `null`-origin column (expression/literal/aggregate) does NOT refuse the
 * query; it inherits the conservative join/meet of the db's labeled columns
 * (see `deriveNullOriginIfc`). The query IS refused (`{ error }`) only when two
 * columns project to the SAME output name, which would make the per-row label
 * ambiguous. Returns `{ schema }` (possibly undefined when nothing is labeled).
 */
export function labelResultSchema(
  columns: readonly ResultColumn[],
  tables: LabelTables,
): { schema?: Record<string, unknown>; error?: string } {
  const itemProps: Record<string, unknown> = {};
  const seen = new Set<string>();
  let anyLabeled = false;
  for (const c of columns) {
    // Duplicate output names make per-field labeling ambiguous: the row object
    // keeps only the last value for that key, but a label set on an earlier
    // iteration could track a DIFFERENT source column. Refuse rather than
    // mis-attribute.
    if (seen.has(c.output)) {
      return {
        error:
          `sqlite: a CFC-labeled query cannot project two columns to the same ` +
          `output name ("${c.output}") — the per-row label would be ambiguous; ` +
          `alias them to distinct names`,
      };
    }
    seen.add(c.output);

    if (c.table === null || c.column === null) {
      // No single source → conservative join/meet of the db's labeled columns.
      const derived = deriveNullOriginIfc(tables);
      if (derived) {
        Object.defineProperty(itemProps, c.output, {
          value: { ifc: derived },
          enumerable: true,
          configurable: true,
          writable: true,
        });
        anyLabeled = true;
      }
      continue;
    }
    const ifc = tables?.[c.table]?.properties?.[c.column]?.ifc;
    if (columnDeclaresIfc(ifc)) {
      // Deep-clone to a fully extensible copy: the `ifc` read off `db.tables` is
      // part of a deep-frozen cell value exposed through a proxy, so embedding it
      // by reference makes the schema-policy walk proxy a non-extensible object
      // ("ownKeys … non-extensible"). `cloneIfNecessary(_, { frozen: false })`
      // reads through the proxy and returns plain, mutable data.
      Object.defineProperty(itemProps, c.output, {
        value: {
          ifc: cloneIfNecessary(
            ifc as Parameters<typeof cloneIfNecessary>[0],
            { frozen: false },
          ),
        },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      anyLabeled = true;
    }
  }
  if (!anyLabeled) return {};
  // `additionalProperties: true` at BOTH object levels so the write preserves
  // every field it isn't labeling — the QueryState siblings (`pending`,
  // `requestHash`, `error`) and every unlabeled result column — while the
  // declared columns carry their `ifc`. A partial schema would otherwise shape
  // those away.
  return {
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        result: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            properties: itemProps,
          },
        },
      },
    },
  };
}

/** Schema for one SQLite row after unsafe column names have selected the
 * entry-list wire representation. Column labels move from object properties to
 * each entry tuple's value slot; ordinary rows keep their object schema. */
function sqliteWireRowSchema(
  row: unknown,
  objectSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!Array.isArray(row)) {
    return objectSchema ?? {
      type: "object",
      additionalProperties: true,
    };
  }
  const properties = objectSchema?.properties as
    | Record<string, unknown>
    | undefined;
  return {
    type: "array",
    prefixItems: (row as Array<[string, unknown]>).map(([name]) => ({
      type: "array",
      prefixItems: [
        { type: "string" },
        Object.getOwnPropertyDescriptor(properties ?? {}, name)?.value ?? true,
      ],
      items: false,
    })),
    items: false,
  };
}

/** sqliteDatabase: yields an opaque handle cell whose value is the SqliteDbRef. */
export function sqliteDatabase(
  inputsCell: Cell<any>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
  outputBinding?: NormalizedFullLink,
): RawBuiltinResult {
  const initialized = new Set<string>();
  const action: Action = (tx: IExtendedStorageTransaction) => {
    const scope = outputBinding?.scope ?? "space";
    const instance = resolveScopeKey(
      scope,
      waveRunContextOf(tx)?.scopeKeyIdentity ?? runtime.scopeKeyIdentity,
    );
    if (!initialized.has(instance)) {
      // The db's scope is the scope the author declared on the result cell
      // (`PerUser<SqliteDb>` / `.asScope("user")`), carried on the resolved
      // output binding. The server uses it to derive a per-user / per-session
      // on-disk filename; the handle cell itself must live at that scope so its
      // value is partitioned the same way.
      const handle = makeResultCell<SqliteDbRef>(
        runtime,
        parentCell,
        cause,
        "sqliteDatabase",
        tx,
        scope,
      );
      const options = inputsCell.withTx(tx).get() as
        | { tables?: SqliteDbRef["tables"] }
        | undefined;
      // `handle` is a builtin RESULT cell (makeResultCell), and result cells
      // are always `of:`-schemed — the computed kind applies only to derived
      // internal cells — so stripping the entity scheme yields the handle's
      // stable, historical key form. Deriving from the scheme-preserving
      // sourceURI through the canonical helper keeps that assumption
      // explicit and in one place.
      const id = (typeof handle.sourceURI === "string"
        ? stripEntityUriScheme(handle.sourceURI)
        : undefined) ?? JSON.stringify(handle.getAsLink());
      // Grow-only merge the per-column `ifc` against any prior committed handle
      // value at this (causally-stable) id: the store's effective label is
      // monotone, so a re-derivation reading a weaker `tables` input cannot lower
      // a column's read label or widen its write ceiling (audit S8). First
      // creation (no prior) passes the declared tables through unchanged.
      const prior = handle.withTx(tx).get() as SqliteDbRef | undefined;
      const merged = growOnlyMergeDbTables(prior?.tables, options?.tables);
      // The db's owner: the principal creating this handle (CFC Phase 3 —
      // resolves the row rule's dbOwner(); a FIXED property of the db, not
      // the acting reader). Minted ONLY when there is no prior committed
      // handle: this init re-runs in every runtime that opens the piece (the
      // `initialized` guard is per scoped instance), and re-minting would
      // rotate ownership to the last opener — dbOwner() row rules and
      // {__ctDbOwner} ceiling placeholders would then admit the wrong
      // principal. An ownerless prior handle stays ownerless (dbOwner()
      // fails closed) rather than adopting a later opener.
      //
      // "The principal creating this handle" is the acting principal of
      // the CREATING RUN (06-cfc.md's dbOwner row read under
      // serving-loop.md §3c): on a served creation that is the demanded
      // run's carried principal — the runtime-ambient provider there is
      // the SERVICE, and minting it would grant the service dbOwner()
      // row admission (OW53). A served creating run with no carried
      // actor mints NO owner — fail closed, like the OW31 genesis arm —
      // never the service DID.
      const owner = prior !== undefined
        ? prior.owner
        : sqliteRunActingPrincipal(runtime, tx);
      // Materialize to plain JSON: the stored handle must be SELF-CONTAINED.
      // A raw `set` of the inputs proxy would capture `tables` as a LINK into
      // this pattern's doc graph — whose rule-term splits no schema-driven
      // sync loads — so a second runtime deep-resolves parts of it to null and
      // hashes a DIFFERENT request for the same shared query cell: each
      // runtime sees the other's hash as "new inputs" and re-issues forever.
      // Inline, every runtime that can read the handle doc has the full spec.
      const tables = merged !== undefined
        ? cloneIfNecessary(
          merged as Parameters<typeof cloneIfNecessary>[0],
          { frozen: false },
        ) as SqliteDbRef["tables"]
        : undefined;
      // Fail closed on an UNRESOLVED materialization (this runtime loaded the
      // pattern but not every linked doc under `tables`): writing it would
      // bake nulls over a good prior value. The prior handle stays; a runtime
      // that resolves fully (the creator, at least) writes the inline form.
      if (prior === undefined || dbTablesResolved(tables)) {
        // RAW write, not `.set()`: this first action run can execute inside
        // the pattern's builder frame, where `set` anchors every object
        // in an array — splitting a rule's term list into per-element entity
        // docs (the very shape the materialization above exists to avoid).
        // The raw write stores the subtree verbatim; `onlyIfDifferent` keeps
        // an unchanged re-derivation write-free (no hash churn per runtime).
        handle.withTx(tx).setRawUntyped(
          fabricFromConvertibleJsValue({
            id,
            ...(tables !== undefined && { tables }),
            scope,
            ...(owner !== undefined && { owner }),
            // Carry db.exec's write revision forward — dropping it would make
            // this re-derivation look like "new inputs" to every handle hasher.
            ...(typeof prior?.rev === "number" && { rev: prior.rev }),
          }),
          true,
        );
      }
      sendResult(tx, handle);
      // The scheduler retries this same action closure after a stale-basis
      // rejection. In a serving runtime, a successful transaction commit only
      // seals the write into its wave; the wave can still withdraw it. Advance
      // the one-shot guard only when the handle is durable at the destination.
      // Failed older attempts never reset it, so a later durable attempt wins.
      tx.addCommitCallback((settledTx, result) => {
        if (result.error) {
          return;
        }
        const waveSettlement = waveSettlementOf(settledTx);
        if (waveSettlement === undefined) {
          initialized.add(instance);
          return;
        }
        void waveSettlement.then((waveResult) => {
          if (!waveResult.error) {
            initialized.add(instance);
          }
        });
      });
    }
  };
  return { action };
}

type QueryState = {
  pending: boolean;
  result?: unknown[];
  error?: unknown;
  requestHash?: string;

  /** CFC Phase 3.b read-time clearance audit: how many rows the acting reader
   *  could not read were withheld (a declared existence release). Absent when
   *  no clearance was requested. */
  withheld?: number;
};

/**
 * The memo decision for one sqliteQuery evaluation against the COMMITTED
 * result state (server-execution v2 stage G, serving-loop.md §4 — the
 * one effectful builtin whose memo KEY commits AHEAD of its result: the
 * claim marker `{pending: true, requestHash}` rides the requesting
 * run's own commit, so a dropped effect leaves a durable claim with no
 * result behind it).
 *
 * - `"hit"`: the stored key matches AND a result/error landed — the
 *   stored result IS the value (§4's hit rule; a bare claim is NOT a
 *   hit).
 * - `"dedupe"`: a pending claim for this key stands and either this node
 *   instance has the RPC in flight or the run is speculative. A speculative
 *   derivation drops SQLite effects, so it cannot own or recover a query.
 * - `"issue"`: no stored key for this hash — or a pending claim with no
 *   in-flight work in this process. Another runtime may still own the claim,
 *   but re-issuing a read is side-effect-free and hash-guarded completion
 *   makes the overlap safe.
 *
 * Exported for unit testing only — not part of the builtin surface.
 */
export function sqliteQueryMemoDecision(options: {
  stored: { pending?: boolean; requestHash?: string } | undefined;
  hash: string;

  /** This node instance holds the RPC in flight right now. */
  inFlightHere: boolean;

  /** The evaluation belongs to a client speculation overlay. */
  speculativeRun: boolean;
}): "hit" | "dedupe" | "issue" {
  if (options.stored?.requestHash !== options.hash) return "issue";
  if (options.stored.pending !== true) return "hit";
  if (options.inFlightHere || options.speculativeRun) return "dedupe";
  return "issue";
}

/** sqliteQuery: reactive server-side read. */
export function sqliteQuery(
  inputsCell: Cell<any>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
  outputBinding?: NormalizedFullLink,
  _awaitSync?: boolean,
  publicationBinding?: NormalizedFullLink,
): RawBuiltinResult {
  let initialized = false;
  let selectedResult: Cell<QueryState>;
  let resultScope: CellScope | undefined;

  /** Resolved request targets with an outstanding RPC. */
  const inFlightIssues = new Set<string>();

  /** Pending publications, partitioned by result and physical binding instance. */
  const stagings = new Map<
    string,
    Map<string, {
      sequence: number;
      target: string;
      fieldsSelected: boolean;
      release: () => void;
    }>
  >();
  let sequence = 0;

  const action: Action = (tx: IExtendedStorageTransaction) => {
    const inputs = inputsCell.withTx(tx).get() as {
      db?: unknown;
      sql?: string;
      params?: WireParams;
      reactOn?: unknown;
      // Transformer-injected from `db.query<Row>` / `sqliteQuery<Row>`; absent
      // for untyped queries.
      rowSchema?: unknown;
      // CFC Phase 3: declared output ceiling + what to do when a row's label
      // exceeds it ("fail" default | "skip"). The typed alternative is
      // MaxConfidentiality<> on the Row schema (rowSchema.ifc).
      maxConfidentiality?: CfcConfClause[];
      onExceed?: unknown;
      // CFC Phase 3.b: opt into read-time clearance — filter rows to those the
      // acting reader may read (a declared existence release). Requires the
      // touched rule-bearing table to permit it (rowLabelReadClearance).
      readClearance?: unknown;
    } | undefined;

    // The query result holds rows from a scope-partitioned db, so it must be at
    // least as narrow as the db's scope; also honor any scope declared on the
    // query result binding itself. The db's scope rides on its handle value.
    const dbScope = (inputs?.db && typeof inputs.db === "object" &&
        typeof (inputs.db as SqliteDbRef).id === "string")
      ? (inputs.db as SqliteDbRef).scope
      : undefined;
    // CFC Phase 3.b: a read-time-clearance result is filtered to the ACTING
    // READER, so it must never be shared across readers. Force it to (at least)
    // per-`user` scope so each reader gets an isolated result cell — otherwise a
    // space-scoped result cell would let one reader observe another's filtered
    // rows (the shared cell + reader-independent request hash both leak).
    const clearanceScope: CellScope | undefined = inputs?.readClearance
      ? "user"
      : undefined;
    const databaseSpace = inputsCell.withTx(tx).key("db").resolveAsCell().space;
    const crossSpace = databaseSpace !== parentCell.space;
    const scope = narrowestScope([
      outputBinding?.scope,
      dbScope,
      clearanceScope,
      crossSpace ? "user" : undefined,
    ]);

    const runContext = waveRunContextOf(tx);
    const servedRun = runContext !== undefined;
    const runIdentity = runContext?.scopeKeyIdentity;
    // A shared result has one materialization, independent of the observing
    // runtime. Session results can filter at the query; shared results retain
    // all rows admitted by the query contract and are guarded on cell reads.
    const readCeiling = scope === "session"
      ? effectiveReadCeiling(runtime, runContext)
      : { maxConfidentiality: undefined, onExceed: undefined };
    if (
      crossSpace && servedRun &&
      (!runIdentity?.principal ||
        (scope === "session" && !runIdentity.sessionId))
    ) {
      throw new Error(
        "sqlite: cross-space served queries require a complete scoped reader identity",
      );
    }
    const needsPublication = !initialized || resultScope !== scope;
    if (needsPublication) {
      selectedResult = makeResultCell<QueryState>(
        runtime,
        parentCell,
        cause,
        "sqliteQuery",
        tx,
        scope,
      );
      initialized = true;
      resultScope = scope;
    }

    const result = selectedResult;
    const instanceKey = effectTargetKey(
      "sqliteQuery:staging",
      result,
      runIdentity,
    );
    const bindingKey = publicationBinding
      ? resolveScopeKey(
        publicationBinding.scope ?? "space",
        runIdentity ?? runtime.scopeKeyIdentity,
      )
      : "legacy-callback";
    let pending = stagings.get(instanceKey);
    if (!pending) stagings.set(instanceKey, pending = new Map());
    const releaseStaging = () => {
      if (pending.get(bindingKey) === staging) pending.delete(bindingKey);
      if (pending.size === 0 && stagings.get(instanceKey) === pending) {
        stagings.delete(instanceKey);
      }
    };
    const staging = {
      sequence: ++sequence,
      target: effectTargetKey("publication", result),
      fieldsSelected: true,
      release: releaseStaging,
    };
    pending.set(bindingKey, staging);
    const ownsAnnouncement = () =>
      stagings.get(instanceKey)?.get(bindingKey) === staging;
    const onAcceptance = (
      publicationTx: IExtendedStorageTransaction,
      accepted: () => void,
      rejected?: () => void,
    ) => {
      if (servedRun) requireWaveAcceptance(publicationTx);
      publicationTx.addCommitCallback((committedTx, outcome) => {
        if (outcome.error) return rejected?.();
        const settlement = waveSettlementOf(committedTx) ??
          waveSettlementOf(publicationTx);
        if (settlement) {
          settlement.then((verdict) => {
            if (!verdict.error) accepted();
            else rejected?.();
          });
        } else accepted();
      });
    };
    const recordPublication = (publicationTx: IExtendedStorageTransaction) => {
      onAcceptance(publicationTx, () => {
        for (const other of stagings.values()) {
          const previous = other.get(bindingKey);
          if (
            previous && previous.sequence < staging.sequence &&
            previous.target !== staging.target
          ) {
            previous.release();
          }
        }
      });
    };
    let requestStaged = false;
    onAcceptance(tx, () => {
      for (const previous of stagings.get(instanceKey)?.values() ?? []) {
        if (previous.sequence < staging.sequence) {
          previous.fieldsSelected = false;
        }
      }
      releaseStaging();
    }, () => {
      if (!requestStaged) releaseStaging();
    });
    if (servedRun || needsPublication) {
      sendResult(tx, result);
      recordPublication(tx);
    }

    if (!inputs?.db || typeof inputs.sql !== "string") return;

    // A `db` that does not read back as a handle reaches the result cell as
    // this query's error, on the same terms as an unencodable parameter
    // below. The guard above admits any truthy value, and an object read
    // that resolved to nothing is `{}` — truthy, and not a handle — so the
    // throw would otherwise leave the action dead and the query pending for
    // good, with no later reactive pass to recover it once the handle reads.
    let db: SqliteDbRef;
    try {
      db = readDbRef(inputs.db);
    } catch (error) {
      result.withTx(tx).set({ pending: false, error: errMsg(error) });
      return;
    }
    const linkCols = asCellColumnsFromRowSchema(inputs.rowSchema);
    let params: WireParams;
    try {
      params = encodeSqliteParams(inputs.sql, inputs.params);
    } catch (error) {
      result.withTx(tx).set({ pending: false, error: errMsg(error) });
      return;
    }
    // The acting reader of THIS run (OW53): the run-carried principal on a
    // served run, the ambient provider (= the user) on a client. Captured
    // here — with the run's instance identity — for the flush below: the
    // flush runs OUTSIDE the run, on transactions of its own, where the
    // ambient identity is the SERVICE on a serving runtime.
    const actingReader = sqliteRunActingPrincipal(runtime, tx);
    // Cleared memo identity matches the result's granularity: the reader
    // principal for user scope, and the reader/session pair for session scope.
    // Outbox identity additionally resolves the result target's scope instance.
    // Row admission remains a principal decision at both granularities.
    const clearanceSession = inputs.readClearance && scope === "session"
      ? runIdentity?.sessionId
      : undefined;
    const hash = computeInputHashFromValue({
      databaseSpace,
      reader: crossSpace ? (actingReader ?? null) : null,
      readerSession: crossSpace && scope === "session"
        ? (runIdentity?.sessionId ?? null)
        : null,
      db,
      sql: inputs.sql,
      params: params ?? null,
      reactOn: inputs.reactOn ?? null,
      // Shared materializations include their shape-label contract in the
      // identity so a memo without that protection cannot stand as a hit.
      ...(scope !== "session" ? { sharedResultLabelVersion: 1 } : {}),
      // Phase 3 read-surface options join the request identity so changing
      // them re-issues the query (pre-existing queries re-hash once — benign).
      maxConfidentiality: inputs.maxConfidentiality ?? null,
      onExceed: inputs.onExceed ?? null,
      readClearance: inputs.readClearance ?? null,
      // Phase 3.b: a cleared result depends on WHO is asking, so the acting
      // reader is part of the query identity (belt-and-suspenders with the
      // per-user result scope above — a cleared result is never keyed only by
      // the boolean; builtins.md §2: the reader principal is part of the
      // memo key). At session granularity the reader component ALSO carries
      // the run's session (RULED 2026-08-22 — see `clearanceSession` above);
      // row admission stays a USER-principal question either way. Absent for
      // non-clearance queries so they do not re-hash.
      clearanceReader: inputs.readClearance
        ? (clearanceSession !== undefined
          ? { user: actingReader ?? null, session: clearanceSession }
          : (actingReader ?? null))
        : null,
      // The run's ceiling joins the request identity too — the runtime's
      // own met with the one the run's session carries: a settled result
      // is only a hit for a run reading under the same ceiling. Absent for
      // a run without one, so such a run's queries do not re-hash.
      ...(readCeiling.maxConfidentiality !== undefined
        ? {
          runtimeReadCeiling: readCeiling.maxConfidentiality,
          runtimeReadOnExceed: readCeiling.onExceed ?? null,
        }
        : {}),
    });
    // Dedup against COMMITTED state (and, stage G, against this node's
    // own in-flight RPC): the claim marker commits with the REQUESTING
    // run, so it survives an abort+retry — but under the serving
    // posture a dropped effect leaves it orphaned, and only re-issuing
    // heals that (sqliteQueryMemoDecision above; serving-loop.md §4,
    // §6 step 3).
    // The claim as it stands before this request writes its own, for the
    // abandonment ending below to compare against.
    const effectKey = effectTargetKey(
      `sqliteQuery:${hash}`,
      result,
      runIdentity,
    );
    // The destination snapshot decides whether an abandoned publication may
    // replace this exact record. Its values never enter the query or an output.
    const storedBeforeClaim = result.withTx(tx).getRaw({
      meta: writeDestinationRead,
    }) as QueryState | undefined;
    const decision = sqliteQueryMemoDecision({
      stored: storedBeforeClaim,
      hash,
      inFlightHere: inFlightIssues.has(effectKey),
      speculativeRun: speculationRunContextOf(tx) !== undefined,
    });
    if (decision === "hit") {
      // The §4 memo hit (server-execution v2): the committed result records
      // this request hash AND carries a settled result — the stored result
      // is the value, no re-issue. A bare pending claim is never a hit.
      runtime.effectMemoObserver?.({ kind: "hit", id: `sqliteQuery:${hash}` });
      return;
    }
    if (decision === "dedupe") return;
    result.withTx(tx).set({ pending: true, requestHash: hash });

    const sql = inputs.sql;
    requestStaged = true;
    // Per-target dedupe key (stage-G round-2 headline): the bare
    // `sqliteQuery:<hash>` collides across DISTINCT nodes issuing the
    // same query, and the dropped second closure would leave that
    // node's result cell pending forever.
    tx.enqueuePostCommitEffect({
      id: `sqliteQuery:${hash}`,
      idempotencyKey: effectKey,
      kind: "sqlite-query",
      // The claim above rides this transaction, and so does this effect. When
      // the scheduler stops attempting the commit neither landed and no read
      // is coming, so a reader of the claim would wait on a query nobody is
      // running.
      abandon: () => {
        runtime.trackAsyncWork(
          settleAbandonedRequest(
            runtime,
            "sqliteQuery",
            effectKey,
            (settleTx) => {
              if (runIdentity !== undefined) {
                settleTx.tx.scopeKeyIdentity = runIdentity;
              }
              if (!ownsAnnouncement()) return;
              sendResult(settleTx, result);
              recordPublication(settleTx);
              // Read the stored claim at write time. Another query holds
              // this result in either of two ways, and the ending steps around
              // both. One is running: the pending flag is up under a hash that
              // is not this query's, and from then on the result is that
              // query's to write, exactly as `failQuery` decides it. Or one
              // has committed here since this query was staged, whatever state
              // it left — a later query that already answered leaves its own
              // hash with the flag down, and that answer is its own to keep.
              //
              // What is left over from before this query was staged is neither.
              // A query that finished leaves its hash standing with the flag
              // down, so every query after the first one finds a hash here that
              // belongs to nobody, and reading that as a takeover would leave
              // the pattern holding the finished query's rows under a statement
              // it no longer runs.
              const stored = result.withTx(settleTx).getRaw({
                meta: writeDestinationRead,
              }) as QueryState | undefined;
              // A newer accepted action can select a memo without changing
              // its stored value. Publication ownership permits this binding
              // to link that result; field ownership preserves the memo.
              if (!ownsAnnouncement() || !staging.fieldsSelected) return;
              const running = stored?.pending === true &&
                stored.requestHash !== undefined && stored.requestHash !== hash;
              // Whole value, not one field of it: a query that answers
              // records rows without moving the hash, and one that takes over
              // moves the hash without recording rows.
              // `valueEqual` rather than a structural walk: a decoded row can
              // carry a `FabricValue` whose contents live in private fields
              // that such a walk cannot see, and every distinct instance of one
              // compares equal to every other.
              const writtenSinceStaged = !valueEqual(
                storedBeforeClaim as FabricValue,
                stored as FabricValue,
              );
              if (running || writtenSinceStaged) {
                return;
              }
              // What the pattern reads is that the query was refused, and
              // nothing more. The refusal names the document the rule matched
              // on and the source of each caveat — the principal that
              // introduced it — which is what the pattern-facing surface
              // withholds. That detail reaches the operator through the
              // scheduler's report of the dropped write.
              result.withTx(settleTx).set({
                pending: false,
                error: "sqliteQuery request was refused before it started",
                requestHash: hash,
              });
            },
          ).finally(releaseStaging),
          parentCell,
        );
      },
      // The flush awaits the query and its writeback, so the transaction's own
      // commit promise spans them and the scheduler registers that promise for
      // every commit carrying post-commit effects. Nothing here is handed to
      // `trackAsyncWork` for that reason; the abandonment settle above is
      // separate work with its own completion, and is registered.
      async flush() {
        inFlightIssues.add(effectKey);
        // The requesting RUN's identity, applied to every writeback
        // transaction of this flush (OW53; serving-loop.md §4: the effect
        // carries the run's identity carriage, and the completion's reads
        // and writes resolve the ORIGINAL run's instance). Without it the
        // writeback's hash-guard read resolves the SERVICE's instance of a
        // per-user result cell — where no claim exists — and the completion
        // no-ops forever (the stage-A residual flagged in
        // space-server.ts `#commitEffectCompletion`). Set inside the
        // editWithRetry callback so every retry's fresh transaction
        // carries it, before that transaction's first read. Unstamped
        // requesting runs (clients, the OFF arm) captured no identity and
        // leave the manager's own in force — byte-identical to before.
        const applyRunIdentity = (wtx: IExtendedStorageTransaction) => {
          if (runIdentity !== undefined) wtx.tx.scopeKeyIdentity = runIdentity;
        };
        // The acting reader at flush time: the CAPTURED run principal for
        // a served request (the flush's own ambient is the service); the
        // ambient provider read for an unstamped one (the client/OFF
        // path — read once at flush START rather than per consumption
        // site after the RPC: equivalent for a fixed-identity manager,
        // and one coherent reader for the whole completion if an
        // ambient identity ever rotated mid-flight).
        const flushActingPrincipal = servedRun
          ? actingReader
          : runtime.trustSnapshotProvider()?.actingPrincipal;
        try {
          // Write an error result for THIS request, guarded against a newer query
          // (different inputs -> different hash) that superseded it mid-flight.
          const failQuery = (error: string) =>
            runtime.editWithRetry((wtx) => {
              markEffectCompletion(wtx, effectKey);
              applyRunIdentity(wtx);
              if (result.withTx(wtx).key("requestHash").get() !== hash) return;
              result.withTx(wtx).set({
                pending: false,
                error,
                requestHash: hash,
              });
            });
          const provider = runtime.storageManager.open(databaseSpace);
          try {
            if (!provider.sqliteQuery) {
              throw new Error(
                "sqlite: storage provider does not support queries " +
                  "(sqliteQuery unavailable)",
              );
            }
            if (crossSpace && servedRun && !actingReader) {
              throw new Error(
                "sqlite: cross-space served queries require a reader",
              );
            }
            const reader = crossSpace && servedRun && actingReader
              ? { ...runIdentity, principal: actingReader }
              : undefined;
            const res = await provider.sqliteQuery(db, sql, params, reader);
            // Decode asCell-marked `_cf_link` columns from sigil STRINGS to sigil
            // OBJECTS so a typed consumer's asCell schema rehydrates them to live
            // Cells (Piece A). Untyped queries (no rowSchema) keep raw strings.
            const rows = decodeRowLinkColumns(res.rows, linkCols);
            // CFC read-labeling (per-column static `ifc`): when the db declares
            // `ifc`, the server returns each result column's TRUE origin; map it to
            // the column's confidentiality and write the rows under a schema that
            // carries it, so a consumer reading `q.result[i].<col>` inherits the
            // label (re-establishing propagation across the opaque SQLite boundary).
            // Fail closed (refuse) on an unattributable column. The labeled write
            // is CFC-relevant; `editWithRetry` runs `prepareTxForCommit` before the
            // commit, so the label persists.
            let labelSchema: Record<string, unknown> | undefined;
            if (res.columns) {
              const { schema, error } = labelResultSchema(
                res.columns,
                db.tables as Parameters<typeof labelResultSchema>[1],
              );
              if (error) {
                await failQuery(error);
                return;
              }
              labelSchema = schema;
            }
            // CFC Phase 3: per-row data-derived labels + the declared output
            // ceiling. The pure half (row-label-read.ts) re-validates the wire
            // spec, locates rule inputs by TRUE origin, evaluates the rule per
            // row, and decides fail/skip under the ceiling — every unresolvable
            // case refuses the query (fail closed), never under-labels.
            const rowSchemaCeiling = (inputs.rowSchema as {
              ifc?: { maxConfidentiality?: CfcConfClause[] };
            } | undefined)?.ifc?.maxConfidentiality;
            if (
              inputs.maxConfidentiality !== undefined &&
              rowSchemaCeiling !== undefined
            ) {
              await failQuery(
                "sqlite: declare the output ceiling once — either the Row " +
                  "schema's MaxConfidentiality or the query's maxConfidentiality " +
                  "option, not both",
              );
              return;
            }
            const placeholderContext = {
              actingPrincipal: flushActingPrincipal,
              owner: db.owner,
            };
            let ceiling: readonly CfcConfClause[] | undefined =
              inputs.maxConfidentiality ?? rowSchemaCeiling;
            if (ceiling !== undefined) {
              const resolved = resolveCeilingPlaceholders(
                ceiling,
                placeholderContext,
              );
              if ("error" in resolved) {
                await failQuery(resolved.error);
                return;
              }
              ceiling = resolved.atoms;
            }
            // The runtime's ceiling meets the query's: a row survives only if
            // it fits both, so the query can tighten the runtime's ceiling and
            // never widen it. The meet rather than an atom intersection, which
            // is sound but over-withholds an OR-labeled row both admit.
            // Resolved against the same principal and owner as the query's,
            // and refusing on the same terms when a placeholder cannot be.
            if (readCeiling.maxConfidentiality !== undefined) {
              const resolved = resolveCeilingPlaceholders(
                readCeiling.maxConfidentiality,
                placeholderContext,
              );
              if ("error" in resolved) {
                await failQuery(resolved.error);
                return;
              }
              ceiling = meetCfcObservationCeilings(ceiling, resolved.atoms);
            }
            const rowLabels = computeRowLabelRead({
              tables: db.tables,
              columns: res.columns,
              rows,
              owner: db.owner,
              staticConfidentiality: staticConfidentialityOf(labelSchema),
              ceiling,
              // The query's own mode stands, an invalid one included, so
              // the validation below still refuses it; the runtime's
              // supplies the default for a query that declared none, and
              // the builtin's `fail` beneath that.
              onExceed: inputs.onExceed === undefined
                ? readCeiling.onExceed
                : inputs.onExceed,
              onExceedIsRuntimeDefault: inputs.onExceed === undefined &&
                readCeiling.onExceed !== undefined,
              // Phase 3.b read-time clearance: the reader is the acting
              // principal of the REQUESTING run (same identity the ceiling
              // placeholders resolve against, and the USER half of the
              // request hash's reader component above — the session half,
              // where the result scope carries one, splits the CELL and the
              // keys, never row admission: rows name principals, and which
              // rows a user may read does not vary by their session). A
              // served request with no carried reader passes undefined and
              // the clearance path refuses — fail closed, never cleared FOR
              // the service.
              readClearance: inputs.readClearance
                ? { reader: flushActingPrincipal }
                : undefined,
            });
            if ("error" in rowLabels) {
              await failQuery(
                scope === "session"
                  ? rowLabels.error
                  : rowLabels.error.startsWith(
                      "sqlite: rowLabel rule failed on row ",
                    )
                  ? "sqlite: rowLabel rule could not safely label a result row"
                  : rowLabels.error.replace(/row \d+/g, "row"),
              );
              return;
            }
            const withheld = rowLabels.withheld;
            // onExceed:"skip" — drop rows the declared ceiling does not admit
            // (a declared, observable existence release; 06-cfc.md ceiling).
            const keep = rowLabels.keep;
            const keptRows = keep ? rows.filter((_, i) => keep[i]) : rows;
            const perRow = keep
              ? rowLabels.labels.filter((_, i) => keep[i])
              : rowLabels.labels;
            const anyPerRow = perRow.some((l) => l !== undefined);
            // Convert before the Fabric write: SQLite aliases are arbitrary,
            // while Fabric records reserve prototype-pollution keys. Unsafe
            // rows use the memory protocol's entry-list representation. On the
            // labeled path, clone that Fabric-safe form to an extensible value
            // before the schema-aware diff attaches per-path labels.
            const resultRows = keptRows.map((row) => {
              const wireRow = sqliteRowToWire(
                row as Parameters<typeof sqliteRowToWire>[0],
              );
              return labelSchema || anyPerRow
                ? cloneIfNecessary(
                  wireRow as Parameters<typeof cloneIfNecessary>[0],
                  { frozen: false },
                )
                : wireRow;
            }) as unknown[];
            const objectRowSchema = (labelSchema?.properties as {
              result?: { items?: Record<string, unknown> };
            } | undefined)?.result?.items;
            const rowSchemas = resultRows.map((row) =>
              sqliteWireRowSchema(row, objectRowSchema)
            );
            const needsEntryRowSchema = resultRows.some(Array.isArray) &&
              (labelSchema !== undefined || anyPerRow);
            const shapeConfidentiality = scope === "session"
              ? []
              : joinCfcObservedConfidentiality([
                staticConfidentialityOf(labelSchema),
                ...rowLabels.labels.map((label) => label?.confidentiality),
              ]);
            let writeSchema = needsEntryRowSchema
              ? {
                type: "object",
                additionalProperties: true,
                properties: {
                  result: {
                    type: "array",
                    prefixItems: rowSchemas,
                    items: false,
                  },
                },
              }
              : labelSchema;
            if (shapeConfidentiality.length > 0) {
              // A shared array's length and membership reveal its rows even
              // without dereferencing them. The complete row-label join also
              // protects a count of rows a query contract deliberately skips.
              const properties = (writeSchema?.properties ?? {}) as Record<
                string,
                Record<string, unknown>
              >;
              const shapeIfc = { confidentiality: shapeConfidentiality };
              writeSchema = {
                ...writeSchema,
                type: "object",
                additionalProperties: true,
                properties: {
                  ...properties,
                  result: {
                    ...properties.result,
                    type: "array",
                    ifc: shapeIfc,
                  },
                  withheld: { type: "number", ifc: shapeIfc },
                },
              };
            }
            // Every row is an entity document of its own under the result
            // cell, keyed as `resultRowKeys()` decides: a key stands still
            // across runs for a row that did not change, so the diff finds
            // nothing to write for it, and a key is drawn only from what a
            // reader of the unlabeled row links may already see. The
            // selected database and the handle's `tables` declaration are
            // namespaces the keys carry on purpose, so a query whose `db`
            // input moves to another database, or whose handle is
            // re-declared, lands its rows on documents of their own. Nothing
            // else that varies between runs may reach a key, or an
            // unchanged result would mint a document per row per run.
            const rowKeys = resultRowKeys({
              rows: resultRows,
              columns: res.columns,
              tables: db.tables,
              database: { space: databaseSpace, id: db.id },
              columnLabeled: labelSchema !== undefined,
              rowLabel: (i) => perRow[i],
            });
            const wrote = await runtime.editWithRetry((wtx) => {
              markEffectCompletion(wtx, effectKey);
              applyRunIdentity(wtx);
              // Stale-writeback guard: a newer query (different inputs -> different
              // hash) may have superseded this one while the RPC was in flight.
              // Only write back if the result cell still records THIS request.
              if (result.withTx(wtx).key("requestHash").get() !== hash) {
                return;
              }
              const base = result.getAsNormalizedFullLink();
              // The stored link is bare. The row's schema, per-column labels
              // and row label included, goes on the write alone, whose policy
              // input is what carries the labels to the row document. A link
              // carrying a schema would install that schema as a
              // content-addressed document, and two scoped instances of one
              // result settling in separate waves would both write it, which
              // the second wave refuses.
              const storedRows = resultRows.map((row, i) => {
                const schema = {
                  ...rowSchemas[i],
                  ...(perRow[i] !== undefined && { ifc: perRow[i] }),
                };
                const rowCell = createCell(
                  runtime,
                  {
                    ...base,
                    id: toURI(createRef(rowKeys[i], {
                      parent: { id: base.id, space: base.space },
                      path: [...base.path, "result"],
                      context: "sqlite-result-row",
                    })),
                    path: [],
                    schema: undefined,
                  },
                  wtx,
                );
                rowCell.asSchema(
                  schema as Parameters<Cell<unknown>["asSchema"]>[0],
                ).set(row);
                return rowCell;
              });
              const target = writeSchema
                ? result.asSchema(writeSchema).withTx(wtx)
                : result.withTx(wtx);
              target.set({
                pending: false,
                result: storedRows,
                requestHash: hash,
                ...(withheld !== undefined ? { withheld } : {}),
              });
            });
            // Surface a write-back failure as `q.error` rather than leaving the
            // query stuck `pending` (editWithRetry returns the error, not throws).
            if (wrote.error) {
              await failQuery(
                wrote.error.message ?? "sqlite: result write failed",
              );
            }
          } catch (error) {
            await failQuery(errMsg(error));
          }
        } finally {
          inFlightIssues.delete(effectKey);
        }
      },
    });
  };
  return { action };
}
