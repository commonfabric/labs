import { assertNotDID, DID, isDID } from "@commonfabric/identity/did";
import type { CellScope } from "@commonfabric/api";
import {
  parseCellReference,
  renderCellReference,
} from "@commonfabric/runner/shared";
import { asSpaceSegment } from "@commonfabric/runner/fabric-url";
import { isSlugAddress, isValidSlug } from "@commonfabric/runner/slugs";

export type AppBuiltInView = "home";

export type AppViewMode = "embed";

const EMBED_PATH_PREFIX = ".embed";

export type PieceViewRef = {
  pieceId?: string;
  /** The concrete document instance; omitted means the space scope. */
  pieceScope?: CellScope;
  /** Pointer keys of a nested view in the selected result document. */
  piecePath?: string[];
  pieceSlug?: string;

  /**
   * The member `pieceSlug` names, when that slug names a collection rather
   * than a piece: `/<space>/top/42` holds the slug `top` and the member `42`.
   * One segment reaches a member, so a member's own fields never compete for
   * it, and a view carrying one without a slug addresses nothing.
   */
  pieceMember?: string;

  /**
   * The segments an address carries past its member, joined as written:
   * `/<space>/top/42/comments/7` holds the member `42` and this `comments/7`.
   * Only the member is read out of an address, so these are carried rather
   * than read, and a view holding them addresses nothing that opens. Carrying
   * them is what keeps such a view from being the view of the member alone,
   * and what lets whoever opens it name them in refusing it.
   */
  pieceExtraPath?: string;
};

export type AppViewModeRef = {
  mode?: AppViewMode;
};

export type AppOpenPathRef = {
  /** One-shot deep link: a target the piece should open on load, captured
   * from `?path=` at boot. Consumed by the shell after the piece loads and
   * never re-emitted into a URL (`appViewToUrlPath` ignores it), so
   * reloads and internal navigation stay clean. */
  openPath?: string;
};

export type AppView =
  | {
    builtin: AppBuiltInView;
  }
  | (
    & {
      spaceName: string;
    }
    & PieceViewRef
    & AppViewModeRef
    & AppOpenPathRef
  )
  | (
    & {
      spaceDid: DID;
    }
    & PieceViewRef
    & AppViewModeRef
    & AppOpenPathRef
  );

/**
 * How a view addresses a space, given a name and a DID that may both be
 * present and may both be absent.
 *
 * A name that is a DID addresses the space by DID. Taken as a name it would
 * instead name the space a key derived from that string reaches, which is a
 * different space; and the URL it produced would be read back as a space DID
 * anyway, so the view would not survive its own round trip.
 *
 * Returns `undefined` only when neither is given, which is a view that
 * addresses no space at all; a caller holding a DID always gets one back.
 */
export function spaceViewRef(
  spaceName: string | undefined,
  spaceDid: DID,
): { spaceName: string } | { spaceDid: DID };
export function spaceViewRef(
  spaceName: string | undefined,
  spaceDid: DID | undefined,
): { spaceName: string } | { spaceDid: DID } | undefined;
export function spaceViewRef(
  spaceName: string | undefined,
  spaceDid: DID | undefined,
): { spaceName: string } | { spaceDid: DID } | undefined {
  if (isDID(spaceName)) return { spaceDid: spaceName };
  if (spaceName) return { spaceName };
  if (spaceDid) return { spaceDid };
  return undefined;
}

export function isAppBuiltInView(view: unknown): view is AppBuiltInView {
  switch (view as AppBuiltInView) {
    case "home":
      return true;
  }
  return false;
}

export function isAppView(view: unknown): view is AppView {
  if (!view || typeof view !== "object") return false;
  if ("builtin" in view) {
    return isAppBuiltInView(view.builtin) && !("mode" in view);
  }
  if (!isAppViewModeRef(view)) return false;
  if (!isPieceViewRef(view)) return false;
  if ("spaceName" in view) {
    // A name that is also a DID is refused rather than tolerated: the URL a
    // named space produces is read back as a space DID, so such a view would
    // address one space going out and a different one coming back.
    return typeof view.spaceName === "string" && !!view.spaceName &&
      !isDID(view.spaceName);
  }
  if ("spaceDid" in view) {
    return isDID(view.spaceDid);
  }
  return false;
}

function isAppViewModeRef(view: object): view is AppViewModeRef {
  return !("mode" in view) || view.mode === "embed";
}

/**
 * Whether a view's piece reference addresses one thing: an id or a slug but
 * never both, and a member only under the slug whose collection holds it.
 *
 * A member is held to the grammar the name in front of it answers to, which
 * `docs/specs/collection-naming.md` fixes as the slug grammar for both. That
 * is what makes a member one URL segment: `appViewToUrlPath` writes it
 * verbatim and `urlToAppView` reads it back verbatim, so a value carrying a
 * separator, resolving away, or reading as empty would name something other
 * than what it says — an empty member addresses the collection's own piece
 * rather than a member of it.
 *
 * Segments past a member are held only beside a member, because they are
 * written after it: without one, `appViewToUrlPath` has nothing to write them
 * after and leaves them out, so the address it writes names the collection
 * alone. They are also held to a spelling a URL path keeps as written. Any
 * other spelling writes an address that reads back as another view: a `?` or
 * `#` starts a query or a fragment, and `../43` reads back as member `43`.
 * Past that they are not held to a grammar, since a view carrying them is
 * refused by them rather than resolved through them.
 */
function isPieceViewRef(view: object): view is PieceViewRef {
  if (
    "piecePath" in view && (!("pieceId" in view) ||
      !Array.isArray(view.piecePath) ||
      !view.piecePath.every((key) => typeof key === "string"))
  ) return false;
  if (
    "pieceScope" in view && (!("pieceId" in view) ||
      !["space", "user", "session"].includes(String(view.pieceScope)))
  ) return false;
  if ("pieceId" in view && "pieceSlug" in view) return false;
  const member = "pieceMember" in view ? view.pieceMember : undefined;
  const slug = "pieceSlug" in view ? view.pieceSlug : undefined;
  const extraPath = "pieceExtraPath" in view ? view.pieceExtraPath : undefined;
  const memberHeld = member === undefined ||
    (typeof member === "string" && isValidSlug(member) &&
      typeof slug === "string" && !!slug);
  return memberHeld &&
    (extraPath === undefined ||
      (typeof extraPath === "string" && !!extraPath && member !== undefined &&
        isKeptAsWrittenInPath(extraPath)));
}

/**
 * Whether `path`, written after a segment of a URL path, comes back out of
 * that path as it went in: nothing in it starts a query or a fragment,
 * resolves away as a dot segment, or is rewritten into another spelling.
 *
 * A URL hands its path back parsed and percent-encoded, so every spelling
 * `urlToAppView` carries out of one passes.
 */
function isKeptAsWrittenInPath(path: string): boolean {
  // Reading the answer off a URL is what keeps this from restating a parser's
  // rules for dot segments, backslashes, and what each byte encodes to: the
  // parser these addresses are read by decides, rather than a copy of it here
  // that would have to be kept in step.
  const written = `/segment/${path}`;
  return new URL(written, "http://view.invalid").pathname === written;
}

/**
 * Whether two views address the same thing. Two views are equal when they hold
 * the same fields with the same values, whatever order the route or control
 * that built them wrote those fields in. Pointer keys compare by their contents.
 * A field holding `undefined` counts
 * as absent, which is what a URL or a history entry keeps of one.
 */
export function isAppViewEqual(a: AppView, b: AppView): boolean {
  if (a === b) return true;
  const held = (view: AppView) =>
    new Map(Object.entries(view).filter(([, value]) => value !== undefined));
  const fields = held(a);
  const other = held(b);
  return fields.size === other.size &&
    [...fields].every(([name, value]) => {
      const target = other.get(name);
      return Array.isArray(value)
        ? Array.isArray(target) && value.length === target.length &&
          value.every((key, index) => key === target[index])
        : target === value;
    });
}

export function isEmbeddedView(view: AppView): boolean {
  return "mode" in view && view.mode === "embed";
}

export function preserveAppViewMode(
  currentView: AppView,
  nextView: AppView,
): AppView {
  if (!isEmbeddedView(currentView) || "builtin" in nextView) {
    return nextView;
  }
  if ("mode" in nextView) {
    return nextView;
  }
  return { ...nextView, mode: "embed" };
}

export function isViewingDefaultPatternView(view: AppView): boolean {
  return !(
    ("pieceId" in view && view.pieceId) ||
    ("pieceSlug" in view && view.pieceSlug)
  );
}

export function appViewToUrlPath(view: AppView): `/${string}` {
  const prefix = isEmbeddedView(view) ? `/${EMBED_PATH_PREFIX}` : "";
  if ("builtin" in view) {
    switch (view.builtin) {
      case "home":
        return `/`;
    }
  } else if ("spaceName" in view) {
    // `urlToAppView` reads a DID-shaped first segment back as a space DID, so
    // a name that is a DID would round-trip into a different space. Refuse it
    // here, where the name is still attached to the view that carried it.
    assertNotDID(view.spaceName, "A space name");
    return `${prefix}/${view.spaceName}${pieceUrlSegments(view)}`;
  } else if ("spaceDid" in view) {
    return `${prefix}/${view.spaceDid}${pieceUrlSegments(view)}`;
  }
  return `/`;
}

/**
 * The segments a view's piece reference adds after its space, empty for a
 * view naming no piece. A member follows the slug it belongs to; an id
 * carries pointer keys in a query value so URL normalization cannot change
 * their identity. A member is a collection's name for one of its own. The
 * segments past a member follow it as they were written, so a page refused by
 * them keeps the address that named them.
 */
function pieceUrlSegments(view: PieceViewRef): string {
  const pieceSlug = "pieceSlug" in view ? view.pieceSlug : undefined;
  const pieceId = "pieceId" in view ? view.pieceId : undefined;
  const pieceMember = "pieceMember" in view ? view.pieceMember : undefined;
  const pieceExtraPath = "pieceExtraPath" in view
    ? view.pieceExtraPath
    : undefined;
  if (pieceSlug) {
    if (!pieceMember) return `/${pieceSlug}`;
    return pieceExtraPath
      ? `/${pieceSlug}/${pieceMember}/${pieceExtraPath}`
      : `/${pieceSlug}/${pieceMember}`;
  }
  if (!pieceId) return "";
  const reference = renderCellReference({
    id: pieceId,
    path: [],
    scope: view.pieceScope ?? "space",
  }, { scope: "space" });
  return view.piecePath?.length
    ? `${reference}?${new URLSearchParams({
      cellPath: JSON.stringify(view.piecePath),
    })}`
    : reference;
}

export function urlToAppView(url: URL): AppView {
  const segments = url.pathname.split("/");
  segments.shift(); // shift off the pathnames' prefix "/";
  const mode = segments[0] === EMBED_PATH_PREFIX ? "embed" : undefined;
  if (mode) segments.shift();
  // A reference that travels carries its space, written as the cell reference
  // grammar writes a fully qualified one: `//<space>/<collection>/<member>` is
  // the spelling the header hands out and the one `cf` reads, and it
  // addresses what `/<space>/<collection>/<member>` does. The second slash is
  // the whole difference, so the empty segment it leaves ahead of the space
  // comes off.
  if (segments[0] === "") segments.shift();
  // A leading `@` on the space marks it as well. Addresses in circulation
  // carry that spelling, though the grammar reads it only ahead of a DID. The
  // mark is no part of the space, so it comes off and the segment reads as
  // any other space does — which leaves a segment that is nothing but the
  // mark naming no space, the address a bare origin already carries.
  const first = segments[0] === undefined
    ? undefined
    : asSpaceSegment(segments[0]) ?? segments[0];
  let pieceId = segments[1];
  let scopeRef: Pick<PieceViewRef, "pieceScope" | "piecePath"> = {};
  if (pieceId?.includes(":")) {
    const reference = parseCellReference(`/${segments.slice(1).join("/")}`);
    if (reference.member === "argument" || reference.pin !== undefined) {
      throw new Error("A piece view must name the current result document");
    }
    pieceId = reference.id;
    if (reference.scope && reference.scope !== "space") {
      scopeRef = { pieceScope: reference.scope };
    }
    if (reference.path.length > 0) scopeRef.piecePath = reference.path;
  }
  if (url.searchParams.has("cellPath")) {
    let path: unknown;
    try {
      path = JSON.parse(url.searchParams.get("cellPath")!);
    } catch {
      throw new Error("Invalid cell path");
    }
    if (
      !pieceId?.includes(":") || scopeRef.piecePath !== undefined ||
      url.searchParams.getAll("cellPath").length !== 1 ||
      !Array.isArray(path) || !path.every((key) => typeof key === "string")
    ) {
      throw new Error("Invalid cell path");
    }
    if (path.length > 0) scopeRef.piecePath = path;
  }
  const modeRef: AppViewModeRef = mode ? { mode } : {};
  // The segment after a slug selects a member of the collection it names.
  // Reading it apart from resolving it is what keeps this pure: whether the
  // slug names a collection at all is the resolver's question. Exactly one
  // segment reaches a member, and nothing past it is read. What is past it is
  // still part of what the address says, so it is carried as written — a
  // trailing separator adds nothing — and the view is not the member's alone.
  const member = segments[2] || undefined;
  const extraPath = member
    ? segments.slice(3).join("/") || undefined
    : undefined;
  const memberRef: PieceViewRef = member
    ? {
      pieceMember: member,
      ...(extraPath ? { pieceExtraPath: extraPath } : {}),
    }
    : {};
  // `?path=` is the piece deep link (e.g. a cabinet page Mobile Loom should
  // open). Captured here — the only place the query survives boot — and
  // delivered once by the shell after the piece loads.
  const openPath = url.searchParams.get("path") || undefined;
  const openRef: AppOpenPathRef = openPath ? { openPath } : {};

  if (!first) {
    return { builtin: "home" };
  }
  if (isDID(first)) {
    if (!pieceId) return { spaceDid: first, ...modeRef, ...openRef };
    return isSlugAddress(pieceId)
      ? {
        spaceDid: first,
        pieceSlug: pieceId,
        ...memberRef,
        ...modeRef,
        ...openRef,
      }
      : { spaceDid: first, pieceId, ...scopeRef, ...modeRef, ...openRef };
  } else {
    if (!pieceId) return { spaceName: first, ...modeRef, ...openRef };
    return isSlugAddress(pieceId)
      ? {
        spaceName: first,
        pieceSlug: pieceId,
        ...memberRef,
        ...modeRef,
        ...openRef,
      }
      : { spaceName: first, pieceId, ...scopeRef, ...modeRef, ...openRef };
  }
}
