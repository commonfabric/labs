/**
 * Operator admission of foreign references. Each admitted space has an explicit
 * host route; reads retain the session's identity and the source's CFC labels.
 */

import { debugStr } from "@commonfabric/data-model";
import { isDIDKey } from "@commonfabric/identity/did";
import { type MemorySpace, normalizeSpaceHost } from "@commonfabric/runner";
import { isPlainObject } from "@commonfabric/utils/types";

/** Foreign space DIDs and their HTTP(S) origins, supplied by the operator. */
export type HarnessForeignSpaces = Readonly<Record<string, string>>;

/**
 * Validates and snapshots an operator's admission map. Throws for a space name
 * or a host that is not an HTTP(S) origin.
 */
export const validateHarnessForeignSpaces = (
  value: unknown,
): HarnessForeignSpaces => {
  if (!isPlainObject(value)) {
    throw new Error("`fabric-foreign-spaces` must be a JSON DID-to-host map");
  }
  const routes: Record<string, string> = {};
  for (const [space, host] of Object.entries(value)) {
    if (!isDIDKey(space) || space === "did:key:" || /\s/.test(space)) {
      throw new Error(
        debugStr`Foreign space must be a \`did:key\`: $quote${space}`,
      );
    }
    if (typeof host !== "string") {
      throw new Error("Foreign space host must be an HTTP(S) origin");
    }
    routes[space] = normalizeSpaceHost(host).href;
  }
  return Object.freeze(routes);
};

/** Parses the trusted startup flag or environment value; absent admits none. */
export const parseHarnessForeignSpaces = (
  raw: string | undefined,
): HarnessForeignSpaces | undefined =>
  raw === undefined ? undefined : validateHarnessForeignSpaces(JSON.parse(raw));

/** Returns whether a reference targets the local space or an admitted DID. */
export const admitsFabricReference = (
  referenceSpace: MemorySpace | undefined,
  sessionSpace: MemorySpace,
  foreignSpaces: HarnessForeignSpaces = {},
): boolean =>
  referenceSpace === undefined || referenceSpace === sessionSpace ||
  Object.hasOwn(foreignSpaces, referenceSpace);
