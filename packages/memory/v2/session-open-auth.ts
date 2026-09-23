/**
 * Shared verification for the signed `session.open` invocation.
 *
 * The memory server authenticates a client by verifying the signature on its
 * `session.open` invocation; the verified issuer becomes the session principal
 * that storage partitioning keys off. Toolshed's `/api/storage/memory` route
 * and the standalone test server use this shared verifier.
 *
 * The handshake adds three anti-replay checks on top of the signature:
 *
 *  - **expiry** (`exp`): a `session.open` is a live handshake, not a durable
 *    grant. When the invocation carries an `exp` (the client now stamps one),
 *    reject it once expired (with a clock-skew grace). Bounds how long a
 *    captured open can be replayed.
 *
 *  - **challenge** (`challenge`): the server advertises a fresh, connection
 *    scoped challenge in `hello.ok`; the client signs that value into
 *    `session.open`, and the server accepts it once.
 *
 *  - **audience** (`aud`): the invocation must carry this server's audience
 *    identity. An open signed for host A cannot be replayed to host B.
 */

import type { FabricPlainObject, FabricValue } from "@commonfabric/api";
import {
  hashOf,
  isFabricPlainObject,
  valueEqual,
} from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { fromDID } from "../util.ts";
import { MEMORY_PROTOCOL, type SessionOpenChallenge } from "../v2.ts";

/**
 * Build an `AuthorizationError`. Pass `retriable: true` for the anti-replay
 * races a fresh handshake heals (an expired, already-used, or mismatched
 * challenge; a stale signed `exp`); omit it for a permanent denial (an audience
 * mismatch, a malformed invocation, an ACL shortfall) that retrying cannot fix.
 * The flag rides on the thrown error and is copied onto the wire `V2Error` so
 * the client can classify the failure without parsing its message.
 */
export const authorizationError = (
  message: string,
  options?: { retriable?: boolean },
): Error =>
  Object.assign(
    new Error(message),
    options?.retriable === true
      ? { name: "AuthorizationError", retriable: true }
      : { name: "AuthorizationError" },
  );

const sameSessionDescriptor = (
  left: FabricPlainObject,
  right: {
    sessionId?: string;
    seenSeq?: number;
    sessionToken?: string;
    actingAs?: string;
    genesisRoot?: FabricValue;
  },
): boolean =>
  (typeof left.sessionId === "string" ? left.sessionId : undefined) ===
    right.sessionId &&
  (typeof left.seenSeq === "number" ? left.seenSeq : undefined) ===
    right.seenSeq &&
  (typeof left.sessionToken === "string" ? left.sessionToken : undefined) ===
    right.sessionToken &&
  // The delegated READ binding (OW31) is part of the signed descriptor:
  // a message-level marker that disagrees with the signed one is a
  // mismatch, so the binding cannot be injected or stripped in transit.
  (typeof left.actingAs === "string" ? left.actingAs : undefined) ===
    right.actingAs &&
  valueEqual(left.genesisRoot, right.genesisRoot);

export type SessionOpenMessage = {
  space: string;
  session: {
    sessionId?: string;
    seenSeq?: number;
    sessionToken?: string;
    genesisRoot?: FabricValue;
  };
  invocation?: FabricPlainObject;
  authorization?: FabricValue;
};

/**
 * The `session.open` authorization AFTER validation. Deliberately not the
 * declared type of `SessionOpenMessage.authorization`: that field is whatever
 * the peer sent, so it stays a bare `FabricValue` and only
 * {@link wireAuthorizationOf} may produce this type.
 *
 * The signature crosses the wire as a `FabricBytes` -- the canonical binary
 * `FabricValue` -- not as the `Uint8Array`-derived `Signature<T>` used
 * in-process.
 */
export type WireSessionOpenAuthorization = {
  signature: FabricBytes;
};

/**
 * Narrow a peer-supplied `authorization` to {@link WireSessionOpenAuthorization},
 * or `undefined` if it is not one. This is the only sanctioned way to go from
 * the untrusted field to the named shape.
 */
export const wireAuthorizationOf = (
  authorization: FabricValue,
): WireSessionOpenAuthorization | undefined => {
  if (!isFabricPlainObject(authorization)) return undefined;
  const { signature } = authorization;
  return signature instanceof FabricBytes ? { signature } : undefined;
};

export type VerifySessionOpenOptions = {
  /** This server's own audience identity. */
  audience: string;

  /** The challenge issued to this connection. */
  challenge: SessionOpenChallenge;

  /** Current unix time in seconds (defaults to now). Injectable for tests. */
  nowSeconds?: number;

  /** Grace window for `exp` to tolerate client/server clock skew. */
  clockSkewSeconds?: number;
};

const DEFAULT_CLOCK_SKEW_SECONDS = 120;

/**
 * Verify a `session.open` authorization. Returns the verified issuer DID or
 * throws an AuthorizationError.
 */
export const verifySessionOpenAuthorization = async (
  message: SessionOpenMessage,
  options: VerifySessionOpenOptions,
): Promise<string> => {
  const wireAuthorization = wireAuthorizationOf(message.authorization);
  const signature = wireAuthorization?.signature.slice() ?? null;
  if (!isFabricPlainObject(message.invocation) || signature === null) {
    throw authorizationError("memory session.open requires authorization");
  }

  const invocation = message.invocation;
  if (
    typeof invocation.iss !== "string" ||
    invocation.cmd !== "session.open" ||
    invocation.sub !== message.space ||
    !isFabricPlainObject(invocation.args) ||
    invocation.args.protocol !== MEMORY_PROTOCOL ||
    !isFabricPlainObject(invocation.args.session) ||
    !sameSessionDescriptor(invocation.args.session, message.session)
  ) {
    throw authorizationError("memory session.open authorization mismatch");
  }

  if (typeof invocation.aud !== "string") {
    throw authorizationError("memory session.open requires audience");
  }
  if (invocation.aud !== options.audience) {
    throw authorizationError("memory session.open audience mismatch");
  }

  if (typeof invocation.challenge !== "string") {
    throw authorizationError("memory session.open requires challenge");
  }
  if (invocation.challenge !== options.challenge.value) {
    throw authorizationError("memory session.open challenge mismatch", {
      retriable: true,
    });
  }
  const challengeNow = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (options.challenge.expiresAt <= challengeNow) {
    throw authorizationError("memory session.open challenge expired", {
      retriable: true,
    });
  }

  if (typeof invocation.iat !== "number" || !Number.isFinite(invocation.iat)) {
    throw authorizationError("memory session.open requires iat");
  }
  if (typeof invocation.exp !== "number" || !Number.isFinite(invocation.exp)) {
    throw authorizationError("memory session.open requires exp");
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  if (invocation.exp < now - skew) {
    throw authorizationError("memory session.open authorization expired", {
      retriable: true,
    });
  }

  const issuer = await fromDID(invocation.iss);
  if (issuer.error) {
    throw issuer.error;
  }

  const verified = await issuer.ok.verify({
    payload: hashOf(invocation).bytes,
    signature,
  });
  if (verified.error) {
    throw verified.error;
  }

  return invocation.iss;
};
