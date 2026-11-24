/**
 * The canonical spelling of the API URL written `apiUrl`: no query, no
 * fragment, empty path segments collapsed, and no trailing slash. Two
 * spellings of one deployment normalize to one string, which is what lets
 * them compare equal — as the identity of the deployment a process is
 * connected to, and as the base a printed app route is built on.
 *
 * Throws on an `apiUrl` that does not parse, so a caller that may hold one
 * establishes that first.
 */
export function normalizeApiUrl(apiUrl: string): string {
  const parsed = new URL(apiUrl);
  const normalized = new URL(parsed);
  const basePath = parsed.pathname.split("/").filter(Boolean).join("/");
  normalized.pathname = basePath ? `/${basePath}` : "/";
  normalized.search = "";
  normalized.hash = "";
  const href = normalized.toString();
  return basePath ? href : href.slice(0, -1);
}
