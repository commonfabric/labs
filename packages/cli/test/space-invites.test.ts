import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { buildSpaceInviteCommand } from "../commands/space-invites.ts";
import {
  inviteCodeVerifier,
  parseInviteLink,
} from "@commonfabric/runner/space-invites";
import { verifyFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";

describe("space invite", () => {
  it("persists private creation credentials before HTTP and reuses them after a lost response", async () => {
    const signer = await Identity.fromPassphrase("durable invite CLI", {
      implementation: "noble",
    });
    const directory = await Deno.makeTempDir();
    const identity = `${directory}/identity.key`;
    await Deno.writeFile(identity, signer.toPkcs8());
    const getEnv = Deno.env.get.bind(Deno.env);
    using _state = stub(
      Deno.env,
      "get",
      (name) => name === "XDG_STATE_HOME" ? directory : getEnv(name),
    );
    const output: string[] = [];
    const messages: string[] = [];
    using _output = stub(console, "log", (value: string) => {
      output.push(value);
    });
    using _error = stub(console, "error", (value: string) => {
      messages.push(value);
    });
    const requests: Record<string, unknown>[] = [];
    let saved: Record<string, unknown> | undefined;
    let requestFile = "";
    let committed = 0;
    using _http = stub(globalThis, "fetch", async (input, init) => {
      const request = new Request(input, init);
      const body = await request.json();
      const entries = await Array.fromAsync(
        Deno.readDir(`${directory}/commonfabric/space-invites`),
      );
      expect(entries).toHaveLength(1);
      requestFile = `${directory}/commonfabric/space-invites/${
        entries[0]!.name
      }`;
      saved = JSON.parse(await Deno.readTextFile(requestFile));
      expect((await Deno.stat(requestFile)).mode! & 0o777).toBe(0o600);
      expect(
        (await Deno.stat(`${directory}/commonfabric/space-invites`)).mode! &
          0o777,
      ).toBe(0o700);
      expect(messages.join("\n")).toContain(requestFile);
      expect(body.inviteId).toBe(saved!.inviteId);
      expect(body.codeVerifier).toBe(
        inviteCodeVerifier(
          saved as {
            host: string;
            space: string;
            inviteId: string;
            code: string;
          },
        ),
      );
      if (requests.length === 0) committed++;
      else expect(body).toEqual(requests[0]);
      requests.push(body);
      if (requests.length === 1) {
        throw new TypeError("lost response after commit");
      }
      return Response.json({
        inviteId: body.inviteId,
        access: body.access,
        usedCount: 0,
        remainingUses: body.maxUses,
      });
    });
    const run = (...extra: string[]) =>
      buildSpaceInviteCommand().reset().throwErrors().parse([
        "create",
        "--access",
        "WRITE",
        "--ttl",
        "90",
        "--max-uses",
        "3",
        "--api-url",
        "https://fabric.example",
        "--space",
        signer.did(),
        "--identity",
        identity,
        ...extra,
      ]);
    try {
      await expect(run()).rejects.toThrow("create-outcome-unknown");
      expect(requests).toHaveLength(1);
      expect(saved).toMatchObject({
        version: 1,
        host: "https://fabric.example",
        space: signer.did(),
        issuer: signer.did(),
        access: "WRITE",
        ttlSeconds: 90,
        maxUses: 3,
      });
      const before = await Deno.readTextFile(requestFile);
      await run("--request-file", requestFile);
      expect(requests).toHaveLength(2);
      expect(committed).toBe(1);
      expect(await Deno.readTextFile(requestFile)).toBe(before);
      expect(JSON.parse(output[0]!)).toMatchObject({
        code: saved!.code,
        requestFile,
        remainingUses: 3,
      });
      expect(messages.join("\n")).not.toContain(saved!.code as string);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("refuses request file destination or term changes without sending or overwriting", async () => {
    const signer = await Identity.fromPassphrase("durable invite CLI", {
      implementation: "noble",
    });
    const directory = await Deno.makeTempDir();
    const identity = `${directory}/identity.key`;
    const requestFile = `${directory}/prepared.json`;
    await Deno.writeFile(identity, signer.toPkcs8());
    using _output = stub(console, "log", () => {});
    using _error = stub(console, "error", () => {});
    using http = stub(globalThis, "fetch", async (input, init) => {
      const body = await new Request(input, init).json();
      return Response.json({ inviteId: body.inviteId });
    });
    const run = (
      host: string,
      space: string,
      access = "READ",
      ttl = "60",
      uses = "1",
    ) =>
      buildSpaceInviteCommand().reset().throwErrors().parse([
        "create",
        "--access",
        access,
        "--ttl",
        ttl,
        "--max-uses",
        uses,
        "--request-file",
        requestFile,
        "--api-url",
        host,
        "--space",
        space,
        "--identity",
        identity,
      ]);
    try {
      await run("https://fabric.example", signer.did());
      const before = await Deno.readTextFile(requestFile);
      for (
        const [host, space, access, ttl, uses] of [
          ["https://other.example", signer.did(), "READ", "60", "1"],
          [
            "https://fabric.example",
            (await Identity.generate()).did(),
            "READ",
            "60",
            "1",
          ],
          ["https://fabric.example", signer.did(), "WRITE", "60", "1"],
          ["https://fabric.example", signer.did(), "READ", "61", "1"],
          ["https://fabric.example", signer.did(), "READ", "60", "2"],
        ]
      ) {
        await expect(run(host!, space!, access, ttl, uses)).rejects.toThrow(
          "request file does not match",
        );
      }
      expect(http.calls).toHaveLength(1);
      expect(await Deno.readTextFile(requestFile)).toBe(before);
      const otherSigner = await Identity.fromPassphrase("other CLI owner", {
        implementation: "noble",
      });
      await Deno.writeFile(identity, otherSigner.toPkcs8());
      await expect(run("https://fabric.example", signer.did())).rejects.toThrow(
        "request file does not match",
      );
      await Deno.writeFile(identity, signer.toPkcs8());
      await Deno.writeTextFile(requestFile, "private malformed credentials");
      await expect(run("https://fabric.example", signer.did())).rejects.toThrow(
        "Invalid invitation request file",
      );
      expect(await Deno.readTextFile(requestFile)).toBe(
        "private malformed credentials",
      );
      expect(http.calls).toHaveLength(1);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("refuses symlink, directory, and nonprivate request files without HTTP or overwrites", async () => {
    const signer = await Identity.fromPassphrase("CLI file refusal", {
      implementation: "noble",
    });
    const directory = await Deno.makeTempDir();
    const identity = `${directory}/identity.key`;
    const target = `${directory}/target.json`;
    const symlink = `${directory}/linked.json`;
    const nonprivate = `${directory}/public.json`;
    await Deno.writeFile(identity, signer.toPkcs8());
    await Deno.writeTextFile(target, "private existing data", { mode: 0o600 });
    await Deno.symlink(target, symlink);
    await Deno.writeTextFile(nonprivate, "existing data", { mode: 0o644 });
    using http = stub(
      globalThis,
      "fetch",
      () => Promise.reject(new Error("unexpected request")),
    );
    try {
      for (const path of [symlink, directory, nonprivate]) {
        await expect(
          buildSpaceInviteCommand().reset().throwErrors().parse([
            "create",
            "--access",
            "READ",
            "--ttl",
            "60",
            "--request-file",
            path,
            "--api-url",
            "https://fabric.example",
            "--space",
            signer.did(),
            "--identity",
            identity,
          ]),
        ).rejects.toThrow("private regular file");
      }
      expect(http.calls).toHaveLength(0);
      expect(await Deno.readTextFile(target)).toBe("private existing data");
      expect(await Deno.readTextFile(nonprivate)).toBe("existing data");
      expect((await Deno.lstat(symlink)).isSymlink).toBe(true);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("transports the requested invite operations and returns caller-only credentials", async () => {
    const signer = await Identity.fromPassphrase("invite CLI operations", {
      implementation: "noble",
    });
    const directory = await Deno.makeTempDir();
    const getEnv = Deno.env.get.bind(Deno.env);
    using _state = stub(
      Deno.env,
      "get",
      (name) => name === "XDG_STATE_HOME" ? directory : getEnv(name),
    );
    using _error = stub(console, "error", () => {});
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
      expect(requests.at(-1)).toMatchObject({
        operation: "create",
        body: { access: "WRITE", ttlSeconds: 90, maxUses: 3 },
      });
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
