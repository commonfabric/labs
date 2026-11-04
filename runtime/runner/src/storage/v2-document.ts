import type { FabricValue } from "@commonfabric/api";
import type { EntityDocument } from "@commonfabric/memory/v2";

export const toTransactionDocumentValue = (
  document: EntityDocument | undefined,
): FabricValue | undefined => {
  if (document === undefined) {
    return undefined;
  }

  return Object.keys(document).length === 0 ? undefined : document;
};
