/**
 * Whether a URL taken from untrusted content is safe to put in a document.
 *
 * A component that renders content it did not author decides, for every URL in
 * that content, whether the browser may follow it. The decision is an
 * allowlist: a URL passes only when its scheme is one this module names, so a
 * scheme nobody anticipated is refused rather than permitted.
 */

/**
 * The schemes a link, an image, or any other URL-valued attribute may name.
 *
 * `javascript:` and `data:text/html` run script and are absent for that
 * reason, but so is every other scheme, including ones that are harmless
 * today. A URL with no scheme at all is relative to the document, cannot name
 * a protocol handler, and is allowed without appearing here.
 */
const ALLOWED_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/**
 * The prefix an image URL may carry in place of a scheme from the set above.
 *
 * A browser renders `data:image/...` as a still image: an SVG delivered this
 * way is drawn without running the script it contains and without loading the
 * resources it references.
 */
const DATA_IMAGE = "data:image/";

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * Drops the characters a URL parser discards before it reads a scheme: ASCII
 * whitespace and the C0 controls. `java\tscript:alert(1)` names the
 * `javascript` scheme, and reading it from the string as written misses that.
 *
 * Dropping every character in that range rather than the exact set the parser
 * drops can only widen the scheme this finds, never narrow it, so a URL the
 * browser would treat as script cannot slip past the check below.
 */
function withoutIgnoredCharacters(url: string): string {
  let kept = "";
  for (const character of url) {
    if (character.codePointAt(0)! > 0x20) kept += character;
  }
  return kept;
}

/**
 * The URL a link may point at, or `null` when the browser must not follow it.
 *
 * The URL is returned as written; only its scheme is read.
 */
export function safeUrl(url: string): string | null {
  const scheme = SCHEME.exec(withoutIgnoredCharacters(url))?.[1].toLowerCase();
  if (scheme === undefined) return url;
  return ALLOWED_SCHEMES.has(scheme) ? url : null;
}

/**
 * The URL an image may load, or `null` when the browser must not fetch it.
 *
 * An image may also carry its own bytes in a `data:image/` URL.
 */
export function safeImageUrl(url: string): string | null {
  const normalized = withoutIgnoredCharacters(url).toLowerCase();
  return normalized.startsWith(DATA_IMAGE) ? url : safeUrl(url);
}
