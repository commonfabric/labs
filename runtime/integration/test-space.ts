import { type DID, Identity, legacySpaceDid } from "@commonfabric/identity";
import { type ACL, aclDocId } from "@commonfabric/memory/acl";
import { toDocumentPath } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import {
  RemoteSessionFactory,
  storageAddressForHost,
} from "@commonfabric/runner/storage/v2";

import { API_URL } from "./env.ts";

/**
 * Creates a space owned by `owner` on the server at `apiUrl`, and returns its
 * DID. `grants` gives other identities access at creation, which is how a test
 * shares one space between several users. Opening a DID never creates a
 * space, so a test that wants a space of its own makes one here.
 */
export async function createTestSpace(
  owner: Identity,
  options: { apiUrl?: string | URL; grants?: ACL } = {},
): Promise<DID> {
  const manager = StorageManager.open({
    as: owner,
    memoryHost: new URL(options.apiUrl ?? API_URL),
  });
  try {
    return await manager.createSpace({
      ...options.grants,
      [owner.did()]: "OWNER",
    });
  } finally {
    await manager.close();
  }
}

/**
 * The passphrase every legacy space key was derived from. Nothing creates a
 * legacy space any more; this reproduces how one was born, so that a test of
 * what a legacy name opens has a legacy space for the name to open.
 */
const LEGACY_SPACE_PASSPHRASE = "common user";

/**
 * Makes the legacy space `name` resolves to exist on the server at `apiUrl`,
 * owned by `owner`, and returns its DID.
 *
 * A legacy space was created by signing its genesis with a key derived from a
 * published passphrase and the name, which is what this does. The genesis
 * access-control document grants `owner` alone, as a swept legacy space
 * stands, so the key derived from the name holds nothing once it lands.
 *
 * @throws If the space already has history, which a test that picked a fresh
 *   name never meets: the genesis commit then conflicts.
 */
export async function createLegacyTestSpace(
  owner: Identity,
  name: string,
  options: { apiUrl?: string | URL } = {},
): Promise<DID> {
  const key = await (await Identity.fromPassphrase(LEGACY_SPACE_PASSPHRASE))
    .derive(name);
  const space = key.did();
  if (space !== await legacySpaceDid(name)) {
    throw new Error(
      `The legacy derivation of ${JSON.stringify(name)} gave ${space}, and ` +
        `legacySpaceDid gives another DID`,
    );
  }
  const endpoint = storageAddressForHost(options.apiUrl ?? API_URL);
  const factory = new RemoteSessionFactory(() => endpoint, key);
  const { client, session } = await factory.create(space, key, {
    sessionId: crypto.randomUUID(),
  });
  try {
    // The commit reads the access-control document as absent, so it lands
    // only as the space's first; a space with history refuses it.
    const aclId = aclDocId(space);
    await session.transact({
      localSeq: 1,
      reads: {
        confirmed: [{ id: aclId, path: toDocumentPath([]), seq: 0 }],
        pending: [],
      },
      operations: [{
        op: "set",
        id: aclId,
        value: { value: { [owner.did()]: "OWNER" } },
      }],
    });
  } finally {
    await client.close();
  }
  return space;
}
