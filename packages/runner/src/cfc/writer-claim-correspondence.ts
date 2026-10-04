/**
 * Spelling helpers for `writeAuthorizedBy` writer-identity claims.
 *
 * A claim's `file` and a live identity's `sourceFile` both record the module's
 * source-file SPELLING, and that spelling is resolver-dependent: the compiler
 * sees names exactly as the program resolver spelled them, and the
 * ts-transformers' historical normalization additionally stripped the first
 * path segment of absolute names (aimed at the engine's per-load `/<id>`
 * prefix, but applied blindly). The same module therefore appears as e.g.
 * `/api/patterns/system/x.tsx` (piece-deploy staging), `api/patterns/...`
 * (piece-manifest relative), or `/patterns/system/x.tsx` (HTTP-resolved,
 * stripped) — while its content-addressed `moduleIdentity` agrees everywhere
 * (labs#4772 / CT-1886).
 *
 * Authorization therefore anchors on `moduleIdentity` + `bindingPath`; the
 * file spelling is diagnostic. The tolerant correspondence below is consumed
 * in exactly one place — `reconcileWriterClaimStamp` (schema-merge.ts), where
 * a stamp minted under the current compile's spelling meets a stored claim
 * carrying an aged spelling of the same binding, and only while at most one
 * of the two is stamped: two stamped claims each name their module
 * content-addressed, and their spellings are not compared at all. It
 * deliberately does NOT gate stamp MINTING (`rebindWriteAuthorizedByClaims`
 * requires exact slash-normalized equality: a claim being stamped rides a
 * schema emitted by the same compile as the writer, so exact holds wherever
 * stamping is genuine), so the tolerance never widens who can create
 * authority — only how an already-minted stamp meets an aged spelling.
 * Residual: at the reconcile-adoption edge, a hostile verified module whose
 * forged path differs from a stored unstamped claim's by one leading segment
 * is accepted where before it needed the exact spelling — a marginal widening
 * of the pre-existing path-forgeability that #4871's mint-time identity
 * binding closes at the source for newly engine-minted claims (aged unstamped
 * claims remain compatibility state), with authenticated `piece setsrc`
 * delegation carrying authority across legitimate updates.
 *
 * The correspondence is deliberately no wider than the divergence the
 * toolchain actually produced: equal after slash-normalization, or exactly
 * one leading path segment apart (the transformer's strip). Stored claims
 * keep their mint-time spelling forever, so this is permanent aged-store
 * compat.
 *
 * One wider rule, {@link writerClaimPatternFilesCorrespond}, lets a stamped
 * claim adopt an unstamped one spelled below another known pattern root. It
 * applies only in a release of the piece whose document holds the claim
 * (schema-merge.ts `release`), where the release's own schema is what
 * describes the document from then on.
 */

/** Leading-slash-normalize a claim/identity source-file spelling. */
export const normalizeIdentitySource = (
  source: string | undefined,
): string | undefined => {
  if (typeof source !== "string" || source.length === 0) {
    return undefined;
  }
  return source.startsWith("/") ? source : `/${source}`;
};

// The ts-transformers' historical first-segment strip, mirrored exactly: the
// only spelling divergence the toolchain has produced for one module.
const dropFirstPathSegment = (source: string): string | undefined =>
  source.match(/^\/[^/]+(\/.+)$/)?.[1] ?? undefined;

/**
 * Whether two source-file spellings plausibly name the same module: equal
 * after leading-slash normalization, or one is the other minus its first
 * path segment. Never treats an undefined side as corresponding.
 */
export const writerClaimFilesCorrespond = (
  left: string | undefined,
  right: string | undefined,
): boolean => {
  const a = normalizeIdentitySource(left);
  const b = normalizeIdentitySource(right);
  if (a === undefined || b === undefined) {
    return false;
  }
  if (a === b) {
    return true;
  }
  return dropFirstPathSegment(a) === b || dropFirstPathSegment(b) === a;
};

// The roots the pattern sources are compiled below: the toolshed's route, a
// labs checkout, and the toolchain's old strip of either. Closed on purpose;
// a root this list does not name leaves the spelling as it is.
const PATTERN_ROOTS = ["/api/patterns/", "/packages/patterns/", "/patterns/"];

// A spelling's path below its pattern root, or the spelling itself when no
// known root starts it (a compile rooted at the patterns directory).
const patternTail = (source: string): string => {
  const root = PATTERN_ROOTS.find((prefix) => source.startsWith(prefix));
  return root === undefined ? source : `/${source.slice(root.length)}`;
};

/**
 * Whether an unstamped stored claim's file and a stamped claim's file name the
 * same source below a known pattern root: the same path from the root down,
 * at least a directory and a file name, so a file staged alone matches
 * nothing.
 *
 * A claim stored before writer stamps existed carries only the spelling its
 * compile gave, and compiles rooted differently (the toolshed route, a labs
 * checkout, the patterns directory itself) spell one file differently by
 * more than the one segment {@link writerClaimFilesCorrespond} allows. Used
 * only where a stamped claim adopts an unstamped one, which authorized no
 * writer.
 */
export const writerClaimPatternFilesCorrespond = (
  unstamped: string | undefined,
  stamped: string | undefined,
): boolean => {
  const a = normalizeIdentitySource(unstamped);
  const b = normalizeIdentitySource(stamped);
  if (a === undefined || b === undefined) return false;
  // The stamp comes from the current compile, which spells a pattern below
  // one of the roots; a spelling that names none could be anything.
  if (!PATTERN_ROOTS.some((root) => b.startsWith(root))) return false;
  const tail = patternTail(a);
  const segments = tail.split("/").slice(1);
  return tail === patternTail(b) && segments.length >= 2 &&
    segments.every((segment) =>
      segment !== "" && segment !== "." && segment !== ".."
    );
};
