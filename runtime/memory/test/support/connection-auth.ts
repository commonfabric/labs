/**
 * Builds `connection.auth` messages signed the way a client signs them, for
 * tests of what verifies them, and the authentication a client is given to
 * sign its own.
 */

import type { FabricPlainObject, FabricValue } from "@commonfabric/api";
import { hashOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { Identity } from "@commonfabric/identity";

import { MEMORY_PROTOCOL } from "../../v2.ts";
import type { SessionPrincipal } from "../../v2/client.ts";

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

/**
 * Returns the authentication a client mounts sessions with as `signer`: a
 * `connection.auth` signed over the connection's challenge, and a
 * `session.open` signed per session for a server that verifies only those.
 */
export const principalOf = (signer: Identity): SessionPrincipal => {
  const window = () => {
    const iat = Math.floor(Date.now() / 1000);
    return { iat, exp: iat + 300 };
  };
  return {
    did: signer.did(),
    authorizeConnection: (context) =>
      signConnectionAuth(signer, {
        aud: context.audience,
        challenge: context.challenge.value,
        ...window(),
      }),
    authorizeSessionOpen: async (space, session, context) => {
      const invocation: Record<string, FabricValue> = {
        iss: signer.did(),
        cmd: "session.open",
        sub: space,
        aud: context.audience,
        challenge: context.challenge.value,
        args: {
          protocol: MEMORY_PROTOCOL,
          session: session as FabricPlainObject,
        },
        ...window(),
      };
      const signature = await signer.sign(hashOf(invocation).bytes);
      if (signature.error) throw signature.error;
      return {
        invocation,
        authorization: { signature: new FabricBytes(signature.ok) },
      };
    },
  };
};
