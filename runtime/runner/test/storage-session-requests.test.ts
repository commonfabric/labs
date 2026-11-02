/**
 * A storage manager sending the requests that act on a space through its
 * memory session there, over a real standalone server: a pattern-lifecycle
 * verb, an invitation's administration, and its redemption on a session's
 * open.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  createInviteCredentials,
  inviteCodeVerifier,
  type InviteMetadata,
} from "@commonfabric/memory/space-invites";
import * as Engine from "@commonfabric/memory/v2/engine";
import type { PatternLifecycleCall } from "@commonfabric/memory/v2/server";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";

import { StorageManager } from "../src/storage/v2.ts";

const INVITE_HOST = "https://invites.example";

describe("storage-session-requests", () => {
  let server: StandaloneMemoryServer;
  let owner: Identity;
  let space: MemorySpace;
  let cleanups: (() => Promise<void>)[];

  beforeEach(async () => {
    cleanups = [];
    server = StandaloneMemoryServer.start({
      acl: { mode: "enforce" },
      inviteHost: INVITE_HOST,
    });
    cleanups.push(() => server.close());
    owner = await Identity.generate();
    space = owner.did() as MemorySpace;
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
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  const managerAs = (as: Identity) => {
    const manager = StorageManager.open({ as, memoryHost: server.url });
    cleanups.push(() => manager.close());
    return manager;
  };

  it("runs a pattern-lifecycle verb as the manager's principal and returns its receipt", async () => {
    const calls: PatternLifecycleCall[] = [];
    server.server.setPatternLifecycleHandler((call) => {
      calls.push(call);
      return Promise.resolve({ ok: { pattern: "receipt" } });
    });

    const receipt = await managerAs(owner).runPatternLifecycle(
      space,
      "upload",
      { program: { main: "/main.tsx" } },
    );

    expect(receipt).toEqual({ pattern: "receipt" });
    expect(calls).toEqual([{
      space,
      principal: owner.did(),
      verb: "upload",
      body: { program: { main: "/main.tsx" } },
    }]);
  });

  it("administers the space's invitations, and redeems one for a principal the access list does not name", async () => {
    const guest = await Identity.generate();
    const { inviteId, code } = createInviteCredentials();

    const created = await managerAs(owner).administerInvites(space, {
      operation: "create",
      body: {
        inviteId,
        codeVerifier: inviteCodeVerifier({
          host: INVITE_HOST,
          space,
          inviteId,
          code,
        }),
        access: "WRITE",
        ttlSeconds: 60,
      },
    }) as InviteMetadata;
    const receipt = await managerAs(guest).redeemInvite(space, {
      inviteId,
      code,
    });

    expect(created).toMatchObject({ inviteId, issuedBy: owner.did() });
    expect(receipt).toMatchObject({
      outcome: "redeemed",
      currentAccess: "WRITE",
    });
    expect(
      (await server.server.readDocument(space, aclDocId(space)))?.value,
    ).toEqual({ [owner.did()]: "OWNER", [guest.did()]: "WRITE" });
  });
});
