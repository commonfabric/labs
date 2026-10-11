/**
 * The closed set of things a piece's recorded origin can be.
 *
 * A piece stores its origin as one string in `patternSource`. Every consumer —
 * the reconciler that follows it, the panel that displays it — dispatches on
 * the same classification, so what the product says about an origin and what
 * the runtime does with it cannot drift apart.
 *
 * `docs/specs/piece-source-lifecycle.md` is the design of record. The kinds
 * below are that document's origin vocabulary, plus the two states a stored
 * string can be in that name no source at all.
 */

import {
  type FabricRef,
  parseFabricRef,
  pinnedIdentity,
} from "./sandbox/fabric-import-specifier.ts";
import {
  normalizePatternSource,
  resolveSystemPatternSource,
} from "./pattern-source-scheme.ts";

/**
 * What one recorded origin string is.
 *
 * - `system`: a pattern this deployment's toolshed serves from its patterns
 *   directory. `route` is the path it addresses; the host is supplied by
 *   whoever serves the piece's space.
 * - `legacy-path`: a rooted path from before the `system:` scheme existed.
 *   `ref` is the `system:` ref naming the same file when there is one, and is
 *   absent for a path that addresses nothing under the patterns route.
 * - `fabric-entity`: an unpinned fabric URL naming a mutable entity, whose
 *   current pattern the piece follows.
 * - `fabric-pattern`: content-addressed source, named directly or fixed by a
 *   trailing pin. It resolves to the same code forever.
 * - `unusable`: a string no resolver can follow.
 */
export type PieceOriginKind =
  | { kind: "system"; ref: string; route: string }
  | { kind: "legacy-path"; path: string; ref?: string }
  | { kind: "fabric-entity"; ref: FabricRef }
  | { kind: "fabric-pattern"; ref: FabricRef; identity: string }
  | { kind: "unusable"; reason: string };

/**
 * A `system:` origin: the one kind whose host advertises, through the
 * `?identity` route, the identity of the source it serves.
 */
export type SystemPieceOrigin = Extract<PieceOriginKind, { kind: "system" }>;

/**
 * Classify a recorded origin string.
 *
 * `host` is the origin of the host serving the piece's space, used only to
 * recognize the absolute spelling of a legacy patterns-route locator. Omitting
 * it leaves such a locator unusable, which is what it means for a piece served
 * by some other host.
 */
export function classifyPieceOriginString(
  origin: string,
  host?: string | URL,
): PieceOriginKind {
  const source = origin.trim();
  if (source.length === 0) {
    return { kind: "unusable", reason: "the origin is empty" };
  }

  // The fabric parser decides whether this is a fabric URL: it returns
  // undefined for anything that is not one, and throws for a fabric URL it
  // cannot read. A malformed one reports as an unusable origin like any other
  // unusable string, rather than as a parser error from a layer below.
  let ref: FabricRef | undefined;
  try {
    ref = parseFabricRef(source);
  } catch (cause) {
    return {
      kind: "unusable",
      reason: `${source} is not a usable fabric URL: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
  if (ref !== undefined) {
    const identity = pinnedIdentity(ref);
    return identity === undefined
      ? { kind: "fabric-entity", ref }
      : { kind: "fabric-pattern", ref, identity };
  }

  const route = resolveSystemPatternSource(source);
  if (route !== undefined) return { kind: "system", ref: source, route };

  // A leading `//` opens an authority, not a path, so such a string is a
  // protocol-relative URL and falls through to the absolute-URL test below,
  // where it reports as unusable for naming no scheme.
  if (source.startsWith("/") && !source.startsWith("//")) {
    const rewritten = normalizePatternSource(source);
    return {
      kind: "legacy-path",
      path: source,
      ...(rewritten === source ? {} : { ref: rewritten }),
    };
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return { kind: "unusable", reason: `${source} is not an absolute URL` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { kind: "unusable", reason: `${source} names no program` };
  }
  // The absolute spelling of a legacy patterns-route locator, which is what a
  // pre-scheme lifecycle transition rewrote a rooted path into. It is that
  // locator only when it names the host serving this piece's space.
  const rewritten = host === undefined
    ? source
    : normalizePatternSource(source, host);
  if (rewritten !== source) {
    return { kind: "legacy-path", path: source, ref: rewritten };
  }
  // Any other absolute URL names an endpoint outside this deployment. A piece
  // follows what the deployment serves and what the fabric holds, so nothing
  // resolves this and it is carried as a string a person can read and repair.
  return {
    kind: "unusable",
    reason: `${source} is an external endpoint, which is not a source origin`,
  };
}
