import { isPlainObject } from "@commonfabric/utils/types";
import { ACL, ACLUser, ANYONE, Capability, DID, DIDKey } from "./interface.ts";
import { isDID } from "@commonfabric/identity/did";

export type { ACL, ACLUser, ANYONE, Capability, DID, DIDKey };

export const ANYONE_USER: ANYONE = "*";

/**
 * Entity id of a space's ACL document. The id used to be hand-built as
 * `of:${space}` independently by the memory server, the runner's storage
 * manager, `ACLManager`, the CFC space-membership reader and the write
 * chokepoint; all of those now call this. Tests still spell the id out
 * literally on purpose — a test that derived the id from the same helper the
 * code under test uses would agree with a wrong helper.
 *
 * The document has a non-standard write contract — see INV-12 in
 * `docs/specs/memory-v2/09-invariants.md`: a mutation must be an ACL-only
 * commit carrying a single whole-document `set`. Value-surface writes are
 * refused client-side at the runner's write chokepoint.
 */
export const aclDocId = (space: string): string => `of:${space}`;

export function isACLUser(value: unknown): value is ACLUser {
  return value === ANYONE_USER || isDID(value);
}

export function isCapability(value: unknown): value is Capability {
  return value === "READ" || value === "WRITE" || value === "OWNER";
}

export function isACL(value: unknown): value is ACL {
  if (!isPlainObject(value)) return false;
  for (const [did, cap] of Object.entries(value)) {
    if (!isACLUser(did)) return false;
    if (!isCapability(cap)) return false;
  }
  return true;
}

/** An enforceable ACL must retain an OWNER tied to a concrete DID. A wildcard
 *  OWNER may coexist with one, but cannot by itself administer the ACL. */
export function hasConcreteOwner(acl: ACL): boolean {
  return Object.entries(acl).some(([principal, capability]) =>
    principal !== ANYONE_USER && capability === "OWNER"
  );
}

/** Whether a stored ACL document is exactly `expected`: same principals,
 *  same capabilities, nothing more. Key order is not part of the contract. */
export function sameAcl(stored: unknown, expected: ACL): boolean {
  if (!isPlainObject(stored)) return false;
  const actual = stored as Record<string, unknown>;
  const expectedKeys = Object.keys(expected);
  return Object.keys(actual).length === expectedKeys.length &&
    expectedKeys.every((key) => actual[key] === expected[key as ACLUser]);
}

const CapabilityMap: Record<Capability, number> = {
  READ: 0,
  WRITE: 1,
  OWNER: 2,
};

export function isCapable(
  capability: Capability,
  requirement: Capability,
): boolean {
  return CapabilityMap[capability] >=
    CapabilityMap[requirement];
}
