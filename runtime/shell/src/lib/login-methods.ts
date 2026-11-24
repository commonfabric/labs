/**
 * The ways the login screen offers to sign in, and how it names a saved
 * credential.
 */

import {
  AUTH_METHOD_KEYFILE,
  AUTH_METHOD_PASSKEY,
  AUTH_METHOD_PASSPHRASE,
  type AuthMethod,
  type StoredCredential,
} from "./credentials.ts";

/**
 * Signing in with a code from a Loom. A login method, but not a stored
 * credential: the key it brings is stored as a key-file credential.
 */
export const LOOM_PAIRING = "loom-pairing";

/** A way to sign in: a stored-credential method, or pairing with a Loom. */
export type LoginMethod = AuthMethod | typeof LOOM_PAIRING;

/**
 * The stored-credential methods a page at `hostname` offers, in the order the
 * screen lists them. Passphrases and key files are always offered. Passkeys
 * need WebAuthn, and are not offered on `localhost`.
 */
export function availableAuthMethods(
  hostname: string,
  hasWebAuthn: boolean,
): AuthMethod[] {
  return hostname !== "localhost" && hasWebAuthn
    ? [AUTH_METHOD_PASSKEY, AUTH_METHOD_PASSPHRASE, AUTH_METHOD_KEYFILE]
    : [AUTH_METHOD_PASSPHRASE, AUTH_METHOD_KEYFILE];
}

/**
 * The methods offered for `flow`. Pairing signs in as an identity that already
 * exists, so it is offered for login and not for registration.
 */
export function methodsForFlow(
  flow: "register" | "login",
  available: readonly AuthMethod[],
): readonly LoginMethod[] {
  return flow === "login" ? [...available, LOOM_PAIRING] : available;
}

/**
 * How the quick-unlock button names `credential`: a passphrase by its kind
 * alone, since its id is a random tag, and a key or passkey by the tail of its
 * id, so that two saved on one browser over time can be told apart.
 */
export function storedCredentialLabel(credential: StoredCredential): string {
  switch (credential.method) {
    case AUTH_METHOD_PASSPHRASE:
      return "Passphrase";
    case AUTH_METHOD_KEYFILE:
      return `Imported Key (${credential.id.slice(-8)})`;
    case AUTH_METHOD_PASSKEY:
      return `Passkey (${credential.id.slice(-4)})`;
  }
}
