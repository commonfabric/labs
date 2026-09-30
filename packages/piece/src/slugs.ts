import type { CellScope, JSONSchema } from "@commonfabric/api";
import type { Cell, IExtendedStorageTransaction } from "@commonfabric/runner";
import {
  cellTx,
  DEFAULT_CELL_SCOPE,
  entityIdFrom,
  isPieceDocument,
  isSlugAddress,
  type NormalizedFullLink,
  parseSlugRedirect,
  resolveSlugReference,
  resolveSlugTargetCell as resolveRuntimeSlugTargetCell,
  resolveSlugTargetInPiece,
  slugIdForSpace,
  slugIndexIdForSpace,
  SlugResolutionError,
  validateSlug,
} from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { utf8Compare } from "@commonfabric/utils/utf8";
import type { PiecesController } from "./ops/pieces-controller.ts";
import { pieceId } from "./piece-id.ts";

export { SlugResolutionError };

/**
 * A name that was already bound when an assignment reached it. The target it
 * carries is a reference to what the name points at now, which is both what
 * forcing the assignment would take and what a caller writes to put the name
 * back.
 *
 * The condition is the library's and the remedy is the caller's, so a caller
 * with a word for forcing — a CLI flag, a tool parameter — supplies its own
 * and the message reads in that caller's vocabulary.
 */
export class SlugAssignedError extends Error {
  #slug: string;
  #target: string;

  constructor(slug: string, target: string, remedy?: string) {
    super(
      `Slug "${slug}" already points at ${target}, so assigning it would ` +
        `take that address from whoever holds it.` +
        (remedy === undefined ? "" : ` ${remedy}`),
    );
    this.name = "SlugAssignedError";
    this.#slug = slug;
    this.#target = target;
  }

  /** The name the assignment asked for. */
  get slug(): string {
    return this.#slug;
  }

  /** A reference to what the name points at now. */
  get target(): string {
    return this.#target;
  }
}

/**
 * A name that had moved on when an assignment reached it, and now points
 * nowhere. The sibling of {@link SlugAssignedError}, and a different outcome:
 * nobody holds the name, so the caller's answer is to read it again and try,
 * where a name someone else holds is one to leave alone.
 *
 * Only a caller naming what to take the name from can see this, since a
 * caller that names none is asking for a free name and has found one.
 */
export class SlugReleasedError extends Error {
  #slug: string;
  #expected: string;

  constructor(slug: string, expected: string, remedy?: string) {
    super(
      `Slug "${slug}" no longer points at ${expected}, and now points ` +
        `nowhere.` + (remedy === undefined ? "" : ` ${remedy}`),
    );
    this.name = "SlugReleasedError";
    this.#slug = slug;
    this.#expected = expected;
  }

  /** The name the assignment asked for. */
  get slug(): string {
    return this.#slug;
  }

  /** The reference the caller said to take the name from. */
  get expected(): string {
    return this.#expected;
  }
}

/** The slug index's shape: names to `true`. Written one key at a time, so
 * two clients assigning different slugs merge as two keys rather than two
 * whole maps racing. The names are the whole content — where a name points
 * stays the slug cell's own answer, because a copy of the target here would
 * be a second answer able to disagree with it. */
const SLUG_INDEX_SCHEMA = {
  type: "object",
  additionalProperties: { type: "boolean" },
} as const satisfies JSONSchema;

/**
 * The schema the redirect write carries. It exists to stop the write asking
 * what the name currently resolves to: a handle with no schema resolves its
 * own link to find one, and a name whose value is a link cycle makes that
 * throw — so without it a forced assignment could not repoint the very state
 * an operator forces to escape.
 *
 * It costs one sync, and the cost is worth stating precisely because the
 * obvious summary overstates the equivalence. `asSchema` resets the handle's
 * synced flag, so the write kicks a second provider sync of the slug
 * document: two calls where a schemaless write makes one, both for that same
 * document.
 *
 * What it does not do is widen what a sync reaches. An object with no
 * properties describes the shape a redirect payload has and names nothing to
 * follow. What a sync of the name reaches beyond that document is the
 * server's doing rather than the schema's: serving a document whose value is
 * a redirect, it resolves the redirect through the links on its path under
 * whichever schema the selector carries, so both syncs reach the same
 * documents and the stored bytes are identical either way. Measured with a
 * five-document chain behind the name: those five arrive with the sync
 * `setSlugLink` performs before its transaction, which runs with or without
 * this schema, so none of them are this schema's doing.
 */
const SLUG_REDIRECT_SCHEMA = { type: "object" } as const satisfies JSONSchema;

/** The document a name's redirect lives in, whose id derives from the name. */
function slugCellFor(pieces: PiecesController, validSlug: string) {
  return pieces.runtime.getCellFromEntityId(
    pieces.getSpace(),
    entityIdFrom(slugIdForSpace(pieces.getSpace(), validSlug)),
  );
}

/** What a name holds, in the three forms the module asks about. */
interface SlugBinding {
  /** The redirect the name's document holds, for the holder it takes from. */
  held: NormalizedFullLink | undefined;

  /** The reference it reads as, which is what a refusal names. */
  ref: string | null;

  /** What an assignment compares. See {@link readSlugBinding}. */
  claim: string | null;
}

/**
 * What a name holds. A payload that is no redirect — absent, structurally
 * invalid, or shaped like a link and malformed inside — is a name pointing
 * nowhere, which is what `parseSlugRedirect` answers and therefore what every
 * reader of this name agrees it is. Asking any other way would let a name the
 * resolver calls malformed throw out of an assignment instead.
 *
 * `withTargetFacts` adds what the name points AT to the claim: whether that
 * document is a piece, which is a fact a caller's own rule about a free name
 * can turn on. Only a caller naming a target to take the name from compares
 * it — the default rule turns on whether anything is bound at all — so it is
 * read only for those, rather than putting the target document in the read
 * set of every assignment.
 */
function slugBindingOf(
  pieces: PiecesController,
  slugCell: Cell<unknown>,
  withTargetFacts: boolean,
): SlugBinding {
  const held = parseSlugRedirect(slugCell.getRaw(), slugCell);
  if (held === undefined) return { held, ref: null, claim: null };
  const ref = createLLMFriendlyLink(held, pieces.getSpace());
  if (!withTargetFacts) return { held, ref, claim: ref };
  return { held, ref, claim: `${ref} ${targetKindOf(pieces, held, slugCell)}` };
}

/**
 * What a name's target is, as the claim records it: whether the document it
 * resolves to is a piece, which is the fact a caller's own rule about a free
 * name turns on.
 *
 * A target that will not resolve at all — a redirect cycle, including the
 * self-cycle an assignment can point a name at — is a third state rather than
 * a failure. It is as stable to compare as the other two: a name stops
 * resolving nowhere only by being written.
 */
function targetKindOf(
  pieces: PiecesController,
  held: NormalizedFullLink,
  base: Cell<unknown>,
): string {
  try {
    const target = pieces.runtime.getCellFromLink(held, undefined, cellTx(base))
      .resolveAsCell();
    return isPieceDocument(pieces.runtime, target) ? "piece" : "not-piece";
  } catch {
    return "unresolvable";
  }
}

/**
 * The document root that carries a name for `cell`, or `undefined` when
 * `cell` names a position inside a document rather than a document of its
 * own. The stored `slug` entry belongs to a root, so a name pointing into one
 * has no root of its own to stamp.
 *
 * One question for both sides of a reassignment — the stamp on the target
 * taking the name and the clear on the holder losing it — because the two
 * disagreeing is what leaves a root claiming a name that moved: a stored
 * redirect can carry a path and still resolve to a root, and asking about the
 * path before resolving answers about the redirect rather than about the
 * document the name reaches.
 */
function slugStampRoot(cell: Cell<unknown>): Cell<unknown> | undefined {
  const resolved = cell.resolveAsCell();
  return resolved.getAsNormalizedFullLink().path.length === 0
    ? resolved
    : undefined;
}

/**
 * {@link slugStampRoot} for the holder a name is taken FROM, where a target
 * that will not resolve is an answer rather than a failure: there is no root
 * that could be carrying the name, so there is nothing to clear.
 *
 * The two sides ask one question and differ only here, in what an
 * unanswerable one means. Taking a name is what an operator reaches for when
 * its current target is broken — a redirect cycle above all — so the cleanup
 * that rides along must not be able to block the replacement.
 */
function heldStampRoot(
  pieces: PiecesController,
  held: NormalizedFullLink,
  tx: IExtendedStorageTransaction,
): Cell<unknown> | undefined {
  try {
    return slugStampRoot(
      pieces.runtime.getCellFromLink(held).withTx(tx),
    );
  } catch {
    return undefined;
  }
}

function slugIndexCell(pieces: PiecesController) {
  return pieces.runtime.getCellFromEntityId(
    pieces.getSpace(),
    entityIdFrom(slugIndexIdForSpace(pieces.getSpace())),
  ).asSchema(SLUG_INDEX_SCHEMA);
}

/**
 * Every slug name the space's index records, in byte order (utf8Compare is
 * the repo comparator).
 *
 * A lower bound with one boundary it cannot detect: the index lists slugs
 * assigned since it existed, so a slug written by an older client still
 * resolves but is not named here. Nothing can find such a slug to report it —
 * a slug cell's id is derived from its name, and that unenumerability is the
 * reason the index exists at all.
 */
export async function listSlugs(pieces: PiecesController): Promise<string[]> {
  const index = await slugIndexCell(pieces).pull();
  if (index === undefined) return [];
  return Object.keys(index).filter((slug) => index[slug] === true)
    .sort(utf8Compare);
}

/**
 * What `slug` holds now, as an opaque value: the value a caller hands back as
 * `takeFrom` when it has its own rule about which states count as a free
 * name. Read it, judge it, and carry it into the assignment, where the commit
 * holds the judgment against the state the write actually lands on. `null` is
 * a name pointing nowhere.
 *
 * Opaque because it covers more than where the name points. A rule that calls
 * a name free because it resolves to no piece is judging the target as well
 * as the pointer, and a comparison over the pointer alone would let the
 * target become a piece under the caller and still match. Read it, do not
 * parse it.
 */
export async function readSlugBinding(
  pieces: PiecesController,
  slug: string,
): Promise<string | null> {
  const slugCell = slugCellFor(pieces, validateSlug(slug));
  await slugCell.sync();
  // The target too, so the facts below are read from what the space holds
  // rather than from whatever this client happens to have. A name that
  // resolves nowhere has no target to load, and reads as that state.
  try {
    await slugCell.resolveAsCell().sync();
  } catch {
    // Nothing to load, which `targetKindOf` records as its own state.
  }
  return slugBindingOf(pieces, slugCell, true).claim;
}

/**
 * Points `slug` at a piece and stamps the piece with the name, refusing a
 * name that is already bound the way {@link setSlugLink} does.
 */
export async function assignSlug(
  pieces: PiecesController,
  piece: Cell<unknown>,
  slug: string,
  options?: { force?: boolean; takeFrom?: string | null },
): Promise<void> {
  await setSlugLink(pieces, slug, piece, {
    writeTargetMetadata: true,
    force: options?.force,
    takeFrom: options?.takeFrom,
  });
}

/**
 * Points `slug` at `source`, and records the name in the space's slug index.
 *
 * A name pointing somewhere other than `takeFrom` — nowhere, for a caller
 * that names none — is refused: with a {@link SlugAssignedError} naming what
 * it holds, or a {@link SlugReleasedError} when it has come to point nowhere,
 * which is a name to read again rather than one to leave alone. `force` takes
 * it whatever it holds, and ignores `takeFrom`.
 *
 * The refusal is a claim rather than a check: the name is read inside the
 * transaction the assignment commits in, so a writer that binds it between
 * that read and the commit conflicts, and `editWithRetry` re-runs the body
 * against what that writer left. Two assignments of one free name therefore
 * end with one holder, not with whichever committed last — and that holds for
 * a caller whose own rule about a free name is wider than this module's,
 * because `takeFrom` carries that rule's answer into the transaction rather
 * than leaving it in a read the write has outlived.
 *
 * Taking a name from a holder clears the `slug` entry the holder's document
 * root carries for it, in the same transaction as the new redirect, so no
 * document is left claiming a name it no longer holds.
 *
 * Throws when storage refuses the transaction, so a caller never reads a name
 * as assigned that never landed.
 */
export async function setSlugLink(
  pieces: PiecesController,
  slug: string,
  source: Cell<unknown>,
  options?: {
    resolveBeforeLinking?: boolean;
    writeTargetMetadata?: boolean;
    force?: boolean;
    takeFrom?: string | null;
  },
): Promise<void> {
  const claim = await prepareSlugClaim(pieces, slug, source, options);
  const { validSlug } = claim;
  // Where the caller says the name points now, and so what the assignment
  // commits only while it still points at. A caller that names none is asking
  // for a free name, which is a name pointing nowhere.
  const takeFrom = options?.takeFrom ?? null;

  const { ok: refusal, error } = await pieces.runtime.editWithRetry((tx) =>
    claimSlugInTx(pieces, claim, tx, {
      ...(options?.force === undefined ? {} : { force: options.force }),
      takeFrom,
    })
  );
  if (error) {
    throw new Error(
      `Linking the slug "${validSlug}" failed because storage returned ${error.name}: ${error.message}`,
      { cause: error },
    );
  }
  if (refusal !== undefined) {
    if (refusal.held !== null) {
      throw new SlugAssignedError(validSlug, refusal.held);
    }
    // A name pointing nowhere only refuses a caller that named somewhere for
    // it to point, because `takeFrom` of `null` is what a name pointing
    // nowhere matches. So there is a reference to report here.
    throw new SlugReleasedError(validSlug, takeFrom!);
  }

  await pieces.runtime.idle();
  await pieces.synced();
}

/** A slug claim with its cells synced, ready to be written in a transaction. */
export interface PreparedSlugClaim {
  validSlug: string;

  /** The cell the name will redirect to. */
  target: Cell<unknown>;

  /** The document that records the name it holds, when one is to. */
  metadataTarget: Cell<unknown> | undefined;

  /** The name's own cell, synced so the claim reads what the space holds. */
  slugCell: Cell<unknown>;

  /** The slug index, synced for the same reason. */
  indexCell: Cell<Record<string, boolean>>;
}

/**
 * Validate `slug` and sync every cell {@link claimSlugInTx} reads, so the
 * claim can be written inside a transaction the caller owns. A caller with
 * a transaction of its own — a served creation naming the piece it creates
 * — takes this pair instead of {@link setSlugLink}.
 */
export async function prepareSlugClaim(
  pieces: PiecesController,
  slug: string,
  source: Cell<unknown>,
  options?: { resolveBeforeLinking?: boolean; writeTargetMetadata?: boolean },
): Promise<PreparedSlugClaim> {
  const validSlug = validateSlug(slug);
  const target = options?.resolveBeforeLinking
    ? source.resolveAsCell()
    : source;
  await target.sync();
  const metadataTarget = options?.writeTargetMetadata ||
      options?.resolveBeforeLinking
    ? target.resolveAsCell()
    : undefined;
  await metadataTarget?.sync();
  const indexCell = slugIndexCell(pieces);
  await indexCell.sync();
  const slugCell = slugCellFor(pieces, validSlug);
  await slugCell.sync();
  return { validSlug, target, metadataTarget, slugCell, indexCell };
}

/**
 * Write a prepared claim in `tx`: the redirect, the index entry, and the
 * name on the target's document, clearing it from a holder the claim takes
 * the name from. Returns the refusal — what the name holds — when the name
 * points somewhere other than `takeFrom` and `force` is not set, and then
 * writes nothing.
 */
export function claimSlugInTx(
  pieces: PiecesController,
  claim: PreparedSlugClaim,
  tx: IExtendedStorageTransaction,
  options?: { force?: boolean; takeFrom?: string | null },
): { held: string | null } | undefined {
  const { validSlug, target, metadataTarget, slugCell, indexCell } = claim;
  const takeFrom = options?.takeFrom ?? null;
  const targetWithTx = target.withTx(tx);
  const slugWithTx = slugCell.withTx(tx);
  const metadataTargetWithTx = metadataTarget?.withTx(tx);

  // The claim, ahead of every write so that declining stages nothing: the
  // reads here join the commit's read set, so a change to what the name
  // holds under this transaction rejects it and the body re-runs against
  // what the change left.
  const binding = slugBindingOf(pieces, slugWithTx, takeFrom !== null);
  const held = binding.held;
  if (!options?.force && binding.claim !== takeFrom) {
    // A `null` reference is a refusal too: a caller that named what to
    // take the name from has not got it, whether somebody else holds the
    // name now or nobody does.
    return { held: binding.ref };
  }

  // The name is being taken from a holder, so the holder stops claiming
  // it. Only its own name is cleared: another name pointing at the same
  // root is not this assignment's to drop. Ahead of the stamp below, so a
  // root that is both the old holder and the new one ends up stamped.
  const previousRoot = held === undefined
    ? undefined
    : heldStampRoot(pieces, held, tx);
  if (previousRoot?.getMetaRaw("slug") === validSlug) {
    previousRoot.setMetaRaw("slug", undefined, rawMetaWriteAuthorization);
  }

  const stampRoot = metadataTargetWithTx === undefined
    ? undefined
    : slugStampRoot(metadataTargetWithTx);
  stampRoot?.setMetaRaw("slug", validSlug, rawMetaWriteAuthorization);
  slugWithTx.setMetaRaw("slug", validSlug, rawMetaWriteAuthorization);
  // Only the redirect write carries the schema; the meta write above keeps
  // the bare handle, whose sync stays the one the name was read through.
  const redirectWrite = slugWithTx.asSchema(SLUG_REDIRECT_SCHEMA);
  redirectWrite.setRawUntyped(
    targetWithTx.getAsWriteRedirectLink({ base: redirectWrite }),
  );
  // The index entry rides the slug's own transaction, so a listing can
  // never see a name without its slug or a slug without its name.
  indexCell.withTx(tx).key(validSlug).set(true);
  return undefined;
}

/**
 * A piece and a cell path inside it, as an address and the path written
 * after it resolve.
 */
export interface PieceReference {
  /** The piece's id. */
  piece: string;

  /**
   * The scope the piece was reached through, where that narrows the default.
   * Absent otherwise, which leaves whatever scope the caller was addressing
   * under standing.
   */
  scope?: CellScope;

  /** The segments left to address after the piece, a cell path inside it. */
  pathAfter: (string | number)[];
}

/**
 * Where a slug points: the piece whose document holds the target, and the
 * path from that document's root to the target, which is empty when the slug
 * names the piece itself.
 */
export interface SlugTarget {
  /** The id of the piece the target sits in. */
  piece: string;

  /** The path from the piece's root to the target. */
  pathInside: string[];
}

/**
 * Resolves an address and the path written after it to a piece and the cell
 * path inside it. A handle names its piece and the path is returned whole. A
 * slug resolves as the runtime's `resolveSlugReference` does: to the piece it
 * names, with the path returned whole, or through the collection it names to
 * the member the path's first segment selects, with the rest of the path.
 *
 * Fails as `resolveSlugReference` fails, and with `missing-piece-id` when the
 * piece reached has no id.
 */
export async function resolvePieceReference(
  pieces: PiecesController,
  token: string,
  path: readonly (string | number)[],
): Promise<PieceReference> {
  if (!isSlugAddress(token)) {
    return { piece: token, pathAfter: [...path] };
  }
  const target = await resolveSlugReference(
    pieces.runtime,
    pieces.getSpace(),
    token,
    path,
  );
  // Scope selects which instance of an id is addressed, so a member held
  // through a narrowed link is a different cell from the one the id alone
  // names. Reporting it is what keeps a read and a write on that member from
  // landing on the space-wide instance instead.
  const { scope } = target.piece.getAsNormalizedFullLink();
  return {
    piece: pieceIdOrThrow(token, target.piece),
    ...(scope !== undefined && scope !== DEFAULT_CELL_SCOPE && { scope }),
    pathAfter: target.pathAfter,
  };
}

/**
 * Resolves an address to a piece id: a handle as itself, and a slug as
 * {@link resolvePieceReference} resolves it with no path, so a slug that
 * names a collection rather than a piece is refused.
 */
export async function resolvePieceAddress(
  pieces: PiecesController,
  token: string,
): Promise<string> {
  return (await resolvePieceReference(pieces, token, [])).piece;
}

/**
 * Resolves a slug to the piece its target sits in and the path to the target
 * inside it. Fails with `not-piece` when that document is no piece, and with
 * `missing-piece-id` when it has no id.
 */
export async function resolveSlugTarget(
  pieces: PiecesController,
  token: string,
): Promise<SlugTarget> {
  const target = await resolveSlugTargetInPiece(
    pieces.runtime,
    pieces.getSpace(),
    token,
  );
  return {
    piece: pieceIdOrThrow(token, target.piece),
    pathInside: target.pathInside,
  };
}

/**
 * Helper for `resolvePieceReference()` and `resolveSlugTarget()`, which reads
 * a piece's id off its root cell and refuses a cell that has none.
 */
function pieceIdOrThrow(token: string, piece: Cell<unknown>): string {
  const id = pieceId(piece);
  if (!id) {
    throw new SlugResolutionError(
      `Slug "${token}" redirects to a document without a piece id.`,
      "missing-piece-id",
    );
  }
  return id;
}

export async function resolveSlugTargetCell(
  pieces: PiecesController,
  token: string,
): Promise<Cell<unknown>> {
  return await resolveRuntimeSlugTargetCell(
    pieces.runtime,
    pieces.getSpace(),
    token,
  );
}
