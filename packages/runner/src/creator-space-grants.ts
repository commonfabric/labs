import type { DID } from "@commonfabric/api";
import { debugStr } from "@commonfabric/data-model";
import { isDID } from "@commonfabric/identity/did";
import { isObjectNotArray } from "@commonfabric/utils/types";

/**
 * Returns the grants a creator-only space's genesis gives its `members`,
 * beside its creator: each member's principal mapped to its level. This is the
 * one check of a member list, made where a pattern names one and again where
 * the runtime writes the genesis, so no path reaches a genesis with a list it
 * did not pass. `creator`, when given, may not be among the members.
 *
 * @throws Error when `members` is not an array, or an entry is not
 *   `{ principal, level }` with a principal's DID (never the wildcard) at
 *   `WRITE` or `OWNER`, or a principal is listed twice or is `creator`.
 */
export function creatorSpaceGrants(
  members: unknown,
  creator?: DID,
): Readonly<Record<DID, "WRITE" | "OWNER">> {
  if (!Array.isArray(members)) {
    throw new Error(
      debugStr`A creator-only space's \`members\` must be an array; got $quote${members}.`,
    );
  }
  const grants: Record<DID, "WRITE" | "OWNER"> = {};
  for (const entry of members) {
    const principal = isObjectNotArray(entry) ? entry.principal : undefined;
    const level = isObjectNotArray(entry) ? entry.level : undefined;
    if (typeof principal !== "string" || !isDID(principal)) {
      throw new Error(
        "A creator-only space's member must be a principal's DID, never " +
          debugStr`the wildcard; got $quote${principal}.`,
      );
    }
    if (level !== "WRITE" && level !== "OWNER") {
      throw new Error(
        "A creator-only space's member is admitted at `WRITE` or `OWNER`; " +
          debugStr`got $quote${level} for ${principal}.`,
      );
    }
    if (Object.hasOwn(grants, principal)) {
      throw new Error(
        `A creator-only space lists ${principal} as a member twice.`,
      );
    }
    if (principal === creator) {
      throw new Error(
        `A creator-only space lists its creator, ${creator}, as a member.`,
      );
    }
    grants[principal] = level;
  }
  return Object.freeze(grants);
}
