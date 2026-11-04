export const HARNESS_BROWSER_ACCESS_LEASE_TYPE =
  "cf-harness.chat.browser-access-lease" as const;

export const HARNESS_BROWSER_ACCESS_PROFILE_MODES = [
  "persistent",
  "transient",
] as const;

export type HarnessBrowserAccessProfileMode =
  typeof HARNESS_BROWSER_ACCESS_PROFILE_MODES[number];

export const HARNESS_BROWSER_ACCESS_ACCOUNT_ACCESS = [
  "available",
  "none",
] as const;

export type HarnessBrowserAccessAccountAccess =
  typeof HARNESS_BROWSER_ACCESS_ACCOUNT_ACCESS[number];

export interface HarnessBrowserAccessLease {
  type: typeof HARNESS_BROWSER_ACCESS_LEASE_TYPE;
  leaseId: string;
  cdpUrl: string;
  owner?: string;
  expiresAt?: string;
  profileMode?: HarnessBrowserAccessProfileMode;
  accountAccess?: HarnessBrowserAccessAccountAccess;
}

/**
 * The CDP hosts a lease may point at. The browser runs on the same machine
 * (or its Docker host); a lease naming anything else is misconfigured, not a
 * remote browser to honor.
 */
const ALLOWED_CDP_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "[::1]",
  "host.docker.internal",
  "localhost",
]);

/**
 * The canonical origin of a Browser Access CDP endpoint, or `undefined` when
 * the endpoint is not an http:// local origin with an explicit port and
 * nothing else — no path, no query, no fragment.
 */
export const normalizeCdpOrigin = (
  endpoint: string | undefined,
): string | undefined => {
  if (endpoint === undefined) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") {
    return undefined;
  }
  if (!ALLOWED_CDP_HOSTS.has(url.hostname)) {
    return undefined;
  }
  if (url.port === "") {
    return undefined;
  }
  const port = Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  return url.origin;
};

/**
 * Removes echoes of a CDP endpoint from text bound for the model: the origin
 * itself, its URL-encoded form, and the bare host:port, each of which shows
 * up in real connection errors. This is a backstop against accidental
 * echoes, not a flow boundary — the code that holds the endpoint (the
 * agent-browser CLI, a digest-pinned bundled script) is trusted host
 * software, and that trust is what actually keeps the endpoint out of model
 * reach.
 */
export const redactCdpEndpoint = (text: string, cdpOrigin: string): string => {
  const hostPort = cdpOrigin.replace(/^http:\/\//, "");
  return [cdpOrigin, encodeURIComponent(cdpOrigin), hostPort]
    .filter((form) => form !== "")
    .reduce(
      (scrubbed, form) => scrubbed.replaceAll(form, "<lease endpoint>"),
      text,
    );
};

export const parseBrowserAccessExpiresAt = (
  expiresAt: string,
): Date | undefined => {
  const timestampMs = Date.parse(expiresAt);
  return Number.isFinite(timestampMs) ? new Date(timestampMs) : undefined;
};

export const validateBrowserAccessLeaseFreshness = (
  expiresAt: string | undefined,
  options: { now?: Date } = {},
): string | undefined => {
  if (expiresAt === undefined || expiresAt.trim() === "") {
    return undefined;
  }
  const expiresAtDate = parseBrowserAccessExpiresAt(expiresAt);
  if (expiresAtDate === undefined) {
    return "Browser Access lease expiry is invalid";
  }
  const now = options.now ?? new Date();
  if (expiresAtDate.getTime() <= now.getTime()) {
    return "Browser Access lease has expired";
  }
  return undefined;
};
