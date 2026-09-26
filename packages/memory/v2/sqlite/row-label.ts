// CFC Phase 3: the per-row label rule — builder helpers, the serialized AST,
// authoring/wire validation, and the shared evaluator.
// (Spec: docs/specs/sqlite-builtin/06-cfc.md, "Per-row labels".)
//
// A rule is a PURE declarative projection over (stored columns, fixed db
// properties): the builders below return plain-JSON AST nodes, `table()`
// validates and attaches the result to the table schema as `rowLabel`, and
// `evaluateRowLabel` interprets it identically at the write gate, the server
// commit, and read re-derivation. There is deliberately NO acting-principal
// term (a read-time `currentUser()` would resolve to the *reader* — in an
// OR-clause that self-grants access; the acting user belongs in the result
// ceiling). `any(...)` evaluates to one authored OR-clause `{anyOf:[…]}` — any
// single alternative can read (CFC spec §18.5.3 / §3.1.8, Epic E1). The
// runner's clause-aware label profile enforces subsumption at the boundary and
// rejects non-principal-like alternatives (Caveat/Expires); this evaluator
// keeps the disjunction structural, never silently lowered to conjunctive
// atoms.
//
// Pure module: no FFI, no engine imports — safe for client-side import.

import type { FabricPlainObject, FabricValue } from "@commonfabric/api";
import type { MutableFabricPlainObjectLayer } from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { sqlAffinity } from "./columns.ts";

/** A reference to a declared column, handed to the rule as `f.<col>`. */
export type FieldRef = {
  field: string;
};

export type MatchOpts = {
  /** Capture group to extract instead of the whole match. */
  group?: number;

  /** Minimum number of matches; fewer fails closed (required anchor). */
  min?: number;
};

/** Serialized rule, attached to the table schema as `rowLabel`. */
export type RowLabelSpec = {
  version: 1;
  confidentiality?: FabricValue;
  integrity?: FabricValue;
};

/** Field handles passed to the rule: one accessor per declared column. */
export type RowFieldHandles<C extends Record<string, unknown>> =
  & { [K in keyof C]: FieldRef }
  & Record<string, FieldRef>;

export type RowLabelRule<C extends Record<string, unknown>> = (
  f: RowFieldHandles<C>,
) => { confidentiality?: FabricValue; integrity?: FabricValue };

const isFieldRef = (x: unknown): x is FieldRef =>
  isObjectNotArray(x) && typeof x.field === "string" &&
  Object.keys(x).length === 1;

//
// Builders — each returns its serialized AST node.
//

/**
 * Run `re` (forced global) over a column's text ⟹ the ordered list of matches
 * (or capture `group`). The universal field extractor: splits a dirty
 * `Name <addr>, addr` recipient line for free. Strict-if-present: a non-empty
 * value yielding zero matches fails closed at evaluation (never under-label);
 * `min` makes the field a required anchor.
 */
export function match(
  field: FieldRef,
  re: RegExp,
  opts: MatchOpts = {},
): { match: FabricPlainObject } {
  assertField(field, "match()");
  assertRegExp(re, "match()");
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const node: MutableFabricPlainObjectLayer = {
    field: field.field,
    source: re.source,
    flags,
  };
  if (opts.group !== undefined) node.group = opts.group;
  if (opts.min !== undefined) node.min = opts.min;
  return { match: node };
}

/**
 * Include `then` only when the regex TESTS true against the column (gate
 * trust, or a data-dependent conjunct, on extracted metadata). One fused
 * helper — a bare `when(matches(…))` pair would collide with the builder's
 * control-flow `when`, whose transformer lowering matches by NAME and mangles
 * any local so named.
 */
export function whenMatches(
  field: FieldRef,
  re: RegExp,
  then: FabricValue,
): { when: FabricValue; then: FabricValue } {
  assertField(field, "whenMatches()");
  assertRegExp(re, "whenMatches()");
  return {
    when: {
      match: {
        field: field.field,
        source: re.source,
        flags: re.flags.replace("g", ""),
      },
    },
    then,
  };
}

/** `did:<protocol>:<v>` for each extracted `v` (distributes over the match
 *  list). Normalization is protocol-implied: mailto/web lowercase+trim,
 *  did:key untouched (base58 is case-sensitive), unknown protocols identity. */
export function principal(
  protocol: string,
  of: { match: FabricPlainObject },
): { principal: FabricPlainObject } {
  if (typeof protocol !== "string" || !/^[a-z][a-z0-9.+-]*$/.test(protocol)) {
    throw new TypeError(
      `principal(): invalid DID protocol ${JSON.stringify(protocol)}`,
    );
  }
  if (!isObjectNotArray(of) || !isObjectNotArray(of.match)) {
    throw new TypeError("principal() takes a match(...) term");
  }
  return { principal: { protocol, of } };
}

/** The db's owner — the principal that created the SqliteDb cell, resolved
 *  from the db ref. A FIXED db property, so the rule stays pure. */
export function dbOwner(): { dbOwner: true } {
  return { dbOwner: true };
}

/** A literal atom (escape hatch). (Named `constant` — `const` is reserved.) */
export function constant(atom: FabricValue): { constant: FabricValue } {
  return { constant: atom };
}

/** Separate conjunctive clauses, one per atom — today's only confidentiality
 *  combinator (every principal an independent requirement). */
export function all(...terms: FabricValue[]): { allOf: FabricValue[] } {
  return { allOf: terms };
}

/** ONE authored OR-clause: any alternative satisfies it (CFC spec §3.1.8).
 *  Serializes, but `table()` REJECTS it until the runtime ships the
 *  clause-aware label profile — never silently lowered to all-of. */
export function any(...terms: FabricValue[]): { anyOf: FabricValue[] } {
  return { anyOf: terms };
}

/** Set-intersection over integrity atom sets (the trust-floor meet).
 *  Integrity only — confidentiality combines by all()/any(). */
export function intersect(
  ...terms: FabricValue[]
): { intersect: FabricValue[] } {
  return { intersect: terms };
}

/** Integrity claim: the row was authored by the extracted principal. Minted as
 *  a self-describing `claimed-authored-by` atom — content-derived provenance
 *  is forgeable by the row's writer, so it never lowers to the trusted
 *  `AuthoredBy` family directly (see 06-cfc.md; upgrade via provider trust). */
export function authoredBy(
  p: { principal: FabricPlainObject },
): { authoredBy: FabricValue } {
  assertPrincipal(p, "authoredBy()");
  return { authoredBy: p };
}

/** Integrity claim: endorsed by the extracted principal (same downgrade rule
 *  as `authoredBy`). */
export function endorsedBy(
  p: { principal: FabricPlainObject },
): { endorsedBy: FabricValue } {
  assertPrincipal(p, "endorsedBy()");
  return { endorsedBy: p };
}

function assertField(x: unknown, who: string): asserts x is FieldRef {
  if (!isFieldRef(x)) {
    throw new TypeError(`${who} takes a field handle (f.<column>)`);
  }
}
function assertRegExp(x: unknown, who: string): asserts x is RegExp {
  if (!(x instanceof RegExp)) throw new TypeError(`${who} takes a RegExp`);
}
function assertPrincipal(x: unknown, who: string) {
  if (!isObjectNotArray(x) || !isObjectNotArray(x.principal)) {
    throw new TypeError(`${who} takes a principal(...) term`);
  }
}

//
// Validation — fail closed at authoring AND on wire-supplied specs.
//

const MAX_REGEX_SOURCE = 512;

/** Reject ReDoS-shaped patterns: a quantifier applied to a group that itself
 *  contains an unbounded quantifier (star height ≥ 2), e.g. `(a+)+`. Linear
 *  scan honoring escapes and character classes. Conservative lint, not a
 *  parser; the per-eval input is additionally produced by the row itself. */
function regexLintReason(source: string): string | undefined {
  if (source.length > MAX_REGEX_SOURCE) {
    return `regex too long (${source.length} > ${MAX_REGEX_SOURCE})`;
  }
  const QUANT = new Set(["*", "+", "{", "?"]);
  // Stack of group frames; [0] is the top level. hasQuant = an unbounded
  // quantifier occurred directly inside this frame (or a nested one).
  const stack: { hasQuant: boolean }[] = [{ hasQuant: false }];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++; // skip escaped char
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      stack.push({ hasQuant: false });
      continue;
    }
    if (c === ")") {
      const frame = stack.pop();
      if (frame === undefined || stack.length === 0) {
        // Unmatched ")" — invalid regex; report a reason rather than crash
        // (the lint runs on hostile wire specs and must stay fail-closed).
        return "regex fails the safety lint (unbalanced parenthesis)";
      }
      const next = source[i + 1];
      if (frame.hasQuant && next !== undefined && QUANT.has(next)) {
        return "regex fails the safety lint (nested quantifier — ReDoS risk)";
      }
      stack[stack.length - 1].hasQuant ||= frame.hasQuant;
      continue;
    }
    if (QUANT.has(c)) stack[stack.length - 1].hasQuant = true;
  }
  return undefined;
}

// Validate an `any(...)` node: every alternative must be a valid confidentiality
// term (Epic E1). Atom-shape restrictions on alternatives (principal-like only;
// no Caveat/Expires) are enforced runner-side at the boundary (§3.1.8); here we
// check structural well-formedness AND that no alternative is a conjunction.
function validateConfAnyOf(
  node: Record<string, unknown>,
  columns: ReadonlySet<string>,
): string | undefined {
  const terms = node.anyOf;
  if (!Array.isArray(terms) || terms.length === 0) {
    return "any() needs at least one alternative";
  }
  for (const t of terms) {
    const r = validateAnyOfAlternative(t, columns);
    if (r) return r;
  }
  return undefined;
}

// An `any()` alternative is one INDEPENDENT reader (a disjunct), so it must be
// a leaf that evaluates to reader atoms — `principal()`, `dbOwner()`,
// `constant()`, or a `whenMatches(...)` gating one of those. A CONJUNCTION
// (`all()`) or a nested `any()` is rejected: the evaluator's union-flatten
// would turn `any(all(A,B), C)` into `A ∨ B ∨ C`, silently widening
// `(A ∧ B) ∨ C` so a row becomes readable by A alone (CFC spec §3.1.8:
// alternatives are principal-like atoms, not clauses). The `when` gate is
// checked recursively so `whenMatches(…, all(A,B))` is rejected too.
function validateAnyOfAlternative(
  node: unknown,
  columns: ReadonlySet<string>,
): string | undefined {
  if (isObjectNotArray(node) && ("allOf" in node || "anyOf" in node)) {
    return "an any() alternative must be a single principal-like term, not " +
      "all()/any() — a conjunction or nested disjunction cannot be an " +
      "OR-clause alternative (CFC spec §3.1.8)";
  }
  if (isObjectNotArray(node)) {
    // Before the `when` branch below follows the gate: a dual-op alternative
    // (e.g. {when, then, principal}) would be validated as a when() here but
    // EVALUATED as a principal (evalConf dispatches on `principal` first).
    const amb = ambiguousOpReason(node, "any()-alternative");
    if (amb) return amb;
  }
  if (isObjectNotArray(node) && "when" in node) {
    const test = (node as { when?: unknown }).when;
    const gate = isObjectNotArray(test) && "match" in test
      ? validateMatchNode(test.match, columns, "when")
      : "malformed when gate (use whenMatches())";
    if (gate) return gate;
    return validateAnyOfAlternative((node as { then?: unknown }).then, columns);
  }
  return validateConfTerm(node, columns);
}

function validateMatchNode(
  node: unknown,
  columns: ReadonlySet<string>,
  who: string,
): string | undefined {
  if (!isObjectNotArray(node)) return `${who}: malformed match node`;
  const { field, source, flags, group, min } = node;
  if (typeof field !== "string") return `${who}: match without a field`;
  if (!columns.has(field)) {
    return `rule references unknown column "${field}"`;
  }
  if (typeof source !== "string") return `${who}: match without a source`;
  const lint = regexLintReason(source);
  if (lint) return lint;
  if (typeof flags !== "string" || !/^[dgimsuvy]*$/.test(flags)) {
    return `${who}: invalid regex flags`;
  }
  try {
    new RegExp(source, flags);
  } catch {
    return `${who}: invalid regex ${JSON.stringify(source)}`;
  }
  if (
    group !== undefined && (!Number.isInteger(group) || (group as number) < 0)
  ) {
    return `${who}: invalid capture group`;
  }
  if (min !== undefined && (!Number.isInteger(min) || (min as number) < 0)) {
    return `${who}: invalid min`;
  }
  return undefined;
}

function validatePrincipalNode(
  node: unknown,
  columns: ReadonlySet<string>,
): string | undefined {
  if (!isObjectNotArray(node) || typeof node.protocol !== "string") {
    return "malformed principal node";
  }
  if (!/^[a-z][a-z0-9.+-]*$/.test(node.protocol)) {
    return `invalid DID protocol ${JSON.stringify(node.protocol)}`;
  }
  const of = node.of;
  if (!isObjectNotArray(of) || !("match" in of)) {
    return "principal() takes a match(...) term";
  }
  return validateMatchNode(of.match, columns, "principal");
}

function unknownOp(node: Record<string, unknown>, position: string): string {
  return `unknown rowLabel op in ${position} position: ` +
    `{${Object.keys(node).join(", ")}}`;
}

// Every recognized op key — a node must carry EXACTLY ONE. The validator, the
// evaluator, and the static common-alternative analysis each dispatch on these
// by their own key precedence, so a hand-crafted dual-op wire node (e.g.
// {principal, dbOwner}) would validate as one op, evaluate as another, and be
// statically analyzed as a third — an unsoundness: a COUNT(*) labeled by the
// owner while no contributing row's label names the owner (CFC spec §8.17.4).
// Ambiguous nodes refuse everywhere. (`then` is not an op — it rides `when`.)
const OP_KEYS = [
  "anyOf",
  "allOf",
  "intersect",
  "principal",
  "dbOwner",
  "constant",
  "when",
  "authoredBy",
  "endorsedBy",
] as const;

function presentOps(node: Record<string, unknown>): string[] {
  return OP_KEYS.filter((k) => k in node);
}

function ambiguousOpReason(
  node: Record<string, unknown>,
  position: string,
): string | undefined {
  const ops = presentOps(node);
  if (ops.length <= 1) return undefined;
  return `ambiguous rowLabel node in ${position} position: ` +
    `{${ops.join(", ")}} — exactly one op per node (fail closed)`;
}

function validateConfTerm(
  node: unknown,
  columns: ReadonlySet<string>,
): string | undefined {
  if (!isObjectNotArray(node)) return "malformed confidentiality term";
  const amb = ambiguousOpReason(node, "confidentiality");
  if (amb) return amb;
  if ("anyOf" in node) return validateConfAnyOf(node, columns);
  if ("intersect" in node) {
    return "intersect() is integrity-only (the trust-floor meet); " +
      "confidentiality combines by all() — and any() once OR-clauses land";
  }
  if ("authoredBy" in node || "endorsedBy" in node) {
    return "authoredBy()/endorsedBy() are integrity terms, not confidentiality";
  }
  if ("allOf" in node) return validateConfExpr(node, columns);
  if ("principal" in node) {
    return validatePrincipalNode(node.principal, columns);
  }
  if ("dbOwner" in node) {
    return node.dbOwner === true ? undefined : "malformed dbOwner node";
  }
  if ("constant" in node) return undefined;
  if ("when" in node) {
    const test = (node as { when?: unknown }).when;
    const r = isObjectNotArray(test) && "match" in test
      ? validateMatchNode(test.match, columns, "when")
      : "malformed when gate (use whenMatches())";
    if (r) return r;
    return validateConfTerm((node as { then?: unknown }).then, columns);
  }
  return unknownOp(node, "confidentiality");
}

function validateConfExpr(
  node: unknown,
  columns: ReadonlySet<string>,
): string | undefined {
  if (!isObjectNotArray(node)) return "malformed confidentiality expression";
  const amb = ambiguousOpReason(node, "confidentiality");
  if (amb) return amb;
  if ("anyOf" in node) return validateConfAnyOf(node, columns);
  if ("allOf" in node) {
    const terms = node.allOf;
    if (!Array.isArray(terms) || terms.length === 0) {
      return "all() needs at least one term";
    }
    for (const t of terms) {
      const r = validateConfTerm(t, columns);
      if (r) return r;
    }
    return undefined;
  }
  return validateConfTerm(node, columns);
}

function validateIntegTerm(
  node: unknown,
  columns: ReadonlySet<string>,
): string | undefined {
  if (!isObjectNotArray(node)) return "malformed integrity term";
  const amb = ambiguousOpReason(node, "integrity");
  if (amb) return amb;
  if ("anyOf" in node) {
    return "disjunctive integrity does not exist (CFC spec §3.1.8): " +
      "integrity is a conjunction combined by meet";
  }
  if ("authoredBy" in node || "endorsedBy" in node) {
    const inner = (node.authoredBy ?? node.endorsedBy) as unknown;
    if (!isObjectNotArray(inner) || !("principal" in inner)) {
      return "authoredBy()/endorsedBy() take a principal(...) term";
    }
    return validatePrincipalNode(inner.principal, columns);
  }
  if ("intersect" in node || "allOf" in node) {
    const terms = (node.intersect ?? node.allOf) as unknown;
    if (!Array.isArray(terms) || terms.length === 0) {
      return "intersect()/all() need at least one term";
    }
    for (const t of terms) {
      const r = validateIntegTerm(t, columns);
      if (r) return r;
    }
    return undefined;
  }
  if ("when" in node) {
    const test = node.when;
    const r = isObjectNotArray(test) && "match" in test
      ? validateMatchNode(test.match, columns, "when")
      : "malformed when gate (use whenMatches())";
    if (r) return r;
    return validateIntegTerm((node as { then?: unknown }).then, columns);
  }
  if ("constant" in node) return undefined;
  return unknownOp(node, "integrity");
}

// A rule reads a column as text, and two declared types settle what the column
// holds before any rule sees it. A REAL-affinity column forces every value it
// stores to a float, and this evaluator renders none: the fractional ones
// refuse (its rendering is not reproducible — see `regexInputText`) and a
// whole one shows "7" where SQLite shows "7.0", so a rule written from the
// column's declared type never fires, and a gate that never fires drops a
// confidentiality clause. A BLOB column's bytes are refused outright. Neither
// is a rule anyone can write correctly, so neither is accepted — declare a
// column that carries text as TEXT.
function unreadableRuleInput(
  field: string,
  sqlType: unknown,
): string | undefined {
  if (typeof sqlType !== "string") return undefined; // no declared type
  // By affinity, not by substring: `INT BLOB` is an INTEGER column to
  // SQLite (INT matches first), and only a type SQLite itself reads as BLOB
  // is refused. An empty declared type also has BLOB affinity but stores
  // each value as bound, so text stays text; it is left readable.
  if (sqlAffinity(sqlType) === "blob" && sqlType.trim() !== "") {
    return `rule input "${field}" is declared ${sqlType} — a rule reads a ` +
      "column as text, and a BLOB has none";
  }
  if (sqlAffinity(sqlType) === "real") {
    return `rule input "${field}" is declared ${sqlType}, which gives it ` +
      "REAL affinity — a rule reads a column as text, and this evaluator " +
      "renders no REAL (declare a column holding text as TEXT)";
  }
  return undefined;
}

/**
 * Validate a rowLabel spec against the declared column names. Returns the
 * failure reason, or undefined when valid. Used by `table()` at authoring
 * (throws) and MUST be re-run on wire-supplied specs before evaluation —
 * "couldn't validate" is never "no label".
 *
 * `properties` is the table schema's column map, when the caller holds one:
 * with it, a rule reading a column whose declared type settles its storage
 * class against the rule is refused here rather than at evaluation.
 */
export function validateRowLabelSpec(
  spec: unknown,
  columns: readonly string[],
  properties?: Readonly<Record<string, unknown>>,
): string | undefined {
  if (!isObjectNotArray(spec)) return "rowLabel spec must be an object";
  if (spec.version !== 1) {
    return `unsupported rowLabel version ${JSON.stringify(spec.version)}`;
  }
  const cols = new Set(columns);
  if (spec.confidentiality === undefined && spec.integrity === undefined) {
    return "rowLabel rule must declare confidentiality and/or integrity";
  }
  if (spec.confidentiality !== undefined) {
    const r = validateConfExpr(spec.confidentiality, cols);
    if (r) return r;
  }
  if (spec.integrity !== undefined) {
    const r = validateIntegTerm(spec.integrity, cols);
    if (r) return r;
  }
  if (properties !== undefined) {
    // After the structural pass, so the walk reads a spec whose match nodes
    // are known to be well formed.
    for (const field of ruleInputFields(spec as RowLabelSpec)) {
      const column = properties[field];
      const reason = unreadableRuleInput(
        field,
        isObjectNotArray(column) ? column.sqlType : undefined,
      );
      if (reason) return reason;
    }
  }
  return undefined;
}

/** Build + validate the serialized spec from an authored rule. Throws on any
 *  violation (fail closed at definition time). Called by `table()`. */
export function buildRowLabelSpec<C extends Record<string, unknown>>(
  columns: readonly string[],
  rule: RowLabelRule<C>,
  properties?: Readonly<Record<string, unknown>>,
): RowLabelSpec {
  const handles = Object.fromEntries(
    columns.map((name) => [name, { field: name }]),
  ) as RowFieldHandles<C>;
  const out = rule(handles);
  if (!isObjectNotArray(out)) {
    throw new TypeError(
      "table(): a rowLabel rule must return { confidentiality?, integrity? }",
    );
  }
  const spec: RowLabelSpec = { version: 1 };
  if (out.confidentiality !== undefined) {
    spec.confidentiality = out.confidentiality;
  }
  if (out.integrity !== undefined) spec.integrity = out.integrity;
  const reason = validateRowLabelSpec(spec, columns, properties);
  if (reason) {
    throw new TypeError(`table(): invalid rowLabel rule — ${reason}`);
  }
  return spec;
}

//
// Evaluation — one pure function, shared by write gate, server, and read.
//

class RowLabelEvalError extends Error {}

const fail = (msg: string): never => {
  throw new RowLabelEvalError(msg);
};

/** Stable structural key for dedup / set membership (atoms are small plain
 *  JSON). Canonical: object keys are sorted, so two atoms that differ only in
 *  key insertion order share a key. Exported so cross-module callers (the
 *  read-side common-alternative intersection) compare atoms the same way. */
export function atomKey(v: unknown): string {
  if (typeof v === "string") return `s:${v}`;
  return `j:${
    JSON.stringify(v, (_k, val) =>
      isObjectNotArray(val)
        ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
        : val)
  }`;
}

function dedup(atoms: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const a of atoms) {
    const k = atomKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

function normalizeForProtocol(protocol: string, v: string): string {
  switch (protocol) {
    case "mailto":
    case "web":
      return v.trim().toLowerCase();
    default:
      // did:key is base58 (case-sensitive); unknown protocols: do nothing.
      return v;
  }
}

//
// Regex input — the text a row value shows a rule's regex.
//

// An INTEGER is an int64; a JS number carries 53 bits of integer precision.
// Past that a number no longer names one integer — a large INTEGER read into
// a double has already lost its low digits, and the driver's own bind wraps
// on the way back (1e21 binds as 3875820019684212736) — so no text we
// produced would honestly be the row's.
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * The text a row value shows a rule's regex, or `undefined` for a value class
 * the evaluator refuses (the caller fails closed on it).
 *
 * A rule gates on stored data, and a column keyed by an INTEGER — a mailbox
 * id, an account id — is the ordinary thing to gate on, so a whole integer
 * shows the regex its decimal digits. Those are the digits SQLite shows for
 * that INTEGER, which is what makes a rule writable from the row: the read
 * side reads whole integers (`read-pool.ts` opens every connection with
 * `int64`) and commit evaluation renders them (`commit-eval.ts`), so the
 * digits here are the stored ones rather than a truncation of them. One value
 * has one text, so the write gate, the server commit, and read re-derivation
 * derive one label from one row.
 *
 * A REAL does not coerce. SQLite renders one with "%!.15g" over its OWN
 * decoded digits, and that rendering is not a function of the double this
 * evaluator holds: the SQLite builds behind this driver disagree about the
 * last digit of -0.009598882198146955, which one returns as
 * "-0.00959888219814696" and another as the correctly rounded
 * "-0.00959888219814695" (the split follows the architecture, whose long
 * double the decoder uses where it is wider than a double). A gate is an
 * anchored comparison against the text SQLite would show, so a text that can
 * only be nearly reproduced is a gate that silently fails to fire on some
 * rows, dropping a confidentiality clause.
 * (`v2-sqlite-row-label-number-text.test.ts` pins the disagreement.)
 *
 * A column declared REAL or BLOB is refused a rule outright, at declaration —
 * see `validateRowLabelSpec`. What reaches here is a REAL a column of some
 * other affinity happens to hold, and one exception to the digits being
 * SQLite's: a whole REAL in a column with no affinity arrives as a JS number
 * carrying no storage class, and shows "7" where SQLite shows "7.0".
 */
export function regexInputText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  // `Number.isSafeInteger` also rejects NaN and the infinities, which are not
  // SQLite INTEGERs either (SQLite stores a NaN as NULL).
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? String(value) : undefined;
  }
  // A driver in int64 mode hands large INTEGERs over as bigints, whose digits
  // ARE exact; one outside int64 never came out of a row.
  if (typeof value === "bigint") {
    return value >= INT64_MIN && value <= INT64_MAX ? String(value) : undefined;
  }
  return undefined;
}

/** Why a value has no regex text — its CLASS only. The refusal reaches a
 *  model-facing consumer, so it carries nothing of the row itself. */
function regexInputRefusal(field: string, value: unknown): string {
  const kind = typeof value === "number"
    ? (Number.isNaN(value)
      ? "NaN, which SQLite stores as NULL"
      : !Number.isFinite(value)
      ? "an infinity, which is a REAL"
      : Number.isInteger(value)
      ? "a whole number too large to name one SQLite INTEGER exactly"
      : "a REAL, whose SQLite text this evaluator cannot reproduce")
    : typeof value === "bigint"
    ? "a bigint outside SQLite's int64 range"
    : ArrayBuffer.isView(value) || value instanceof ArrayBuffer
    ? "a BLOB"
    : typeof value === "boolean"
    ? "a boolean, which is not a SQLite value (bind 1 or 0)"
    : typeof value === "object"
    ? "an object"
    : `a ${typeof value}`;
  return `field "${field}" is ${kind} — regex input must be TEXT or a whole ` +
    "INTEGER";
}

/** Extract the match list for a field per the strict-if-present contract. */
function evalMatch(
  node: Record<string, unknown>,
  row: Record<string, unknown>,
): string[] {
  const field = node.field as string;
  if (!(field in row)) {
    return fail(`rule input field "${field}" is absent from the row`);
  }
  const value = row[field];
  const values: string[] = [];
  if (value !== null && value !== undefined && value !== "") {
    const text = regexInputText(value);
    if (text === undefined) return fail(regexInputRefusal(field, value));
    // Force the global flag like match() does at authoring: matchAll throws
    // on non-global regexes, and a hostile/legacy wire spec must degrade to
    // the documented split semantics, not an uncaught exception.
    const rawFlags = typeof node.flags === "string" ? node.flags : "";
    const flags = rawFlags.includes("g") ? rawFlags : rawFlags + "g";
    const re = new RegExp(node.source as string, flags);
    const group = node.group as number | undefined;
    for (const m of text.matchAll(re)) {
      const picked = group !== undefined ? m[group] : m[0];
      if (typeof picked === "string") values.push(picked);
    }
    if (values.length === 0) {
      // Strict-if-present: a populated field that yields nothing would
      // silently drop real principals (under-labeling). Fail closed.
      return fail(
        `field "${field}" is non-empty but matched nothing — refusing to ` +
          "under-label (strict-if-present)",
      );
    }
  }
  const min = node.min as number | undefined;
  if (min !== undefined && values.length < min) {
    return fail(
      `field "${field}" yielded ${values.length} match(es); rule requires ` +
        `at least ${min}`,
    );
  }
  return values;
}

function evalTest(
  test: unknown,
  row: Record<string, unknown>,
): boolean {
  if (!isObjectNotArray(test) || !isObjectNotArray(test.match)) {
    return fail("malformed when gate (use whenMatches())");
  }
  const { field, source, flags } = test.match as Record<string, unknown>;
  if (typeof field !== "string" || !(field in row)) {
    return fail(`rule input field "${String(field)}" is absent from the row`);
  }
  const value = row[field];
  if (value === null || value === undefined || value === "") return false;
  const text = regexInputText(value);
  if (text === undefined) return fail(regexInputRefusal(field, value));
  return new RegExp(source as string, (flags as string) ?? "").test(text);
}

function evalPrincipal(
  node: Record<string, unknown>,
  row: Record<string, unknown>,
): string[] {
  const protocol = node.protocol as string;
  const of = node.of as { match: Record<string, unknown> };
  return evalMatch(of.match, row).map(
    (v) => `did:${protocol}:${normalizeForProtocol(protocol, v)}`,
  );
}

// True if an `any()` alternative is (directly, or via a `when()` gate) a
// conjunction/nested disjunction — the shape the evaluator must reject rather
// than union-flatten. Mirrors `validateAnyOfAlternative`'s recursion so eval
// fails closed on the same shape the validator rejects, even for a wire spec
// that bypassed validation.
function anyOfAlternativeHasConjunction(node: unknown): boolean {
  if (!isObjectNotArray(node)) return false;
  if ("allOf" in node || "anyOf" in node) return true;
  if ("when" in node) {
    return anyOfAlternativeHasConjunction((node as { then?: unknown }).then);
  }
  return false;
}

function evalConf(
  node: unknown,
  row: Record<string, unknown>,
  ctx: { dbOwner?: string },
): unknown[] {
  if (!isObjectNotArray(node)) return fail("malformed confidentiality term");
  // Defense in depth against a wire spec that bypassed validation: a dual-op
  // node must refuse, never be resolved by this dispatch's key precedence
  // (the validator and the static analysis each have their own).
  const amb = ambiguousOpReason(node, "confidentiality");
  if (amb) return fail(amb);
  if ("anyOf" in node) {
    const terms = node.anyOf;
    if (!Array.isArray(terms)) return fail("malformed any()");
    // One OR-clause: the alternatives are the union of what each term
    // evaluates to (a `principal(match)` may yield several INDEPENDENT
    // readers — a disjunction, which flattens correctly). The clause is ONE
    // element of the row's conjunctive confidentiality list, so an enclosing
    // `all(...)` concatenates it with sibling clauses (`all(any(A,B), C)` →
    // `[{anyOf:[A,B]}, C]` = (A∨B)∧C). Kept structural, never flattened into
    // bare atoms (Epic E1, CFC spec §3.1.8). Defense in depth against a wire
    // spec that bypassed validation: reject a CONJUNCTION (`all()`) or nested
    // `any()` as an alternative — union-flattening it would silently widen
    // `(A∧B)∨C` into `A∨B∨C` (readable by A alone).
    const alternatives: unknown[] = [];
    for (const t of terms) {
      if (anyOfAlternativeHasConjunction(t)) {
        return fail(
          "an any() alternative must not be all()/any() (directly or under " +
            "a when() gate) — a conjunction cannot be an OR-clause " +
            "alternative (CFC spec §3.1.8)",
        );
      }
      alternatives.push(...evalConf(t, row, ctx));
    }
    return [{ anyOf: alternatives }];
  }
  if ("allOf" in node) {
    const terms = node.allOf;
    if (!Array.isArray(terms)) return fail("malformed all()");
    return terms.flatMap((t) => evalConf(t, row, ctx));
  }
  if ("principal" in node) {
    return evalPrincipal(node.principal as Record<string, unknown>, row);
  }
  if ("dbOwner" in node) {
    return ctx.dbOwner !== undefined ? [ctx.dbOwner] : fail(
      "dbOwner() has no owner in the evaluation context",
    );
  }
  if ("constant" in node) return [node.constant];
  if ("when" in node) {
    return evalTest(node.when, row)
      ? evalConf((node as { then?: unknown }).then, row, ctx)
      : [];
  }
  return fail(unknownOp(node, "confidentiality"));
}

function evalInteg(
  node: unknown,
  row: Record<string, unknown>,
  ctx: { dbOwner?: string },
): unknown[] {
  if (!isObjectNotArray(node)) return fail("malformed integrity term");
  const amb = ambiguousOpReason(node, "integrity");
  if (amb) return fail(amb);
  if ("anyOf" in node) return fail("disjunctive integrity does not exist");
  if ("authoredBy" in node || "endorsedBy" in node) {
    const kind = "authoredBy" in node
      ? "claimed-authored-by"
      : "claimed-endorsed-by";
    const inner = (node.authoredBy ?? node.endorsedBy) as Record<
      string,
      unknown
    >;
    const subjects = evalPrincipal(
      inner.principal as Record<string, unknown>,
      row,
    );
    if (subjects.length > 1) {
      return fail(
        `${subjects.length} matches in an integrity-bearing position — a ` +
          "provenance subject must be unique (display-name bait); fail closed",
      );
    }
    // Zero matches: the claim simply is not made (distinct from >1 = error).
    return subjects.map((subject) => ({ kind, subject }));
  }
  if ("intersect" in node) {
    const terms = node.intersect;
    if (!Array.isArray(terms) || terms.length === 0) {
      return fail("malformed intersect()");
    }
    const lists = terms.map((t) => evalInteg(t, row, ctx));
    return lists.reduce((acc, list) => {
      const keys = new Set(list.map(atomKey));
      return acc.filter((a) => keys.has(atomKey(a)));
    });
  }
  if ("allOf" in node) {
    const terms = node.allOf;
    if (!Array.isArray(terms)) return fail("malformed all()");
    return terms.flatMap((t) => evalInteg(t, row, ctx));
  }
  if ("when" in node) {
    return evalTest(node.when, row)
      ? evalInteg((node as { then?: unknown }).then, row, ctx)
      : [];
  }
  if ("constant" in node) return [node.constant];
  return fail(unknownOp(node, "integrity"));
}

/**
 * Evaluate a rowLabel spec against a row's column values. Fail-closed: any
 * unresolvable input, malformed node, or policy violation returns `{error}` —
 * never a partial label. Callers turn `{error}` into a refused query /
 * rejected write.
 */
export function evaluateRowLabel(
  spec: RowLabelSpec,
  row: Record<string, unknown>,
  ctx: { dbOwner?: string },
):
  | { confidentiality: unknown[]; integrity: unknown[] }
  | { error: string } {
  if (!isObjectNotArray(spec) || spec.version !== 1) {
    return {
      error: `unsupported rowLabel version ${
        JSON.stringify(isObjectNotArray(spec) ? spec.version : spec)
      }`,
    };
  }
  try {
    const confidentiality = spec.confidentiality !== undefined
      ? dedup(evalConf(spec.confidentiality, row, ctx))
      : [];
    const integrity = spec.integrity !== undefined
      ? dedup(evalInteg(spec.integrity, row, ctx))
      : [];
    return { confidentiality, integrity };
  } catch (error) {
    if (error instanceof RowLabelEvalError) return { error: error.message };
    throw error;
  }
}

// The STATIC UNCONDITIONAL readers of one confidentiality conjunct — atoms
// guaranteed (for EVERY row, without data dependence) to satisfy that clause:
// `dbOwner()` and `constant()`, including such alternatives of an `any()`.
// A `principal(match)` is data-dependent (varies per row) and a `when()` is
// conditional, so neither contributes. Used by `ruleCommonAlternatives`.
function staticUnconditionalAlternatives(
  node: unknown,
  ctx: { dbOwner?: string },
): unknown[] {
  if (!isObjectNotArray(node)) return [];
  // A dual-op node is ambiguous (the evaluator dispatches by a DIFFERENT key
  // precedence — e.g. {principal, dbOwner} labels rows with only the
  // principal): it contributes no static reader, so the aggregate refuses.
  if (presentOps(node).length > 1) return [];
  if (node.dbOwner === true) {
    return ctx.dbOwner !== undefined ? [ctx.dbOwner] : [];
  }
  if ("constant" in node) return [node.constant];
  if ("anyOf" in node && Array.isArray(node.anyOf)) {
    return node.anyOf.flatMap((alt) =>
      staticUnconditionalAlternatives(alt, ctx)
    );
  }
  return [];
}

// Flatten a confidentiality expression into its conjunctive clauses, descending
// through nested `all(...)` (allOf) levels: `all(all(A, B), C)` is the three
// conjuncts A, B, C. Both consumers below reason per-conjunct, so a nested
// conjunction must not hide a clause — a one-level flatten would treat
// `all(A, B)` as one opaque term with no static reader and refuse an aggregate
// that is in fact satisfiable. Leaves (anyOf/principal/when/dbOwner/constant)
// pass through unchanged; an `any(...)` never wraps an `allOf` (E1 rejects that
// at authoring), so only allOf nesting needs flattening. Only a PURE allOf node
// unwraps: a dual-op wrapper ({allOf, constant}) stays one opaque conjunct so
// it reaches the ambiguity guard in `staticUnconditionalAlternatives` instead
// of silently shedding the smuggled sibling op — and an ambiguous
// {allOf: [], constant} keeps counting as a constraint rather than reading as
// the degenerate empty conjunction (which would make an aggregate public).
function flattenConfConjuncts(conf: unknown): unknown[] {
  return isObjectNotArray(conf) && Array.isArray(conf.allOf) &&
      presentOps(conf).length === 1
    ? conf.allOf.flatMap(flattenConfConjuncts)
    : [conf];
}

/**
 * The atoms that are a reader of EVERY row this rule could label — the
 * "common-alternative" set (CFC spec §8.17.4, Epic E2). An atom is common iff
 * it is a static unconditional reader of every conjunctive clause of the rule
 * (the intersection across conjuncts). Only `dbOwner()`/`constant()` qualify;
 * a rule with any purely data-dependent conjunct (`principal(match)` — the
 * conjunctive email form) has NO common alternative, correctly. A member of
 * this set satisfies the join of all row labels, so it can soundly read a
 * COUNT/SUM aggregate over the table with no declassification.
 */
export function ruleCommonAlternatives(
  spec: RowLabelSpec,
  ctx: { dbOwner?: string },
): unknown[] {
  const conf = isObjectNotArray(spec) ? spec.confidentiality : undefined;
  if (conf === undefined) return [];
  const conjuncts = flattenConfConjuncts(conf);
  if (conjuncts.length === 0) return [];
  let common: Map<string, unknown> | undefined;
  for (const c of conjuncts) {
    const alts = new Map<string, unknown>();
    for (const a of staticUnconditionalAlternatives(c, ctx)) {
      alts.set(atomKey(a), a);
    }
    if (alts.size === 0) return []; // this clause has no guaranteed reader
    common = common === undefined
      ? alts
      : new Map([...common].filter(([k]) => alts.has(k)));
    if (common.size === 0) return [];
  }
  return common === undefined ? [] : [...common.values()];
}

/**
 * Whether a rule imposes any confidentiality constraint on its rows — its
 * confidentiality expression has at least one conjunctive clause. An
 * integrity-only rule (no `confidentiality`) or a degenerate empty conjunction
 * (`all()` — readable by everyone) constrains nothing, so an aggregate over
 * such a table carries no confidentiality (E2, CFC spec §8.17.4). This is the
 * distinction `ruleCommonAlternatives` alone cannot make: it returns `[]` both
 * here (no constraint → aggregate is public) AND when a rule DOES constrain but
 * shares no guaranteed reader (that case must refuse). Callers intersecting
 * across tables must skip unconstrained rules, not treat them as a refusal.
 */
export function ruleConstrainsConfidentiality(spec: RowLabelSpec): boolean {
  const conf = isObjectNotArray(spec) ? spec.confidentiality : undefined;
  if (conf === undefined) return false;
  return flattenConfConjuncts(conf).length > 0;
}

/** The rule attached to a (possibly wire-supplied) table schema, or undefined.
 *  Presence gates all Phase 3 work, so rule-less tables pay nothing. */
export function rowLabelSpecOf(tableSchema: unknown): RowLabelSpec | undefined {
  if (!isObjectNotArray(tableSchema)) return undefined;
  const spec = tableSchema.rowLabel;
  return isObjectNotArray(spec) ? spec as unknown as RowLabelSpec : undefined;
}

/**
 * The column names a rule reads (its input columns), in walk order, deduped.
 * The read side locates each of these in the projection by TRUE origin
 * `(table, column)` — never by output name — and refuses when one is missing
 * or ambiguous.
 */
export function ruleInputFields(spec: RowLabelSpec): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    if (!isObjectNotArray(n)) return;
    const m = n.match;
    if (
      isObjectNotArray(m) && typeof m.field === "string" && !seen.has(m.field)
    ) {
      seen.add(m.field);
      out.push(m.field);
    }
    for (const v of Object.values(n)) walk(v);
  };
  walk(spec.confidentiality);
  walk(spec.integrity);
  return out;
}
