import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import {
  createInviteCredentials,
  SpaceInviteClient,
  SpaceInviteError,
} from "../src/space-invites.ts";
import { verifyFirstPartyHttpRequest } from "../src/toolshed-http-auth.ts";

describe("space-invites", () => {
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
});
