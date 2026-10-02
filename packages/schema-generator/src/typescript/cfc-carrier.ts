/**
 * Recognizes the carrier a CFC alias intersects its payload with: a member
 * holding the alias's labels under `__ct_cfc__` and nothing else
 * (`Cfc` in `packages/api/cfc.ts`). The checker drops an alias's name where it
 * reduces the alias's type, and then the carrier is all that says a value is
 * labelled.
 */

import type ts from "typescript";

/**
 * The member a CFC metadata carrier holds. It is a phantom: no value holds it.
 */
export const CFC_CARRIER_PROPERTY = "__ct_cfc__";

/**
 * The `__ct_cfc__` member of `member` when that is all `member` holds: a CFC
 * metadata carrier, which a CFC alias intersects its payload with.
 */
export const cfcCarrierProperty = (
  member: ts.Type,
): ts.Symbol | undefined => {
  const properties = member.getProperties();
  return properties.length === 1 &&
      properties[0]!.name === CFC_CARRIER_PROPERTY
    ? properties[0]
    : undefined;
};
