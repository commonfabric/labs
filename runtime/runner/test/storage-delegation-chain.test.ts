/**
 * A runtime presenting a proof chain when it opens a space: the owner of a
 * space delegates to a guest, the guest's session factory holds the
 * delegation, and the guest's session acts under the owner's grant over a
 * real standalone server, on each of the two authentication paths a
 * `session.open` takes.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { type DIDKey, Identity, issueDelegation } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";

import {
  createStorageAddressResolver,
  RemoteSessionFactory,
} from "../src/storage/v2-remote-session.ts";
import { StorageManager } from "../src/storage/v2.ts";

const owner = await Identity.fromPassphrase("delegation-chain owner");
const guest = await Identity.fromPassphrase("delegation-chain guest");

describe("storage-delegation-chain", () => {
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  /** A server, and a space on it the owner created and alone is granted. */
  const serverWithOwnedSpace = async (
    options: { delegations: boolean; connectionAuth: boolean },
  ) => {
    const server = StandaloneMemoryServer.start({
      acl: { mode: "enforce", delegations: options.delegations },
      connectionAuth: options.connectionAuth,
    });
    cleanups.push(() => server.close());
    const ownerManager = StorageManager.open({
      as: owner,
      memoryHost: server.url,
    });
    cleanups.push(() => ownerManager.close());
    const space = await ownerManager.createSpace({ [owner.did()]: "OWNER" });
    return { server, space };
  };

  const guestFactory = (server: StandaloneMemoryServer) => {
    const factory = new RemoteSessionFactory(
      createStorageAddressResolver(server.url),
      guest,
    );
    cleanups.push(() => factory.close());
    return factory;
  };

  const write = (
    session: { transact: RemoteSessionFactoryTransact },
    localSeq: number,
  ) =>
    session.transact({
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:delegated",
        value: { value: { by: "guest" } },
      }],
    });

  type RemoteSessionFactoryTransact = Awaited<
    ReturnType<RemoteSessionFactory["create"]>
  >["session"]["transact"];

  for (const connectionAuth of [false, true]) {
    describe(
      connectionAuth
        ? "against a server that authenticates the connection"
        : "against a server that verifies each signed open",
      () => {
        it("opens the space and writes under the owner's grant with the owner's delegation held", async () => {
          const { server, space } = await serverWithOwnedSpace({
            delegations: true,
            connectionAuth,
          });
          const factory = guestFactory(server);
          const delegation = await issueDelegation(owner, {
            aud: guest.did(),
            sub: space as DIDKey,
            cmd: "/memory",
            pol: [],
          });
          await factory.addDelegationChain([delegation.bytes]);

          const { client, session } = await factory.create(space);
          cleanups.push(() => client.close());
          const written = await write(session, 1);
          expect(written.seq).toBeGreaterThan(0);
        });

        it("presents a delegation added after an earlier open was refused, on the same factory", async () => {
          const { server, space } = await serverWithOwnedSpace({
            delegations: true,
            connectionAuth,
          });
          const factory = guestFactory(server);
          await expect(factory.create(space)).rejects.toThrow("lacks READ");
          const delegation = await issueDelegation(owner, {
            aud: guest.did(),
            sub: space as DIDKey,
            cmd: "/memory",
            pol: [],
          });
          await factory.addDelegationChain([delegation.bytes]);
          const { client, session } = await factory.create(space);
          cleanups.push(() => client.close());
          expect((await write(session, 1)).seq).toBeGreaterThan(0);
        });

        it("presents the chain added last among those rooted elsewhere than the space, so the owner's chain added after a stranger's wins", async () => {
          const { server, space } = await serverWithOwnedSpace({
            delegations: true,
            connectionAuth,
          });
          const factory = guestFactory(server);
          const stranger = await Identity.fromPassphrase(
            "delegation-chain stranger",
          );
          const alice = await Identity.fromPassphrase("delegation-chain alice");
          const viaStranger = await issueDelegation(stranger, {
            aud: guest.did(),
            sub: space as DIDKey,
            cmd: "/memory",
            pol: [],
          });
          const fromOwner = await issueDelegation(owner, {
            aud: alice.did(),
            sub: space as DIDKey,
            cmd: "/memory",
            pol: [],
          });
          const onward = await issueDelegation(alice, {
            aud: guest.did(),
            sub: space as DIDKey,
            cmd: "/memory",
            pol: [],
          });
          await factory.addDelegationChain([viaStranger.bytes]);
          await factory.addDelegationChain([fromOwner.bytes, onward.bytes]);
          const { client, session } = await factory.create(space);
          cleanups.push(() => client.close());
          expect((await write(session, 1)).seq).toBeGreaterThan(0);
        });

        it("is refused the space with no delegation held", async () => {
          const { server, space } = await serverWithOwnedSpace({
            delegations: true,
            connectionAuth,
          });
          const factory = guestFactory(server);
          await expect(factory.create(space)).rejects.toThrow(
            "lacks READ",
          );
        });

        it("throws before opening when the server admits no chain", async () => {
          const { server, space } = await serverWithOwnedSpace({
            delegations: false,
            connectionAuth,
          });
          const factory = guestFactory(server);
          const delegation = await issueDelegation(owner, {
            aud: guest.did(),
            sub: space as DIDKey,
            cmd: "/memory",
            pol: [],
          });
          await factory.addDelegationChain([delegation.bytes]);
          await expect(factory.create(space)).rejects.toThrow(
            "sessionOpenProofs",
          );
        });
      },
    );
  }

  it("rejects a delegation that does not verify", async () => {
    const { server, space } = await serverWithOwnedSpace({
      delegations: true,
      connectionAuth: false,
    });
    const factory = guestFactory(server);
    const delegation = await issueDelegation(owner, {
      aud: guest.did(),
      sub: space as DIDKey,
      cmd: "/memory",
      pol: [],
    });
    const forged = delegation.bytes.slice();
    forged[10] ^= 0xff;
    await expect(factory.addDelegationChain([forged])).rejects.toThrow(
      "does not verify",
    );
  });

  describe("a chain of two over a space that owns itself", () => {
    /**
     * A server, a space on it that owns itself and grants nobody else, the
     * delegation it issued to the owner, and the delegation the owner issues
     * to the guest over it with `guestFields` beside the audience and
     * subject.
     */
    const selfOwnedSpaceDelegatedToGuest = async (
      guestFields: { exp?: number | null; nbf?: number } = {},
    ) => {
      const server = StandaloneMemoryServer.start({
        acl: { mode: "enforce", delegations: true },
      });
      cleanups.push(() => server.close());
      const ownerManager = StorageManager.open({
        as: owner,
        memoryHost: server.url,
      });
      cleanups.push(() => ownerManager.close());
      const { space, delegation: root } = await ownerManager
        .createSelfOwnedSpace({ delegateTo: owner.did() });
      const toGuest = await issueDelegation(owner, {
        aud: guest.did(),
        sub: space as DIDKey,
        cmd: "/memory",
        pol: [],
        ...guestFields,
      });
      return { server, space, chain: [root, toGuest.bytes] };
    };

    const aclOf = async (
      server: StandaloneMemoryServer,
      space: string,
    ): Promise<unknown> =>
      (await server.server.readDocument(space, aclDocId(space)))?.value;

    it("lets the guest act as the space's OWNER through the owner's delegation behind the space's own", async () => {
      const { server, space, chain } = await selfOwnedSpaceDelegatedToGuest();
      const factory = guestFactory(server);
      await factory.addDelegationChain(chain);
      const { client, session } = await factory.create(space);
      cleanups.push(() => client.close());
      // Replacing the access list is an OWNER's act, and the list grants
      // the guest nothing: the capability is the chain's root's.
      const replaced = await session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: aclDocId(space),
          value: { value: { [space]: "OWNER", [guest.did()]: "READ" } },
        }],
      });
      expect(replaced.seq).toBeGreaterThan(0);
      expect(await aclOf(server, space)).toEqual({
        [space]: "OWNER",
        [guest.did()]: "READ",
      });
    });

    it("reports the chain it holds for the space as the guest, and nothing for another space or before holding one", async () => {
      const { server, space, chain } = await selfOwnedSpaceDelegatedToGuest();
      const factory = guestFactory(server);
      expect(factory.delegationChainFor(space, guest.did())).toBeUndefined();
      await factory.addDelegationChain(chain);
      expect(factory.delegationChainFor(space, guest.did())).toEqual(chain);
      expect(factory.delegationChainFor(space, owner.did())).toBeUndefined();
      expect(factory.delegationChainFor(owner.did(), guest.did()))
        .toBeUndefined();
    });

    it("lets the guest delegate onward by extending the chain it holds, so a third key opens the space under the same root", async () => {
      const { server, space, chain } = await selfOwnedSpaceDelegatedToGuest();
      const third = await Identity.fromPassphrase("delegation-chain third");
      const guestFactoryHolding = guestFactory(server);
      await guestFactoryHolding.addDelegationChain(chain);
      const held = guestFactoryHolding.delegationChainFor(space, guest.did())!;
      const onward = await issueDelegation(guest, {
        aud: third.did(),
        sub: space as DIDKey,
        cmd: "/memory",
        pol: [],
      });
      const thirdFactory = new RemoteSessionFactory(
        createStorageAddressResolver(server.url),
        third,
      );
      cleanups.push(() => thirdFactory.close());
      // The delegation alone, which drops the proof the guest itself
      // needs, opens nothing; behind the held chain it opens the space.
      await thirdFactory.addDelegationChain([onward.bytes]);
      await expect(thirdFactory.create(space)).rejects.toThrow("lacks READ");
      await thirdFactory.addDelegationChain([...held, onward.bytes]);
      const { client, session } = await thirdFactory.create(space);
      cleanups.push(() => client.close());
      expect((await write(session, 1)).seq).toBeGreaterThan(0);
    });

    it("is refused the space with the owner's delegation alone, which ends at the owner rather than the guest", async () => {
      const { server, space, chain } = await selfOwnedSpaceDelegatedToGuest();
      const factory = guestFactory(server);
      await factory.addDelegationChain([chain[0]]);
      await expect(factory.create(space)).rejects.toThrow("lacks READ");
    });

    it("presents nothing once the owner's delegation to the guest has expired, and is refused", async () => {
      const { server, space, chain } = await selfOwnedSpaceDelegatedToGuest({
        exp: Math.floor(Date.now() / 1000) - 1,
      });
      const factory = guestFactory(server);
      await factory.addDelegationChain(chain);
      await expect(factory.create(space)).rejects.toThrow("lacks READ");
    });
  });
});
