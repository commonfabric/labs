/**
 * Runtime shape checks for CFC labels received through harness-owned state or
 * host transports. The runner's TypeScript types do not validate decoded
 * values, so both ingress and resume use this one fail-closed rule.
 */

import type { CfcConfClause, IFCLabel } from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";

/** Whether a decoded value has the supported shape of one CFC atom. */
export const isCfcAtomShape = (value: unknown): boolean =>
  typeof value === "string" ||
  (isObjectNotArray(value) && typeof value.type === "string" &&
    !Object.hasOwn(value, "anyOf"));

/** Whether a decoded value has the supported shape of one CFC clause. */
export const isCfcClauseShape = (
  value: unknown,
): value is CfcConfClause =>
  isCfcAtomShape(value) ||
  (isObjectNotArray(value) && Object.keys(value).length === 1 &&
    Array.isArray(value.anyOf) &&
    value.anyOf.length > 0 && value.anyOf.every(isCfcAtomShape));

/** Whether a decoded value is a label whose clauses and atoms are readable. */
export const isCfcLabelShape = (value: unknown): value is IFCLabel =>
  isObjectNotArray(value) &&
  Object.keys(value).every((key) =>
    key === "confidentiality" || key === "integrity"
  ) &&
  (value.confidentiality === undefined ||
    (Array.isArray(value.confidentiality) &&
      value.confidentiality.every(isCfcClauseShape))) &&
  (value.integrity === undefined ||
    (Array.isArray(value.integrity) &&
      value.integrity.every(isCfcAtomShape)));
