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
 * - `default-route-in-use`: the space opened through the default host and a
 *   stateful operation was issued there, so this session keeps that route.
 *   Opening alone does not cause it. The refusal says nothing against the
 *   offered host.
 * - `no-remote-resolution`: storage resolves no per-space host, so a hint can
 *   take no effect.
 * - `memory-routed`: the runtime opens Memory on a memory URL, which places
 *   every space itself, and the hint names a host other than the API host.
 *   A hint carries a space's Memory as well as its HTTP work, so it cannot
 *   name a host for one without the other.
 * - `unspecified`: storage gave a verdict without a reason.
 */
export type SpaceHostRefusalReason =
  | "known-different-host"
  | "default-route-in-use"
  | "no-remote-resolution"
  | "memory-routed"
  | "unspecified";

/**
 * The outcome of a space host registration. Acceptance covers a hint that took
 * effect and one that confirms the route already in effect.
 */
export type SpaceHostRegistration =
  | {
    /**
     * The hint is in effect.
     */
    accepted: true;
  }
  | {
    /**
     * The hint was refused.
     */
    accepted: false;

    /**
     * The rule that refused it.
     */
    reason: "known-different-host";

    /**
     * The normalized origin the space is routed to.
     */
    existingHost: string;
  }
  | {
    /**
     * The hint was refused.
     */
    accepted: false;

    /**
     * The rule that refused it.
     */
    reason: Exclude<SpaceHostRefusalReason, "known-different-host">;
  };

/** The refusals {@link normalizeSpaceHost} reports, worded for what it checks. */
interface OriginRuleMessages {
  invalid: string;
  protocol: string;
  credentials: string;
  path: string;
  query: string;
  fragment: string;
  origin: string;
}

const SPACE_HOST_MESSAGES: OriginRuleMessages = {
  invalid: "Invalid space host URL",
  protocol: "Unsupported space host protocol",
  credentials: "Space host must not include credentials",
  path: "Space host must not include a path",
  query: "Space host must not include a query",
  fragment: "Space host must not include a fragment",
  origin: "Space host must contain only an origin",
};

const MEMORY_URL_MESSAGES: OriginRuleMessages = {
  invalid: "Invalid memory URL",
  protocol: "Unsupported memory URL protocol",
  credentials: "Memory URL must not include credentials",
  path: "Memory URL must not include a path",
  query: "Memory URL must not include a query",
  fragment: "Memory URL must not include a fragment",
  origin: "Memory URL must contain only an origin",
};

/** Parses `host` as an HTTP or HTTPS origin, refusing with `messages`. */
const parseOrigin = (
  host: string | URL,
  messages: OriginRuleMessages,
): URL => {
  const source = typeof host === "string" ? host.trim() : host.href;
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;
    throw new SpaceHostValidationError(messages.invalid);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SpaceHostValidationError(messages.protocol);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new SpaceHostValidationError(messages.credentials);
  }
  if (parsed.pathname !== "/") {
    throw new SpaceHostValidationError(messages.path);
  }
  if (parsed.search !== "") {
    throw new SpaceHostValidationError(messages.query);
  }
  if (parsed.hash !== "") {
    throw new SpaceHostValidationError(messages.fragment);
  }
  if (!/^https?:\/\/[^/?#\\@\s]+\/?$/i.test(source)) {
    throw new SpaceHostValidationError(messages.origin);
  }

  return parsed;
};

/**
 * Parses a shared per-space host route. Storage and compute requests use the
 * same route, so the value contains only an HTTP or HTTPS origin.
 */
export const normalizeSpaceHost = (host: string | URL): URL =>
  parseOrigin(host, SPACE_HOST_MESSAGES);

/**
 * Whether `host` is `apiUrl`'s own origin. This is the one rule by which a
 * memory URL, an attach's memory URL and a host hint name the API host: they
 * compare origins, so a path on `apiUrl` does not make its own host another
 * one. Only an HTTP or HTTPS `host` names one: a `blob:` URL reports the
 * origin of the URL it wraps, and an opaque origin reports none.
 */
export const namesApiOrigin = (host: URL, apiUrl: URL): boolean =>
  (host.protocol === "http:" || host.protocol === "https:") &&
  host.origin === apiUrl.origin;

/**
 * Parses a memory URL: the host a deployment has its clients open Memory on
 * when that is not its API host, such as a memory router. It is held to the
 * rule a space host is, an HTTP or HTTPS origin, since storage opens it the
 * same way. An absent or empty value names none, and so does one naming
 * `apiUrl`'s own origin ({@link namesApiOrigin}): each leaves Memory on the
 * API host, and each returns `undefined`.
 *
 * The comparison with `apiUrl` comes before the origin rule. A client with
 * no memory URL opens storage on `apiUrl` itself, which may carry a path, and
 * hands that host on as its memory host; it names the API host, and is none.
 *
 * @throws SpaceHostValidationError When the value names another host and is
 * not an HTTP or HTTPS origin, with a message that calls it a memory URL.
 */
export const parseMemoryUrl = (
  memoryUrl: string | URL | undefined,
  apiUrl?: string | URL,
): URL | undefined => {
  if (memoryUrl === undefined || memoryUrl === "") return undefined;
  if (apiUrl !== undefined) {
    const candidate = tryParseUrl(memoryUrl);
    if (candidate !== undefined && namesApiOrigin(candidate, new URL(apiUrl))) {
      return undefined;
    }
  }
  return parseOrigin(memoryUrl, MEMORY_URL_MESSAGES);
};

/** `value` as a URL, or `undefined` where it does not parse as one. */
const tryParseUrl = (value: string | URL): URL | undefined => {
  if (typeof value !== "string") return value;
  try {
    return new URL(value.trim());
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;
    return undefined;
  }
};

/**
 * {@link parseMemoryUrl} for a value that came from outside the program, such
 * as an environment variable, a page or a server's document: a value that is
 * not a string, or not an HTTP or HTTPS origin, is returned as the reason it
 * was refused rather than thrown, for the caller to report its own way.
 */
export const readMemoryUrl = (
  value: unknown,
  apiUrl?: string | URL,
): { memoryUrl: URL | undefined } | { refused: string } => {
  if (value === undefined || value === null) return { memoryUrl: undefined };
  if (typeof value !== "string") return { refused: "expected a string" };
  try {
    return { memoryUrl: parseMemoryUrl(value, apiUrl) };
  } catch (error) {
    if (!(error instanceof SpaceHostValidationError)) throw error;
    return { refused: error.message };
  }
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
