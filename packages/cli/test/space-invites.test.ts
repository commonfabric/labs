import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { buildSpaceInviteCommand } from "../commands/space-invites.ts";
import { parseInviteLink } from "@commonfabric/runner/space-invites";
import { verifyFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";

describe("space invite", () => {
  it("transports the requested invite operations and returns caller-only credentials", async () => {
    const signer = await Identity.fromPassphrase("invite CLI operations", {
      implementation: "noble",
    });
    const directory = await Deno.makeTempDir();
    const keyPath = `${directory}/identity.key`;
    const codePath = `${directory}/invite.code`;
    await Deno.writeFile(keyPath, signer.toPkcs8());
    const requests: { operation: string; body: Record<string, unknown> }[] = [];
    const outputs: string[] = [];
    using _output = stub(console, "log", (value: string) => {
      outputs.push(value);
    });
    using _http = stub(globalThis, "fetch", async (input, init) => {
      const request = new Request(input, init);
      expect((await verifyFirstPartyHttpRequest({ request })).userDid).toBe(
        signer.did(),
      );
      const body = await request.json();
      const operation = new URL(request.url).pathname.split("/").at(-1)!;
      expect(new URL(request.url).pathname).toContain(
        `/api/spaces/${encodeURIComponent(signer.did())}/invites/`,
      );
      requests.push({ operation, body });
      if (operation === "create") {
        return Response.json({
          inviteId: body.inviteId,
          access: body.access,
          maxUses: body.maxUses,
          issuedBy: signer.did(),
          createdAt: 1,
          expiresAt: 60001,
          usedCount: 0,
          remainingUses: body.maxUses,
        });
      }
      if (operation === "redeem") {
        return Response.json({
          outcome: "redeemed",
          redemption: { inviteId: body.inviteId, did: signer.did() },
          currentAccess: "READ",
        });
      }
      if (operation === "revoke") return Response.json({ revoked: true });
      return Response.json([]);
    });
    const run = async (...args: string[]) => {
      await buildSpaceInviteCommand().reset().throwErrors().parse([
        ...args,
        "--api-url",
        "https://fabric.example",
        "--space",
        signer.did(),
        "--identity",
        keyPath,
      ]);
      return JSON.parse(outputs.at(-1)!);
    };
    try {
      const first = await run(
        "create",
        "--access",
        "READ",
        "--ttl",
        "60",
        "--shell",
        "https://shell.example",
      );
      expect(requests.at(-1)).toMatchObject({
        operation: "create",
        body: { access: "READ", ttlSeconds: 60, maxUses: 1 },
      });
      expect(requests.at(-1)!.body).not.toHaveProperty("code");
      expect(parseInviteLink(first.link)).toEqual({
        host: "https://fabric.example",
        space: signer.did(),
        inviteId: first.inviteId,
        code: first.code,
      });
      const second = await run(
        "create",
        "--access",
        "WRITE",
        "--ttl",
        "90",
        "--max-uses",
        "3",
      );
      expect(second).toMatchObject({ access: "WRITE", maxUses: 3 });
      expect(second).not.toHaveProperty("link");
      expect(second.inviteId).not.toBe(first.inviteId);
      await Deno.writeTextFile(codePath, ` ${first.code}\n`);
      expect(await run("redeem", first.inviteId, "--code-file", codePath))
        .toMatchObject({ outcome: "redeemed", currentAccess: "READ" });
      expect(requests.at(-1)).toEqual({
        operation: "redeem",
        body: { inviteId: first.inviteId, code: first.code },
      });
      const original = Object.getOwnPropertyDescriptor(Deno.stdin, "readable");
      Object.defineProperty(Deno.stdin, "readable", {
        configurable: true,
        value: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(first.code + "\n"));
            controller.close();
          },
        }),
      });
      try {
        await run("redeem", first.inviteId, "--code-file", "-");
      } finally {
        if (original) Object.defineProperty(Deno.stdin, "readable", original);
        else Reflect.deleteProperty(Deno.stdin, "readable");
      }
      expect(requests.at(-1)).toEqual({
        operation: "redeem",
        body: { inviteId: first.inviteId, code: first.code },
      });
      expect(await run("list")).toEqual([]);
      expect(requests.at(-1)).toEqual({ operation: "list", body: {} });
      expect(await run("receipts")).toEqual([]);
      expect(requests.at(-1)).toEqual({ operation: "receipts", body: {} });
      await run("receipts", first.inviteId);
      expect(requests.at(-1)).toEqual({
        operation: "receipts",
        body: { inviteId: first.inviteId },
      });
      expect(await run("revoke", first.inviteId)).toEqual({ revoked: true });
      expect(requests.at(-1)).toEqual({
        operation: "revoke",
        body: { inviteId: first.inviteId },
      });
      expect(outputs).toHaveLength(8);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("refuses incomplete commands before making a request", async () => {
    using http = stub(
      globalThis,
      "fetch",
      () => Promise.reject(new Error("unexpected request")),
    );
    const common = [
      "--api-url",
      "https://fabric.example",
      "--space",
      "named-space",
      "--identity",
      "/not-needed.key",
    ];
    for (
      const [args, error] of [
        [
          ["create", "--access", "OWNER", "--ttl", "60"],
          "--access must be READ or WRITE",
        ],
        [["create", "--access", "READ"], "--ttl is required"],
        [["create", "--access", "READ", "--ttl", "60"], "explicit space DID"],
        [["redeem", "A".repeat(22)], "--code-file is required"],
      ] as const
    ) {
      await expect(
        buildSpaceInviteCommand().reset().throwErrors().parse([
          ...args,
          ...common,
        ]),
      ).rejects.toThrow(error);
    }
    expect(http.calls).toHaveLength(0);
  });

  it("validates the shell origin before creating an invitation", async () => {
    const signer = await Identity.fromPassphrase("invite CLI test", {
      implementation: "noble",
    });
    const keyPath = await Deno.makeTempFile();
    await Deno.writeFile(keyPath, signer.toPkcs8());
    using fetchStub = stub(
      globalThis,
      "fetch",
      (_request) =>
        Promise.resolve(Response.json({
          inviteId: "AAAAAAAAAAAAAAAAAAAAAA",
          code: "A".repeat(43),
        })),
    );
    try {
      await expect(
        buildSpaceInviteCommand().reset().throwErrors().parse([
          "create",
          "--api-url",
          "https://fabric.example",
          "--space",
          signer.did(),
          "--identity",
          keyPath,
          "--access",
          "READ",
          "--ttl",
          "60",
          "--shell",
          "https://shell.example/join",
        ]),
      ).rejects.toMatchObject({ code: "invalid-host" });
      expect(fetchStub.calls).toHaveLength(0);
    } finally {
      await Deno.remove(keyPath);
    }
  });
});
