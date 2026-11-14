import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { Runtime } from "@commonfabric/runner";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import { createRouter, createTestApp } from "@/lib/create-app.ts";
import {
  createAclServer,
  genesisAcl,
  LoopbackSessionFactory,
  TestStorageManager,
} from "@/test/support/memory-acl.ts";
import { getRegistration } from "@/routes/ingest/ingest.utils.ts";
import {
  createIngestChannelHandlers,
  createIngestChannelsRouter,
  type IngestChannelHandlerDeps,
} from "./ingest-channels.handlers.ts";
import * as routes from "./ingest-channels.routes.ts";

const operator = await Identity.fromPassphrase("ich-operator");
const alice = await Identity.fromPassphrase("ich-alice");
const spaceIdentity = await Identity.fromPassphrase("ich-space");
const space = spaceIdentity.did();

describe("ingest-channels.handlers", () => {
  // The authorization contract is the utils module's, tested against an
  // ACL-enforcing memory server in ingest-channels.utils.test.ts. These pin
  // what the handlers add: the verified caller and the space in the path
  // reaching the call, and its result reaching the wire.

  let server: MemoryV2Server.Server;
  let storageManager: TestStorageManager;
  let runtime: Runtime;
  let deps: IngestChannelHandlerDeps;
  let client = 0;

  beforeEach(async () => {
    server = createAclServer(`ingest-channels-handlers-${crypto.randomUUID()}`);
    const factory = new LoopbackSessionFactory(server);
    storageManager = TestStorageManager.overServer({ as: operator }, factory);
    runtime = new Runtime({
      apiUrl: new URL("https://ich-test.invalid"),
      storageManager,
    });
    deps = {
      runtime: () => runtime,
      serviceSpace: operator.did(),
      operatorDid: operator.did(),
      serviceDids: [],
      hostsSpace: () => true,
      apiUrl: "https://ich-test.invalid",
    };
    await genesisAcl(factory, spaceIdentity, {
      [alice.did()]: "OWNER",
      [operator.did()]: "WRITE",
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  /** Sends `payload` to `path`, signed by `signer`, through `app`. */
  const signed = async (
    app: ReturnType<typeof createTestApp>,
    path: string,
    payload: unknown,
    signer: Identity = alice,
  ) => {
    const url = new URL(path, "http://localhost");
    const body = JSON.stringify(payload);
    const headers = await signFirstPartyHttpRequest({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // A client of its own per request, so no case drains another's
        // rate-limit bucket.
        "X-Forwarded-For": `10.1.0.${++client}`,
      },
      body,
      signer,
    });
    return await app.request(url.toString(), { method: "POST", headers, body });
  };

  const spaceVerb = (verb: string) =>
    `${routes.SPACE_BASE.replace(":space", space)}/${verb}`;

  it("mints, lists, rotates and revokes a channel for the caller", async () => {
    const app = createTestApp(createIngestChannelsRouter(deps));

    const minted = await signed(app, spaceVerb("mint"), {
      installId: "phone-1",
      requestId: crypto.randomUUID(),
    });
    expect(minted.status).toBe(200);
    const { id, token } = await minted.json();
    expect(token).toMatch(/^ingsec_/);
    expect((await getRegistration(runtime, operator.did(), id))?.owner).toBe(
      alice.did(),
    );

    const listed = await signed(app, spaceVerb("list"), {});
    expect(listed.status).toBe(200);
    expect((await listed.json()).channels.map((c: { id: string }) => c.id))
      .toEqual([id]);

    const own = await signed(app, `${routes.CALLER_BASE}/list`, {});
    expect(own.status).toBe(200);
    expect((await own.json()).channels.map((c: { id: string }) => c.id))
      .toEqual([id]);

    const rotated = await signed(app, spaceVerb("rotate"), {
      id,
      requestId: crypto.randomUUID(),
    });
    expect(rotated.status).toBe(200);
    const { token: rotatedToken } = await rotated.json();
    expect(rotatedToken).toMatch(/^ingsec_/);
    expect(rotatedToken).not.toBe(token);

    const revision = (await getRegistration(runtime, operator.did(), id))
      ?.revision;
    const revoked = await signed(app, spaceVerb("revoke"), {
      id,
      requestId: crypto.randomUUID(),
      expectedRevision: revision,
    });
    expect(revoked.status).toBe(200);
    expect((await getRegistration(runtime, operator.did(), id))?.revoked?.by)
      .toBe(alice.did());
  });

  it("returns the refusal for a caller who does not own the space, minting nothing", async () => {
    const app = createTestApp(createIngestChannelsRouter(deps));
    const mallory = await Identity.fromPassphrase("ich-mallory");
    const res = await signed(app, spaceVerb("mint"), {
      installId: "phone-1",
      requestId: crypto.randomUUID(),
    }, mallory);
    expect(res.status).toBe(403);
    const own = await signed(app, `${routes.CALLER_BASE}/list`, {}, mallory);
    expect(await own.json()).toEqual({ channels: [] });
  });

  it("returns 401 from every handler that runs without a verified caller", async () => {
    // Mounted without the auth middleware, so no verified DID reaches them.

    const handlers = createIngestChannelHandlers(deps);
    const app = createTestApp(
      createRouter()
        .openapi(routes.mint, handlers.mint)
        .openapi(routes.list, handlers.list)
        .openapi(routes.listOwn, handlers.listOwn)
        .openapi(routes.rotate, handlers.rotate)
        .openapi(routes.revoke, handlers.revoke),
    );
    const post = (path: string, payload: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    const requestId = crypto.randomUUID();
    const responses = await Promise.all([
      post(spaceVerb("mint"), { installId: "phone-1", requestId }),
      post(spaceVerb("list"), {}),
      post(`${routes.CALLER_BASE}/list`, {}),
      post(spaceVerb("rotate"), { id: "ing_x", requestId }),
      post(spaceVerb("revoke"), {
        id: "ing_x",
        requestId,
        expectedRevision: 1,
      }),
    ]);
    expect(responses.map((res) => res.status)).toEqual([
      401,
      401,
      401,
      401,
      401,
    ]);
  });
});
