/**
 * Verification of the signed `connection.auth` invocation, by which a key
 * authenticates once for a whole connection (04-protocol.md §4.5). The
 * verified issuer becomes an authenticated principal of the connection, which
 * a later `session.open` names in place of carrying a signature of its own.
 *
 * The invocation is held to what a signed `session.open` is held to — the
 * server's audience, a challenge issued to this connection, a validity
 * window, the issuer's signature — and names no space: what the principal may
 * do in a space is decided when it opens a session there.
 */

import type { FabricPlainObject, FabricValue } from "@commonfabric/api";
import { isFabricPlainObject } from "@commonfabric/data-model";

import { MEMORY_PROTOCOL } from "../v2.ts";
import {
  authorizationError,
  type VerifySessionOpenOptions,
  verifySignedInvocation,
  wireAuthorizationOf,
} from "./session-open-auth.ts";

/** The parts of a `connection.auth` request its verification reads. */
export type ConnectionAuthMessage = {
  /** The signed invocation, as the peer sent it. */
  invocation?: FabricPlainObject;

  /** The signature over the invocation, as the peer sent it. */
  authorization?: FabricValue;
};

/**
 * What a `connection.auth` is verified against: the server's audience, the
 * challenge the invocation names, and the clock.
 */
export type VerifyConnectionAuthOptions = VerifySessionOpenOptions;

/**
 * Verifies a `connection.auth` authorization. Returns the verified issuer
 * DID, or throws an `AuthorizationError`: marked `retriable` for a challenge
 * that is not the one in `options` or has expired and for an `exp` that has
 * passed, and permanent for everything else.
 */
export const verifyConnectionAuthorization = (
  message: ConnectionAuthMessage,
  options: VerifyConnectionAuthOptions,
): Promise<string> => {
  const signature = wireAuthorizationOf(message.authorization)?.signature
    .slice();
  if (!isFabricPlainObject(message.invocation) || signature === undefined) {
    return Promise.reject(
      authorizationError("memory connection.auth requires authorization"),
    );
  }

  const invocation = message.invocation;
  if (
    invocation.cmd !== "connection.auth" ||
    !isFabricPlainObject(invocation.args) ||
    invocation.args.protocol !== MEMORY_PROTOCOL
  ) {
    return Promise.reject(
      authorizationError("memory connection.auth authorization mismatch"),
    );
  }

  return verifySignedInvocation(
    "memory connection.auth",
    invocation,
    signature,
    options,
  );
};

/**
 * Authorizes a `connection.auth` on an in-process memory server. A signed
 * request is verified as a deployed memory server verifies it, and admitted
 * as the signature's issuer. An unsigned request is admitted, unverified, as
 * the principal its `authorization.principal` names, and returns `undefined`
 * when it names none. Trusting that unsigned claim confines this authorizer
 * to in-process emulation, where every client shares the process.
 */
export const authorizeLoopbackConnection = (
  message: ConnectionAuthMessage,
  context: VerifyConnectionAuthOptions,
): Promise<string> | string | undefined => {
  const { authorization } = message;
  if (wireAuthorizationOf(authorization) !== undefined) {
    return verifyConnectionAuthorization(message, context);
  }
  return isFabricPlainObject(authorization) &&
      typeof authorization.principal === "string"
    ? authorization.principal
    : undefined;
};
