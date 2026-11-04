import { VerifierIdentity } from "@commonfabric/identity";
import { DID_PREFIX, isDID, isDIDKey } from "@commonfabric/identity/did";

import { AsyncResult, DID, DIDKey } from "./interface.ts";

/**
 * Parses a DID string into an Identity
 */
export const fromDID = async <ID extends DIDKey>(
  id: ID | DID | string,
): AsyncResult<VerifierIdentity<ID>, SyntaxError> => {
  if (!isDID(id)) {
    return {
      error: new SyntaxError(
        `Invalid DID "${id}", must start with "${DID_PREFIX}"`,
      ),
    };
  } else if (!isDIDKey(id)) {
    return {
      error: new SyntaxError(
        `Invalid DID "${id}", only "did:key:" are supported right now`,
      ),
    };
  } else {
    try {
      return { ok: await VerifierIdentity.fromDid(id as ID) };
    } catch (e) {
      return { error: new SyntaxError(`Invalid DID "${id}", ${e}`) };
    }
  }
};
