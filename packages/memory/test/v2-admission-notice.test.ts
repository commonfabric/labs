/**
 * The `session/admissible` notice, from the server's record of a refusal to
 * the client's observer: which access-list changes send one, to which
 * connection, and how often. Each case drives the server through real
 * clients over loopback, and reads an absence only after
 * `Client.delivered()`, since the server sends a notice while it admits the
 * access-list commit, before it answers the commit's writer.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import {
  createInviteCredentials,
  inviteCodeVerifier,
} from "../space-invites.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ServerMessage,
  type SessionOpenAuthMetadata,
} from "../v2.ts";
import {
  type Client,
  connect,
  loopback,
  type SessionOpenAuthFactory,
  type SpaceSession,
} from "../v2/client.ts";
import { Server } from "../v2/server.ts";

const OWNER = "did:key:z6Mk-admission-notice-owner";
const GUEST = "did:key:z6Mk-admission-notice-guest";
const CAROL = "did:key:z6Mk-admission-notice-carol";
const SPACE = OWNER;
const AUDIENCE = "did:key:z6Mk-admission-notice-audience";

/** Opens a session as `principal`, which the test server trusts as given. */
const authAs = (principal: string): SessionOpenAuthFactory =>
(
  _space,
  _session,
  context,
) => ({
  invocation: { aud: context.audience, challenge: context.challenge.value },
  authorization: { principal },
});

type Notice = { space: string; principal: string };

describe("session/admissible", () => {
  let server: Server;
  let owner: SpaceSession;
  let clients: Client[];
  let seq: number;
  let serverCount = 0;

  /** Connects a client, recording every notice it is sent. */
  const connectRecording = async (): Promise<{
    client: Client;
    notices: Notice[];
  }> => {
    const client = await connect({ transport: loopback(server) });
    clients.push(client);
    const notices: Notice[] = [];
    client.subscribeAdmissible((space, principal) =>
      notices.push({ space, principal })
    );
    return { client, notices };
  };

  /** Replaces the space's access list with OWNER plus `grants`. */
  const setAcl = async (grants: Record<string, string>): Promise<void> => {
    await owner.transact({
      localSeq: ++seq,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${SPACE}`,
        value: { value: { [OWNER]: "OWNER", ...grants } },
      }],
    });
  };

  /** Mounts the space as `principal`, expecting the server to refuse it. */
  const expectRefused = async (
    client: Client,
    principal: string,
  ): Promise<void> => {
    await expect(client.mount(SPACE, {}, authAs(principal))).rejects
      .toMatchObject({ name: "AuthorizationError" });
  };

  beforeEach(async () => {
    seq = 0;
    clients = [];
    server = new Server({
      store: new URL(`memory://admission-notice-${++serverCount}`),
      sessionOpenAuth: { audience: AUDIENCE },
      authorizeSessionOpen: (message) =>
        (message.authorization as { principal: string }).principal,
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
    });
    const ownerClient = await connect({ transport: loopback(server) });
    clients.push(ownerClient);
    owner = await ownerClient.mount(SPACE, {}, authAs(OWNER));
    await setAcl({});
  });

  afterEach(async () => {
    for (const client of clients) await client.close();
    await server.close();
  });

  it("is advertised as `admissionNotice`", async () => {
    const { client } = await connectRecording();
    expect(client.serverFlags?.admissionNotice).toBe(true);
  });

  it("reaches a connection refused the space once a grant gives its principal `READ`", async () => {
    const guest = await connectRecording();
    await expectRefused(guest.client, GUEST);

    await setAcl({ [GUEST]: "READ" });
    await guest.client.delivered();
    expect(guest.notices).toEqual([{ space: SPACE, principal: GUEST }]);
  });

  it("reaches the connection of a session revoked for want of `READ` once a later grant restores it", async () => {
    await setAcl({ [GUEST]: "READ" });
    const guest = await connectRecording();
    const session = await guest.client.mount(SPACE, {}, authAs(GUEST));

    await setAcl({});
    await guest.client.delivered();
    expect(session.closeError?.name).toBe("AuthorizationError");
    expect(guest.notices).toEqual([]);

    await setAcl({ [GUEST]: "WRITE" });
    await guest.client.delivered();
    expect(guest.notices).toEqual([{ space: SPACE, principal: GUEST }]);
  });

  it("reaches no connection but the admitted principal's", async () => {
    const guest = await connectRecording();
    const carol = await connectRecording();
    await expectRefused(guest.client, GUEST);
    await expectRefused(carol.client, CAROL);

    await setAcl({ [GUEST]: "READ" });
    await guest.client.delivered();
    await carol.client.delivered();
    expect(guest.notices).toEqual([{ space: SPACE, principal: GUEST }]);
    expect(carol.notices).toEqual([]);
  });

  it("is not sent for a change that leaves the principal without `READ`", async () => {
    const guest = await connectRecording();
    await expectRefused(guest.client, GUEST);

    await setAcl({ [CAROL]: "READ" });
    await guest.client.delivered();
    expect(guest.notices).toEqual([]);

    // The same connection is told once a change does admit its principal,
    // so the absence above is not a channel that delivers nothing.
    await setAcl({ [CAROL]: "READ", [GUEST]: "READ" });
    await guest.client.delivered();
    expect(guest.notices).toEqual([{ space: SPACE, principal: GUEST }]);
  });

  it("is sent once per refusal", async () => {
    const guest = await connectRecording();
    await expectRefused(guest.client, GUEST);
    await expectRefused(guest.client, GUEST);

    await setAcl({ [GUEST]: "READ" });
    await setAcl({ [GUEST]: "READ", [CAROL]: "READ" });
    await guest.client.delivered();
    expect(guest.notices).toEqual([{ space: SPACE, principal: GUEST }]);
  });

  it("reaches every observer after one that throws, and none that unsubscribed", async () => {
    const guest = await connectRecording();
    const thrower = Promise.withResolvers<void>();
    guest.client.subscribeAdmissible(() => {
      thrower.resolve();
      throw new Error("observer failure");
    });
    const after: Notice[] = [];
    guest.client.subscribeAdmissible((space, principal) =>
      after.push({ space, principal })
    );
    const gone: Notice[] = [];
    const unsubscribe = guest.client.subscribeAdmissible((space, principal) =>
      gone.push({ space, principal })
    );
    unsubscribe();
    await expectRefused(guest.client, GUEST);

    await setAcl({ [GUEST]: "READ" });
    await guest.client.delivered();
    await thrower.promise;
    expect(guest.notices).toEqual([{ space: SPACE, principal: GUEST }]);
    expect(after).toEqual([{ space: SPACE, principal: GUEST }]);
    expect(gone).toEqual([]);
  });

  it("reaches a connection refused the space once its principal redeems an invitation", async () => {
    // An invitation names a space and principals by their real DIDs.
    const inviter = (await Identity.generate()).did();
    const invitee = (await Identity.generate()).did();
    const ownerClient = await connectRecording();
    const inviterSession = await ownerClient.client.mount(
      inviter,
      {},
      authAs(inviter),
    );
    await inviterSession.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${inviter}`,
        value: { value: { [inviter]: "OWNER" } },
      }],
    });
    const guest = await connectRecording();
    await expect(guest.client.mount(inviter, {}, authAs(invitee))).rejects
      .toMatchObject({ name: "AuthorizationError" });
    const host = "https://invites.example";
    const now = Date.now();
    const { inviteId, code } = createInviteCredentials();
    await server.invite({
      operation: "create",
      body: {
        inviteId,
        codeVerifier: inviteCodeVerifier({
          host,
          space: inviter,
          inviteId,
          code,
        }),
        access: "READ",
        ttlSeconds: 60,
      },
      host,
      space: inviter,
      principal: inviter,
      now,
    });

    await server.invite({
      operation: "redeem",
      body: { inviteId, code },
      host,
      space: inviter,
      principal: invitee,
      now,
    });
    await guest.client.delivered();
    expect(guest.notices).toEqual([{ space: inviter, principal: invitee }]);
  });

  it("is not sent to a connection that did not advertise `admissionNotice`", async () => {
    // A hand-driven connection, since a client always advertises the
    // capability. A client connection refused alongside it is the control:
    // it is told, so the commit below did admit the principal.
    const guest = await connectRecording();
    await expectRefused(guest.client, GUEST);
    const messages: ServerMessage[] = [];
    const connection = server.connect((message) => messages.push(message));
    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: { ...getMemoryProtocolFlags(), admissionNotice: false },
    }));
    const hello = messages.shift();
    expect(hello?.type).toBe("hello.ok");
    const auth = (hello as { sessionOpen: SessionOpenAuthMetadata })
      .sessionOpen;
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open",
      space: SPACE,
      session: {},
      invocation: { aud: auth.audience, challenge: auth.challenge.value },
      authorization: { principal: GUEST },
    }));
    expect(messages.shift()).toMatchObject({
      type: "response",
      requestId: "open",
      error: { name: "AuthorizationError" },
    });

    await setAcl({ [GUEST]: "READ" });
    await guest.client.delivered();
    expect(guest.notices).toEqual([{ space: SPACE, principal: GUEST }]);
    expect(messages).toEqual([]);
    connection.close();
  });
});
