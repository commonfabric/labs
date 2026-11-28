/**
 * `cf id pair`: become the identity a Common Fabric Service holds, by
 * redeeming a one-time pairing code, as any other device of the person's does.
 *
 * Why: a Weaver user whose service runs on a cloud host has the identity key
 * only in the Weaver's keychain, which no other program can read. The person's
 * devices already get the key by pairing: Weaver's Settings > Pair a device
 * mints a short code, and the service trades it, once, for the key
 * (`@commonfabric/runner/pairing`, which the shell's sign-in uses too). `cf`
 * redeems the same way and keeps the key as the keyfile it already reads, so
 * `cf` deploys as the person and its pieces land where their Weaver shows
 * them. What is `cf`'s own here is the keyfile: never written over, and
 * readable by this user only.
 */

import { Identity } from "@commonfabric/identity";
import {
  LoomPairingError,
  normalizePairingCode,
  redeemPairingCode,
} from "@commonfabric/runner/pairing";
import { dirname } from "@std/path/dirname";
import { firstPartyUrl } from "./first-party.ts";

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
  // Refused before anything is sent: the service voids an offer after five
  // wrong codes.
  const code = normalizePairingCode(options.code.trim());
  if (code === null) {
    throw new PairingError(
      "That is not a pairing code: it is ten letters and digits, as Weaver's " +
        "Settings > Pair a device shows it.",
    );
  }
  let loomUrl: string;
  try {
    loomUrl = firstPartyUrl(options.service).origin;
  } catch (error) {
    throw new PairingError(String((error as Error).message));
  }
  const held = await existingIdentity(options.keyfile);
  if (held === undefined) await preparePlace(options.keyfile);
  let pkcs8: Uint8Array;
  let named: string | null;
  try {
    ({ pkcs8, did: named } = await redeemPairingCode(
      { code, loomUrl },
      { name: "cf", platform: Deno.build.os },
      options.fetch,
    ));
  } catch (error) {
    if (error instanceof LoomPairingError) {
      throw new PairingError(error.message);
    }
    throw error;
  }
  const identity = await Identity.fromPkcs8(pkcs8).catch(() => undefined);
  if (identity === undefined) {
    throw new PairingError("The service answered without a key cf can use.");
  }
  const did = identity.did();
  if (named !== null && named !== did) {
    throw new PairingError(
      `The service named ${named} but handed over the key of ${did}; cf ` +
        "keeps neither.",
    );
  }
  if (held !== undefined) {
    if (held === did) return { did, wrote: false };
    throw new PairingError(
      `${options.keyfile} already holds another identity (${held}); cf ` +
        "keeps it, and the code is spent. Remove the device named cf in " +
        "Weaver's Settings > Pair a device, move the keyfile aside or name " +
        "another, and pair again.",
    );
  }
  try {
    await Deno.writeFile(options.keyfile, pkcs8, {
      createNew: true,
      mode: 0o600,
    });
  } catch (error) {
    throw new PairingError(
      `The code is spent, but ${options.keyfile} could not be written ` +
        `(${(error as Error).message}). Remove the device named cf in ` +
        "Weaver's Settings > Pair a device, then pair again.",
    );
  }
  return { did, wrote: true };
}

/**
 * Makes the keyfile's directory before the code is spent: a place that cannot
 * take the key fails here, not after the service has handed the key over.
 */
async function preparePlace(keyfile: string): Promise<void> {
  try {
    await Deno.mkdir(dirname(keyfile), { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new PairingError(
      `cf cannot make ${dirname(keyfile)} for the key: ` +
        (error as Error).message,
    );
  }
}

/**
 * The DID a keyfile holds, undefined when nothing stands at its path. Anything
 * else there, a link to nothing included, is refused.
 */
async function existingIdentity(
  keyfile: string,
): Promise<`did:key:${string}` | undefined> {
  try {
    await Deno.lstat(keyfile);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw new PairingError(
      `cf cannot check ${keyfile}: ${(error as Error).message}`,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(keyfile);
  } catch (error) {
    throw new PairingError(
      error instanceof Deno.errors.NotFound
        ? `${keyfile} is a link or a file cf cannot read as a key; cf will ` +
          "not write the key there."
        : `cf cannot read ${keyfile}: ${(error as Error).message}`,
    );
  }
  try {
    return (await Identity.fromPkcs8(bytes)).did();
  } catch {
    throw new PairingError(
      `${keyfile} exists and holds no key; cf will not write over it.`,
    );
  }
}
