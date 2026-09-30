export { PassKey } from "./pass-key.ts";
export {
  Identity,
  type IdentityCreateConfig,
  VerifierIdentity,
} from "./identity.ts";
export {
  keyPairFromRealmValue,
  realmValueFromKeyPair,
} from "./key-pair-transport.ts";
export { KeyStore } from "./key-store.ts";
export * from "./interface.ts";
export { legacySpaceDid } from "./legacy-space.ts";
export { createSession, type Session } from "./session.ts";
