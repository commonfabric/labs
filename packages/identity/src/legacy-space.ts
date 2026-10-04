/**
 * The resolver for legacy space names.
 *
 * A space created before space identities were random was given a key derived
 * from a passphrase this repository publishes and the space's name. That
 * derivation is a pure function of the name, so it gives the same DID in every
 * process and at every provider, and needs no record of which names exist.
 * It is what keeps a URL that names such a space opening the space it always
 * opened.
 *
 * The resolver returns a DID and nothing else. The derived key is public, so
 * handing it to a caller would hand out a signing key anyone can recompute.
 * Creating a space never calls this: a new space's key is generated from
 * random data, so no new space is born at a DID anyone can recompute.
 */

import { assertNotDID, type DID } from "./did.ts";
import { Identity } from "./identity.ts";

/** The published passphrase every legacy space key was derived from. */
const LEGACY_SPACE_PASSPHRASE = "common user";

/**
 * Returns the DID that the legacy space name `name` resolves to. The DID may
 * name a space that has never been created; opening it then opens nothing.
 *
 * @throws If `name` is itself a DID. A caller that accepts either splits on
 *   `isDID()` first, so one string cannot address two spaces.
 */
export async function legacySpaceDid(name: string): Promise<DID> {
  assertNotDID(name, "A space name");
  const root = await Identity.fromPassphrase(LEGACY_SPACE_PASSPHRASE);
  return (await root.derive(name)).did();
}
