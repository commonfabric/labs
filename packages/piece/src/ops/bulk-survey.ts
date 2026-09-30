/**
 * The read-only survey under every bulk piece operation: enumerate a set of
 * pieces, read what each one currently is, cross-check the selection, and
 * emit the plan the write stages consume.
 *
 * The survey answers "what does each of these pieces currently look like?"
 * with one cheap read per piece — the pattern identity, the current source
 * revision when the piece keeps a log, and whether the identity's source is
 * still retained in the space — and never runs a piece. Selection reads the
 * holder's own collection and is cross-checked against the piece registry by
 * containment: the registry is expected to be the smaller set, so the failure
 * worth stopping on is a registered in-scope piece the collection lacks. The
 * design is [docs/plans/piece-bulk-operations.md](../../../../docs/plans/piece-bulk-operations.md).
 */

import type { CellScope } from "@commonfabric/api";
import {
  type Cell,
  getPatternIdentityRef,
  getPatternSource,
  type JSONSchema,
  schemaAcceptsOpaqueCellValue,
} from "@commonfabric/runner";
import { validateSchemaValue } from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { pieceId } from "../piece-id.ts";
import {
  canonicalPieceAddress,
  type PieceExpect,
  type PiecePlan,
  type PiecePlanRow,
  type RegisteredOutside,
  type RetargetOp,
  type SurveyProblem,
} from "./bulk-plan.ts";
import { readPieceSourceMetadata } from "./piece-origin.ts";
import type { PiecesController } from "./pieces-controller.ts";

/**
 * Names the pieces a survey covers.
 *
 * A `collection` selector names a holder piece and the path to the collection
 * inside it, and emits the members followed by the holder as the last row —
 * children first, holder last is the selector's property, not a step the
 * operator performs. `side` picks the document holding the collection and
 * defaults to the stored input. A `list` selector names pieces outright, for
 * a hand-picked set or the one orphan a containment check found.
 */
export type PieceSelector =
  | {
    kind: "collection";

    /** The holder piece's address. */
    holder: string;

    /** The path to the collection within the chosen document. */
    path: readonly (string | number)[];

    side?: "input" | "result";
  }
  | { kind: "list"; pieces: readonly string[] };

/** One selected piece, with the phase label its plan row will carry. */
export interface SelectedPiece {
  piece: string;
  phase: string;
}

/** The phase label a collection selector puts on its holder's row. */
export const HOLDER_PHASE = "holder";

/** The phase label a list selector puts on every row. */
export const LIST_PHASE = "list";

/** A retarget to stamp onto every row of one phase, identity already computed. */
export type PlannedRetarget = Omit<RetargetOp, "kind">;

/** What {@link surveyPieces} takes beyond the controller. */
export interface SurveyOptions {
  selector: PieceSelector;

  /**
   * Retargets to stamp onto rows, keyed by phase — a collection selector
   * labels members with the collection path and the holder with
   * {@link HOLDER_PHASE}. Rows of an unlisted phase get no `op`, and neither
   * does a row already on the operation's reference — such a row would be
   * unverifiable — so the plan stays a pre-state record for both.
   */
  operations?: Readonly<Record<string, PlannedRetarget>>;

  /**
   * A schema to read each piece's result under — a holder's demanded schema
   * is the canonical one. Pieces whose result cannot materialize under it
   * are named in the result: the only bulk answer to "which member breaks
   * the holder's read?", since the holder's own read fails as a whole. The
   * check uses read semantics, so a field a schema default rescues passes
   * here exactly as it would for the holder.
   */
  validator?: JSONSchema;

  /** The header's `takenAt`; defaults to now. A parameter so tests can pin it. */
  takenAt?: string;
}

/** How many selected pieces run one `{identity, symbol}` within one phase. */
export interface TallyEntry {
  phase: string;
  patternIdentity: string;
  symbol: string;
  count: number;
}

/** Everything a survey reports beyond the plan itself. */
export interface SurveyResult {
  plan: PiecePlan;

  /** Identity counts by phase — "do these pieces all agree?" at a glance. */
  tally: readonly TallyEntry[];

  /** Registered in-scope pieces the selection lacks. Any entry is a stop. */
  outside: readonly RegisteredOutside[];

  /** Selected pieces that could not be read into a row. Any entry is a stop. */
  problems: readonly SurveyProblem[];

  /** Pieces whose result fails the supplied validator, with the failure. */
  validatorFailures: readonly SurveyProblem[];

  /**
   * Whether the plan accounts for everything: no unreadable piece and no
   * registered in-scope piece outside the selection. A write stage must
   * refuse a plan surveyed incomplete; validator failures are a finding, not
   * an incompleteness.
   */
  complete: boolean;
}

/**
 * Resolve a selector to pieces in execution order. Collection members come
 * back in stored order with the holder last; a member slot that does not
 * hold a piece is an error naming its position, because a silently skipped
 * member is the failure the survey exists to prevent.
 */
export async function selectPieces(
  pieces: PiecesController,
  selector: PieceSelector,
): Promise<SelectedPiece[]> {
  if (selector.kind === "list") {
    // Canonicalized before the uniqueness check, so the `of:` alias and the
    // bare spelling of one piece cannot pass as two.
    return assertUniqueSelection(
      selector.pieces.map((piece) => ({
        piece: canonicalPieceAddress(piece),
        phase: LIST_PHASE,
      })),
    );
  }
  if (
    selector.path.length === 0 ||
    selector.path.some((segment) => segment === "")
  ) {
    // The last segment becomes the rows' phase label, and the codec refuses
    // an empty one — a survey must not emit a plan its own codec rejects.
    throw new Error(
      "A collection path needs at least one segment, and none may be empty.",
    );
  }
  const holder = await pieces.get(selector.holder, false);
  const io = selector.side === "result" ? holder.result : holder.input;
  const root = await io.getCell();
  const collection = root.key(...selector.path).asSchema(
    MEMBER_LIST_SCHEMA,
  ) as Cell<Cell<unknown>[]>;
  const members = await collection.pull() ?? [];
  // An absent stored value and a misspelled path read the same, and the
  // silent holder-only plan a default would produce is the exact subset
  // failure the survey exists to prevent — so absence is a refusal. The raw
  // read resolves a final link the way the pull above did, so a collection
  // stored as a link — a result-side passthrough, a linked list — reads as
  // the array it points at rather than as the link.
  const stored = collection.getRaw({ lastNode: "value" });
  if (stored === undefined) {
    throw new Error(
      `The holder stores no collection at ${selector.path.join("/")} — a ` +
        `misspelled path and a never-written collection are ` +
        `indistinguishable, so neither is surveyed silently.`,
    );
  }
  if (!Array.isArray(stored)) {
    throw new Error(
      `The value at ${selector.path.join("/")} is not a collection.`,
    );
  }
  // The cell-typed read yields one cell per stored slot — nothing shortens
  // it — so the per-member check below covers every slot, a null one
  // included.
  const phase = String(selector.path.at(-1) ?? "members");
  // A literal in a member slot resolves to a cell inside the holder's own
  // document rather than to another document, which is how one is told apart
  // from a link.
  const holderDoc = collection.getAsNormalizedFullLink().id;
  const selected = members.map((member, index) => {
    const id = pieceId(member);
    if (id === undefined || member.getAsNormalizedFullLink().id === holderDoc) {
      throw new Error(
        `Collection member ${index} at ${
          selector.path.join("/")
        } does not hold a piece link.`,
      );
    }
    return { piece: id, phase };
  });
  if (phase === HOLDER_PHASE) {
    throw new Error(
      `A collection named "${HOLDER_PHASE}" would share its phase label ` +
        `with the holder's own row, and a per-phase operation would hit ` +
        `both. Survey it as a list instead.`,
    );
  }
  selected.push({ piece: holder.id, phase: HOLDER_PHASE });
  return assertUniqueSelection(selected);
}

/** A piece selected twice would be surveyed — and later applied — twice. */
function assertUniqueSelection(selected: SelectedPiece[]): SelectedPiece[] {
  const seen = new Set<string>();
  for (const { piece } of selected) {
    if (seen.has(piece)) {
      throw new Error(`The selection lists ${piece} more than once.`);
    }
    seen.add(piece);
  }
  return selected;
}

/**
 * Survey the selected pieces and build the plan. Read-only: one identity
 * read per piece (a second per piece when a validator is supplied), one
 * retained-source load per distinct identity, and one
 * pass over the registry for the containment check. Every read is live —
 * nothing is served from a snapshot — so re-running after a change reflects
 * the change.
 */
export async function surveyPieces(
  pieces: PiecesController,
  options: SurveyOptions,
): Promise<SurveyResult> {
  const selected = await selectPieces(pieces, options.selector);
  const retainedByIdentity = new Map<string, boolean>();
  const rows: PiecePlanRow[] = [];
  const problems: SurveyProblem[] = [];
  const validator = options.validator as unknown;
  if (
    validator !== undefined && typeof validator !== "boolean" &&
    !isObjectNotArray(validator)
  ) {
    // The type admits only a schema, but the value usually arrives from a
    // caller-parsed file. `null` is not `undefined`, and shaping by it
    // validates nothing — a validator that cannot fail would report a clean
    // board it never read.
    throw new Error(
      "A validator must be a JSON schema: an object or a boolean.",
    );
  }
  const validatorFailures: SurveyProblem[] = [];

  for (const { piece, phase } of selected) {
    const pin = await readPiecePin(pieces, piece, retainedByIdentity);
    if (pin === undefined) {
      const controller = await pieces.get(piece, false);
      problems.push({
        piece: controller.id,
        problem: "carries no pattern identity",
      });
      continue;
    }
    const expect: PieceExpect = {
      patternIdentity: pin.patternIdentity,
      symbol: pin.symbol,
      retained: pin.retained,
      // The origin rides the row so the artifact records what the plan was
      // built against. It is this read and nothing later: what a run
      // detaches is the run's to report, on its own row.
      ...(pin.origin === undefined ? {} : { origin: pin.origin }),
      ...(pin.revisionId === undefined ? {} : { revisionId: pin.revisionId }),
    };
    // An own-property check: a phase named like an `Object.prototype` member
    // must not resolve an inherited value into a phantom operation.
    const operation = options.operations !== undefined &&
        Object.hasOwn(options.operations, phase)
      ? options.operations[phase]
      : undefined;
    // A piece already on the operation's reference gets no op: the row would
    // be unverifiable — landed and never-ran read the same — and the apply
    // has nothing to do for it. The op-less row stays a pre-state record.
    const op = operation !== undefined &&
        (operation.patternIdentity !== pin.patternIdentity ||
          operation.symbol !== pin.symbol)
      ? { kind: "retarget" as const, ...operation }
      : undefined;
    rows.push({
      piece: pin.piece,
      phase,
      expect,
      ...(op === undefined ? {} : { op }),
    });
    if (options.validator !== undefined) {
      const controller = await pieces.get(piece, false);
      const failure = await validateResult(controller, options.validator);
      if (failure !== undefined) {
        validatorFailures.push({ piece: pin.piece, problem: failure });
      }
    }
  }

  // Containment is a property of surveying a holder's collection — the claim
  // "this collection is all there is of its kind". A hand-picked list claims
  // no such thing, so a registered sibling outside one is not a disagreement.
  // One registry read serves the containment check and the header count, so
  // the two can never describe different live enumerations.
  const registered = await pieces.getRegisteredPieces();
  // An operation keyed by a phase no row carries would otherwise vanish —
  // resolved from disk, identity computed, and silently thrown away, leaving
  // a pre-state record the operator believes is a retarget plan.
  const phases = new Set(rows.map((row) => row.phase));
  const unusedPhases = Object.keys(options.operations ?? {})
    .filter((phase) => !phases.has(phase));
  if (unusedPhases.length > 0) {
    throw new Error(
      `No selected row carries phase ${unusedPhases.join(", ")} — the ` +
        `operation keyed by it would be dropped, not applied.`,
    );
  }
  const outside = options.selector.kind === "collection"
    ? await registeredOutsideSelection(pieces, registered, rows)
    : [];
  const memberCount = options.selector.kind === "collection"
    ? Math.max(selected.length - 1, 0)
    : selected.length;
  const plan: PiecePlan = {
    header: {
      kind: "piece-plan",
      v: 1,
      space: pieces.getSpace(),
      takenAt: options.takenAt ?? new Date().toISOString(),
      selector: options.selector.kind,
      enumerated: {
        collection: memberCount,
        registry: registered.length,
        registeredOutside: outside.length,
      },
      // Incompleteness rides the artifact: an encoded plan whose survey
      // could not account for every piece must not read as a complete one.
      ...(problems.length === 0 ? {} : { problems: [...problems] }),
      ...(outside.length === 0 ? {} : { outside }),
    },
    rows,
  };
  return {
    plan,
    tally: tallyRows(rows),
    outside,
    problems,
    validatorFailures,
    complete: problems.length === 0 && outside.length === 0,
  };
}

/** The source pin one cheap read yields for one piece. */
export interface PiecePin {
  /** The piece's canonical address. */
  piece: string;

  patternIdentity: string;

  /** The entry export the identity runs. */
  symbol: string;

  /**
   * The origin the piece follows, exactly as it records it; absent when the
   * piece is detached. Read raw rather than classified, as
   * `readRestorableSource` in [piece-restore.ts](./piece-restore.ts) reads it
   * and for the same reason: a classified read reports an origin this runtime
   * cannot resolve as detached, while a write detaches such an origin like
   * any other, so reading it classified would leave exactly those pieces
   * unrecorded.
   */
  origin?: string;

  /** The current source revision, when the piece keeps a log. */
  revisionId?: string;

  /** Whether the identity's source is retained in the space. */
  retained: boolean;
}

/**
 * Read one piece's source pin: identity, symbol, the origin it follows,
 * current revision when a log exists, and whether the identity's source is
 * verifiably retained. One synced read of the piece plus one
 * retained-source load cached per identity — the piece is never run, and
 * nothing else is pulled. Returns `undefined` for a piece carrying no
 * pattern identity.
 */
export async function readPiecePin(
  pieces: PiecesController,
  piece: string,
  retainedByIdentity: Map<string, boolean> = new Map(),
  scope?: CellScope,
): Promise<PiecePin | undefined> {
  const controller = await pieces.get(piece, false, undefined, scope);
  const cell = controller.getCell();
  const state = readPieceSourceMetadata(pieces.runtime, cell);
  // A KEYLESS piece carries no durable pointer (the never-durable
  // contract; L3(a), RULED 2026-08-27). In the session that set it up the
  // runner's session pointer names it, so the survey reports the honest
  // row — a builder-run piece, `retained: false` (no source closure can
  // exist for a session identity). A fresh session finds neither and the
  // piece surfaces as the designed "carries no pattern identity" problem.
  const sessionRef = state.pattern === undefined
    ? pieces.runtime.runner.sessionPatternPointerFor(cell)
    : undefined;
  const patternRef = state.pattern ?? sessionRef;
  if (patternRef === undefined) return undefined;
  const recorded = getPatternSource(cell);
  // An empty recorded origin names no place a source can be resolved from,
  // and the plan codec refuses one — a survey must not emit a plan its own
  // codec rejects — so it reads as detached here.
  const origin = recorded === undefined || recorded === ""
    ? undefined
    : recorded;
  return {
    piece: controller.id,
    patternIdentity: patternRef.identity,
    symbol: patternRef.symbol,
    ...(origin === undefined ? {} : { origin }),
    ...(state.currentRevisionId === undefined
      ? {}
      : { revisionId: state.currentRevisionId }),
    retained: await isSourceRetained(
      pieces,
      patternRef.identity,
      retainedByIdentity,
    ),
  };
}

/** Members come back as cells, so no element's value is read. */
const MEMBER_LIST_SCHEMA = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  default: [],
} as const satisfies JSONSchema;

/**
 * Whether `identity`'s source closure is verifiably retained in the space —
 * the canonical loader can produce it, hashes checked — cached per distinct
 * identity, so a board pays the load once per generation rather than once
 * per piece. Bare document existence would be cheaper and would lie: a
 * malformed entry document exists while nothing can restore from it.
 */
export async function isSourceRetained(
  pieces: PiecesController,
  identity: string,
  cache: Map<string, boolean>,
): Promise<boolean> {
  const cached = cache.get(identity);
  if (cached !== undefined) return cached;
  const program = await pieces.runtime.patternManager
    .getPatternSourceProgramByIdentity(identity, pieces.getSpace());
  const retained = program !== undefined;
  cache.set(identity, retained);
  return retained;
}

/**
 * The containment check: every registered piece on an in-scope identity must
 * be in the selection. One that is not is either a member the collection
 * read dropped or a piece of the same kind living outside the holder, and
 * either way the plan does not account for it.
 */
async function registeredOutsideSelection(
  pieces: PiecesController,
  registered: readonly { id: string }[],
  rows: readonly PiecePlanRow[],
): Promise<RegisteredOutside[]> {
  // In scope by the full executable pointer: an identity alone conflates two
  // patterns one module exports.
  const inScope = new Set(
    rows.map((row) => `${row.expect.patternIdentity}\x00${row.expect.symbol}`),
  );
  const selectedIds = new Set(rows.map((row) => row.piece));
  const outside: RegisteredOutside[] = [];
  for (const candidate of registered) {
    if (selectedIds.has(candidate.id)) continue;
    const synced = await pieces.get(candidate.id, false);
    const ref = getPatternIdentityRef(synced.getCell());
    if (
      ref !== undefined && inScope.has(`${ref.identity}\x00${ref.symbol}`)
    ) {
      outside.push({
        piece: synced.id,
        patternIdentity: ref.identity,
        symbol: ref.symbol,
      });
    }
  }
  return outside;
}

/**
 * Read one piece's result under the validator schema, returning what failed
 * and `undefined` when the piece passes. A demanding read does not throw — it
 * comes back `undefined` when the schema's required values cannot resolve —
 * so failure is a value that did not materialize while stored data is
 * present and the schema rejects `undefined`. That mirrors a holder's read:
 * a field rescued by its schema default passes here exactly as it would
 * there.
 */
async function validateResult(
  controller: { result: { getCell(): Promise<Cell<unknown>> } },
  validator: JSONSchema,
): Promise<string | undefined> {
  const result = await controller.result.getCell();
  const shaped = result.asSchema(validator);
  await shaped.pull();
  const materialized = shaped.get();
  if (materialized !== undefined) {
    // Materializing is necessary, not sufficient: a value can come back and
    // still violate the schema — a string where a number is demanded. A
    // position the schema declares `asCell` materializes as a cell handle by
    // design, so the handle is accepted exactly there and nowhere else.
    return validateSchemaValue(validator, materialized, validator, {
      acceptOpaqueValue: schemaAcceptsOpaqueCellValue,
    });
  }
  return validateSchemaValue(validator, undefined) === undefined
    ? undefined
    : result.getRaw() === undefined
    ? "has no stored result"
    : "stored result is present, but the schema could not resolve all " +
      "required values";
}

function tallyRows(rows: readonly PiecePlanRow[]): TallyEntry[] {
  const counts = new Map<string, TallyEntry>();
  for (const row of rows) {
    const phase = row.phase ?? "";
    const key =
      `${phase}\x00${row.expect.patternIdentity}\x00${row.expect.symbol}`;
    const entry = counts.get(key);
    if (entry === undefined) {
      counts.set(key, {
        phase,
        patternIdentity: row.expect.patternIdentity,
        symbol: row.expect.symbol,
        count: 1,
      });
    } else entry.count++;
  }
  return [...counts.values()];
}
