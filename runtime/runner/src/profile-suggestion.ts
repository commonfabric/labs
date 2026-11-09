/**
 * The profile a host suggests for its user's first profile, held where the
 * `#profile` wish's create surface reads it on whichever runtime serves it.
 */

import type { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { internSchema } from "@commonfabric/data-model-schema";
import type { Cell } from "./cell.ts";
import type { Runtime } from "./runtime.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

/**
 * A name and, optionally, a picture for the user's first profile, offered by
 * the host that knows them, as Web Weaver does with the profile an invitation
 * suggests for the person it is for. The create surface shows them; the user
 * keeps, edits, or drops them, and only their click on "Create profile"
 * applies them.
 */
export type ProfileSuggestion = {
  name: string;
  picture?: FabricBytes;
};

const profileSuggestionSchema = internSchema({
  type: "object",
  properties: {
    name: { type: "string" },
    picture: { type: "FabricBytes" },
  },
});

/**
 * Returns the cell holding the profile suggested for the user whose home space
 * a run on `tx` targets, by the rule `Runtime.getHomeSpaceCell()` follows: the
 * runtime's own user on a client, and the run's demanding identity on a
 * serving runtime. The cell is a document of its own in that home space,
 * named by a cause only the runtime derives, so no pattern can address it; the
 * create surface reaches it through the link the wish hands it.
 *
 * @throws On a serving runtime whose run carries no demanding identity.
 */
export function profileSuggestionCell(
  runtime: Runtime,
  tx?: IExtendedStorageTransaction,
): Cell<ProfileSuggestion | undefined> {
  const principal = runtime.homeSpacePrincipalFor(tx);
  if (principal === undefined) {
    throw new Error(
      "a profile suggestion on a serving runtime belongs to the run's " +
        "demanding identity, and this run carries none",
    );
  }
  return runtime.getCell(
    principal,
    { profileSuggestion: principal },
    profileSuggestionSchema,
    tx,
  ) as Cell<ProfileSuggestion | undefined>;
}

/**
 * Stores `suggestion` as the profile suggested for this client runtime's
 * user, replacing any suggestion stored before, and resolves once the write
 * commits.
 *
 * @throws On a serving runtime, which acts for many users, or when the write
 *   cannot commit.
 */
export async function offerProfileSuggestion(
  runtime: Runtime,
  suggestion: ProfileSuggestion,
): Promise<void> {
  if (runtime.servingPosture) {
    throw new Error("only a client runtime offers its user a profile");
  }
  const { error } = await runtime.editWithRetry((tx) => {
    profileSuggestionCell(runtime, tx).set(suggestion);
  });
  if (error) throw new Error(error.message);
}
