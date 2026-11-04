/**
 * Opens a space by its legacy name in emulated storage, for tests of what a
 * session opened by name does with that name.
 */
import {
  createSession,
  type Identity,
  legacySpaceDid,
} from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { ACLManager, type Runtime } from "@commonfabric/runner";

/**
 * Gives the space the legacy name `name` resolves to an access-control
 * document making `identity` its owner, which is what a space created before
 * space identities were random holds, and returns a controller over that
 * space opened by `name`, as `PiecesController.initialize` opens a named
 * space. Opening by name creates nothing, so the space has to exist first.
 */
export const openLegacySpace = async (
  identity: Identity,
  runtime: Runtime,
  name: string,
): Promise<PiecesController> => {
  const space = await legacySpaceDid(name);
  await new ACLManager(runtime, space).set(identity.did(), "OWNER");
  return new PiecesController(
    createSession({ identity, spaceDid: space }),
    runtime,
    { spaceName: name },
  );
};
