/**
 * The plan a bulk piece operation runs from, and its on-disk form.
 *
 * A plan is a header plus one row per piece. Each row names a piece, the state
 * it must be in for the operation to apply (`expect`), and — once an operation
 * is chosen — what to do to it (`op`). A survey emits rows with `expect` alone;
 * a later pass adds the `op`. The rollback of a retarget plan is derived from
 * these rows rather than surveyed again, which is why a row records both the
 * identity the piece is on and, for a retarget, the identity its source
 * produces.
 *
 * The on-disk form is line-oriented JSON: the header on the first line, then
 * one object per row, and **line order is execution order**. That keeps the
 * ordering constraint — children before the holder — in the artifact a reviewer
 * reads, and lets a reader check it without running anything. The design is in
 * [docs/plans/piece-bulk-operations.md](../../../../docs/plans/piece-bulk-operations.md).
 */

import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { hashStringForEntityAddress } from "@commonfabric/runner/entity-kind";
import { isObjectNotArray } from "@commonfabric/utils/types";

/**
 * The canonical spelling of a piece address: the bare tagged-hash form every
 * survey row carries. The `of:` URI alias names the same entity and folds to
 * it here, so two spellings of one piece cannot slip past a uniqueness check
 * or a diff key. What remains after the fold must parse as a tagged content
 * hash — an empty or arbitrary string is refused, not carried. A kinded
 * (`computed:`) address is refused by the underlying parser — the `of:` id
 * over the same hash names a different entity.
 */
export function canonicalPieceAddress(address: string): string {
  const bare = hashStringForEntityAddress(address);
  try {
    // The parsed hash's own spelling, not the input's: padded and other
    // non-canonical base64 spellings of one hash must land on one key.
    return FabricHash.fromString(bare).taggedHashString;
  } catch {
    throw new Error(`Not a piece address: ${JSON.stringify(address)}.`);
  }
}

/** One piece and what went wrong with it — unreadable, or failing a validator. */
export interface SurveyProblem {
  piece: string;
  problem: string;
}

/** A registered in-scope piece the selection does not cover. */
export interface RegisteredOutside {
  piece: string;
  patternIdentity: string;
  symbol: string;
}

/** What a plan row requires of its piece before its operation applies. */
export interface PieceExpect {
  /** The pattern identity the piece is currently on. */
  patternIdentity: string;

  /**
   * The export the identity runs. The runtime's executable pointer is the
   * `{identity, symbol}` pair — two patterns exported by one module share an
   * identity and differ only here — so every comparison a plan feeds carries
   * both halves.
   */
  symbol: string;

  /**
   * Whether the source behind `patternIdentity` is verifiably retained in
   * the space — the canonical loader can produce its closure — and so is a
   * usable restore target. A row whose prior source is not has no rollback
   * target, which a run has to know before it starts rather than during an
   * incident.
   */
  retained: boolean;

  /**
   * The origin the piece followed when the survey read it, exactly as the
   * piece records it; absent when it was detached then.
   *
   * A record of what the plan was built against, and no claim about what any
   * later run does. A retarget detaches the origin the piece holds when its
   * write commits, which is this one only while nothing moved it in between
   * — and only the reference pair is a precondition, so a piece whose origin
   * alone moved is still written. What a run detached rides its own report
   * row as `ApplyRow.detachedOrigin`
   * ([bulk-apply.ts](./bulk-apply.ts)), and that is the value to re-attach
   * from; this one disagreeing with it is what tells an operator the plan
   * had gone stale.
   *
   * The recorded spelling alone. `PieceOrigin` carries two more fields, the
   * canonical URL and the kind, and `classifyOrigin` derives both from this
   * string — the URL against the host this deployment routes the space to —
   * so recording either would put a re-derivable fact in the artifact in a
   * spelling that reads differently elsewhere. `RestoreOutcome.origin`
   * spells the same fact the same way.
   */
  origin?: string;

  /**
   * The revision the piece is at, when it already keeps a source-revision log.
   * A piece with no log yet — a legacy piece — has none until its first
   * transition appends a baseline revision, so a survey cannot read one for it.
   */
  revisionId?: string;

  /**
   * The hash of the piece's stored input document, recorded by a repair's
   * dry run. It is the repair row's precondition the way the reference pair
   * is a retarget row's: the apply refuses a row whose stored document no
   * longer hashes to it, because a document something else moved is a stop,
   * not an overwrite.
   */
  documentHash?: string;
}

/** Replace a piece's source with the program a local source closure produces. */
export interface RetargetOp {
  kind: "retarget";

  /** The source closure to apply, as the local-program inputs that name it. */
  source: RetargetSource;

  /**
   * A human-facing label for the source's provenance — a git rev, say. Recorded
   * for readers and for diffing two plans; never enforced. The identity is the
   * pin: the apply recomputes the resolved source's identity and refuses the
   * row if it differs from `patternIdentity`.
   */
  rev?: string;

  /** The identity the source produces, computed from the source, not compiled. */
  patternIdentity: string;

  /** The export the retarget runs: the source's `mainExport`, or the default. */
  symbol: string;

  /**
   * Whether this row may apply with the pattern and retained-link compatibility
   * checks disabled. A field on the row so a reviewer sees which rows ran with
   * the gate open; a flag at plan time is what stamps it across a run.
   */
  allowIncompatible?: boolean;
}

/** The local-source inputs that name a program to retarget onto. */
export interface RetargetSource {
  /** The entry module path. */
  main: string;

  /** The source root, when it is not the entry's own directory. */
  root?: string;

  /** Test entry paths to include in the closure. */
  testPaths?: readonly string[];

  /** Data file paths to attach and classify as data. */
  dataFilePaths?: readonly string[];

  /** The entry export to run, when it is not the default. */
  mainExport?: string;
}

/**
 * Return a piece to a retained revision — the reversal of a retarget.
 *
 * A restore carries no compatibility override. Returning to a reference the
 * piece already ran can still be refused — the piece's documents have moved
 * on since, and the restored source may not accept what they now hold — but
 * a refusal there is a stop naming the piece and the reason, not a gate to
 * open. Getting one piece back over that refusal means retargeting it onto
 * that source, where the row-level override already lives and is recorded
 * per row. A field here would make the decision a property of the
 * derivation instead, which is the many-decisions-as-one risk that override
 * exists to avoid.
 */
export interface RestoreOp {
  kind: "restore";

  /**
   * The identity the retained revision carries. For a legacy piece whose
   * baseline the retarget itself appended, this is the identity the survey
   * recorded in the retarget row's `expect`; the run resolves it to the
   * revision retaining that identity's source.
   */
  patternIdentity: string;

  /** The export the restored revision runs — the pair's other half. */
  symbol: string;

  /**
   * The revision to restore, when the survey read one — a piece that already
   * kept a log at survey time. Absent for a baseline the retarget appends,
   * where `patternIdentity` selects the revision instead.
   */
  revisionId?: string;
}

/**
 * Run a caller-supplied fixer over the piece's stored input document. The
 * fixer itself is a TypeScript module the run imports; the row's
 * enforceable halves are `expect.documentHash`, which pins the document
 * the fixer's answer was computed from, and `fixerIdentity`, which pins
 * the implementation itself. The name is for readers and for diffing.
 */
export interface RepairOp {
  kind: "repair";

  /** The fixer's name as supplied — a module path or label; never resolved. */
  fixer: string;

  /**
   * The content identity of the fixer module's authored closure — the same
   * no-compile identity a retarget's source carries — which is the pin the
   * name cannot be: a path re-resolved elsewhere, or a file edited after
   * review, changes this and the apply refuses the plan. Required: a
   * repair row without it is a plan nothing can hold to what was
   * reviewed, so the codec refuses it rather than carrying a bypass.
   */
  fixerIdentity: string;
}

/** What a plan row does to its piece, absent on a survey-only row. */
export type PieceOp = RetargetOp | RestoreOp | RepairOp;

/** One piece in a plan: the piece, its precondition, and its operation. */
export interface PiecePlanRow {
  /**
   * The piece's canonical bare address (`fid1:…`). The `of:` alias names the
   * same piece and folds to this form at decode.
   */
  piece: string;

  /** A grouping label for reports and for stopping between groups; not a sort key. */
  phase?: string;

  expect: PieceExpect;
  op?: PieceOp;
}

/** The counts a survey compares to catch a selection that dropped members. */
export interface PlanEnumeration {
  /** Pieces the selection names: a collection's members, or a list's entries. */
  collection: number;

  /** Pieces the space's piece registry lists. */
  registry: number;

  /**
   * Registered pieces on an in-scope identity that the collection does not
   * hold. Any above zero is a selection error: the collection read dropped a
   * member, or a piece of the same kind lives outside the holder.
   */
  registeredOutside: number;
}

/** A plan's first line: what it is, and how its selection was cross-checked. */
export interface PiecePlanHeader {
  kind: "piece-plan";
  v: 1;

  /** The space every row's piece lives in. */
  space: string;

  /** When the survey behind the plan was taken, as an ISO-8601 string. */
  takenAt: string;

  /** Which selector produced the rows: a holder's collection, or a list. */
  selector: "collection" | "list";

  enumerated: PlanEnumeration;

  /**
   * Selected pieces the survey could not read into rows. Their absence from
   * `rows` would otherwise be invisible in the artifact, so an incomplete
   * survey stays incomplete across encode and decode; a write stage refuses
   * a plan carrying any.
   */
  problems?: readonly SurveyProblem[];

  /** Registered in-scope pieces the selection lacks — the same standing. */
  outside?: readonly RegisteredOutside[];
}

/** A header and its rows, in execution order. */
export interface PiecePlan {
  header: PiecePlanHeader;
  rows: readonly PiecePlanRow[];
}

/**
 * Render a plan as line-oriented JSON: the header, then one row per line, in
 * order. The result ends in a newline so it appends cleanly and reads as a
 * complete file.
 */
export function encodePlan(plan: PiecePlan): string {
  const lines = [JSON.stringify(plan.header)];
  for (const row of plan.rows) lines.push(JSON.stringify(row));
  return lines.join("\n") + "\n";
}

/**
 * Parse a plan from the form {@link encodePlan} writes. Blank lines are
 * ignored so a hand-edited file round-trips; every other line must be an
 * object, the first of them the `piece-plan` header. Row addresses fold to
 * the canonical bare spelling, and a plan listing one piece twice is
 * refused. Throws on a missing or wrong header, or a row that is not a
 * valid row — a malformed plan is refused rather than half-read.
 */
export function decodePlan(text: string): PiecePlan {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error("Plan is empty.");
  return normalizePlan({
    header: JSON.parse(lines[0]),
    rows: lines.slice(1).map((line) => JSON.parse(line)),
  });
}

/**
 * Validate an assembled plan against every invariant the codec holds, and
 * return it with each row's piece address canonical. This is the one
 * validator the decoder and the executors share: an in-memory plan handed
 * straight to a run gets exactly the scrutiny a decoded file gets, so no
 * caller can slip a shape past execution that the codec would have refused
 * — a repair row without its document hash, a duplicate piece, an invalid
 * row.
 */
export function normalizePlan(
  plan: { header: unknown; rows: readonly unknown[] },
): PiecePlan {
  if (!isPlanHeader(plan.header)) {
    throw new Error(
      'Plan does not start with a "piece-plan" v1 header line.',
    );
  }
  const rows = plan.rows.map((row, index) => {
    if (!isPlanRow(row)) {
      throw new Error(`Plan row ${index + 1} is not a valid row object.`);
    }
    return { ...row, piece: canonicalPieceAddress(row.piece) };
  });
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.piece)) {
      throw new Error(`Plan lists ${row.piece} more than once.`);
    }
    seen.add(row.piece);
  }
  return { header: plan.header, rows };
}

/**
 * What a derivation is allowed to leave out of the rollback it produces.
 */
export interface RollbackDerivationOptions {
  /**
   * Pieces the operator has accepted, by name, as ones this rollback cannot
   * return: their prior source is not retained, so no restore exists for
   * them. See {@link acceptUnretained} for the rule every acceptance is
   * held to.
   */
  accepted?: readonly string[];
}

/**
 * Hold a plan's unretained rows against the acceptances an operator named,
 * and return the accepted addresses in canonical form.
 *
 * A retarget row whose prior source is not retained is a piece that cannot
 * be returned once it moves. Both moments in the arc turn on it — the
 * forward run must not start over such a row, and the reversal cannot
 * derive one — so both hold acceptances to one rule, stated once here:
 *
 * - Every unretained row must be accepted by name, or the operation is
 *   refused naming the rows that are not. Accepting is per piece and there
 *   is deliberately no blanket form: one flag covering every row would turn
 *   many decisions into one, which is a different risk from the same
 *   decision taken many times.
 * - An acceptance that covers no unretained row of this plan is refused
 *   rather than ignored. The operator believes they have accounted for a
 *   piece, and accounting for none looks exactly like accounting for one.
 *
 * `lead` names the moment in the refusal, since the two read differently to
 * whoever is holding the plan.
 */
export function acceptUnretained(
  rows: readonly PiecePlanRow[],
  accepted: readonly string[] | undefined,
  lead: string,
): Set<string> {
  const named = new Set(
    (accepted ?? []).map((piece) => canonicalPieceAddress(piece)),
  );
  const unretained = rows.filter((row) =>
    row.op?.kind === "retarget" && !row.expect.retained
  );
  const covers = new Set(unretained.map((row) => row.piece));
  const idle = [...named].filter((piece) => !covers.has(piece));
  if (idle.length > 0) {
    throw new Error(
      `${lead}: nothing accepts as unrollbackable for ` + idle.join(", ") +
        " — no retarget row of this plan names them with an unretained " +
        "prior source.",
    );
  }
  const refused = unretained.filter((row) => !named.has(row.piece));
  if (refused.length > 0) {
    throw new Error(
      `${lead}: the prior source is not retained for ` +
        refused.map((row) => row.piece).join(", ") +
        ", so a move could not be reversed. Supply the legacy source for " +
        "each, or accept each by name.",
    );
  }
  return named;
}

/**
 * Derive the rollback of a retarget plan, row by row: the precondition
 * becomes the reference the retarget produced, and the operation restores the
 * retained revision carrying the reference the row recorded. Nothing is
 * re-surveyed or re-supplied. A plan whose header names pieces the survey
 * could not account for is refused before any row is read. Survey-only and
 * restore rows have nothing to roll back and are left out; a repair row is
 * refused by name, its reversal being an inverse fixer nothing can derive;
 * and a plan with no retarget rows at all is refused, because deriving an
 * empty rollback would read as having one.
 *
 * A retarget row whose prior source is not retained is refused by name
 * before any rollback row is produced: a restore of an unretained source is
 * an operation nothing can perform, and a plan carrying one would read as a
 * rollback while not being one. The operator's way past that is to name the
 * piece in `accepted`, which leaves it out — the other way being to supply
 * the legacy source and retarget onto it, which is a retarget plan and not
 * this derivation's business.
 *
 * A derived row's `retained` is true by construction: the retarget stored the
 * source it applied, so the reference it produced is a retained one.
 */
export function deriveRollbackPlan(
  plan: PiecePlan,
  takenAt: string,
  options: RollbackDerivationOptions = {},
): PiecePlan {
  if (
    (plan.header.problems?.length ?? 0) > 0 ||
    (plan.header.outside?.length ?? 0) > 0
  ) {
    throw new Error(
      "No rollback can be derived from an incomplete plan: its header " +
        "names pieces the survey did not account for.",
    );
  }
  const repairs = plan.rows.filter((row) => row.op?.kind === "repair");
  if (repairs.length > 0) {
    // A repair's reversal would be the inverse fixer, which does not exist;
    // silently dropping the rows would launder a partial rollback into a
    // complete-looking one.
    throw new Error(
      "No rollback can be derived: repair rows have no derivable " +
        "reversal — " + repairs.map((row) => row.piece).join(", ") + ".",
    );
  }
  const accepted = acceptUnretained(
    plan.rows,
    options.accepted,
    "No rollback can be derived",
  );
  const rows = plan.rows.flatMap((row): PiecePlanRow[] => {
    if (row.op?.kind !== "retarget" || accepted.has(row.piece)) return [];
    return [{
      piece: row.piece,
      ...(row.phase === undefined ? {} : { phase: row.phase }),
      // No `origin`: the retarget this reverses detached the piece, so a
      // detached piece is the precondition, and carrying the forward row's
      // origin would claim the reversal detaches something already gone.
      // Re-attaching is not the restore's to do either — a restore detaches
      // in its own right (`docs/specs/piece-source-lifecycle.md`), and the
      // only re-attachment the runtime has, `follow`, resolves the origin
      // NOW and adopts whatever source it currently ships, which is not the
      // reference a rollback promises to land.
      expect: {
        patternIdentity: row.op.patternIdentity,
        symbol: row.op.symbol,
        retained: true,
      },
      op: {
        kind: "restore",
        patternIdentity: row.expect.patternIdentity,
        symbol: row.expect.symbol,
        ...(row.expect.revisionId === undefined
          ? {}
          : { revisionId: row.expect.revisionId }),
      },
    }];
  });
  if (rows.length === 0) {
    throw new Error(
      accepted.size === 0
        ? "Plan has no retarget rows to derive a rollback from."
        : "Every retarget row of this plan was accepted as unrollbackable, " +
          "so the rollback would be empty — an empty rollback reads as " +
          "having one.",
    );
  }
  return {
    header: {
      ...plan.header,
      takenAt,
      // The derived plan's selection is its rows, not the survey's — a
      // header claiming the source plan's counts would read as a rollback
      // that dropped every op-less piece.
      enumerated: {
        collection: rows.length,
        registry: plan.header.enumerated.registry,
        registeredOutside: 0,
      },
    },
    rows,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isObjectNotArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/**
 * An optional field that names something — absent, or a nonempty string.
 * An empty name would round-trip through the codec but resolve nothing.
 */
function isOptionalName(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value !== "");
}

/** An enumeration count: a selection size no real selection can exceed. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0;
}

function isOptionalStringArray(
  value: unknown,
): value is readonly string[] | undefined {
  return value === undefined ||
    (Array.isArray(value) &&
      value.every((entry) => typeof entry === "string"));
}

function isPlanHeader(value: unknown): value is PiecePlanHeader {
  if (!isRecord(value)) return false;
  const enumerated = value.enumerated;
  if (
    value.kind !== "piece-plan" || value.v !== 1 ||
    typeof value.space !== "string" || typeof value.takenAt !== "string" ||
    (value.selector !== "collection" && value.selector !== "list") ||
    !isRecord(enumerated) ||
    !isCount(enumerated.collection) || !isCount(enumerated.registry) ||
    !isCount(enumerated.registeredOutside) ||
    !(value.problems === undefined ||
      (Array.isArray(value.problems) && value.problems.every(isProblem))) ||
    !(value.outside === undefined ||
      (Array.isArray(value.outside) && value.outside.every(isOutside)))
  ) return false;
  // The header states the outside fact twice — a count and a list — and a
  // plan where the two disagree has been hand-edited into a lie: deleting
  // the list must not launder an incomplete plan into a complete one.
  const outside = value.outside as readonly unknown[] | undefined;
  return enumerated.registeredOutside === (outside?.length ?? 0);
}

function isProblem(value: unknown): value is SurveyProblem {
  return isRecord(value) && typeof value.piece === "string" &&
    typeof value.problem === "string";
}

function isOutside(value: unknown): value is RegisteredOutside {
  return isRecord(value) && typeof value.piece === "string" &&
    typeof value.patternIdentity === "string" &&
    value.patternIdentity !== "" &&
    typeof value.symbol === "string" && value.symbol !== "";
}

function isPlanRow(value: unknown): value is PiecePlanRow {
  if (!isRecord(value)) return false;
  if (typeof value.piece !== "string") return false;
  if (
    value.phase !== undefined &&
    (typeof value.phase !== "string" || value.phase === "")
  ) return false;
  const expect = value.expect;
  if (
    !isRecord(expect) || typeof expect.patternIdentity !== "string" ||
    expect.patternIdentity === "" ||
    typeof expect.symbol !== "string" || expect.symbol === "" ||
    typeof expect.retained !== "boolean" ||
    !isOptionalName(expect.origin) ||
    !isOptionalName(expect.revisionId) ||
    !isOptionalName(expect.documentHash)
  ) return false;
  if (value.op === undefined) return true;
  if (!isPieceOp(value.op)) return false;
  if (value.op.kind === "repair") {
    // A repair row's verifiable half is the document hash: without one the
    // row cannot be resumed or verified from the artifact, so the codec
    // requires it rather than carrying a row no run could check.
    return typeof expect.documentHash === "string" &&
      expect.documentHash !== "";
  }
  // A row whose operation produces the reference the row already records is
  // unverifiable: a diff could not tell "landed" from "never ran". Such a
  // row is a no-op to drop, not an operation to carry.
  return value.op.patternIdentity !== expect.patternIdentity ||
    value.op.symbol !== expect.symbol;
}

function isPieceOp(value: unknown): value is PieceOp {
  if (!isRecord(value)) return false;
  if (value.kind === "repair") {
    return typeof value.fixer === "string" && value.fixer !== "" &&
      typeof value.fixerIdentity === "string" && value.fixerIdentity !== "";
  }
  if (
    typeof value.patternIdentity !== "string" ||
    value.patternIdentity === "" ||
    typeof value.symbol !== "string" || value.symbol === ""
  ) return false;
  if (value.kind === "restore") return isOptionalName(value.revisionId);
  if (value.kind !== "retarget") return false;
  const source = value.source;
  if (!isRecord(source) || typeof source.main !== "string") return false;
  const mainExport = source.mainExport;
  // An empty export name is refused rather than read as the default: the
  // resolver drops a falsy export and runs the default, so a row carrying
  // one would execute something its own text does not say.
  if (!isOptionalString(mainExport) || mainExport === "") return false;
  // The symbol is what diff and rollback compare; the source's export is what
  // an apply resolves. A row where the two disagree would land one pattern
  // and verify another, so the codec refuses it.
  if (value.symbol !== (mainExport ?? "default")) return false;
  return isOptionalString(source.root) &&
    isOptionalStringArray(source.testPaths) &&
    isOptionalStringArray(source.dataFilePaths) &&
    isOptionalString(value.rev) &&
    (value.allowIncompatible === undefined ||
      typeof value.allowIncompatible === "boolean");
}
