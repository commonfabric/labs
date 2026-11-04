import type { DID } from "./did.ts";
import type { Identity } from "./identity.ts";

/** The identity a runtime acts as, and the space it addresses. */
export type Session = {
  space: DID;
  as: Identity;
};

export type SessionCreateOptions = {
  identity: Identity;
  spaceDid: DID;
};

/** Creates a session in which `identity` addresses the space `spaceDid`. */
export const createSession = (options: SessionCreateOptions): Session => ({
  as: options.identity,
  space: options.spaceDid,
});
