import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  createInviteCredentials,
  inviteCodeVerifier,
} from "@commonfabric/memory/space-invites";
import * as Engine from "@commonfabric/memory/v2/engine";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";

import {
  createStorageAddressResolver,
  RemoteSessionFactory,
} from "../src/storage/v2-remote-session.ts";

const INVITE_HOST = "https://invites.example";

describe("RemoteSessionFactory.redeemInvite()", () => {
  // Every open here is signed, as on a deployment whose memory server
  // authenticates no connection.

  let server: StandaloneMemoryServer;
  let owner: Identity;
  let guest: Identity;
  let space: MemorySpace;
  let factory: RemoteSessionFactory;

  beforeEach(async () => {
    server = StandaloneMemoryServer.start({
      acl: { mode: "enforce" },
      inviteHost: INVITE_HOST,
    });
    owner = await Identity.generate();
    guest = await Identity.generate();
    space = owner.did() as MemorySpace;
    factory = new RemoteSessionFactory(
      createStorageAddressResolver(server.url),
      guest,
    );
    Engine.applyCommit(await server.server.engineForSpace(space), {
      space,
      sessionId: "acl-seed",
      commitClass: "system",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: aclDocId(space),
          value: { value: { [owner.did()]: "OWNER" } },
        }],
      },
    });
  });

  afterEach(async () => {
    await factory.close();
    await server.close();
  });

  /** Issues a READ invitation from the owner, and returns its credentials. */
  const issue = async (): Promise<{ inviteId: string; code: string }> => {
    const credentials = createInviteCredentials();
    await server.server.invite({
      operation: "create",
      body: {
        inviteId: credentials.inviteId,
        codeVerifier: inviteCodeVerifier({
          host: INVITE_HOST,
          space,
          ...credentials,
        }),
        access: "READ",
        ttlSeconds: 60,
      },
      host: INVITE_HOST,
      space,
      principal: owner.did(),
      now: Date.now(),
    });
    return credentials;
  };

  it("returns the receipt, grants the invitation's access, and leaves no socket open", async () => {
    const invite = await issue();

    const receipt = await factory.redeemInvite(space, invite);
    const acl = await server.server.readDocument(space, aclDocId(space));

    expect(receipt).toEqual({
      outcome: "redeemed",
      redemption: { inviteId: invite.inviteId, did: guest.did() },
      currentAccess: "READ",
    });
    expect(acl?.value).toEqual({
      [owner.did()]: "OWNER",
      [guest.did()]: "READ",
    });
    expect(factory.getSizes().socketsOpen).toBe(0);
  });

  it("throws the service's refusal for a wrong code, and grants nothing", async () => {
    const { inviteId } = await issue();

    const failure = await factory.redeemInvite(space, {
      inviteId,
      code: createInviteCredentials().code,
    }).then(() => undefined, (error: unknown) => error as Error);
    const acl = await server.server.readDocument(space, aclDocId(space));

    expect(failure?.name).toBe("SpaceInviteRefusal");
    expect(acl?.value).toEqual({ [owner.did()]: "OWNER" });
  });
});
