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
import { isLoopbackHostname } from "@commonfabric/utils/loopback";

/** The Loom a code is redeemed against when the link or the form names none. */
export const DEFAULT_LOOM_URL = "http://localhost:9900";

/** Fragment prefix of a pairing link. */
const PAIRING_LINK_PREFIX = "#pair=";

/** Crockford's base32, which has no I, L, O or U. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const CODE_LENGTH = 10;

/** What the Loom's redeem route is called, relative to the Loom's origin. */
const REDEEM_PATH = "/identity-pairing/redeem";

/**
 * The canonical form of a typed pairing code, or null when it cannot be one.
 *
 * Folds what the Loom folds, so the shell refuses exactly the codes the Loom
 * would: case, whitespace, `-`, `_` and `.` separators, and Crockford's
 * look-alikes (`O` for zero, `I` and `L` for one). A malformed code is caught
 * here rather than sent, because the Loom counts every wrong redeem against
 * the outstanding offer and voids it after five.
 */
export function normalizePairingCode(text: string): string | null {
  // ASCII only, before any case folding: `toUpperCase()` maps some other
  // letters onto the alphabet, `ſ` to `S` and `ı` to `I`.
  if (!/^[0-9A-Za-z\s\-_.]*$/.test(text)) return null;
  const folded = text.replace(/[\s\-_.]+/g, "").toUpperCase()
    .replaceAll("O", "0").replaceAll("I", "1").replaceAll("L", "1");
  if (folded.length !== CODE_LENGTH) return null;
  for (const char of folded) {
    if (!CODE_ALPHABET.includes(char)) return null;
  }
  return folded;
}

/**
 * The origin of a Loom URL as a person typed it, or null when it is not an
 * `http:` or `https:` URL.
 *
 * Only the origin is kept: the Loom serves its routes from the root, so a path
 * someone pasted along with the host would only misdirect the redeem.
 */
export function normalizeLoomUrl(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url.origin;
}

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

/** A code, and the Loom that minted it. */
export interface LoomPairingRequest {
  /** The code in canonical form, as `normalizePairingCode()` returns it. */
  code: string;

  /** The Loom's origin, as `normalizeLoomUrl()` returns it. */
  loomUrl: string;
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

/** Why a redeem did not produce an identity. */
export type LoomPairingFailure =
  /** The Loom refused the code: wrong, expired, spent, or voided. */
  | "refused"
  /**
   * No Loom that can pair this page at that URL: nothing answers there, or a
   * Loom too old to pair a browser does, one without the redeem route or
   * without admitting a page on another origin to it.
   */
  | "unreachable"
  /** The Loom answered, but not with a key this shell can use. */
  | "invalid-response";

/** A redeem that did not produce an identity, and why. */
export class LoomPairingError extends Error {
  #reason: LoomPairingFailure;

  /**
   * Constructs an instance for `reason`. `message` is shown to the person,
   * so it says what to do next.
   */
  constructor(
    reason: LoomPairingFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LoomPairingError";
    this.#reason = reason;
  }

  /** Why the redeem failed. */
  get reason(): LoomPairingFailure {
    return this.#reason;
  }
}

/** What the Loom's redeem route returns on success. */
export interface RedeemedKey {
  /** The person's root key, as PKCS8. */
  pkcs8: Uint8Array;

  /** The DID the Loom says the key is, or null when it names none. */
  did: string | null;
}

/**
 * Redeem a pairing code against the Loom that minted it.
 *
 * The request carries no credentials and no referrer: the code is the whole
 * of what authorizes it. `device` is what the Loom records as the device it
 * handed the key to, which the owner reads back to see which devices hold it.
 *
 * @throws LoomPairingError when the Loom refuses the code, cannot be reached,
 *   or answers with something other than a key.
 */
export async function redeemPairingCode(
  request: LoomPairingRequest,
  device: { name: string; platform: string },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RedeemedKey> {
  let response: Response;
  try {
    response = await fetchImpl(new URL(REDEEM_PATH, request.loomUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: request.code, device }),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch (error) {
    throw new LoomPairingError(
      "unreachable",
      `Could not reach Loom at ${request.loomUrl}. Check that Loom is ` +
        "running there and is recent enough to pair a browser.",
      { cause: error },
    );
  }

  if (response.status === 404) {
    throw new LoomPairingError(
      "unreachable",
      `Loom at ${request.loomUrl} does not offer pairing. Update Loom and ` +
        "try again.",
    );
  }
  const body = await readJson(response);
  if (response.status === 403) {
    const hint = typeof body?.hint === "string" ? body.hint : null;
    throw new LoomPairingError(
      "refused",
      hint ??
        "Loom did not accept that code. Show a new code on the Mac that " +
          "runs Loom and enter it within ten minutes.",
    );
  }
  if (!response.ok) {
    throw new LoomPairingError(
      "invalid-response",
      `Loom at ${request.loomUrl} answered with HTTP ${response.status}.`,
    );
  }

  const pkcs8 = typeof body?.pkcs8Base64 === "string"
    ? decodeBase64(body.pkcs8Base64)
    : null;
  if (!pkcs8) {
    throw new LoomPairingError(
      "invalid-response",
      `Loom at ${request.loomUrl} did not return a key.`,
    );
  }
  const did = typeof body?.did === "string" && body.did ? body.did : null;
  return { pkcs8, did };
}

/** The JSON object a response carries, or null when it carries none. */
async function readJson(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const value = await response.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Decode standard padded base64, or null when it is not that. */
function decodeBase64(encoded: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    return null;
  }
  if (binary.length === 0) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
