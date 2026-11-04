// Device-link login: `#k=<base64url 32-byte BIP39 entropy>`.
//
// WHY: an identity minted on a desktop had no way to reach a phone or a second
// browser. The interim answer is to hand the identity across as its BIP39
// entropy — the 32 bytes a 24-word phrase encodes — in a URL fragment, scanned
// from a QR with the phone's native camera. The fragment is never sent to a
// server, and 32 bytes fit in a QR where 24 words do not.
//
// This is an INTERIM mechanism, scoped to be deleted when key delegation
// lands. It is confirm-gated on purpose: a credential in a URL is an
// antipattern, and the confirm screen is the only thing standing between a
// user and a link that would sign them in as somebody else.
//
// SECURITY — what the scrub does and does NOT do. It runs synchronously,
// before any await, and removes the secret from the address bar, from what a
// bookmark or a tab-sync would capture, and from the session history entry.
//
// It does NOT erase these, so do not write code that assumes it did:
//   * `performance.getEntriesByType("navigation")[0].name` keeps the FULL
//     original URL, secret included, for the document's lifetime. There is no
//     API to clear it (`clearResourceTimings()` does not). This matters
//     concretely: `@opentelemetry/instrumentation-document-load` reads that
//     entry and reports it as `http.url`. Wiring document-load instrumentation
//     into this shell would ship the private key to the OTLP collector. It is
//     not wired today — keep it that way, or filter the attribute.
//   * The visit is committed to the browser's persistent history database
//     before any script runs; replaceState amends the session entry, not that.
//   * The secret sits in the address bar from navigation commit until this
//     bundle has been fetched, parsed and evaluated — unbounded, and on a cold
//     mobile load over a VPN, easily seconds.
// These are accepted for an interim flow; they are the reason the payload is
// opaque entropy rather than the words, and the reason pairing is reveal-gated
// on the other end.
//
// The path and the query are preserved because the pairing QR targets a deep
// link — after the confirm, the normal boot must continue to that path so the
// flow ends inside a logged-in app the user can bookmark, and the scrubbed URL
// is exactly what gets bookmarked.

/** Fragment param name. Short because QR payload bytes are scarce. */
const DEVICE_LINK_PREFIX = "#k=";

/** 32 bytes of BIP39 entropy is exactly 43 unpadded base64url characters. */
const ENCODED_LENGTH = 43;

const ENTROPY_BYTES = 32;

const ENCODED_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${ENCODED_LENGTH}}$`);

/**
 * Decode unpadded base64url to bytes, or null if it isn't valid.
 */
function decodeBase64Url(encoded: string): Uint8Array | null {
  if (!ENCODED_PATTERN.test(encoded)) return null;
  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  if (binary.length !== ENTROPY_BYTES) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Parse a location hash into device-link entropy.
 *
 * Pure and total: any hash that isn't exactly a well-formed device link
 * yields null. Exported for tests — `consumeDeviceLinkFragment` is the one
 * callers use.
 */
export function parseDeviceLinkFragment(hash: string): Uint8Array | null {
  if (!hash.startsWith(DEVICE_LINK_PREFIX)) return null;
  return decodeBase64Url(hash.slice(DEVICE_LINK_PREFIX.length));
}

/** True when a hash is SHAPED like a device link, valid or not. */
export function looksLikeDeviceLink(hash: string): boolean {
  return hash.startsWith(DEVICE_LINK_PREFIX);
}

/** What the URL turned out to contain. */
export type DeviceLinkFragment =

  /** No device link present — boot normally, say nothing. */
  | { kind: "absent" }
  /** A well-formed device link. */
  | { kind: "entropy"; entropy: Uint8Array }
  /**
   * Shaped like a device link but undecodable. Distinct from "absent" on
   * purpose: the scrub has already removed it, so the documented recovery
   * ("refresh once and rescan") can no longer work, and silently booting to a
   * normal screen would leave the user with no idea the scan failed.
   */
  | { kind: "malformed" };

/**
 * Read the device-link entropy out of the current URL and scrub it.
 *
 * Call at module init, BEFORE any await. Anything shaped like a device link is
 * scrubbed even when it fails to parse: a malformed payload is still somebody's
 * secret, and leaving it in the address bar to be bookmarked or synced would be
 * the same leak with none of the benefit.
 */
export function consumeDeviceLinkFragment(): DeviceLinkFragment {
  const location = globalThis.location;
  if (!location || !looksLikeDeviceLink(location.hash)) {
    return { kind: "absent" };
  }

  const entropy = parseDeviceLinkFragment(location.hash);

  // Scrub FIRST and synchronously — before the caller can await anything, and
  // regardless of what we decide below. A framed or malformed link is still
  // somebody's secret; leaving it in the address bar to be bookmarked or synced
  // is the leak with none of the benefit. (This is why the scrub precedes the
  // frame check, not the reverse.)
  //
  // The scrub target is an absolute URL taken from `location.href` with the
  // fragment cleared. `replaceState` resolves what it is handed as a relative
  // reference, and a path beginning `//` is a protocol-relative URL there:
  // `//space/top/42` against `https://app.example/` is `https://space/top/42`,
  // which the call refuses as cross-origin, and a refusal caught below leaves
  // the secret in the address bar. An absolute URL derived from the current one
  // carries the document's own origin however the path is written, so the path
  // and the query survive and the fragment is the only thing that goes.
  try {
    const scrubbed = new URL(location.href);
    scrubbed.hash = "";
    globalThis.history?.replaceState(null, "", scrubbed.href);
  } catch {
    // A sandboxed/unsupported history is not a reason to abandon the login;
    // the secret is merely more exposed than we'd like.
  }

  // Never ACT on a device link inside a frame. The parent controls the URL, so
  // a framed shell would turn this into a one-click identity swap the user
  // cannot see the address bar for. Storage partitioning already blunts it, but
  // the flow has no legitimate reason to run framed — so report absent (the
  // secret is already scrubbed above).
  //
  // `top` is only meaningful in a browsing context — outside one (tests, SSR)
  // it is undefined, and a bare `top !== self` would then reject everything.
  const top = globalThis.top;
  if (top && top !== globalThis.self) return { kind: "absent" };

  return entropy ? { kind: "entropy", entropy } : { kind: "malformed" };
}
