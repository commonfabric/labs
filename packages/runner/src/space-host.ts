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
