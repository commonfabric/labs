import { isLoopbackHostname } from "@commonfabric/utils/loopback";

export { isLoopbackHostname } from "@commonfabric/utils/loopback";

/** Options for deriving a route from a scheme-less fabric authority. */
export interface FabricSpaceHostOptions {
  /** Whether derived loopback routes use HTTP. */
  useLoopbackHttp?: boolean;
}

/** A space host value that does not describe an HTTP or HTTPS origin. */
export class SpaceHostValidationError extends TypeError {
  override name = "SpaceHostValidationError";
}

/**
 * Why a space host registration was refused.
 *
 * - `known-different-host`: a seed or an accepted hint already routes the
 *   space to another host, which a registration confirms and never replaces.
 * - `already-opened`: the space opened through the default host and a
 *   stateful operation was issued there, so this session keeps that route.
 *   The refusal says nothing against the offered host.
 * - `no-remote-resolution`: storage resolves no per-space host, so a hint can
 *   take no effect.
 * - `unspecified`: storage gave a verdict without a reason.
 */
export type SpaceHostRefusalReason =
  | "known-different-host"
  | "already-opened"
  | "no-remote-resolution"
  | "unspecified";

/**
 * The outcome of a space host registration. Acceptance covers a hint that took
 * effect and one that confirms the route already in effect.
 */
export type SpaceHostRegistration =
  | { accepted: true }
  | {
    accepted: false;
    reason: "known-different-host";

    /**
     * The normalized origin the space is routed to.
     */
    existingHost: string;
  }
  | {
    accepted: false;
    reason: Exclude<SpaceHostRefusalReason, "known-different-host">;
  };

/**
 * Parses a shared per-space host route. Storage and compute requests use the
 * same route, so the value contains only an HTTP or HTTPS origin.
 */
export const normalizeSpaceHost = (host: string | URL): URL => {
  const source = typeof host === "string" ? host.trim() : host.href;
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;
    throw new SpaceHostValidationError("Invalid space host URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SpaceHostValidationError("Unsupported space host protocol");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new SpaceHostValidationError(
      "Space host must not include credentials",
    );
  }
  if (parsed.pathname !== "/") {
    throw new SpaceHostValidationError("Space host must not include a path");
  }
  if (parsed.search !== "") {
    throw new SpaceHostValidationError("Space host must not include a query");
  }
  if (parsed.hash !== "") {
    throw new SpaceHostValidationError(
      "Space host must not include a fragment",
    );
  }
  if (!/^https?:\/\/[^/?#\\@\s]+\/?$/i.test(source)) {
    throw new SpaceHostValidationError(
      "Space host must contain only an origin",
    );
  }

  return parsed;
};

/** Derives the shared host route represented by a `cf://` authority. */
export const spaceHostFromFabricAuthority = (
  authority: string,
  options: FabricSpaceHostOptions = {},
): URL => {
  const route = normalizeSpaceHost(`https://${authority}`);
  if (options.useLoopbackHttp && isLoopbackHostname(route.hostname)) {
    return normalizeSpaceHost(`http://${authority}`);
  }
  return route;
};

/** Returns whether a scheme-less `cf://` authority names a host route. */
export const fabricAuthorityMatchesSpaceHost = (
  authority: string,
  host: string | URL,
): boolean => {
  const route = normalizeSpaceHost(host);
  const candidate = normalizeSpaceHost(`${route.protocol}//${authority}`);
  return candidate.origin === route.origin;
};
