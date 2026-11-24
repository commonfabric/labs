/**
 * Writes a profile that counts as its writer's own, as a profile Home makes
 * does, for integration tests that need the acting person's profile without
 * running Home. A profile is a person's own only when its label names that
 * person alone as the principal it represents (`profileOwnerOf()`), and a
 * `represents-principal` claim is installed only for a write whose writer
 * the profile's schema names; the trusted builtin writer here stands in for
 * the profile's own handlers.
 */

import type {
  Cell,
  JSONSchema,
  MemorySpace,
  Runtime,
} from "@commonfabric/runner";
import { setCfcImplementationIdentity } from "@commonfabric/runner/cfc/trust-authority";

const PROFILE_WRITER = "integration-own-profile";

/** A profile labeled as belonging to the principal acting in its write. */
const ownProfileSchema: JSONSchema = {
  type: "object",
  properties: { name: { type: "string" } },
  ifc: {
    addIntegrity: [{
      kind: "represents-principal",
      subject: { __ctCurrentPrincipal: true },
    }],
    ownerPrincipal: { __ctCurrentPrincipal: true },
    writeAuthorizedBy: [PROFILE_WRITER],
  },
};

/**
 * Writes a profile named `name` at `cause` in `space`, as the principal
 * `runtime` acts for, and returns it once the write commits.
 *
 * @throws The commit's error when the write is refused.
 */
export async function writeOwnProfile(
  runtime: Runtime,
  space: MemorySpace,
  cause: string,
  name: string,
): Promise<Cell<unknown>> {
  const tx = runtime.edit();
  setCfcImplementationIdentity(tx, {
    kind: "builtin",
    builtinId: PROFILE_WRITER,
  });
  const profile = runtime.getCell(space, cause, ownProfileSchema, tx);
  profile.set({ name });
  runtime.prepareTxForCommit(tx);
  const { error } = await tx.commit().settled;
  if (error) throw error;
  return profile;
}
