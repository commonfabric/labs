/** Emits the schemas of Home's authored observation types for the host drift check. */

import { pattern, toSchema } from "commonfabric";
import type { SharedSpaceEntry } from "../../../system/shared-space-catalog.ts";
import type {
  SharedSpaceCollectionView,
  SharedSpaceProfileView,
  SharedSpaceReceiptView,
} from "../../../system/shared-space-interface.ts";

export default pattern(() => ({
  entry: toSchema<SharedSpaceEntry>(),
  collection: toSchema<SharedSpaceCollectionView>(),
  receipts: toSchema<SharedSpaceReceiptView>(),
  profiles: toSchema<SharedSpaceProfileView>(),
}));
