/**
 * Builds `connection.auth` messages signed the way a client signs them, for
 * tests of what verifies them.
 */

import type { FabricValue } from "@commonfabric/api";
import { hashOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { Identity } from "@commonfabric/identity";

import { MEMORY_PROTOCOL } from "../../v2.ts";

/** The fields of a `connection.auth` invocation a test may set or leave out. */
export type ConnectionAuthFields = {
  /** Issuer written into the invocation; the signer's DID when left out. */
  iss?: string;

  cmd?: string;
  aud?: string;
  challenge?: string;
  iat?: number;
  exp?: number;
  args?: FabricValue;
};

/**
 * Returns a `connection.auth` message whose invocation holds exactly
 * `fields`, over the defaults for `cmd`, `args`, and `iss`, signed by
 * `signer`.
 */
export const signConnectionAuth = async (
  signer: Identity,
  fields: ConnectionAuthFields,
): Promise<{
  invocation: Record<string, FabricValue>;
  authorization: { signature: FabricBytes };
}> => {
  const invocation: Record<string, FabricValue> = {
    iss: signer.did(),
    cmd: "connection.auth",
    args: { protocol: MEMORY_PROTOCOL },
    ...fields,
  };
  const signature = await signer.sign(hashOf(invocation).bytes);
  if (signature.error) throw signature.error;
  return {
    invocation,
    authorization: { signature: new FabricBytes(signature.ok) },
  };
};
