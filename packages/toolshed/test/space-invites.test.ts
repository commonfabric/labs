import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { ensureDir } from "@std/fs";
import { dirname, fromFileUrl, toFileUrl } from "@std/path";

import { SqliteError } from "@db/sqlite";
import { pino } from "pino";

import { Identity } from "@commonfabric/identity";
import { hashOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { aclDocId } from "@commonfabric/memory/acl";
import { MEMORY_PROTOCOL } from "@commonfabric/memory/v2";
import { connect, loopback } from "@commonfabric/memory/v2/client";
import * as Engine from "@commonfabric/memory/v2/engine";
import { Server } from "@commonfabric/memory/v2/server";
import { verifySessionOpenAuthorization } from "@commonfabric/memory/v2/session-open-auth";
import { resolveSpaceStoreUrl } from "@commonfabric/memory/v2/storage-path";
import {
  createInviteCredentials,
  inviteCodeVerifier,
  SpaceInviteClient,
} from "@commonfabric/runner/space-invites";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import { createSpaceInviteRouter } from "@/routes/space-invites/router.ts";
import { createRouter, createTestApp } from "@/lib/create-app.ts";

async function fixture(publicHost?: string, captureErrors = true) {
  const directory = await Deno.makeTempDir();
  let closeEngine: (() => void) | undefined;
  let closeServer: (() => Promise<void>) | undefined;
  let closeHttp: (() => Promise<void>) | undefined;
  const close = async () => {
    try {
      await closeHttp?.();
    } finally {
      try {
        await closeServer?.();
      } finally {
        try {
          closeEngine?.();
        } finally {
          await Deno.remove(directory, { recursive: true });
        }
      }
    }
  };
  try {
    const store = toFileUrl(directory + "/");
    const space = (await Identity.generate({ implementation: "noble" })).did();
    const owner = await Identity.generate({ implementation: "noble" });
    const guest = await Identity.generate({ implementation: "noble" });
    const dbUrl = resolveSpaceStoreUrl(store, space);
    await ensureDir(dirname(fromFileUrl(dbUrl)));
    const engine = await Engine.open({ url: dbUrl });
    closeEngine = () => Engine.close(engine);
    Engine.applyCommit(engine, {
      space,
      sessionId: "seed",
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
    Engine.close(engine);
    closeEngine = undefined;
    const server = new Server({
      store,
      acl: { mode: "enforce" },
      authorizeSessionOpen: verifySessionOpenAuthorization,
      sessionOpenAuth: { audience: owner.did() },
      subscriptionRefreshDelayMs: 0,
    });
    closeServer = () => server.close();
    let now = Date.now();
    const router = createSpaceInviteRouter({
      server,
      now: () => now,
      host: publicHost,
    });
    const errors: Error[] = [];
    if (captureErrors) {
      router.onError((error, c) => {
        errors.push(error);
        return c.json({ code: "service-error" }, 500);
      });
    }
    const diagnostics: Record<string, unknown>[] = [];
    const logger = pino({ level: "error" }, {
      write(message) {
        diagnostics.push(JSON.parse(message));
      },
    });
    const mounted = createRouter();
    mounted.use("*", async (c, next) => {
      c.set("logger", logger);
      await next();
    });
    mounted.route("/", router);
    const app = captureErrors ? router : createTestApp(mounted);
    const http = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: () => {},
    }, (req) => app.fetch(req));
    closeHttp = () => http.shutdown();
    const host = `http://127.0.0.1:${http.addr.port}`;
    const client = (signer: Identity) =>
      new SpaceInviteClient({
        host: publicHost ?? host,
        space,
        signer,
        fetch: (input, init) =>
          fetch(new URL(new URL(String(input)).pathname, host), init),
      });
    const raw = async (
      operation: string,
      body: object,
      signer: Identity = owner,
      options: {
        age?: number;
        audience?: string;
        tamper?: boolean;
        forged?: boolean;
      } = {},
    ) => {
      const url = new URL(`/api/spaces/${space}/invites/${operation}`, host);
      const payload = JSON.stringify(body);
      const headers = await signFirstPartyHttpRequest({
        url: options.audience ? new URL(url.pathname, options.audience) : url,
        method: "POST",
        body: payload,
        signer,
        nowSeconds: Math.floor(now / 1000) + (options.age ?? 0),
      });
      if (options.forged) headers.set("CF-Request-Proof", "A".repeat(86));
      return await fetch(url, {
        method: "POST",
        headers,
        body: options.tamper ? payload + " " : payload,
      });
    };
    const memory = async (signer: Identity) => {
      const client = await connect({ transport: loopback(server) });
      try {
        const session = await client.mount(
          space,
          {},
          async (space, session, context) => {
            const invocation = {
              iss: signer.did(),
              sub: space,
              cmd: "session.open",
              args: { protocol: MEMORY_PROTOCOL, session },
              aud: context.audience,
              challenge: context.challenge.value,
              iat: Math.floor(Date.now() / 1000),
              exp: Math.floor(Date.now() / 1000) + 300,
            };
            const signature = await signer.sign(hashOf(invocation).bytes);
            if (signature.error) throw signature.error;
            return {
              invocation,
              authorization: { signature: new FabricBytes(signature.ok) },
            };
          },
        );
        return { client, session };
      } catch (error) {
        await client.close();
        throw error;
      }
    };
    return {
      directory,
      store,
      space,
      owner,
      guest,
      server,
      errors,
      diagnostics,
      host,
      client,
      raw,
      memory,
      advance(ms: number) {
        now += ms;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

describe("space-invites", () => {
  it("removes fixture storage when setup fails before listening", async () => {
    const directory = await Deno.makeTempDir();
    using _tempDirectory = stub(
      Deno,
      "makeTempDir",
      () => Promise.resolve(directory),
    );
    try {
      await expect(fixture("not an origin")).rejects.toThrow("invalid-host");
      await expect(Deno.stat(directory)).rejects.toBeInstanceOf(
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
  });
  it("rejects oversized bodies, invalid spaces, and signed malformed JSON before admission", async () => {
    const f = await fixture();
    try {
      for (
        const [space, body, status] of [
          [f.space, "x".repeat(4097), 413],
          ["not-a-did", "{}", 400],
          [f.space, "{", 400],
        ] as const
      ) {
        const url = new URL(`/api/spaces/${space}/invites/list`, f.host);
        const headers = await signFirstPartyHttpRequest({
          url,
          method: "POST",
          body,
          signer: f.owner,
        });
        const response = await fetch(url, { method: "POST", body, headers });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ code: "invalid-request" });
      }
      expect(await f.client(f.owner).list()).toEqual([]);
      expect(await f.client(f.owner).receipts()).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("returns the service error envelope with the production error boundary", async () => {
    const f = await fixture(undefined, false);
    try {
      await Deno.writeTextFile(
        resolveSpaceStoreUrl(f.store, f.space),
        "private storage failure",
      );
      const response = await f.raw("list", {});
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(await response.json()).toEqual({ code: "service-error" });
      expect(f.diagnostics).toHaveLength(1);
      expect(f.diagnostics[0]).toMatchObject({
        failureKind: "Error",
        operation: "list",
        msg: "Space invitation service failed",
      });
      expect(JSON.stringify(f.diagnostics)).not.toContain("private storage");
      expect(JSON.stringify(f.diagnostics)).not.toContain(f.directory);
    } finally {
      await f.close();
    }
  });
  it("classifies service failures without logging their private name, cause, or body", async () => {
    const f = await fixture(undefined, false);
    try {
      const credentials = createInviteCredentials();
      const privateValue = credentials.code;
      const error = new Error(privateValue, { cause: { code: privateValue } });
      error.name = privateValue;
      const failures = [
        error,
        new TypeError(privateValue),
        new SqliteError(1, privateValue),
        privateValue,
      ];
      using _failure = stub(f.server, "invite", () => {
        throw failures.shift();
      });
      for (
        const failureKind of ["unknown", "TypeError", "SqliteError", "unknown"]
      ) {
        const response = await f.raw("redeem", credentials);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ code: "service-error" });
        expect(f.diagnostics.at(-1)).toMatchObject({
          failureKind,
          operation: "redeem",
          msg: "Space invitation service failed",
        });
      }
      expect(f.diagnostics).toHaveLength(4);
      expect(JSON.stringify(f.diagnostics)).not.toContain(privateValue);
      expect(JSON.stringify(f.diagnostics)).not.toContain(credentials.inviteId);
      expect(f.diagnostics.every((row) => !("err" in row) && !("cause" in row)))
        .toBe(true);
    } finally {
      await f.close();
    }
  });
  it("redacts private storage failures at the HTTP boundary", async () => {
    const f = await fixture();
    try {
      await Deno.writeTextFile(
        resolveSpaceStoreUrl(f.store, f.space),
        "private storage diagnostic: invalid SQLite file",
      );
      const response = await f.raw("list", {});
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ code: "service-error" });
      expect(f.errors).toHaveLength(1);
      expect(f.errors[0]?.message).toBe("Space invitation service failed");
      expect(f.errors[0]?.cause).toBeUndefined();
      expect(JSON.stringify(f.errors)).not.toContain("private storage");
    } finally {
      await f.close();
    }
  });
  it("admits a persisted browser identity through HTTP before it has target READ", async () => {
    const f = await fixture();
    try {
      await expect(f.memory(f.guest)).rejects.toThrow();
      const invite = await f.client(f.owner).create({
        access: "READ",
        ttlSeconds: 60,
        maxUses: 2,
      });
      const receipt = await f.client(f.guest).redeem({
        inviteId: invite.inviteId,
        code: invite.code,
      });
      expect(receipt).toMatchObject({
        outcome: "redeemed",
        currentAccess: "READ",
        redemption: { did: f.guest.did() },
      });
      const { client, session } = await f.memory(f.guest);
      try {
        const write = session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:guest-write",
            value: { value: { no: true } },
          }],
        });
        await expect(write).rejects.toThrow("lacks WRITE");
      } finally {
        await client.close();
      }
      const imported = await Identity.fromPkcs8(f.guest.toPkcs8(), {
        implementation: "noble",
      });
      expect(
        (await f.client(imported).redeem({
          inviteId: invite.inviteId,
          code: invite.code,
        })).outcome,
      ).toBe("already-redeemed");
      expect(await f.client(f.owner).list()).toMatchObject([{
        usedCount: 1,
        remainingUses: 1,
      }]);
      const fresh = await Identity.generate({ implementation: "noble" });
      await f.client(fresh).redeem({
        inviteId: invite.inviteId,
        code: invite.code,
      });
      expect(await f.client(f.owner).list()).toEqual([]);
      expect(await f.client(f.owner).receipts(invite.inviteId)).toHaveLength(2);
    } finally {
      await f.close();
    }
  });
  it("refuses forged, stale, wrong-audience, tampered, and recipient-substitution requests", async () => {
    const f = await fixture();
    try {
      const invite = await f.client(f.owner).create({
        access: "WRITE",
        ttlSeconds: 60,
      });
      const body = { inviteId: invite.inviteId, code: invite.code };
      for (
        const options of [
          { age: -400 },
          { age: 100 },
          {
            audience: "https://other.example",
          },
          { tamper: true },
          { forged: true },
        ]
      ) {
        const response = await f.raw("redeem", body, f.guest, options);
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ code: "invalid-proof" });
      }
      const substituted = await f.raw(
        "redeem",
        { ...body, did: f.owner.did() },
        f.guest,
      );
      expect(substituted.status).toBe(400);
      await substituted.body?.cancel();
      const unsigned = await fetch(
        `${f.host}/api/spaces/${f.space}/invites/redeem`,
        { method: "POST", body: JSON.stringify(body) },
      );
      expect(unsigned.status).toBe(401);
      await unsigned.body?.cancel();
      expect(await f.client(f.owner).receipts()).toEqual([]);
      expect((await f.client(f.guest).redeem(body)).currentAccess).toBe(
        "WRITE",
      );
      const { client, session } = await f.memory(f.guest);
      try {
        const write = await session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:guest-write",
            value: { value: { yes: true } },
          }],
        });
        expect(write.seq).toBeGreaterThan(1);
      } finally {
        await client.close();
      }
    } finally {
      await f.close();
    }
  });
  it("does not recreate revoked admission when a still-fresh signed create proof is replayed", async () => {
    const f = await fixture();
    try {
      const credentials = createInviteCredentials();
      const body = {
        inviteId: credentials.inviteId,
        codeVerifier: inviteCodeVerifier({
          host: f.host,
          space: f.space,
          ...credentials,
        }),
        access: "READ",
        ttlSeconds: 60,
      };
      const url = new URL(`/api/spaces/${f.space}/invites/create`, f.host);
      const payload = JSON.stringify(body);
      const headers = await signFirstPartyHttpRequest({
        url,
        method: "POST",
        body: payload,
        signer: f.owner,
      });
      const first = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
      });
      expect(first.status).toBe(200);
      await first.body?.cancel();
      await f.client(f.owner).revoke(credentials.inviteId);
      const replay = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
      });
      expect(replay.status).toBe(409);
      expect(await replay.json()).toEqual({ code: "invite-id-unavailable" });
      f.advance(362000);
      const stale = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
      });
      expect(stale.status).toBe(401);
      await stale.body?.cancel();
      expect(
        await f.server.invite({
          host: f.host,
          space: f.space,
          principal: f.owner.did(),
          now: Date.now() + 362000,
          operation: "list",
          body: {},
        }),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("publishes capability and allows signed requests from an independent shell origin", async () => {
    const f = await fixture();
    try {
      const capability = await fetch(`${f.host}/api/space-invites`, {
        headers: { Origin: "https://shell.example" },
      });
      expect(capability.headers.get("access-control-allow-origin")).toBe("*");
      expect(await capability.json()).toEqual({
        version: 1,
        maxUses: 1000,
        maxTtlSeconds: 2592000,
      });
      const preflight = await fetch(
        `${f.host}/api/spaces/${f.space}/invites/redeem`,
        {
          method: "OPTIONS",
          headers: {
            Origin: "https://shell.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers":
              "content-type,cf-user-did,cf-request-auth,cf-request-proof,cf-request-body-sha256",
          },
        },
      );
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
      expect(preflight.headers.get("access-control-allow-methods")).toContain(
        "POST",
      );
      expect(
        preflight.headers.get("access-control-allow-headers")?.toLowerCase(),
      ).toContain("cf-request-proof");
      expect(preflight.headers.has("access-control-allow-credentials")).toBe(
        false,
      );
      await preflight.body?.cancel();
    } finally {
      await f.close();
    }
  });
  it("pins proof and verifier audiences to the configured public origin behind a proxy", async () => {
    const f = await fixture("https://public.example");
    try {
      const invite = await f.client(f.owner).create({
        access: "READ",
        ttlSeconds: 60,
      });
      expect(
        (await f.client(f.guest).redeem({
          inviteId: invite.inviteId,
          code: invite.code,
        })).outcome,
      ).toBe("redeemed");
      const wrong = await f.raw("list", {}, f.owner);
      expect(wrong.status).toBe(401);
      await wrong.body?.cancel();
    } finally {
      await f.close();
    }
  });
  it("invalidates live capability caches on upgrades and never restores removed access", async () => {
    const f = await fixture();
    try {
      const read = await f.client(f.owner).create({
        access: "READ",
        ttlSeconds: 60,
      });
      await f.client(f.guest).redeem({
        inviteId: read.inviteId,
        code: read.code,
      });
      const guest = await f.memory(f.guest);
      const owner = await f.memory(f.owner);
      try {
        const aclWatch = await owner.session.watchSet([{
          id: "acl",
          kind: "query",
          query: {
            roots: [{
              id: aclDocId(f.space),
              selector: { path: [], schema: true },
            }],
          },
        }]);
        await expect(
          guest.session.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:denied",
              value: { value: true },
            }],
          }),
        ).rejects.toThrow("lacks WRITE");
        const write = await f.client(f.owner).create({
          access: "WRITE",
          ttlSeconds: 60,
        });
        await f.client(f.guest).redeem({
          inviteId: write.inviteId,
          code: write.code,
        });
        await f.server.flushSessions();
        expect(aclWatch.entities[0]?.document?.value).toMatchObject({
          [f.guest.did()]: "WRITE",
        });
        expect(
          (await guest.session.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:permitted",
              value: { value: true },
            }],
          })).seq,
        ).toBeGreaterThan(1);
        await owner.session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: aclDocId(f.space),
            value: { value: { [f.owner.did()]: "OWNER" } },
          }],
        });
        expect(
          await f.client(f.guest).redeem({
            inviteId: write.inviteId,
            code: write.code,
          }),
        ).toMatchObject({ outcome: "already-redeemed", currentAccess: null });
        expect(guest.session.closeError?.name).toBe("AuthorizationError");
        await expect(f.memory(f.guest)).rejects.toThrow();
      } finally {
        await guest.client.close();
        await owner.client.close();
      }
    } finally {
      await f.close();
    }
  });
});
