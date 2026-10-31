import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import {
  createInviteCredentials,
  inviteCodeVerifier,
  SpaceInviteClient,
  SpaceInviteCreateError,
  SpaceInviteError,
} from "../src/space-invites.ts";
import { verifyFirstPartyHttpRequest } from "../src/toolshed-http-auth.ts";

describe("space-invites", () => {
  it("rejects an array error body even when its prototype supplies a code", async () => {
    const signer = await Identity.generate();
    const body = Object.setPrototypeOf([], { code: "not-owner" });
    const response = new Response(null, { status: 500 });
    response.json = () => Promise.resolve(body);
    const client = new SpaceInviteClient({
      host: "https://example.com",
      space: signer.did(),
      signer,
      fetch: () => Promise.resolve(response),
    });
    await expect(client.list()).rejects.toEqual(
      new SpaceInviteError("service-error"),
    );
  });
  it("retains generated credentials for an exact retry after a lost create response", async () => {
    const signer = await Identity.generate();
    const requests: Record<string, unknown>[] = [];
    const client = new SpaceInviteClient({
      host: "https://example.com",
      space: signer.did(),
      signer,
      fetch: async (input, init) => {
        const body = await new Request(input, init).json();
        requests.push(body);
        if (requests.length === 1) throw new TypeError("connection closed");
        return Response.json({ inviteId: body.inviteId, remainingUses: 3 });
      },
    });
    let failure: unknown;
    try {
      await client.create({ access: "WRITE", ttlSeconds: 120, maxUses: 3 });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SpaceInviteCreateError);
    if (!(failure instanceof SpaceInviteCreateError)) throw failure;
    expect(failure.code).toBe("create-outcome-unknown");
    const retry = failure.retry;
    expect(retry).toMatchObject({
      access: "WRITE",
      ttlSeconds: 120,
      maxUses: 3,
    });
    expect(
      inviteCodeVerifier({
        host: "https://example.com",
        space: signer.did(),
        ...retry,
      }),
    ).toBe(requests[0]?.codeVerifier);
    expect(JSON.stringify(failure)).not.toContain(retry.code);
    expect(Deno.inspect(failure)).not.toContain(retry.code);
    expect(Object.keys(failure)).toEqual([]);
    const result = await client.create(retry);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(result.code).toBe(retry.code);
    expect(result.inviteId).toBe(retry.inviteId);
  });
  it("retains supplied credentials and refusal codes without enumerating secrets", async () => {
    const signer = await Identity.generate();
    const credentials = createInviteCredentials();
    const options = { ...credentials, access: "READ" as const, ttlSeconds: 60 };
    const client = new SpaceInviteClient({
      host: "https://example.com",
      space: signer.did(),
      signer,
      fetch: () =>
        Promise.resolve(Response.json({ code: "not-owner" }, { status: 403 })),
    });
    let failure: unknown;
    try {
      await client.create(options);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SpaceInviteCreateError);
    if (!(failure instanceof SpaceInviteCreateError)) throw failure;
    expect(failure.code).toBe("not-owner");
    expect(failure.retry).toEqual(options);
    expect(Object.isFrozen(failure.retry)).toBe(true);
    options.code = createInviteCredentials().code;
    expect(failure.retry.code).toBe(credentials.code);
    expect(JSON.stringify(failure)).not.toContain(credentials.code);
    expect(Deno.inspect(failure)).not.toContain(credentials.code);
  });
  it("refuses incomplete creation credentials before sending", async () => {
    const signer = await Identity.generate();
    let requests = 0;
    const client = new SpaceInviteClient({
      host: "https://example.com",
      space: signer.did(),
      signer,
      fetch: () => {
        requests++;
        return Promise.resolve(Response.json({}));
      },
    });
    const credentials = createInviteCredentials();
    for (
      const partial of [
        { inviteId: credentials.inviteId },
        { code: credentials.code },
      ]
    ) {
      await expect(
        client.create({ ...partial, access: "READ", ttlSeconds: 60 }),
      )
        .rejects.toThrow("invalid-request");
    }
    expect(requests).toBe(0);
  });
  it("reports malformed service errors as uncertainty without reflecting response bodies", async () => {
    const signer = await Identity.generate();
    for (
      const body of [
        "private upstream diagnostic",
        JSON.stringify({ code: 17 }),
        "null",
        "17",
        "false",
        "[]",
      ]
    ) {
      const client = new SpaceInviteClient({
        host: "https://example.com",
        space: signer.did(),
        signer,
        fetch: () => Promise.resolve(new Response(body, { status: 500 })),
      });
      await expect(client.list()).rejects.toEqual(
        new SpaceInviteError("service-error"),
      );
    }
  });
  it("signs the exact credential body and preserves supplied creation credentials", async () => {
    const signer = await Identity.generate();
    const credentials = createInviteCredentials();
    let body: Record<string, unknown> | undefined;
    const client = new SpaceInviteClient({
      host: "https://example.com",
      space: signer.did(),
      signer,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect((await verifyFirstPartyHttpRequest({ request })).userDid).toBe(
          signer.did(),
        );
        expect(init?.redirect).toBe("error");
        body = await request.json();
        return Response.json({
          inviteId: credentials.inviteId,
          remainingUses: 1,
        });
      },
    });
    const result = await client.create({
      ...credentials,
      access: "READ",
      ttlSeconds: 60,
    });
    expect(result.code).toBe(credentials.code);
    expect(body).toMatchObject({
      inviteId: credentials.inviteId,
      access: "READ",
      ttlSeconds: 60,
    });
    expect(body).not.toHaveProperty("code");
    expect(body).not.toHaveProperty("did");
  });
  it("distinguishes unsupported services, structured refusals, and uncertain network results", async () => {
    const signer = await Identity.generate();
    for (
      const [status, code] of [[404, "invite-service-unsupported"], [
        409,
        "invite-unavailable",
      ]] as const
    ) {
      const client = new SpaceInviteClient({
        host: "https://example.com",
        space: signer.did(),
        signer,
        fetch: () => Promise.resolve(Response.json({ code }, { status })),
      });
      await expect(client.list()).rejects.toThrow(code);
    }
    const failure = new TypeError("network disconnected");
    const client = new SpaceInviteClient({
      host: "https://example.com",
      space: signer.did(),
      signer,
      fetch: () => Promise.reject(failure),
    });
    await expect(client.list()).rejects.toBe(failure);
  });
  describe("on a memory session", () => {
    /** An error shaped as the memory client raises an invitation refusal. */
    const refusal = (code: string) =>
      Object.assign(new Error(`refused: ${code}`), {
        name: "SpaceInviteRefusal",
        code,
      });

    /** A client whose session answers with `answer` and whose HTTP records. */
    const clientWith = async (
      answer: () => Promise<unknown>,
    ) => {
      const signer = await Identity.generate();
      const sent: unknown[] = [];
      const posted: string[] = [];
      const client = new SpaceInviteClient({
        host: "https://example.com",
        space: signer.did(),
        signer,
        fetch: (input) => {
          posted.push(new URL(String(input)).pathname.split("/").at(-1)!);
          return Promise.resolve(Response.json([]));
        },
        session: (invite) => {
          sent.push(invite);
          return answer() as never;
        },
      });
      return { client, sent, posted };
    };

    it("sends administration on the session and makes no HTTP request for it", async () => {
      const { client, sent, posted } = await clientWith(() =>
        Promise.resolve({ revoked: true })
      );

      expect(await client.revoke("a".repeat(22))).toEqual({ revoked: true });
      expect(sent).toEqual([{
        operation: "revoke",
        body: { inviteId: "a".repeat(22) },
      }]);
      expect(posted).toEqual([]);
    });

    it("posts over HTTP when the session's server does not administer invitations", async () => {
      const { client, posted } = await clientWith(() =>
        Promise.reject(refusal("invite-service-unsupported"))
      );

      expect(await client.list()).toEqual([]);
      expect(posted).toEqual(["list"]);
    });

    it("throws the service's refusal with its code", async () => {
      const { client, posted } = await clientWith(() =>
        Promise.reject(refusal("not-owner"))
      );

      await expect(client.list()).rejects.toEqual(
        new SpaceInviteError("not-owner"),
      );
      expect(posted).toEqual([]);
    });

    it("redeems over HTTP whatever session it was given", async () => {
      const { client, sent, posted } = await clientWith(() =>
        Promise.resolve({})
      );

      await client.redeem({ inviteId: "a".repeat(22), code: "b".repeat(43) });
      expect(sent).toEqual([]);
      expect(posted).toEqual(["redeem"]);
    });
  });
});
