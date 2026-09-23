/**
 * Bulk repair: a caller-supplied fixer — a pure transform from a piece's
 * stored input document to the document it should hold — iterated over a
 * selection by the same spine the survey walks. The tooling owns selection,
 * ordering, the write, the stop, and resume; the fixer owns only what the
 * change is (docs/plans/piece-bulk-operations.md, stage 2).
 *
 * The fixer is its own predicate. A piece the fixer would not change needs
 * nothing, so selection ("keep what it would change"), resume ("already
 * repaired reads as unchanged"), and verification ("re-running over the
 * stored result is a no-op") are one mechanism, and none of them can drift
 * from what the fixer does because they are what the fixer does. That is
 * why a fixer must be a pure function of the document, and why this module
 * probes the purity it cannot prove: every evaluation runs the fixer twice
 * and refuses an answer that differs.
 *
 * The write is the wide one — the whole input document replaced — made safe
 * by refusals rather than by narrowing: a document that lost a field the
 * fixer never mentioned is a defect, not an intent, and a reference
 * rewritten as a value or dropped is corruption either way. The apply is
 * transactional: the fixer is re-evaluated against the document the commit
 * actually sees, so a concurrent edit conflicts and re-runs rather than
 * being overwritten. A stored document is a `FabricValue` — references as
 * sigil links, and special values such as bytes as class instances — so
 * every copy, comparison, and hash below goes through the data-model's own
 * primitives, and the walkers treat anything that is not a plain record or
 * a direct array as one atomic value.
 *
 * The run's record is the plan artifact: each evaluated row carries the
 * hash of the document its answer was computed from, which is the repair
 * row's precondition the way the reference pair is a retarget row's.
 */

import type { FabricValue } from "@commonfabric/api";
import {
  cloneIfNecessary,
  hashStringOf,
  isFabricPlainObject,
  isValidFabricValue,
  valueEqual,
} from "@commonfabric/data-model";
import { isLink } from "@commonfabric/runner";
import { isPlainObject } from "@commonfabric/utils/types";

import {
  normalizePlan,
  type PiecePlan,
  type PiecePlanRow,
} from "./bulk-plan.ts";
import {
  HOLDER_PHASE,
  type PieceSelector,
  surveyPieces,
} from "./bulk-survey.ts";
import type { PiecesController } from "./pieces-controller.ts";

/**
 * A fixer: a pure transform from a piece's stored input document to the
 * document it should hold. It receives the raw stored document — sigil
 * links and Fabric special values included — and returns the complete
 * document, never a fragment. Purity is part of the contract, not a style
 * preference: the run answers selection, resume, and verification by
 * re-asking the fixer, the transactional apply re-runs it against the
 * document the commit sees, and a fixer that reads a clock or a random
 * source makes every one of those answers wrong.
 */
export type Fixer = (
  document: Readonly<Record<string, unknown>>,
) => Record<string, unknown>;

/**
 * One difference between a stored document and a fixer's answer. `changed`
 * carries both sides; `added` is a position the answer holds and the stored
 * document does not, `removed` the reverse — presence is its own fact, not
 * an `undefined` standing in for one.
 */
export interface DocumentChange {
  /**
   * The position as a JSON Pointer: `""` is the root, and every non-root
   * position leads with `/` — so the root and a top-level empty-string key
   * (`"/"`) stay distinct. A segment's own `/` is escaped `~1` and `~`
   * escaped `~0`.
   */
  path: string;

  kind: "changed" | "added" | "removed";
  before?: unknown;
  after?: unknown;
}

/**
 * One piece's outcome. `conforms` and `would-change` are the dry verdicts;
 * an apply turns `would-change` into `repaired` — or `failed`, when the
 * stored document does not satisfy the fixer after the write, or when an
 * operational error interrupted the row. `refused` is the fixer breaking
 * its contract on this piece's document; `moved` is a supplied plan's
 * document-hash precondition no longer holding, which is a stop rather
 * than an overwrite; `unattempted` names the rows after an apply stopped.
 */
export type RepairVerdict =
  | "conforms"
  | "would-change"
  | "repaired"
  | "refused"
  | "moved"
  | "failed"
  | "unattempted";

/** One piece's row in a repair report. */
export interface RepairRow {
  piece: string;

  /** The plan row's phase label, carried as the survey stamped it. */
  phase?: string;

  verdict: RepairVerdict;

  /** What a refused, moved, or failed row broke; absent otherwise. */
  problem?: string;

  /** The exact changes the fixer would make (or made); absent when none. */
  changes?: readonly DocumentChange[];

  /**
   * The hash of the stored document this row's verdict was computed from —
   * the precondition a plan row carries. Absent where no document was read.
   */
  documentHash?: string;
}

/** What one repair run found, and — under `apply` — did. */
export interface RepairReport {
  rows: readonly RepairRow[];

  /**
   * The run as a plan artifact: the survey's header, and one row per
   * evaluated piece carrying its document-hash precondition — with the
   * repair operation stamped when the run was given a fixer name to record.
   */
  plan: PiecePlan;

  /** Documents written. Zero on a dry run and on a conforming re-run. */
  applied: number;

  /**
   * True when every row is `conforms` or `repaired`: nothing refused,
   * nothing moved, nothing failed, nothing unattempted. A dry run is
   * complete when nothing refused or failed — `would-change` is its
   * answer, not a defect.
   */
  complete: boolean;
}

export interface RepairOptions {
  selector: PieceSelector;
  fixer: Fixer;

  /**
   * Called with each row as it settles, in the order the run settles them.
   *
   * The same seam the retarget's engine offers, and for the same reason: a
   * caller watching rows can say where a run that never returned had reached,
   * and one that is not watching can only say it does not know.
   */
  onRow?: (row: RepairRow) => void;

  /**
   * The fixer's name as the plan should record it — a module path or a
   * label. With one, the emitted plan's evaluated rows carry the repair
   * operation; without, they carry only the pre-state record.
   */
  fixerName?: string;

  /**
   * The content identity of the fixer module's authored closure — the pin
   * the name cannot be. Recorded on every emitted repair op, and held
   * against a supplied plan's recorded identities: a plan reviewed against
   * one implementation must not execute another, however the file is
   * spelled or what it holds today.
   */
  fixerIdentity?: string;

  /**
   * A previously emitted plan, which then IS the execution: its rows run
   * in its order, each row's recorded document hash is its precondition,
   * and the plan must agree with this run — same space, same fixer name,
   * and exactly the selection's pieces, a stale plan being regenerated
   * rather than silently reconciled. A row whose stored document still
   * needs the repair but no longer hashes to what the plan recorded is
   * `moved` — something other than this plan changed it — while a row the
   * fixer no longer changes is landed, whatever it hashes to now.
   */
  plan?: PiecePlan;

  /**
   * Write the documents the fixer produces. Absent, the run is the
   * dry-run report — the exact per-piece diff, and no write at all.
   */
  apply?: boolean;
}

/**
 * Hold a plan's rows to the run's fixer — every row must carry a repair
 * operation, its recorded name must match, and its implementation pin must
 * match. Exported apart from execution so a command seam can hold the pin
 * BEFORE the fixer module is imported: a dynamic import runs top-level
 * code, and an implementation the plan's reviewer never saw must not run
 * even that much. `repairPieces` applies the same gate behind the seam.
 *
 * A zero-row plan is refused here outright: it pins nothing, so this gate
 * would hold nothing, and a caller with a legitimately empty run has no
 * fixer to gate — it skips the gate and the import both.
 */
export function assertPlanRunsFixer(
  plan: PiecePlan,
  fixerName: string,
  fixerIdentity: string,
): void {
  if (plan.rows.length === 0) {
    throw new Error(
      "A zero-row plan pins no fixer, so nothing can be gated against it.",
    );
  }
  const unrunnable = plan.rows.filter((row) => row.op?.kind !== "repair");
  if (unrunnable.length > 0) {
    throw new Error(
      "The plan carries rows with no repair operation, which cannot be " +
        "executed or precondition-checked: " +
        unrunnable.map((row) => row.piece).join(", ") + ".",
    );
  }
  const disagreeing = plan.rows.filter((row) =>
    row.op?.kind === "repair" && row.op.fixer !== fixerName
  );
  if (disagreeing.length > 0) {
    throw new Error(
      `The plan records a different fixer than this run supplies ` +
        `(${fixerName}) on: ` +
        disagreeing.map((row) => row.piece).join(", ") + ".",
    );
  }
  const repinned = plan.rows.filter((row) =>
    row.op?.kind === "repair" && row.op.fixerIdentity !== fixerIdentity
  );
  if (repinned.length > 0) {
    // The name matching is not the pin: the file behind it may have
    // changed since the plan was reviewed, and a reviewed plan must not
    // execute an implementation nobody reviewed.
    throw new Error(
      "The plan pins a different fixer implementation than this run " +
        "supplies, on: " + repinned.map((row) => row.piece).join(", ") +
        ".",
    );
  }
}

/** How one evaluation of the fixer over one document came out. */
export type FixerOutcome =
  | { kind: "conforms" }
  | {
    kind: "change";
    document: Record<string, unknown>;
    changes: readonly DocumentChange[];
  }
  | { kind: "refused"; problem: string };

/**
 * The plain-record arm of a stored document: an `Object.prototype`-rooted
 * (or null-prototype) record. A Fabric special value — bytes, a hash, an
 * epoch — is a class instance, holds its state privately, and answers
 * `Object.keys` with nothing, so a walker that descended into one would
 * read every one as empty: they are atomic values here, never containers.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

/** Structural equality over stored values, Fabric specials included. */
function storedEqual(a: unknown, b: unknown): boolean {
  return valueEqual(a as FabricValue, b as FabricValue);
}

/** One path segment, display-escaped in the JSON Pointer spelling. */
function escapeSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Segments as a JSON Pointer: `""` for the root, `/`-led otherwise. */
function displayPath(segments: readonly string[]): string {
  return segments.map((segment) => `/${escapeSegment(segment)}`).join("");
}

/**
 * Every path in `node` that holds a sigil link, in traversal order. Paths
 * are segment arrays rather than joined strings, so a key containing the
 * display separator addresses its own slot and nobody else's.
 */
export function collectLinkPaths(
  node: unknown,
  path: readonly string[] = [],
  found: (readonly string[])[] = [],
): readonly (readonly string[])[] {
  if (isLink(node)) {
    found.push(path);
    return found;
  }
  if (!isPlainRecord(node) && !Array.isArray(node)) return found;
  for (const [key, value] of Object.entries(node)) {
    collectLinkPaths(value, [...path, key], found);
  }
  return found;
}

/** The value at a segment path, or `undefined` where the path breaks. */
function valueAtPath(node: unknown, path: readonly string[]): unknown {
  let current: unknown = node;
  for (const segment of path) {
    if (!isPlainRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Paths the fixer's answer lost, recursively: an input record's own key
 * absent from the answer — or present as `undefined`, which the write
 * treats the same — wherever both sides keep a plain record, or an equally
 * long array, at the same position. Recursion stops where the shapes part:
 * replacing a container outright is an act the diff reports as a change,
 * while omitting fields from one that survives is the fragment accident
 * this check exists to refuse. Link nodes are the links-intact check's to
 * judge, and a Fabric special value is one value, so neither is descended.
 */
function lostFields(
  before: unknown,
  after: unknown,
  path: readonly string[] = [],
  out: string[] = [],
): readonly string[] {
  if (isLink(before)) return out;
  if (isPlainRecord(before) && isPlainRecord(after)) {
    for (const key of Object.keys(before)) {
      const beforeValue = before[key];
      if (
        !Object.hasOwn(after, key) ||
        (after[key] === undefined && beforeValue !== undefined)
      ) {
        out.push(displayPath([...path, key]));
        continue;
      }
      lostFields(beforeValue, after[key], [...path, key], out);
    }
    return out;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    // An array may legitimately shrink — a dedup is a repair — but the
    // elements that survive at overlapping positions keep their own
    // fields, whatever happened to the length.
    const overlap = Math.min(before.length, after.length);
    for (let index = 0; index < overlap; index += 1) {
      lostFields(before[index], after[index], [...path, String(index)], out);
    }
  }
  return out;
}

/**
 * The differences between two documents, as change rows with presence its
 * own fact. A position whose two sides are both plain records, or both
 * direct arrays, recurses; anything else that differs — a Fabric special
 * value included — is one change at that position, so a replaced container
 * reads as one change rather than as its every leaf.
 */
export function documentChanges(
  before: unknown,
  after: unknown,
  path: readonly string[] = [],
  out: DocumentChange[] = [],
): readonly DocumentChange[] {
  if (storedEqual(before, after)) return out;
  const bothRecords = isPlainRecord(before) && isPlainRecord(after);
  const bothArrays = Array.isArray(before) && Array.isArray(after);
  if (!bothRecords && !bothArrays) {
    out.push({ path: displayPath(path), kind: "changed", before, after });
    return out;
  }
  if (bothArrays) {
    // Positions, not enumerable keys: a sparse array is a valid stored
    // value and its holes are exactly what a key walk skips, so presence
    // here is "the position exists" (`index < length`, a hole reading
    // `undefined`) — a lost tail is removals, a grown one additions, and
    // two unequal arrays can never diff to nothing.
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      const at = [...path, String(index)];
      if (index >= after.length) {
        out.push({
          path: displayPath(at),
          kind: "removed",
          before: before[index],
        });
        continue;
      }
      if (index >= before.length) {
        out.push({ path: displayPath(at), kind: "added", after: after[index] });
        continue;
      }
      documentChanges(before[index], after[index], at, out);
    }
    return out;
  }
  const beforeRecord = before as Record<string, unknown>;
  const afterRecord = after as Record<string, unknown>;
  const keys = new Set([
    ...Object.keys(beforeRecord),
    ...Object.keys(afterRecord),
  ]);
  for (const key of keys) {
    const hasBefore = Object.hasOwn(beforeRecord, key);
    const hasAfter = Object.hasOwn(afterRecord, key);
    const at = [...path, key];
    if (hasBefore && !hasAfter) {
      out.push({
        path: displayPath(at),
        kind: "removed",
        before: beforeRecord[key],
      });
      continue;
    }
    if (!hasBefore && hasAfter) {
      out.push({
        path: displayPath(at),
        kind: "added",
        after: afterRecord[key],
      });
      continue;
    }
    documentChanges(beforeRecord[key], afterRecord[key], at, out);
  }
  return out;
}

/**
 * Run the fixer over one stored document and classify the answer. Pure —
 * no controller, no space — which is what lets a fixer's refusals be unit
 * tests. The document handed to each fixer call is a fresh unfrozen deep
 * copy through the data-model's own clone, so a fixer that mutates its
 * argument corrupts neither the purity probe nor the diff baseline, and a
 * Fabric special value arrives as itself rather than as an empty shell.
 */
export function evaluateFixer(
  document: Readonly<Record<string, unknown>>,
  fixer: Fixer,
): FixerOutcome {
  const copy = () =>
    cloneIfNecessary(document as FabricValue, {
      frozen: false,
    }) as Record<string, unknown>;
  let answer: unknown;
  try {
    answer = fixer(copy());
  } catch (error) {
    return {
      kind: "refused",
      problem: `The fixer threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!isPlainRecord(answer)) {
    return {
      kind: "refused",
      problem: "The fixer returned a value that is not a document.",
    };
  }
  // The store's own admission test, over the whole answer: a function, an
  // accessor, a class instance, an own constructor or __proto__ key — any
  // of them deep in the answer would pass a root-only look and then fail
  // at the write, after earlier rows had already landed. Preflight exists
  // to find exactly that before anything is written, so the admission
  // question is asked here, and a failure while classifying the answer is
  // a refusal too rather than an escape.
  try {
    if (!isValidFabricValue(answer)) {
      return {
        kind: "refused",
        problem: "The fixer returned a document the store cannot hold — a " +
          "function, an accessor, or a class instance somewhere in it.",
      };
    }
    // Detached before the probe's second run: a fixer that returns one
    // closure-owned object from every call would otherwise mutate its own
    // first answer into agreement with its second, and the probe would
    // compare an object with itself. The detached copy is also what a
    // change decision carries, so no alias the fixer still holds can
    // reach the write.
    const first = cloneIfNecessary(answer as FabricValue, {
      frozen: false,
    }) as Record<string, unknown>;
    let second: unknown;
    try {
      second = fixer(copy());
    } catch (error) {
      return {
        kind: "refused",
        problem: `The fixer threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (!storedEqual(first, second)) {
      return {
        kind: "refused",
        problem: "The fixer is not a pure function of the document: two " +
          "runs over one document answered differently.",
      };
    }
    // The write replaces the whole document, so a field the fixer's answer
    // lacks would be zeroed by it — a defect, never an intent — and a
    // nested field is as gone as a top-level one.
    const lost = lostFields(document, first);
    if (lost.length > 0) {
      return {
        kind: "refused",
        problem: `The fixer returned an incomplete document: ` +
          `${lost.join(", ")} would be lost by the write.`,
      };
    }
    // A reference either round-trips untouched or the document is refused:
    // a link rewritten as a value is corrupted and a dropped one is
    // destroyed, and neither is visible in the result until much later.
    for (const linkPath of collectLinkPaths(document)) {
      const kept = valueAtPath(first, linkPath);
      if (!storedEqual(valueAtPath(document, linkPath), kept)) {
        return {
          kind: "refused",
          problem: `The fixer rewrote or dropped the link at ` +
            `${linkPath.length === 0 ? "<root>" : displayPath(linkPath)}.`,
        };
      }
    }
    if (storedEqual(document, first)) return { kind: "conforms" };
    return {
      kind: "change",
      document: first,
      changes: documentChanges(document, first),
    };
  } catch (error) {
    return {
      kind: "refused",
      problem: `Classifying the fixer's answer failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/** What one pass over a piece's stored document decided. */
type RowDecision =
  | { kind: "not-document" }
  | { kind: "moved"; documentHash: string }
  | { kind: "conforms"; documentHash: string }
  | {
    kind: "change";
    documentHash: string;

    /** The stored document the decision was computed from — what an
     * applied row's changes are measured against, so the write path's own
     * additions show in the report. */
    before: Record<string, unknown>;

    /** The evaluated answer — the exact document a write must land, so
     * the report and the write cannot describe two different evaluations
     * of a fixer that lied to the purity probe. */
    document: Record<string, unknown>;

    changes: readonly DocumentChange[];
  }
  | { kind: "refused"; documentHash: string; problem: string };

/**
 * Iterate the fixer over a selection, serially, in survey order — dry by
 * default, writing under `apply`.
 *
 * Selection is the survey's: the same enumeration, and the same containment
 * gate, so a registered in-scope piece the collection lacks stops a repair
 * exactly the way it stops a survey — a run over a silent subset is the
 * failure this whole design exists to prevent. On a collection selector the
 * holder's own row is not repaired: the fixer is typed against the members'
 * document shape, and a holder wanting repair is a one-piece list selection
 * of its own.
 *
 * Under `apply`, every row is classified first, from one read each and
 * before anything is written — the spine's preflight — and a row that
 * moved, refuses, or cannot be read stops the run from starting at all,
 * with every row reporting its classification and nothing applied. The
 * serial pass then evaluates and writes each row in one transaction: the
 * fixer answers for the document the commit sees, so a concurrent edit
 * re-runs the evaluation rather than being overwritten. A supplied plan's
 * document hash is rechecked in that same transaction, and a mismatch is
 * `moved` — a stop, not an overwrite. The written document is then read
 * back and the fixer asked again — a repair succeeded when re-running the
 * fixer over the stored result is a no-op — and a refusal, a moved row, or
 * a failure stops the run with every remaining row named `unattempted`. An
 * operational error — an unreachable piece, a write the schema refuses —
 * becomes that row's `failed` verdict rather than escaping with the report:
 * the rows that landed stay reported, and the row's state is re-checked
 * after the failure so the problem says where the piece was left.
 */
export async function repairPieces(
  pieces: PiecesController,
  options: RepairOptions,
): Promise<RepairReport> {
  if (options.fixerName === "" || options.fixerIdentity === "") {
    // Stamped into the artifact either would be an op the codec refuses,
    // so a successful apply would return a plan nothing can decode.
    throw new Error(
      "A fixerName and a fixerIdentity must be nonempty when given.",
    );
  }
  if (
    (options.fixerName === undefined) !== (options.fixerIdentity === undefined)
  ) {
    // The name is for readers and the identity is the pin; an op carrying
    // one without the other is a plan the codec refuses, so the pair is
    // required together before anything is read.
    throw new Error("fixerName and fixerIdentity travel together.");
  }
  const survey = await surveyPieces(pieces, { selector: options.selector });
  if (!survey.complete) {
    const named = [
      ...survey.problems.map((problem) =>
        `unreadable: ${problem.piece} ${problem.problem}`
      ),
      ...survey.outside.map((outside) =>
        `registered outside the selection: ${outside.piece}`
      ),
    ];
    throw new Error(
      `The selection is incomplete, and a repair over a silent subset is ` +
        `the failure this refusal prevents:\n${named.join("\n")}`,
    );
  }
  const members = survey.plan.rows.filter((row) => row.phase !== HOLDER_PHASE);
  // A supplied plan is the execution, not a hint: its rows, in its order,
  // validated against this run before anything is read further. A plan that
  // names a piece the selection does not hold, or misses one it does, is
  // stale — the answer is a regenerated plan, never a run that quietly
  // reconciles the difference.
  let executionRows: {
    piece: string;
    phase?: string;
    expect: PiecePlanRow["expect"];
    expectedHash?: string;

    /** The plan row this one executes, carried into the emitted artifact
     * for every verdict short of landed, so a stopped run's artifact can
     * be supplied straight back. */
    supplied?: PiecePlanRow;
  }[];
  if (options.plan === undefined) {
    executionRows = members.map((row) => ({
      piece: row.piece,
      ...(row.phase === undefined ? {} : { phase: row.phase }),
      expect: row.expect,
    }));
  } else {
    // The executor holds an in-memory plan to every invariant the codec
    // holds a decoded one to — the same validator — so a shape the codec
    // would refuse cannot reach a write by skipping the file: a repair row
    // without its document hash, a duplicate piece, an invalid row.
    const plan = normalizePlan(options.plan);
    if (
      (plan.header.problems?.length ?? 0) > 0 ||
      (plan.header.outside?.length ?? 0) > 0
    ) {
      // Executing it would also launder it: the report's plan carries the
      // fresh survey's clean header, so the incompleteness would vanish.
      throw new Error(
        "No repair can run from an incomplete plan: its header names " +
          "pieces the survey did not account for.",
      );
    }
    if (options.fixerName === undefined) {
      throw new Error(
        "A supplied plan needs the run's fixerName: without it the plan's " +
          "recorded fixer cannot be held against the fixer actually run.",
      );
    }
    if (plan.header.space !== survey.plan.header.space) {
      throw new Error(
        `The plan names space ${plan.header.space}; this run ` +
          `targets ${survey.plan.header.space}.`,
      );
    }
    // The pair rule above means a run with a fixerName carries the
    // identity too, and the fixerName requirement for plans has already
    // fired for a run with neither. A zero-row plan pins nothing and gates
    // nothing; whether it fits this run is the selection equality's
    // question below, which refuses it against any nonempty selection.
    if (plan.rows.length > 0) {
      assertPlanRunsFixer(plan, options.fixerName, options.fixerIdentity!);
    }
    const surveyByPiece = new Map(members.map((row) => [row.piece, row]));
    const planPieces = new Set(plan.rows.map((row) => row.piece));
    const missing = members.filter((row) => !planPieces.has(row.piece));
    const extra = plan.rows.filter((row) => !surveyByPiece.has(row.piece));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        "The plan and the selection disagree" +
          (extra.length > 0
            ? "; the plan names pieces the selection does not hold: " +
              extra.map((row) => row.piece).join(", ")
            : "") +
          (missing.length > 0
            ? "; the selection holds pieces the plan does not name: " +
              missing.map((row) => row.piece).join(", ")
            : "") +
          ". A stale plan is regenerated, never reconciled silently.",
      );
    }
    executionRows = plan.rows.map((planRow) => {
      const surveyRow = surveyByPiece.get(planRow.piece)!;
      return {
        piece: surveyRow.piece,
        ...(planRow.phase === undefined ? {} : { phase: planRow.phase }),
        expect: surveyRow.expect,
        expectedHash: planRow.expect.documentHash,
        supplied: planRow,
      };
    });
  }
  // The one classification both passes use, so preflight and the serial
  // recheck cannot drift: not-document, then the fixer's own answer with
  // landed preceding moved — a document the fixer no longer changes is in
  // the state the operation produces, whatever it hashes to.
  const decideFor = (
    stored: FabricValue,
    expectedHash: string | undefined,
  ): RowDecision => {
    if (!isFabricPlainObject(stored)) return { kind: "not-document" };
    const documentHash = hashStringOf(stored);
    const outcome = evaluateFixer(stored, options.fixer);
    if (outcome.kind === "conforms") {
      return { kind: "conforms", documentHash };
    }
    if (expectedHash !== undefined && documentHash !== expectedHash) {
      return { kind: "moved", documentHash };
    }
    if (outcome.kind === "refused") {
      return { kind: "refused", documentHash, problem: outcome.problem };
    }
    return {
      kind: "change",
      documentHash,
      before: stored,
      document: outcome.document,
      changes: outcome.changes,
    };
  };
  const rows: RepairRow[] = [];

  /**
   * Every row this run settles, to the report and to a watching caller.
   *
   * A repair writes, so a run that stalls mid-way leaves the same partial
   * state a retarget does — and the process guard can only name where it
   * stopped if something told it which rows had settled. Routing every row
   * through here is what makes the guard's count a fact about the run rather
   * than an admission that this process cannot see one.
   */
  // Set when a caller's `onRow` throws, so the row loop's catch can tell that
  // error from the operational ones it classifies. The row it was handed has
  // already settled, and classifying the reporter's failure would put one
  // piece in the report twice, under two verdicts, the second contradicting
  // what the caller was just told.
  let reporterThrew = false;

  const report = (row: RepairRow) => {
    rows.push(row);
    if (options.onRow === undefined) return;
    try {
      options.onRow(row);
    } catch (error) {
      reporterThrew = true;
      throw error;
    }
  };
  const planRows: PiecePlanRow[] = [];
  let applied = 0;
  let stopped = false;
  // Preflight, before the first write: every row classified from one read,
  // exactly as the spine documents — a row that moved, or that the fixer
  // refuses, is found while nothing has been touched, and the run does not
  // start. The per-row transactional recheck below still guards each write
  // against what happens after this pass.
  let startBlocked = false;
  const preflight = new Map<
    string,
    RowDecision | { kind: "read-failed"; problem: string }
  >();
  if (options.apply === true) {
    for (const row of executionRows) {
      try {
        const controller = await pieces.get(row.piece, false);
        const cell = await controller.input.getCell();
        await cell.pull();
        const decision = decideFor(
          cell.getRawUntyped({ lastNode: "value" }),
          row.expectedHash,
        );
        preflight.set(row.piece, decision);
        if (decision.kind !== "conforms" && decision.kind !== "change") {
          startBlocked = true;
        }
      } catch (error) {
        preflight.set(row.piece, {
          kind: "read-failed",
          problem: error instanceof Error ? error.message : String(error),
        });
        startBlocked = true;
      }
    }
  }
  for (const row of executionRows) {
    const phase = row.phase === undefined ? {} : { phase: row.phase };
    const preStateRow = {
      piece: row.piece,
      ...phase,
      expect: row.expect,
    };
    // The artifact row this piece contributes. A landed row records the
    // hash its verdict was computed from; any other verdict carries the
    // supplied plan row through unchanged, so a stopped run's artifact can
    // be supplied straight back; and a fresh run's row falls back to its
    // decision's hash when one exists, or to the pre-state record.
    const emitRow = (
      decision:
        | RowDecision
        | { kind: "read-failed"; problem: string }
        | undefined,
      landed: boolean,
    ) => {
      if (!landed && row.supplied !== undefined) {
        planRows.push(row.supplied);
        return;
      }
      if (
        decision !== undefined && decision.kind !== "read-failed" &&
        decision.kind !== "not-document"
      ) {
        planRows.push({
          piece: row.piece,
          ...phase,
          expect: { ...row.expect, documentHash: decision.documentHash },
          ...(options.fixerName === undefined ||
              options.fixerIdentity === undefined
            ? {}
            : {
              op: {
                kind: "repair",
                fixer: options.fixerName,
                fixerIdentity: options.fixerIdentity,
              },
            }),
        });
        return;
      }
      planRows.push(preStateRow);
    };
    if (startBlocked) {
      // The run did not start: every row reports its preflight
      // classification, and nothing was written.
      const decision = preflight.get(row.piece);
      emitRow(decision, decision?.kind === "conforms");
      if (decision === undefined || decision.kind === "read-failed") {
        report({
          piece: row.piece,
          ...phase,
          verdict: "failed",
          problem: (decision?.problem ??
            "The row was never classified.") +
            "; the run did not start, so nothing was written.",
        });
      } else if (decision.kind === "not-document") {
        report({
          piece: row.piece,
          ...phase,
          verdict: "refused",
          problem: "The stored input is not a document.",
        });
      } else if (decision.kind === "moved") {
        report({
          piece: row.piece,
          ...phase,
          verdict: "moved",
          documentHash: decision.documentHash,
          problem: "The stored document no longer hashes to what the plan " +
            "recorded: something other than this plan changed it.",
        });
      } else if (decision.kind === "refused") {
        report({
          piece: row.piece,
          ...phase,
          verdict: "refused",
          documentHash: decision.documentHash,
          problem: decision.problem,
        });
      } else if (decision.kind === "conforms") {
        report({
          piece: row.piece,
          ...phase,
          verdict: "conforms",
          documentHash: decision.documentHash,
        });
      } else {
        report({
          piece: row.piece,
          ...phase,
          verdict: "would-change",
          documentHash: decision.documentHash,
          changes: decision.changes,
        });
      }
      continue;
    }
    if (stopped) {
      report({ piece: row.piece, ...phase, verdict: "unattempted" });
      emitRow(preflight.get(row.piece), false);
      continue;
    }
    try {
      const controller = await pieces.get(row.piece, false);
      const cell = await controller.input.getCell();
      await cell.pull();
      // Initialized only to satisfy definite assignment: a committed edit
      // has run its closure at least once, so the committed pass always
      // overwrites this before it is read.
      let decision: RowDecision = { kind: "not-document" };
      let wroteThisRow = false;
      if (options.apply === true) {
        // Evaluate-and-write in one transaction: on a commit conflict the
        // closure re-runs against fresh state, so `decision` is whatever
        // the committed pass decided, later passes overwriting earlier —
        // and the document written is the very one that decision carries,
        // so the report and the write cannot describe two evaluations.
        const { wrote } = await controller.input.edit((stored) => {
          decision = decideFor(stored, row.expectedHash);
          return decision.kind === "change"
            ? { value: decision.document }
            : undefined;
        });
        wroteThisRow = wrote;
        if (!wrote) {
          // A no-write commit stages nothing and is not conflict-checked
          // (see PiecePropIo.edit), so the decision is remade from a fresh
          // read — the later verification read that contract calls for —
          // and the re-read's answer is the row's verdict. The handle is
          // reacquired rather than reused: a concurrent source change may
          // have superseded the argument cell the row started from.
          const fresh = await controller.input.getCell();
          await fresh.pull();
          decision = decideFor(
            fresh.getRawUntyped({ lastNode: "value" }),
            row.expectedHash,
          );
        }
      } else {
        decision = decideFor(
          cell.getRawUntyped({ lastNode: "value" }),
          row.expectedHash,
        );
      }
      if (decision.kind === "not-document") {
        report({
          piece: row.piece,
          ...phase,
          verdict: "refused",
          problem: "The stored input is not a document.",
        });
        emitRow(decision, false);
        stopped = options.apply === true;
        continue;
      }
      if (decision.kind === "moved") {
        report({
          piece: row.piece,
          ...phase,
          verdict: "moved",
          documentHash: decision.documentHash,
          problem: "The stored document no longer hashes to what the plan " +
            "recorded: something other than this plan changed it.",
        });
        emitRow(decision, false);
        stopped = options.apply === true;
        continue;
      }
      if (decision.kind === "refused") {
        report({
          piece: row.piece,
          ...phase,
          verdict: "refused",
          documentHash: decision.documentHash,
          problem: decision.problem,
        });
        emitRow(decision, false);
        stopped = options.apply === true;
        continue;
      }
      if (decision.kind === "conforms") {
        report({
          piece: row.piece,
          ...phase,
          verdict: "conforms",
          documentHash: decision.documentHash,
        });
        emitRow(decision, true);
        continue;
      }
      if (options.apply !== true) {
        report({
          piece: row.piece,
          ...phase,
          verdict: "would-change",
          documentHash: decision.documentHash,
          changes: decision.changes,
        });
        emitRow(decision, true);
        continue;
      }
      if (!wroteThisRow) {
        // The no-write classification did not hold on the re-read: the
        // document changed under a decision that staged nothing. Nothing
        // was written, and the run stops — plan order is a correctness
        // constraint, so a later row must not land while this one is
        // outstanding. A re-run resumes from here.
        report({
          piece: row.piece,
          ...phase,
          verdict: "would-change",
          documentHash: decision.documentHash,
          changes: decision.changes,
        });
        emitRow(decision, false);
        stopped = true;
        continue;
      }
      applied += 1;
      await pieces.synced();
      // The write target is reacquired for verification: edit() resolves
      // the argument cell inside its own transaction precisely because a
      // concurrent source change can supersede it, and a verification
      // through the handle this row started from would read the old cell.
      const verifyCell = await controller.input.getCell();
      await verifyCell.pull();
      const written = verifyCell.getRaw({ lastNode: "value" });
      const verification = isPlainRecord(written)
        ? evaluateFixer(written, options.fixer)
        : undefined;
      if (verification?.kind === "conforms") {
        report({
          piece: row.piece,
          ...phase,
          verdict: "repaired",
          documentHash: decision.documentHash,
          // Measured between the stored documents, not restated from the
          // fixer's answer: the write path hydrates schema defaults into
          // what it stores, and an addition the report never mentioned is
          // how a repair quietly widens.
          changes: documentChanges(decision.before, written),
        });
        emitRow(decision, true);
        continue;
      }
      report({
        piece: row.piece,
        ...phase,
        verdict: "failed",
        documentHash: decision.documentHash,
        problem: "The stored document does not satisfy the fixer after the " +
          "write: the write path dropped something, or a concurrent change " +
          "landed between the write and this read. Writing again is not " +
          "the answer either way.",
        changes: decision.changes,
      });
      emitRow(decision, false);
      stopped = true;
    } catch (error) {
      // The reporter's own failure is not this row's outcome. The row it was
      // handed has settled and the caller has seen it, so this leaves rather
      // than reporting the same piece again under a contradicting verdict.
      if (reporterThrew) throw error;
      // An operational failure — an unreachable piece, a write the schema
      // refuses — is this row's outcome, not the report's: the rows that
      // landed stay reported. The state check runs after the failure, so
      // the problem says where the piece was left rather than guessing.
      const problem = error instanceof Error ? error.message : String(error);
      let state = "; the piece could not be re-read, so its state is unknown";
      try {
        const controller = await pieces.get(row.piece, false);
        const cell = await controller.input.getCell();
        await cell.pull();
        const stored = cell.getRaw({ lastNode: "value" });
        if (isPlainRecord(stored)) {
          state = evaluateFixer(stored, options.fixer).kind === "conforms"
            ? "; the stored document satisfies the fixer, so the row landed"
            : "; the stored document still needs the repair";
        }
      } catch {
        // The re-read failing changes nothing: `state` already says so.
      }
      report({
        piece: row.piece,
        ...phase,
        verdict: "failed",
        problem: problem + state,
      });
      emitRow(preflight.get(row.piece), false);
      stopped = options.apply === true;
    }
  }
  const complete = rows.every((row) =>
    row.verdict === "conforms" || row.verdict === "repaired" ||
    (options.apply !== true && row.verdict === "would-change")
  );
  return {
    rows,
    plan: { header: survey.plan.header, rows: planRows },
    applied,
    complete,
  };
}
