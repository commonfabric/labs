/**
 * ETag generation utilities for static asset caching.
 * Uses SHA-256 content hashing for strong ETags.
 */

import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";

/**
 * Generate a strong ETag from content using SHA-256 hash.
 * Returns a base64-encoded hash in quotes.
 */
export async function generateETag(content: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", content as BufferSource);
  const base64 = toUnpaddedBase64url(new Uint8Array(hash));

  return `"${base64}"`;
}

/**
 * Compare ETags for equality.
 * Supports comma-separated lists of ETags from If-None-Match headers.
 * Handles weak ETags (W/ prefix) that nginx adds when compression is applied.
 */
export function compareETags(
  etag: string,
  ifNoneMatch: string | null | undefined,
): boolean {
  if (!ifNoneMatch) return false;

  // Handle comma-separated list of ETags
  const clientETags = ifNoneMatch.split(",").map((tag) => tag.trim());

  // Strip W/ prefix for weak ETag comparison
  // Nginx adds W/ when compression is applied
  const normalizeETag = (tag: string) => {
    return tag.replace(/^W\//, "");
  };

  const serverETag = normalizeETag(etag);

  return clientETags.some((clientETag) => {
    // Handle wildcard
    if (clientETag === "*") return true;
    return normalizeETag(clientETag) === serverETag;
  });
}

/**
 * Creates the response headers that carry `etag` and require a client to
 * revalidate against it on every request rather than serving from its own
 * cache.
 */
export function createCacheHeaders(etag: string): Record<string, string> {
  return {
    "ETag": etag,
    "Cache-Control": "public, no-cache",
  };
}
