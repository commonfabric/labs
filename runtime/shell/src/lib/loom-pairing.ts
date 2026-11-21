/**
 * Loom pairing: sign this browser in as the identity a Loom holds, by
 * redeeming a one-time code the Mac that runs Loom shows.
 *
 * On that Mac, Weaver Settings > Pair a device (or `loom identity pair`)
 * mints a code of ten Crockford-base32 characters, good for ten minutes and
 * one use. `POST /identity-pairing/redeem` on the Loom trades it for the
 * person's root key as PKCS8. The code reaches the shell either from the login
 * screen's form or from a link, `#pair=<code>` with an optional
 * `&loom=<Loom URL>`; this module parses both, and redeems.
 *
 * The fragment is scrubbed the same way the device-link fragment is, for the
 * same reasons (`device-link.ts` lists what a scrub does not erase). A code
 * that leaks is worth less than a device-link secret: it expires, it works
 * once, and the Loom voids it after five wrong tries.
 */

import { urlToAppView } from "@commonfabric/navigation";
import { isLoopbackHostname } from "@commonfabric/platform/loopback";

/** The Loom a code is redeemed against when the link or the form names none. */
export const DEFAULT_LOOM_URL = "http://localhost:9900";

/** Fragment prefix of a pairing link. */
const PAIRING_LINK_PREFIX = "#pair=";

import {
  LoomPairingError,
  type LoomPairingFailure,
  type LoomPairingRequest,
  normalizeLoomUrl,
  normalizePairingCode,
  type RedeemedKey,
  redeemPairingCode,
} from "@commonfabric/runner/pairing";

export {
  LoomPairingError,
  type LoomPairingFailure,
  type LoomPairingRequest,
  normalizeLoomUrl,
  normalizePairingCode,
  type RedeemedKey,
  redeemPairingCode,
};

/**
 * Whether a Loom origin, as `normalizeLoomUrl()` returns it, is on this
 * computer.
 *
 * A Loom mints codes only for a caller on its own machine, so a code for a
 * Loom on this computer can only have come from this computer. A Loom
 * anywhere else may be someone else's, minting codes for their own identity.
 */
export function isLocalLoom(loomUrl: string): boolean {
  return isLoopbackHostname(new URL(loomUrl).hostname);
}

/** What a location hash turned out to contain. */
export type LoomPairingFragment =
  /** No pairing link present. */
  | { kind: "absent" }
  /** A well-formed pairing link. */
  | { kind: "request"; request: LoomPairingRequest }
  /**
   * Shaped like a pairing link, but the code or the Loom URL cannot be read.
   * The scrub has already removed it, so this is reported rather than
   * treated as absent.
   */
  | { kind: "malformed" };

/**
 * Parse a location hash into a pairing request.
 *
 * Pure and total. Exported for tests; `consumeLoomPairingFragment()` is the
 * one callers use.
 */
export function parseLoomPairingFragment(hash: string): LoomPairingFragment {
  if (!hash.startsWith(PAIRING_LINK_PREFIX)) return { kind: "absent" };
  const params = new URLSearchParams(hash.slice(1));
  const code = normalizePairingCode(params.get("pair") ?? "");
  const loomUrl = normalizeLoomUrl(params.get("loom") ?? DEFAULT_LOOM_URL);
  if (!code || !loomUrl) return { kind: "malformed" };
  return { kind: "request", request: { code, loomUrl } };
}

/**
 * Read a pairing link out of the current URL and scrub it.
 *
 * Call at module init, before any await, and again on `hashchange`. Anything
 * shaped like a pairing link is scrubbed, parsable or not, and a framed shell
 * never acts on one: the parent controls the URL, and would otherwise hold a
 * one-click identity swap the person cannot see the address bar for.
 */
export function consumeLoomPairingFragment(): LoomPairingFragment {
  const location = globalThis.location;
  if (!location || !location.hash.startsWith(PAIRING_LINK_PREFIX)) {
    return { kind: "absent" };
  }
  const parsed = parseLoomPairingFragment(location.hash);

  // An absolute URL, for the reason `consumeDeviceLinkFragment()` gives: a
  // path beginning `//` would otherwise resolve as protocol-relative. A link
  // opened on a loaded page is a fragment navigation, whose new entry holds no
  // state, and `Navigation` ignores an entry without one when Back or Forward
  // returns to it. So the scrubbed entry is given the view its address names,
  // as `Navigation` does for the entry it starts on.
  try {
    const scrubbed = new URL(location.href);
    scrubbed.hash = "";
    globalThis.history?.replaceState(
      globalThis.history.state ?? urlToAppView(scrubbed),
      "",
      scrubbed.href,
    );
  } catch {
    // An unsupported history leaves the code in the address bar, which is no
    // reason to abandon the pairing.
  }

  const top = globalThis.top;
  if (top && top !== globalThis.self) return { kind: "absent" };
  return parsed;
}
