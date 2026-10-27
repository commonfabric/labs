/**
 * A storage manager creating a space that owns itself, over a real standalone
 * server: the access list it writes, the kind it seals, the delegation its
 * key issues to the creator before being dropped, and a session acting under
 * the space's own grant through that delegation.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  decodeDelegation,
  Identity,
  verifyDelegation,
} from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";

import {
  createStorageAddressResolver,
  RemoteSessionFactory,
} from "../src/storage/v2-remote-session.ts";
import { StorageManager } from "../src/storage/v2.ts";

const owner = await Identity.fromPassphrase("self-owned-space owner");
const other = await Identity.fromPassphrase("self-owned-space other");

describe("storage-self-owned-space", () => {
  let server: StandaloneMemoryServer;
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
    server = StandaloneMemoryServer.start({ acl: { mode: "enforce" } });
    cleanups.push(() => server.close());
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  const managerAs = (as: Identity) => {
    const manager = StorageManager.open({ as, memoryHost: server.url });
    cleanups.push(() => manager.close());
    return manager;
  };

  const factoryAs = (as: Identity) => {
    const factory = new RemoteSessionFactory(
      createStorageAddressResolver(server.url),
      as,
    );
    cleanups.push(() => factory.close());
    return factory;
  };

  const aclOf = async (space: string): Promise<unknown> =>
    (await server.server.readDocument(space, aclDocId(space)))?.value;

  it("writes the space's own DID as the one owner beside the grants, seals the kind, and returns a delegation to the creator", async () => {
    const manager = managerAs(owner);
    const { space, delegation } = await manager.createSelfOwnedSpace({
      grants: { "*": "WRITE" },
      delegateTo: owner.did(),
      spaceKind: "profile",
    });
    expect(await aclOf(space)).toEqual({ "*": "WRITE", [space]: "OWNER" });
    expect(await manager.spaceKind(space)).toBe("profile");

    const decoded = await decodeDelegation(delegation);
    await verifyDelegation(decoded);
    expect(decoded.payload).toMatchObject({
      iss: space,
      aud: owner.did(),
      sub: space,
      cmd: "/memory",
      pol: [],
      exp: null,
    });
  });

  it("throws for grants that make another principal OWNER, and creates nothing", async () => {
    const manager = managerAs(owner);
    await expect(
      manager.createSelfOwnedSpace({
        grants: { [other.did()]: "OWNER" },
        delegateTo: owner.did(),
      }),
    ).rejects.toThrow("grants OWNER to nobody else");
  });

  it("throws on a host that admits no proof chain, and creates nothing there", async () => {
    const refusing = StandaloneMemoryServer.start({
      acl: { mode: "enforce", delegations: false },
    });
    cleanups.push(() => refusing.close());
    const manager = StorageManager.open({
      as: owner,
      memoryHost: refusing.url,
    });
    cleanups.push(() => manager.close());
    await expect(manager.createSelfOwnedSpace({ delegateTo: owner.did() }))
      .rejects.toThrow("does not admit a session.open proof chain");
  });

  it("lets a session holding the delegation act as the space's OWNER, where one holding nothing is refused", async () => {
    const { space, delegation } = await managerAs(owner).createSelfOwnedSpace({
      delegateTo: owner.did(),
    });

    // The key's own grant is nothing: the access list names the space alone.
    const bare = factoryAs(owner);
    await expect(bare.create(space)).rejects.toThrow("lacks READ");

    // Holding the delegation, the same key replaces the access list, which
    // only an OWNER may do.
    const holding = factoryAs(owner);
    await holding.addDelegationChain([delegation]);
    const { client, session } = await holding.create(space);
    cleanups.push(() => client.close());
    const replaced = await session.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: aclDocId(space),
        value: { value: { [space]: "OWNER", [other.did()]: "READ" } },
      }],
    });
    expect(replaced.seq).toBeGreaterThan(0);
    expect(await aclOf(space)).toEqual({
      [space]: "OWNER",
      [other.did()]: "READ",
    });
  });
});
