/**
 * Pairing with a Common Fabric Service: redeem a one-time code the person's
 * Weaver (Settings > Pair a device) or service shows, and receive the
 * person's root key as PKCS8. The same redeem serves every client that pairs:
 * the shell signing a browser in (`runtime/shell/src/lib/loom-pairing.ts`) and
 * `cf id pair`, which keeps the key as `cf`'s keyfile.
 *
 * The code is the whole credential: the request carries no other, and a
 * redirect is never followed, so the code and the key it buys go only to the
 * service named.
 */

import { isObjectNotArray } from "@commonfabric/js-values/types";

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

/** A code, and the Loom that minted it. */
export interface LoomPairingRequest {
  /** The code in canonical form, as `normalizePairingCode()` returns it. */
  code: string;

  /** The Loom's origin, as `normalizeLoomUrl()` returns it. */
  loomUrl: string;
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
      redirect: "manual",
    });
  } catch (error) {
    throw new LoomPairingError(
      "unreachable",
      `Could not reach Loom at ${request.loomUrl}. Check that Loom is ` +
        "running there and is recent enough to pair a browser.",
      { cause: error },
    );
  }

  // A browser reports a redirect it did not follow as `opaqueredirect`, with
  // status 0; a server-side fetch reports its 3xx.
  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    await response.body?.cancel();
    throw new LoomPairingError(
      "unreachable",
      `${request.loomUrl} redirected the pairing code elsewhere; it was not ` +
        "sent on. Use the service's own address.",
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
        "The service did not accept that code: it is wrong, expired, or " +
          "already used. Make a new code in Weaver's Settings > Pair a " +
          "device and enter it within ten minutes.",
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
    const value: unknown = await response.json();
    return isObjectNotArray(value) ? value : null;
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
