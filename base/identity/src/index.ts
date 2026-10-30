export { PassKey } from "./pass-key.ts";
export {
  decodeDelegation,
  type Delegation,
  delegationCid,
  delegationCovers,
  DelegationError,
  type DelegationFields,
  type DelegationPayload,
  ED25519_DAG_CBOR_VARSIG,
  issueDelegation,
  verifyDelegation,
} from "./delegation.ts";
export {
  decodeDelegationChains,
  DELEGATION_CHAIN_FORMAT,
  encodeDelegationChains,
} from "./delegation-chain-text.ts";
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
export { hasEd25519DIDShape, isCanonicalEd25519DID } from "./ed25519/utils.ts";
export { createSession, type Session } from "./session.ts";
