import type { Cell } from "./cell.ts";
import { entityIdFrom } from "./create-ref.ts";
import { areNormalizedLinksSame } from "./link-types.ts";
import { parseLink } from "./link-utils.ts";
import { cellEntityIdString } from "./piece-helpers.ts";
import { getPatternIdentityRef } from "./runner.ts";
import type { Runtime } from "./runtime.ts";
import type { URI } from "./sigil-types.ts";
import { slugIdForSpace, validateSlug } from "./slugs.ts";
import type { MemorySpace } from "./storage/interface.ts";

/**
 * A slug that did not resolve, with a `code` saying how. `inside-piece` and
 * `missing-member` come from resolving a slug that names a collection;
 * `not-piece` is the target that is neither a piece nor a member of one.
 */
export class SlugResolutionError extends Error {
  constructor(
    message: string,
    readonly code?:
      | "invalid"
      | "missing"
      | "malformed"
      | "not-piece"
      | "inside-piece"
      | "missing-member"
      | "missing-piece-id",
  ) {
    super(message);
    this.name = "SlugResolutionError";
  }
}

/**
 * Whether `cell`'s document is a piece: it carries a pattern pointer, either
 * the durable `patternIdentity` or the session pointer a keyless piece has in
 * the runner that set it up. The pointer is the document's, so this holds
 * for every cell in a piece's document whatever its path; {@link isPieceRoot}
 * is the test for the piece itself.
 */
export function isPieceDocument(
  runtime: Runtime,
  cell: Cell<unknown>,
): boolean {
  return getPatternIdentityRef(cell) !== undefined ||
    runtime.runner.sessionPatternPointerFor(cell) !== undefined;
}

/** Whether `cell` is a piece: the root of a document a piece owns. */
export function isPieceRoot(runtime: Runtime, cell: Cell<unknown>): boolean {
  return cell.getAsNormalizedFullLink().path.length === 0 &&
    isPieceDocument(runtime, cell);
}

/**
 * Where a slug's redirect lands, as the piece whose document holds it: the
 * document's root cell, and the path from there to the target, which is
 * empty when the slug names the piece itself.
 */
export interface SlugTargetInPiece {
  /** The root cell of the document the slug's target sits in. */
  piece: Cell<unknown>;

  /** The path from that root to the target. */
  pathInside: string[];
}

/**
 * Where a slug reference lands: the piece reached, as its root cell, and the
 * segments left after it, which are a cell path inside that piece.
 */
export interface SlugReferenceTarget<Segment extends string | number> {
  /** The piece's root cell. */
  piece: Cell<unknown>;

  /** The segments left to address after the piece, a cell path inside it. */
  pathAfter: Segment[];
}

/**
 * Called with each cell a slug's resolution loaded, once it is loaded: the
 * slug's own document, its target, and each cell the walk followed from
 * there. A reader deciding what the answer may show decides it on these,
 * since the answer, and the failure, are made from what they hold.
 */
export type SlugWalkRead = (cell: Cell<unknown>) => void;

/**
 * Resolves a slug to the piece its target sits in and the path to the target
 * inside it. Fails with `not-piece` when the target's document is no piece,
 * and as {@link resolveSlugTargetCell} fails when the slug does not resolve.
 */
export async function resolveSlugTargetInPiece(
  runtime: Runtime,
  space: MemorySpace,
  token: string,
  read?: SlugWalkRead,
): Promise<SlugTargetInPiece> {
  const target = await resolveSlugTargetCell(runtime, space, token, read);
  if (!isPieceDocument(runtime, target)) {
    throw notPiece(token);
  }
  const link = target.getAsNormalizedFullLink();
  const piece = link.path.length === 0 ? target : runtime.getCellFromLink({
    id: link.id,
    space: link.space,
    scope: link.scope,
    path: [],
  });
  return { piece, pathInside: [...link.path] };
}

/**
 * Resolves a slug and the path written after it to a piece.
 *
 * A slug whose target is a piece root names that piece, and the path is a
 * cell path inside it, returned whole. A slug whose target is any other cell
 * names a collection: the target is a map from member name to member, the
 * first segment of the path selects a member, and the cell that member holds,
 * followed through its links, is the piece. Exactly one segment reaches a
 * member, so an item's own fields and a collection's member names stay
 * different namespaces — a member name never competes for the segment after
 * an item. Whichever way the piece was reached, the segments after it are a
 * cell path inside it.
 *
 * Fails, as a `SlugResolutionError`, with `inside-piece` when the target is a
 * cell inside a piece and the path is empty, naming that piece; with
 * `not-piece` when the target is neither a piece nor inside one and the path
 * is empty, or when the member the segment selects is no piece; and with
 * `missing-member` when the segment selects nothing. A slug that does not
 * resolve fails as {@link resolveSlugTargetCell} does.
 */
export async function resolveSlugReference<Segment extends string | number>(
  runtime: Runtime,
  space: MemorySpace,
  token: string,
  path: readonly Segment[],
  read?: SlugWalkRead,
): Promise<SlugReferenceTarget<Segment>> {
  const target = await resolveSlugTargetCell(runtime, space, token, read);
  if (isPieceRoot(runtime, target)) {
    return { piece: target, pathAfter: [...path] };
  }
  if (path.length === 0) {
    throw isPieceDocument(runtime, target)
      ? new SlugResolutionError(
        `Slug "${token}" redirects to a cell inside piece ${
          cellEntityIdString(target)
        }; name a member, e.g. ${token}/<name>.`,
        "inside-piece",
      )
      : notPiece(token);
  }

  // The map is followed through its link before its keys are read: a
  // collection is reached from the containing piece through a link, and a key
  // read on the unresolved cell would look the member up in the wrong
  // document. The member's own link chain is followed the same way.
  const map = await followAndLoad(target, read);
  const member = String(path[0]);
  const held = map.key(member);
  if (held.getRaw() === undefined) {
    throw new SlugResolutionError(
      `no member ${member} in ${token}`,
      "missing-member",
    );
  }
  const reached = await followAndLoad(held, read);
  if (!isPieceRoot(runtime, reached)) {
    throw new SlugResolutionError(
      `"${token}/${member}" does not name a piece.`,
      "not-piece",
    );
  }
  return { piece: reached, pathAfter: path.slice(1) };
}

/**
 * Helper for `resolveSlugReference()`, which follows `cell`'s link to the
 * cell it lands on and loads that cell's document. A link is read out of a
 * loaded document, so following stops at the first document not yet loaded;
 * each round loads what the last one reached and follows again, until
 * following moves nowhere. A cycle of links ends in `resolveAsCell()`'s own
 * refusal.
 */
async function followAndLoad(
  cell: Cell<unknown>,
  read: SlugWalkRead | undefined,
): Promise<Cell<unknown>> {
  let current = cell;
  for (;;) {
    await current.sync();
    read?.(current);
    const next = current.resolveAsCell();
    if (
      areNormalizedLinksSame(
        next.getAsNormalizedFullLink(),
        current.getAsNormalizedFullLink(),
      )
    ) {
      return current;
    }
    current = next;
  }
}

/**
 * Helper for `resolveSlugReference()` and `resolveSlugTargetInPiece()`, which
 * builds the `not-piece` failure.
 */
function notPiece(token: string): SlugResolutionError {
  return new SlugResolutionError(
    `Slug "${token}" redirects to a document that is not a piece.`,
    "not-piece",
  );
}

export async function resolveSlugTargetCell(
  runtime: Runtime,
  space: MemorySpace,
  token: string,
  read?: SlugWalkRead,
): Promise<Cell<unknown>> {
  const slug = validateSlug(token);
  const slugId = slugIdForSpace(space, slug);
  const slugCell = runtime.getCellFromEntityId(
    space,
    entityIdFrom(slugId),
  );
  await slugCell.sync();
  read?.(slugCell);
  const raw = slugCell.getRaw();
  if (raw === undefined) {
    throw new SlugResolutionError(`Slug "${slug}" not found.`, "missing");
  }

  const targetLink = parseSlugRedirect(raw, slugCell);
  if (!targetLink) {
    throw new SlugResolutionError(
      `Slug "${slug}" does not contain a valid redirect.`,
      "malformed",
    );
  }

  const target = runtime.getCellFromLink({
    ...targetLink,
    id: targetLink.id as URI,
    space: targetLink.space ?? space,
    scope: targetLink.scope ?? "space",
  });
  await target.sync();
  read?.(target);
  return target;
}

/**
 * Parse a slug document's raw payload into its redirect link, or undefined
 * when the payload is not a valid redirect. parseLink throws plain TypeErrors
 * on sigil-SHAPED payloads with broken internals (e.g. a non-array path);
 * this runtime's own write path rejects such values, but a slug cell can be
 * written by foreign clients over the memory protocol, so the resolver must
 * fold a parse throw into the same typed "malformed" outcome as a
 * structurally-invalid payload.
 *
 * The one question about what a name holds, so a reader and a writer cannot
 * disagree about it: `packages/piece/src/slugs.ts` asks it before assigning,
 * and would otherwise let a payload this resolver reports as malformed throw
 * out of an assignment instead.
 */
export function parseSlugRedirect(raw: unknown, base: Cell<unknown>) {
  try {
    const link = parseLink(raw, base);
    return link?.overwrite === "redirect" ? link : undefined;
  } catch {
    return undefined;
  }
}
