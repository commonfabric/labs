/**
 * Reads cell references and the location and scope contexts they are relative
 * to. Names remain names; resolving a space name or piece slug requires a session.
 */

import { isDID } from "@commonfabric/identity/did";
import type {
  CellScope,
  LinkScope,
  ReferenceContext,
  ReferenceMember,
  RenderableCellReference,
} from "@commonfabric/api";

export type {
  ReferenceContext,
  ReferenceMember,
  RenderableCellReference,
} from "@commonfabric/api";

import {
  decodeJsonPointer,
  encodeJsonPointer,
} from "@commonfabric/utils/json-pointer";

/** The parts of a cell reference, with names still unresolved. */
export interface ReferenceParts {
  id: string;
  space?: string;
  member?: ReferenceMember;
  scope?: CellScope;
  pin?: string;
  path: string[];
}

/** Refuses a pin outside the module identity's base64url form. */
function checkPin(pin: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(pin)) {
    throw new Error("Invalid `@pin` value: expected 43 base64url characters.");
  }
}

/** Helper for the reader, which separates a piece or relative head from its qualifiers. */
function readHead(segment: string): {
  id: string;
  member?: ReferenceMember;
  scope?: LinkScope;
  pin?: string;
} {
  const [head, ...qualifiers] = segment.split("@");
  const [id, member, ...extra] = head.split("#");
  if (!id) throw new Error("Target must include a piece handle or slug.");
  if (
    extra.length ||
    (member !== undefined && member !== "argument" && member !== "result")
  ) {
    throw new Error(
      "Unknown member. Expected `#argument` or `#result` on the piece segment.",
    );
  }
  let scope: LinkScope | undefined;
  let pin: string | undefined;
  const seen = new Set<string>();
  for (const qualifier of qualifiers) {
    const equal = qualifier.indexOf("=");
    const name = equal < 0 ? "scope" : qualifier.slice(0, equal);
    const value = equal < 0 ? qualifier : qualifier.slice(equal + 1);
    if (seen.has(name)) throw new Error(`Duplicate qualifier \`${name}\`.`);
    seen.add(name);
    switch (name) {
      case "scope":
        if (
          value !== "space" && value !== "user" && value !== "session" &&
          value !== "inherit"
        ) {
          throw new Error(
            "Invalid scope suffix. Expected `@space`, `@user`, `@session`, or `@inherit`; other qualifiers use `@name=value` (registered names: scope, pin). Put `#argument` before qualifiers on the piece segment.",
          );
        }
        scope = value;
        break;
      case "pin":
        checkPin(value);
        pin = value;
        break;
      default:
        throw new Error(
          `Unknown qualifier \`${name}\`. Registered qualifiers: scope, pin; see the cell reference grammar's registered qualifiers table.`,
        );
    }
  }
  return {
    id,
    ...(member && { member }),
    ...(scope && { scope }),
    ...(pin && { pin }),
  };
}

/** Helper for the reader, which checks the space slot's reserved characters. */
function checkSpace(space: string): void {
  if (
    !space || /[/@#]/.test(space) ||
    (space.includes(":") && !isDID(space))
  ) {
    throw new Error(
      "Invalid space: expected a DID or a name without `/`, `@`, `#`, or `:`.",
    );
  }
}

/**
 * Reads one encoded piece segment, including member and qualifiers, without
 * resolving scope inheritance. Route readers use this when entering a piece
 * from a container. Separators inside an id must use JSON Pointer escaping.
 */
export function parsePieceSegment(
  segment: string,
): ReturnType<typeof readHead> {
  if (segment.includes("/")) {
    throw new Error("Expected one piece segment, without a path separator.");
  }
  const parts = readHead(segment);
  return { ...parts, id: decodeJsonPointer(parts.id)[0] };
}

/** A relative head and its literal path, before applying a position or route. */
export interface RelativeReferenceParts {
  /** Number of parent steps selected by the leading head. */
  climbs: number;
  /** Literal decoded keys after the head, including empty and dot keys. */
  path: string[];
  member?: ReferenceMember;
  scope?: LinkScope;
  pin?: string;
}

/**
 * Reads the leading navigation head separately from the literal path. Shuttle
 * applies the climbs to its route; cell readers apply them within a document.
 * Scope inheritance and member selection remain for the caller to resolve.
 */
export function parseRelativeReference(text: string): RelativeReferenceParts {
  if (!text) {
    throw new Error(
      "An empty reference names no cell; use `.` for the position.",
    );
  }
  if (text.startsWith("/")) {
    throw new Error("Expected a piece-relative reference.");
  }
  const segments = text.split("/");
  let climbs = 0;
  let index = 0;
  while (
    segments[index] === ".." &&
    /^\.{1,2}(?:$|[@#])/.test(segments[index + 1] ?? "")
  ) {
    climbs++;
    index++;
  }
  const candidate = segments[index];
  let head: string;
  let path: string[];
  if (/^\.\.(?:$|[@#])/.test(candidate)) {
    climbs++;
    head = candidate;
    path = segments.slice(index + 1);
  } else if (/^\.(?:$|[@#])/.test(candidate)) {
    head = candidate;
    path = segments.slice(index + 1);
  } else {
    head = ".";
    path = segments;
  }
  const { id: _id, ...qualifiers } = readHead(head);
  return {
    climbs,
    ...qualifiers,
    path: path.flatMap((segment) => decodeJsonPointer(segment)),
  };
}

/**
 * Reads a reference, filling omitted location parts and scope from `context`.
 * Preserves every pointer key, including empty and trailing keys. A relative
 * head may climb within the document; members select documents from their root.
 */
export function parseCellReference(
  text: string,
  context?: ReferenceContext,
): ReferenceParts {
  const relative = !text.startsWith("/");
  let space: string | undefined;
  let parsed: ReturnType<typeof readHead>;
  let path: string[];
  let climbs = 0;
  if (relative) {
    if (!context?.id) {
      throw new Error("A piece-relative reference requires a context piece.");
    }
    const walk = parseRelativeReference(text);
    climbs = walk.climbs;
    path = walk.path;
    parsed = {
      id: context.id,
      member: walk.member,
      scope: walk.scope,
      pin: walk.pin,
    };
    space = context.space;
  } else {
    const segments = text.split("/");
    let offset = 1;
    if (text.startsWith("//") || text.startsWith("/@")) {
      space = text.startsWith("//") ? segments[2] : segments[1].slice(1);
      checkSpace(space);
      if (text.startsWith("/@") && !space.startsWith("did:")) {
        throw new Error(
          `The named-space prefix \`/@${space}/\` is retired; use \`//${space}/\`.`,
        );
      }
      offset = text.startsWith("//") ? 3 : 2;
    } else {
      space = context?.space;
    }
    parsed = parsePieceSegment(segments[offset] ?? "");
    path = segments.slice(offset + 1).flatMap((segment) =>
      decodeJsonPointer(segment)
    );
  }
  if (parsed.scope === "inherit" && context === undefined) {
    throw new Error("`@inherit` requires a reference context.");
  }
  const scope = parsed.scope === "inherit"
    ? context?.scope ?? "space"
    : parsed.scope ?? context?.scope;
  const member = parsed.member ?? (relative ? context?.member : undefined);
  const base = relative &&
      !(parsed.member !== undefined &&
        parsed.member !== (context?.member ?? "result"))
    ? [...context?.path ?? []]
    : [];
  if (climbs > base.length) {
    throw new Error("A relative head cannot climb above the piece.");
  }
  base.splice(base.length - climbs, climbs);
  return {
    id: parsed.id,
    ...(space !== undefined && { space }),
    ...(member && { member }),
    ...(scope && { scope }),
    ...(parsed.pin && { pin: parsed.pin }),
    path: [...base, ...path],
  };
}

/** Reads a complete context, admitting a space alone as `//space`. */
export function parseReferenceContext(text: string): ReferenceContext {
  if (text === "") return {};
  if (!text.startsWith("//")) {
    throw new Error(
      "A reference context must be complete, beginning with `//`.",
    );
  }
  if (!text.slice(2).includes("/")) {
    const space = text.slice(2);
    checkSpace(space);
    return { space };
  }
  const parsed = parseCellReference(text);
  if (parsed.pin) throw new Error("A reference context cannot carry a pin.");
  return { ...parsed, space: parsed.space! };
}

/** Renders a context in complete form, preserving an unknown scope. */
export function renderReferenceContext(context: ReferenceContext): string {
  if (context.space === undefined) {
    if (context.scope) {
      throw new Error("A scope-only context has no text form.");
    }
    return "";
  }
  checkSpace(context.space);
  if (context.id === undefined) {
    if (context.scope) {
      throw new Error("A space-only context cannot carry a scope in text.");
    }
    return `//${context.space}`;
  }
  return renderCellReference(
    { ...context, path: context.path ?? [] },
    context.scope === undefined ? { scope: "space" } : {},
  );
}

/**
 * Renders the parts a context does not supply, falling back to a more complete
 * location when space or piece differs. An empty context writes the space and
 * scope explicitly. An unresolved space can be rendered only against a context
 * that also leaves the space unknown.
 */
export function renderCellReference(
  link: RenderableCellReference,
  context: ReferenceContext = {},
): string {
  if (link.pin !== undefined) checkPin(link.pin);
  if (link.space !== undefined) checkSpace(link.space);
  if (link.space === undefined && context.space !== undefined) {
    throw new Error(
      "An unresolved reference space cannot inherit a known context space.",
    );
  }
  const path = link.path.map(String);
  const scope = link.scope ?? "space";
  const qualifiers = (scope === context.scope ? "" : `@${scope}`) +
    (link.pin === undefined ? "" : `@pin=${link.pin}`);
  const member = link.member ?? "result";
  if (link.space !== context.space || link.id !== context.id) {
    const prefix = link.space === context.space ? "/" : `//${link.space}/`;
    return prefix + encodeJsonPointer([link.id]) +
      (member === "argument" ? "#argument" : "") + qualifiers +
      (path.length ? "/" + encodeJsonPointer(path) : "");
  }

  const switched = member !== (context.member ?? "result");
  const base = switched ? [] : context.path ?? [];
  let shared = 0;
  while (
    shared < base.length && shared < path.length &&
    base[shared] === path[shared]
  ) shared++;
  const climbs = base.length - shared;
  const tail = path.slice(shared);
  const selection = (switched ? `#${member}` : "") + qualifiers;
  if (
    !climbs && !selection && tail.length && tail[0] !== "" &&
    !/^\.{1,2}(?:$|[@#])/.test(tail[0])
  ) {
    return encodeJsonPointer(tail);
  }
  let head = climbs ? Array(climbs).fill("..").join("/") : ".";
  if (climbs && !selection && /^\.{1,2}(?:$|[@#])/.test(tail[0] ?? "")) {
    head += "/.";
  }
  return head + selection + (tail.length ? "/" + encodeJsonPointer(tail) : "");
}
