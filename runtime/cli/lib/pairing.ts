/**
 * `cf id pair`: become the identity a Common Fabric Service holds, by
 * redeeming a one-time pairing code, as any other device of the person's does.
 *
 * Why: a Weaver user whose service runs on a cloud host has the identity key
 * only in the Weaver's keychain, which no other program can read. The person's
 * devices already get the key by pairing: Weaver's Settings > Pair a device
 * mints a short code, and the service's `POST /identity-pairing/redeem` trades
 * it, once, for the key. `cf` redeems the same way and keeps the key as the
 * keyfile it already reads, so `cf` deploys as the person and its pieces land
 * where their Weaver shows them.
 *
 * The code is the credential, so the redeem needs no other: it works against
 * a service whose every other route wants a signed request.
 */

import { Identity } from "@commonfabric/identity";
import { dirname } from "@std/path/dirname";
import { fetchNoRedirect, firstPartyUrl } from "./first-party.ts";

/** Crockford's base32, which has no I, L, O or U. */
const CODE_ALPHABET = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/**
 * A code as the service compares it, or null when it cannot be one. Separators
 * and case are folded, and Crockford's look-alikes (`O` for zero, `I` and `L`
 * for one), as the service folds them. A malformed code is refused here rather
 * than sent, since the service voids an offer after five wrong codes.
 */
export function pairingCode(text: string): string | null {
  const folded = text.replace(/[\s\-_.]+/g, "").toUpperCase()
    .replaceAll("O", "0").replaceAll("I", "1").replaceAll("L", "1");
  return CODE_ALPHABET.test(folded) ? folded : null;
}

/** Why pairing did not leave a keyfile. */
export class PairingError extends Error {
  override name = "PairingError";
}

export interface PairOptions {
  /** The service's address; only its origin is used. */
  service: string;
  /** The code as the person copied it. */
  code: string;
  /** Where the keyfile goes. */
  keyfile: string;
  /** Names this device in the service's device list. */
  deviceName?: string;
  fetch?: typeof globalThis.fetch;
}

export interface Paired {
  did: `did:key:${string}`;
  /** False when the keyfile already held this identity, so nothing was written. */
  wrote: boolean;
}

/**
 * Redeems `code` at `service` and keeps the key at `keyfile`, readable by
 * this user only. A keyfile already there is never replaced: one holding the
 * same identity is success with nothing written, any other is refused, since
 * it may be a key the person needs.
 */
export async function pairWithService(options: PairOptions): Promise<Paired> {
  const code = pairingCode(options.code);
  if (code === null) {
    throw new PairingError(
      "That is not a pairing code: it is ten letters and digits, as Weaver's " +
        "Settings > Pair a device shows it.",
    );
  }
  let origin: URL;
  try {
    origin = new URL(firstPartyUrl(options.service).origin);
  } catch (error) {
    throw new PairingError(String((error as Error).message));
  }
  const held = await existingIdentity(options.keyfile);
  const response = await fetchNoRedirect(
    new URL("/identity-pairing/redeem", origin),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        device: { name: options.deviceName ?? "cf", platform: Deno.build.os },
      }),
    },
    options.fetch,
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new PairingError(
      response.status === 403
        ? "The service refused the code: it is wrong, expired, or already " +
          "used. Make a new one in Weaver's Settings > Pair a device."
        : `The service answered ${response.status} to the pairing code.`,
    );
  }
  const answer: unknown = await response.json().catch(() => undefined);
  const pkcs8 = typeof answer === "object" && answer !== null &&
      "pkcs8Base64" in answer && typeof answer.pkcs8Base64 === "string"
    ? decodeBase64(answer.pkcs8Base64)
    : undefined;
  const identity = pkcs8 &&
    await Identity.fromPkcs8(pkcs8).catch(() => undefined);
  if (pkcs8 === undefined || identity === undefined) {
    throw new PairingError("The service answered without a key cf can use.");
  }
  const did = identity.did();
  if (held !== undefined) {
    if (held === did) return { did, wrote: false };
    throw new PairingError(
      `${options.keyfile} already holds another identity (${held}); cf ` +
        "keeps it. Move it aside to pair, or name another keyfile.",
    );
  }
  await Deno.mkdir(dirname(options.keyfile), { recursive: true, mode: 0o700 });
  await Deno.writeFile(options.keyfile, pkcs8, {
    createNew: true,
    mode: 0o600,
  });
  return { did, wrote: true };
}

/** The DID a keyfile holds, undefined when there is none; a file that is no key is refused. */
async function existingIdentity(
  keyfile: string,
): Promise<`did:key:${string}` | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(keyfile);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  try {
    return (await Identity.fromPkcs8(bytes)).did();
  } catch {
    throw new PairingError(
      `${keyfile} exists and holds no key; cf will not write over it.`,
    );
  }
}

function decodeBase64(text: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}
