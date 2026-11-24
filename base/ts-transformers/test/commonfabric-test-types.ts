/**
 * Shared type definitions for commonfabric module used in tests.
 *
 * Loads types from the same source as production: types/commonfabric.d.ts
 * via the static cache, which is generated from base/api/index.ts.
 */

import { StaticCache } from "@commonfabric/static";

const staticCache = StaticCache.fromFileSystem();

/**
 * The commonfabric type definitions, loaded from the same source as production.
 * The file is generated from base/api/index.ts.
 */
export const commonfabricTypes = await staticCache.getText(
  "types/commonfabric.d.ts",
);

export const cfcTypes = await staticCache.getText("types/cfc.ts");

/**
 * Types in the format expected by test utilities.
 */
export const COMMONFABRIC_TYPES: Record<string, string> = {
  "commonfabric.d.ts": commonfabricTypes,
  "cfc.ts": cfcTypes,
};
