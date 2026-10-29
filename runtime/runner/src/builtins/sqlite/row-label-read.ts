// CFC Phase 3 (3.a-read), pure half: per-row label computation for a query
// result, plus the declared output ceiling with onExceed fail|skip. The
// sqliteQuery flush (sqlite-builtins.ts) feeds this real results; everything
// here is side-effect free and fail-closed — any unresolvable input refuses
// the query rather than under-labeling.
// Spec: docs/specs/sqlite-builtin/06-cfc.md ("Read — re-derive per row,
// attach, ceiling"; "Fail-closed rules").

import type { CfcAtom, CfcAtomObject } from "@commonfabric/api/cfc";
import {
  atomKey,
  evaluateRowLabel,
  type RowLabelSpec,
  ruleCommonAlternatives,
  ruleConstrainsConfidentiality,
  ruleInputFields,
  validateRowLabelSpec,
} from "@commonfabric/memory/sqlite/row-label";
import { tableDeclaresRowLabel } from "@commonfabric/memory/v2";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { CfcConfClause } from "../../cfc/clause.ts";
import { clauseAlternatives, isOrClause } from "../../cfc/clause.ts";
import { cfcObservationFitsCeiling } from "../../cfc/observation.ts";

interface ResultColumn {
  output: string;
  table: string | null;
  column: string | null;
}

/** A row's per-row label, shaped as a schema `ifc` for the row-doc write. */
export interface PerRowIfc {
  confidentiality?: CfcConfClause[];
  integrity?: CfcAtom[];
}

export interface RowLabelReadArgs {
  /** Declared table schemas (`db.tables`, wire-supplied — re-validated). */
  tables: Record<string, unknown> | undefined;

  /** Per-result-column TRUE origins (`res.columns`); undefined when the
   *  server captured none. */
  columns: readonly ResultColumn[] | undefined;

  rows: readonly unknown[];

  /** The db's owner (db ref), resolving the rule's `dbOwner()` term. */
  owner?: string;

  /** Per-column (Phase 2) confidentiality atoms of the labeled projection —
   *  they ride every row, so they count against the ceiling too. */
  staticConfidentiality?: readonly CfcConfClause[];

  /** Declared output ceiling (placeholders already resolved). */
  ceiling?: readonly CfcConfClause[];

  /** What to do when a row's label exceeds the ceiling (default "fail"). */
  onExceed?: unknown;
  /** True when `onExceed` is the runtime's default rather than the query's
   *  own declaration. A runtime-wide `skip` is a mode the query author never
   *  chose, so on an aggregate/expression projection — where skip is refused
   *  because a withheld row already contributed server-side — the runtime's
   *  default falls back to `fail` instead of refusing a query that declared
   *  nothing. A query's OWN `skip` on such a projection is still refused. */
  onExceedIsRuntimeDefault?: boolean;

  /** CFC Phase 3.b read-time clearance: when set, keep only rows the acting
   *  reader may read (a declared existence release, §8.17/inv-14). Requires the
   *  rule-bearing table to opt in (`rowLabelReadClearance`); never for
   *  aggregates. `reader` is the acting principal (undefined → refuse). */
  readClearance?: { reader: string | undefined };
}

export type RowLabelReadResult =
  | { error: string }
  | {
    /** Per kept-order row: the per-row label for its row entity doc, or
     *  undefined when the row carries no per-row label. */
    labels: (PerRowIfc | undefined)[];

    /** Row keep-mask under a declared ceiling and/or read-time clearance
     *  (undefined: neither declared). */
    keep: boolean[] | undefined;

    /** CFC Phase 3.b: rows withheld because the acting reader could not read
     *  them (a declared, audited existence release). 0/undefined when no
     *  clearance was requested. */
    withheld?: number;
  };

// The common-alternative outcome for a null-origin (aggregate) projection over
// the rule-bearing tables. `unconstrained`: no rule imposes any confidentiality
// (all integrity-only or degenerate), so the aggregate is public — carry no
// label. `readers`: every confidentiality-bearing table shares this non-empty
// set of guaranteed readers, so the aggregate is readable by them (an
// OR-clause). `refuse`: some confidentiality-bearing table has no reader in the
// intersection, so no principal is guaranteed to read every contributing row.
type AggregateCommon =
  | { kind: "unconstrained" }
  | { kind: "readers"; atoms: CfcConfClause[] }
  | { kind: "refuse" };

// Intersect the common alternatives of every CONFIDENTIALITY-BEARING
// rule-bearing table (CFC spec §8.17.4, Epic E2). A reader in the intersection
// is a guaranteed reader of every row of every such table, so it soundly reads
// an aggregate no matter which of them it ranged over. Integrity-only rules
// impose no confidentiality, so they are skipped rather than treated as a
// refusal (an aggregate over an integrity-only table is public) — the
// distinction `ruleCommonAlternatives` returning `[]` alone cannot make. Uses
// the canonical `atomKey` so structurally-equal atoms (e.g. object constants
// whose keys differ only in order across two rules) intersect correctly.
function intersectCommonAlternatives(
  rules: readonly { spec: RowLabelSpec }[],
  owner: string | undefined,
): AggregateCommon {
  let acc: Map<string, unknown> | undefined;
  let anyConfidentiality = false;
  for (const r of rules) {
    if (!ruleConstrainsConfidentiality(r.spec)) continue; // integrity-only
    anyConfidentiality = true;
    const alts = new Map<string, unknown>();
    for (const a of ruleCommonAlternatives(r.spec, { dbOwner: owner })) {
      alts.set(atomKey(a), a);
    }
    if (alts.size === 0) return { kind: "refuse" }; // constrains, no reader
    acc = acc === undefined
      ? alts
      : new Map([...acc].filter(([k]) => alts.has(k)));
    if (acc.size === 0) return { kind: "refuse" }; // no shared reader
  }
  if (!anyConfidentiality) return { kind: "unconstrained" };
  return {
    kind: "readers",
    atoms: acc === undefined ? [] : [...acc.values()] as CfcConfClause[],
  };
}

// CFC Phase 3.b — whether the acting reader may read a row carrying this
// confidentiality label: EVERY conjunctive clause must list the reader among
// its alternatives (an AND of ORs). A public row (no confidentiality) is
// readable by all. Per-row labels store concrete principals (dbOwner() is
// resolved to the owner at eval time), so an alternative admits the reader iff
// it is exactly the reader principal; a non-principal alternative
// (Caveat/Expires/material-risk marker) never admits a plain reader, so the row
// is withheld — fail closed.
function readerAdmitsLabel(
  confidentiality: readonly CfcConfClause[],
  reader: string,
): boolean {
  return confidentiality.every((clause) =>
    clauseAlternatives(clause as CfcConfClause).some((alt) => alt === reader)
  );
}

/**
 * Compute each result row's per-row label from the declared rules and the
 * projection's TRUE column origins, then apply the declared output ceiling.
 * Fail-closed refusals (spec "Fail-closed rules"): invalid wire spec; missing provenance;
 * any null-origin (aggregate/expression) column while a row rule is declared;
 * a rule input column missing from or ambiguous in the projection; an
 * evaluator error on any row; a ceiling miss under onExceed:"fail"; skip on a
 * projection with a null-origin column (a contribution can't be un-counted).
 */
export function computeRowLabelRead(
  args: RowLabelReadArgs,
): RowLabelReadResult {
  const { tables, columns, rows, owner, ceiling } = args;

  if (
    args.onExceed !== undefined && args.onExceed !== "fail" &&
    args.onExceed !== "skip"
  ) {
    return {
      error: `sqlite: invalid onExceed ${
        JSON.stringify(args.onExceed)
      } — expected "fail" or "skip"`,
    };
  }
  let onExceed = (args.onExceed ?? "fail") as "fail" | "skip";

  // Discover + re-validate rule-bearing tables (db.tables is wire-supplied;
  // "couldn't validate" is never "no label"). `allowReadClearance` is the
  // per-table policy opt-in for Phase 3.b read-time clearance.
  const rules: {
    name: string;
    spec: RowLabelSpec;
    allowReadClearance: boolean;
  }[] = [];
  for (const [name, t] of Object.entries(tables ?? {})) {
    if (!tableDeclaresRowLabel(t)) continue;
    const spec = (t as { rowLabel: RowLabelSpec }).rowLabel;
    const properties =
      (t as { properties?: Record<string, unknown> }).properties ?? {};
    const columnNames = Object.keys(properties);
    const reason = validateRowLabelSpec(spec, columnNames, properties);
    if (reason) {
      return {
        error: `sqlite: table "${name}" declares an invalid rowLabel rule — ` +
          reason,
      };
    }
    rules.push({
      name,
      spec,
      allowReadClearance:
        (t as { rowLabelReadClearance?: unknown }).rowLabelReadClearance ===
          true,
    });
  }

  const nullOrigin =
    columns?.some((c) => c.table === null || c.column === null) ?? false;

  let labels: (PerRowIfc | undefined)[] = rows.map(() => undefined);

  if (rules.length > 0) {
    if (columns === undefined) {
      return {
        error: "sqlite: a row-rule-bearing db needs column provenance for " +
          "the read, but the result carries none — refusing (fail closed)",
      };
    }
    if (nullOrigin) {
      // Epic E2 (common-alternative property, CFC spec §8.17.4): an
      // aggregate/expression column has no single source, so its per-row
      // contributors cannot be attributed. But a reader that is a COMMON
      // ALTERNATIVE of every confidentiality-bearing table — a static,
      // unconditional reader of every row of every such table (e.g. an
      // unconditional `dbOwner()` alternative) — satisfies the join of all
      // those rows, so it soundly reads the aggregate with NO declassification.
      // Intersect the common alternatives across the rule-bearing tables and
      // let the declared output ceiling decide:
      //   - unconstrained: no table imposes confidentiality (all integrity-only
      //     or degenerate) — the aggregate is public, carry no per-row label.
      //   - readers: label the aggregate rows by that reader set (an OR-clause).
      //   - refuse: some table constrains but shares no guaranteed reader.
      const common = intersectCommonAlternatives(rules, owner);
      if (common.kind === "refuse") {
        return {
          error: "sqlite: an aggregate/expression column has no single " +
            "source and the rule has no common reader — its per-row " +
            "contributors cannot be re-labeled on a row-rule-bearing db; " +
            "refusing (fail closed). Query the rows directly, add an " +
            "unconditional reader (e.g. dbOwner()) the aggregate can be read " +
            "by, or move the aggregate to a rule-less table",
        };
      }
      if (common.kind === "readers") {
        const clause = common.atoms.length === 1
          ? common.atoms[0]
          : { anyOf: common.atoms };
        labels = rows.map(() => ({ confidentiality: [clause] }));
      }
      // kind === "unconstrained": no confidentiality on the aggregate — leave
      // labels undefined. Either way no per-row eval (no origins to attribute);
      // fall through to the shared ceiling check below.
    } else {
      const applicable = rules.filter((r) =>
        columns.some((c) => c.table === r.name)
      );
      if (applicable.length > 1) {
        return {
          error: "sqlite: a query may touch at most one rule-bearing table " +
            `(found ${
              applicable.map((r) => `"${r.name}"`).join(", ")
            }) — cross-rule joins are deferred; refusing (fail closed)`,
        };
      }
      if (applicable.length === 1) {
        const { name, spec } = applicable[0];
        // Locate every rule input by TRUE origin — never by output name.
        const inputOutputs = new Map<string, string>();
        for (const field of ruleInputFields(spec)) {
          const hits = columns.filter((c) =>
            c.table === name && c.column === field
          );
          if (hits.length === 0) {
            return {
              error: `sqlite: the rowLabel rule needs column "${field}" of ` +
                `table "${name}", but the projection does not include it (by ` +
                "true origin) — refusing (fail closed); add it to the SELECT",
            };
          }
          if (hits.length > 1) {
            return {
              error: `sqlite: rule input "${name}.${field}" is ambiguous — ` +
                `${hits.length} result columns share that origin; alias all ` +
                "but one away or drop the duplicates",
            };
          }
          inputOutputs.set(field, hits[0].output);
        }
        labels = [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (!isObjectNotArray(row)) {
            return { error: `sqlite: result row ${i} is not an object` };
          }
          const rowValues: Record<string, unknown> = {};
          for (const [field, output] of inputOutputs) {
            rowValues[field] = row[output];
          }
          const res = evaluateRowLabel(spec, rowValues, { dbOwner: owner });
          if ("error" in res) {
            return {
              error: `sqlite: rowLabel rule failed on row ${i}: ${res.error}`,
            };
          }
          const ifc: PerRowIfc = {};
          if (res.confidentiality.length > 0) {
            ifc.confidentiality = res.confidentiality as CfcConfClause[];
          }
          if (res.integrity.length > 0) {
            ifc.integrity = res.integrity as CfcAtom[];
          }
          labels.push(
            ifc.confidentiality || ifc.integrity ? ifc : undefined,
          );
        }
      }
    }
  }

  // Declared output ceiling — the consumer's contract on what the result may
  // carry. Applies to per-row AND static per-column confidentiality; not
  // reader-clearance (none exists), a declared contract (06-cfc.md ceiling).
  let keep: boolean[] | undefined;
  if (ceiling !== undefined) {
    if (
      onExceed === "skip" && nullOrigin && args.onExceedIsRuntimeDefault
    ) {
      // The runtime's default, not the query's word: fall back to the
      // builtin's own `fail` rather than refuse a projection the query
      // author never opted into skipping.
      onExceed = "fail";
    }
    if (onExceed === "skip" && nullOrigin) {
      return {
        error: 'sqlite: onExceed:"skip" never applies to an aggregate/' +
          "expression projection — withheld rows already contributed " +
          'server-side and cannot be un-counted; use "fail"',
      };
    }
    const staticConf = args.staticConfidentiality ?? [];
    keep = [];
    for (let i = 0; i < rows.length; i++) {
      const effective = [
        ...(labels[i]?.confidentiality ?? []),
        ...staticConf,
      ];
      const fits = cfcObservationFitsCeiling(effective, ceiling);
      if (!fits && onExceed === "fail") {
        return {
          error: `sqlite: row ${i}'s label exceeds the declared output ` +
            "ceiling (maxConfidentiality) — refusing (fail closed); narrow " +
            'the query, widen the ceiling, or opt into onExceed:"skip"',
        };
      }
      keep.push(fits);
    }
  }

  // CFC Phase 3.b — read-time clearance (§8.17/inv-14). A declared existence
  // release: keep only rows the acting reader may read. Requires (a) the query
  // opted in (readClearance), (b) the touched rule-bearing table permits it
  // (rowLabelReadClearance), (c) it is audited (withheld count). Never for
  // aggregates — an aggregate has no per-row reader test.
  let withheld: number | undefined;
  if (args.readClearance !== undefined) {
    if (nullOrigin) {
      return {
        error: "sqlite: read-time clearance never applies to an aggregate/" +
          "expression projection — there is no per-row reader to test; remove " +
          "readClearance or query the underlying rows directly",
      };
    }
    const applicable = rules.filter((r) =>
      columns?.some((c) => c.table === r.name)
    );
    if (applicable.length === 0) {
      return {
        error: "sqlite: read-time clearance needs a rule-bearing table with " +
          "per-row labels to filter, but this query touches none — remove " +
          "readClearance",
      };
    }
    const forbidden = applicable.filter((r) => !r.allowReadClearance);
    if (forbidden.length > 0) {
      return {
        error:
          "sqlite: read-time clearance is not permitted by the governing " +
          `policy of table ${
            forbidden.map((r) => `"${r.name}"`).join(", ")
          } — pass { allowReadClearance: true } to table() to opt in`,
      };
    }
    const reader = args.readClearance.reader;
    if (reader === undefined) {
      return {
        error: "sqlite: read-time clearance needs the acting reader, but no " +
          "acting principal is available — refusing (fail closed)",
      };
    }
    const staticConf = args.staticConfidentiality ?? [];
    const clearanceKeep: boolean[] = [];
    withheld = 0;
    for (let i = 0; i < rows.length; i++) {
      const effective = [
        ...(labels[i]?.confidentiality ?? []),
        ...staticConf,
      ];
      const admits = readerAdmitsLabel(effective, reader);
      if (!admits) withheld++;
      clearanceKeep.push(admits);
    }
    // Intersect with any ceiling keep-mask: a row survives iff BOTH the declared
    // contract admits it and the reader may read it.
    keep = keep === undefined
      ? clearanceKeep
      : keep.map((k, i) => k && clearanceKeep[i]);
  }

  return { labels, keep, withheld };
}

/**
 * Resolve placeholder principals in a declared ceiling: the acting user
 * (`{__ctCurrentPrincipal:true}`, prepare-time identity) and the db owner
 * (`{__ctDbOwner:true}`, from the db ref), whether an entry is the
 * placeholder or an `anyOf` whose alternative is. Unresolvable placeholders
 * fail closed — a ceiling that can't be pinned must not silently widen.
 */
export function resolveCeilingPlaceholders(
  ceiling: readonly CfcConfClause[],
  ctx: { actingPrincipal?: string; owner?: string },
): { atoms: CfcConfClause[] } | { error: string } {
  const resolveAtom = (
    atom: CfcAtom,
  ): { atom: CfcAtom } | { error: string } => {
    if (
      isObjectNotArray(atom) &&
      (atom as CfcAtomObject).__ctCurrentPrincipal === true
    ) {
      if (ctx.actingPrincipal === undefined) {
        return {
          error: "sqlite: ceiling references the acting user but no acting " +
            "principal is available — refusing (fail closed)",
        };
      }
      return { atom: ctx.actingPrincipal };
    }
    if (
      isObjectNotArray(atom) && (atom as CfcAtomObject).__ctDbOwner === true
    ) {
      if (ctx.owner === undefined) {
        return {
          error: "sqlite: ceiling references the db owner but the db ref " +
            "carries no owner — refusing (fail closed)",
        };
      }
      return { atom: ctx.owner };
    }
    return { atom };
  };
  const atoms: CfcConfClause[] = [];
  for (const clause of ceiling) {
    if (isOrClause(clause)) {
      // An alternative is an atom, never a nested clause, so one level is
      // the whole depth; a nested `anyOf` stays as it is, opaque and
      // unsatisfiable, which is how the clause machinery reads it.
      const alternatives: CfcAtom[] = [];
      for (const alternative of clause.anyOf) {
        const resolved = resolveAtom(alternative);
        if ("error" in resolved) return resolved;
        alternatives.push(resolved.atom);
      }
      atoms.push({ anyOf: alternatives });
      continue;
    }
    const resolved = resolveAtom(clause);
    if ("error" in resolved) return resolved;
    atoms.push(resolved.atom);
  }
  return { atoms };
}
