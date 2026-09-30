import { isDID } from "@commonfabric/identity/did";

import { validateSlug } from "../slugs.ts";
import { ENTITY_URI_SCHEMES, type EntityUriScheme } from "../entity-kind.ts";

export const HASH_RE = /^[A-Za-z0-9_-]{43}$/;

const HOST_RE = /^[a-z0-9.-]+(:\d+)?$/i;

export interface FabricRef {
  /** Toolshed host (authority); only present in the cf://host/... form. */
  host?: string;

  /** Space name or DID; absent = the compiling space. */
  space?: string;

  ref:
    | { kind: "slug"; slug: string }
    | { kind: "uri"; scheme: EntityUriScheme | "pattern"; hash: string };

  /** Path inside the target program. */
  subpath?: string;

  /** Trailing @<hash> pin. */
  pin?: string;
}

export class FabricRefError extends Error {
  constructor(message: string, readonly specifier: string) {
    super(`${message}: ${specifier}`);
    this.name = "FabricRefError";
  }
}

export function parseFabricRef(specifier: string): FabricRef | undefined {
  if (!specifier.startsWith("cf:")) return undefined;

  let rest = specifier.slice("cf:".length);
  if (
    rest.startsWith("module/") || rest.startsWith("cache-root/") ||
    rest.startsWith("source-root/") || rest.startsWith("data-file/")
  ) {
    throw new FabricRefError(
      "'cf:module/...', 'cf:cache-root/...', 'cf:source-root/...', and " +
        "'cf:data-file/...' are compiler-internal namespaces and cannot be " +
        "imported",
      specifier,
    );
  }

  let pin: string | undefined;
  const pinIndex = rest.lastIndexOf("@");
  if (pinIndex >= 0) {
    pin = rest.slice(pinIndex + 1);
    if (!HASH_RE.test(pin)) {
      throw new FabricRefError("malformed pin", specifier);
    }
    rest = rest.slice(0, pinIndex);
  }

  const { host, space, refSegments } = splitPrefix(rest, specifier);
  const [refToken, ...subpathSegments] = refSegments;
  if (refToken === undefined || refToken.length === 0) {
    throw new FabricRefError("Slug must not be empty.", specifier);
  }
  if (subpathSegments.some((segment) => segment.length === 0)) {
    throw new FabricRefError("empty path segment", specifier);
  }

  const ref = parseRefToken(refToken, specifier);
  validateSpace(space, specifier);

  if (
    ref.kind === "uri" && ref.scheme === "pattern" && pin !== undefined
  ) {
    if (ref.hash !== pin) {
      throw new FabricRefError("conflicting pin", specifier);
    }
    pin = undefined;
  }

  const subpath = subpathSegments.join("/");
  return {
    ...(host === undefined ? {} : { host }),
    ...(space === undefined ? {} : { space }),
    ref,
    ...(subpath.length === 0 ? {} : { subpath }),
    ...(pin === undefined ? {} : { pin }),
  };
}

export function isFabricImportSpecifier(specifier: string): boolean {
  try {
    return parseFabricRef(specifier) !== undefined;
  } catch {
    return false;
  }
}

export function formatFabricRef(ref: FabricRef): string {
  if (ref.host !== undefined && ref.space === undefined) {
    throw new FabricRefError(
      "host-qualified refs require a space",
      `cf://${ref.host}/…`,
    );
  }
  const prefix = ref.host !== undefined
    ? `//${ref.host}/${ref.space}/`
    : ref.space !== undefined
    ? `/${ref.space}/`
    : "";
  const refToken = ref.ref.kind === "slug"
    ? ref.ref.slug
    : ref.ref.scheme === "pattern"
    ? `pattern:${ref.ref.hash}`
    : `${ref.ref.scheme}:fid1:${ref.ref.hash}`;
  const subpath = ref.subpath === undefined ? "" : `/${ref.subpath}`;
  const pin = ref.pin === undefined ||
      (ref.ref.kind === "uri" &&
        ref.ref.scheme === "pattern" &&
        ref.ref.hash === ref.pin)
    ? ""
    : `@${ref.pin}`;

  return `cf:${prefix}${refToken}${subpath}${pin}`;
}

export function pinnedIdentity(ref: FabricRef): string | undefined {
  if (ref.pin !== undefined) return ref.pin;
  return ref.ref.kind === "uri" && ref.ref.scheme === "pattern"
    ? ref.ref.hash
    : undefined;
}

export function withPin(ref: FabricRef, pin: string): FabricRef {
  if (!HASH_RE.test(pin)) {
    throw new FabricRefError("malformed pin", formatFabricRef(ref));
  }
  // A pattern: URI ref is already content-addressed: an equal pin is
  // redundant (normalized away, mirroring parse) and a different pin is the
  // same contradiction parseFabricRef rejects — never representable.
  if (ref.ref.kind === "uri" && ref.ref.scheme === "pattern") {
    if (ref.ref.hash !== pin) {
      throw new FabricRefError("conflicting pin", formatFabricRef(ref));
    }
    return { ...ref };
  }
  return { ...ref, pin };
}

function splitPrefix(
  rest: string,
  specifier: string,
): { host?: string; space?: string; refSegments: string[] } {
  if (rest.startsWith("//")) {
    const segments = rest.slice(2).split("/");
    const host = segments[0];
    if (!host || host.includes("@") || !HOST_RE.test(host)) {
      throw new FabricRefError("malformed host", specifier);
    }
    if (segments.length < 3) {
      throw new FabricRefError(
        "host-qualified refs require a space",
        specifier,
      );
    }
    return {
      host,
      space: segments[1],
      refSegments: segments.slice(2),
    };
  }

  if (rest.startsWith("/")) {
    const segments = rest.slice(1).split("/");
    return { space: segments[0], refSegments: segments.slice(1) };
  }

  return { refSegments: rest.split("/") };
}

function parseRefToken(
  refToken: string,
  specifier: string,
): FabricRef["ref"] {
  if (refToken.includes(":")) {
    const parts = refToken.split(":");
    if (parts.length === 2 && parts[0] === "pattern") {
      return {
        kind: "uri",
        scheme: "pattern",
        hash: parseHash(parts[1], specifier),
      };
    }
    if (
      parts.length === 3 &&
      (ENTITY_URI_SCHEMES as readonly string[]).includes(parts[0]) &&
      parts[1] === "fid1"
    ) {
      return {
        kind: "uri",
        scheme: parts[0] as EntityUriScheme,
        hash: parseHash(parts[2], specifier),
      };
    }
    if (parts.length === 2 && parts[0] === "fid1") {
      return {
        kind: "uri",
        scheme: "of",
        hash: parseHash(parts[1], specifier),
      };
    }
    throw new FabricRefError("unsupported cell URI scheme", specifier);
  }

  try {
    return { kind: "slug", slug: validateSlug(refToken) };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new FabricRefError(message, specifier);
  }
}

function parseHash(hash: string, specifier: string): string {
  if (!HASH_RE.test(hash)) {
    throw new FabricRefError("malformed hash", specifier);
  }
  return hash;
}

function validateSpace(
  space: string | undefined,
  specifier: string,
): void {
  if (space === undefined || isDID(space)) return;
  try {
    validateSlug(space);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new FabricRefError(message, specifier);
  }
}
