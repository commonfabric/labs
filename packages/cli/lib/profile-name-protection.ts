import { isDID } from "@commonfabric/identity/did";
import {
  inspectProfileNameProtection,
  repairProfileNameProtection,
} from "@commonfabric/piece/ops";
import { entityIdFrom } from "@commonfabric/runner";
import { parseCellReference } from "@commonfabric/runner/shared";

import { loadPieces, type SpaceConfig } from "./piece.ts";

export interface ProfileNameProtectionConfig extends SpaceConfig {
  cell: string;
  expectedInspection?: string;
}

/** Uses the explicitly named profile space; never guesses from the login DID. */
export async function profileNameProtection(
  config: ProfileNameProtectionConfig,
  load: typeof loadPieces = loadPieces,
) {
  const ref = parseCellReference(config.cell);
  if (
    !isDID(ref.space) || !ref.id.startsWith("of:") ||
    ref.path.length !== 0 || ref.member !== undefined ||
    ref.pin !== undefined ||
    (ref.scope !== undefined && ref.scope !== "space")
  ) {
    throw new Error(
      "Name protection repair requires a full profile cell address with a space DID, no member or path, and space scope.",
    );
  }
  const id = entityIdFrom(ref.id);
  const pieces = await load({ ...config, space: ref.space });
  try {
    // Read the exact piece. Resolving a parent-owned list slot would silently
    // change the owner-reviewed repair target.
    const profile = pieces.runtime.getCellFromEntityId(
      ref.space,
      id,
      [],
    );
    return config.expectedInspection === undefined
      ? await inspectProfileNameProtection(pieces.runtime, profile)
      : await repairProfileNameProtection(
        pieces.runtime,
        profile,
        config.expectedInspection,
      );
  } finally {
    await pieces.dispose();
  }
}
