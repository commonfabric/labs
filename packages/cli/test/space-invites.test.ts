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

/**
 * Runs `cf space invite` subcommands against a stubbed fabric service that
 * checks each request's signer and route and answers every operation. Each
 * run places the connection options directly after the subcommand's name, so
 * that the words after them may end with `--` and an invitation ID, and
 * returns the JSON the command printed. Disposing it restores the stubs and
 * removes its state directory.
 */
async function inviteCli(passphrase: string) {
  await using stack = new AsyncDisposableStack();
  const signer = await Identity.fromPassphrase(passphrase, {
    implementation: "noble",
  });
  const directory = await Deno.makeTempDir();
  stack.defer(() => Deno.remove(directory, { recursive: true }));
  const getEnv = Deno.env.get.bind(Deno.env);
  stack.use(stub(
    Deno.env,
    "get",
    (name) => name === "XDG_STATE_HOME" ? directory : getEnv(name),
  ));
  stack.use(stub(console, "error", () => {}));
  const keyPath = `${directory}/identity.key`;
  await Deno.writeFile(keyPath, signer.toPkcs8());
  const requests: { operation: string; body: Record<string, unknown> }[] = [];
  const outputs: string[] = [];
  stack.use(stub(console, "log", (value: string) => {
    outputs.push(value);
  }));
  stack.use(stub(globalThis, "fetch", async (input, init) => {
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
  }));
  const run = async (command: string, ...args: string[]) => {
    await buildSpaceInviteCommand().reset().throwErrors().parse([
      command,
      "--api-url",
      "https://fabric.example",
      "--space",
      signer.did(),
      "--identity",
      keyPath,
      ...args,
    ]);
    return JSON.parse(outputs.at(-1)!);
  };
  const disposables = stack.move();
  return {
    signer,
    codePath: `${directory}/invite.code`,
    requests,
    outputs,
    run,
    [Symbol.asyncDispose]: () => disposables.disposeAsync(),
  };
}

describe("space invite", () => {
  it("creates an OWNER invitation whose link carries no access", async () => {
    await using cli = await inviteCli("owner invite CLI");
    const created = await cli.run(
      "create",
      "--access",
      "OWNER",
      "--ttl",
      "60",
      "--shell",
      "https://shell.example",
    );
    expect(cli.requests).toMatchObject([
      { operation: "create", body: { access: "OWNER", ttlSeconds: 60 } },
    ]);
    expect(created).toMatchObject({ access: "OWNER" });
    const link = new URL(created.link);
    expect(link.searchParams.has("access")).toBe(false);
    expect(parseInviteLink(link)).toMatchObject({
      inviteId: created.inviteId,
      code: created.code,
    });
  });
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
    const childDirectory = `${directory}/directory`;
    await Deno.mkdir(childDirectory, { mode: 0o700 });
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
      for (const path of [symlink, childDirectory, nonprivate]) {
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

  for (
    const mode of [
      "public parent",
      "replaced file",
      "unverifiable identity",
    ] as const
  ) {
    it(`refuses unsafe explicit request files: ${mode}`, async () => {
      const signer = await Identity.fromPassphrase("CLI request replacement", {
        implementation: "noble",
      });
      const directory = await Deno.makeTempDir();
      const identity = `${directory}/identity.key`;
      const publicDirectory = `${directory}/public`;
      const requestFile = `${directory}/prepared.json`;
      const replacement = `${directory}/replacement.json`;
      await Deno.writeFile(identity, signer.toPkcs8());
      await Deno.mkdir(publicDirectory, { mode: 0o755 });
      await Deno.chmod(publicDirectory, 0o755);
      const saved = {
        version: 1,
        host: "https://fabric.example",
        space: signer.did(),
        issuer: signer.did(),
        access: "READ",
        ttlSeconds: 60,
        maxUses: 1,
        inviteId: "A".repeat(22),
        code: "A".repeat(43),
      };
      await Deno.writeTextFile(requestFile, JSON.stringify(saved), {
        mode: 0o600,
      });
      await Deno.writeTextFile(
        replacement,
        JSON.stringify({ ...saved, inviteId: "B".repeat(22) }),
        { mode: 0o600 },
      );
      using _output = stub(console, "log", () => {});
      using _error = stub(console, "error", () => {});
      using http = stub(
        globalThis,
        "fetch",
        () => Promise.resolve(Response.json({ inviteId: saved.inviteId })),
      );
      const run = (file: string) =>
        buildSpaceInviteCommand().reset().throwErrors().parse([
          "create",
          "--access",
          "READ",
          "--ttl",
          "60",
          "--request-file",
          file,
          "--api-url",
          "https://fabric.example",
          "--space",
          signer.did(),
          "--identity",
          identity,
        ]);
      try {
        if (mode === "public parent") {
          await expect(run(`${publicDirectory}/new.json`)).rejects.toThrow(
            "private directory",
          );
          expect(await Array.fromAsync(Deno.readDir(publicDirectory))).toEqual(
            [],
          );
          expect(http.calls).toHaveLength(0);
          return;
        }
        const lstat = Deno.lstat.bind(Deno);
        const stat = Deno.FsFile.prototype.stat;
        using _stat = stub(
          Deno.FsFile.prototype,
          "stat",
          async function (this: Deno.FsFile) {
            const info = await stat.call(this);
            return mode === "unverifiable identity"
              ? { ...info, ino: null }
              : info;
          },
        );
        let replaced = false;
        using _replace = stub(Deno, "lstat", async (path) => {
          const info = await lstat(path);
          if (path === requestFile && mode === "unverifiable identity") {
            return { ...info, ino: null };
          }
          if (path === requestFile && !replaced) {
            replaced = true;
            await Deno.rename(replacement, requestFile);
          }
          return info;
        });
        await expect(run(requestFile)).rejects.toThrow("changed while opening");
        expect(replaced).toBe(mode === "replaced file");
        expect(http.calls).toHaveLength(0);
        expect(JSON.parse(await Deno.readTextFile(requestFile)).inviteId).toBe(
          (mode === "replaced file" ? "B" : "A").repeat(22),
        );
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });
  }
  it("refuses missing or unsafe default state directories before HTTP", async () => {
    const signer = await Identity.fromPassphrase(
      "CLI state directory refusal",
      {
        implementation: "noble",
      },
    );
    const directory = await Deno.makeTempDir();
    const identity = `${directory}/identity.key`;
    await Deno.writeFile(identity, signer.toPkcs8());
    let state: string | undefined;
    const getEnv = Deno.env.get.bind(Deno.env);
    using _state = stub(Deno.env, "get", (name) => {
      if (name === "XDG_STATE_HOME") return state;
      if (name === "HOME") return undefined;
      return getEnv(name);
    });
    using http = stub(
      globalThis,
      "fetch",
      () => Promise.reject(new Error("unexpected request")),
    );
    const run = () =>
      buildSpaceInviteCommand().reset().throwErrors().parse([
        "create",
        "--access",
        "READ",
        "--ttl",
        "60",
        "--api-url",
        "https://fabric.example",
        "--space",
        signer.did(),
        "--identity",
        identity,
      ]);
    try {
      await expect(run()).rejects.toThrow("Specify --request-file");
      state = directory;
      const requests = `${directory}/commonfabric/space-invites`;
      await Deno.mkdir(requests, { recursive: true, mode: 0o755 });
      await Deno.chmod(requests, 0o755);
      await expect(run()).rejects.toThrow("private directory (0700)");
      expect(await Array.fromAsync(Deno.readDir(requests))).toEqual([]);
      await Deno.remove(requests);
      const target = `${directory}/private-target`;
      await Deno.mkdir(target, { mode: 0o700 });
      await Deno.symlink(target, requests);
      await expect(run()).rejects.toThrow("private directory (0700)");
      expect((await Deno.lstat(requests)).isSymlink).toBe(true);
      expect(await Array.fromAsync(Deno.readDir(target))).toEqual([]);
      expect(http.calls).toHaveLength(0);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("refuses malformed retained requests without replacing their contents or making HTTP requests", async () => {
    const signer = await Identity.fromPassphrase(
      "CLI invalid retained request",
      {
        implementation: "noble",
      },
    );
    const directory = await Deno.makeTempDir();
    const identity = `${directory}/identity.key`;
    const requestFile = `${directory}/prepared.json`;
    await Deno.writeFile(identity, signer.toPkcs8());
    const valid = {
      version: 1,
      host: "https://fabric.example",
      space: signer.did(),
      issuer: signer.did(),
      access: "READ",
      ttlSeconds: 60,
      maxUses: 1,
      inviteId: "A".repeat(22),
      code: "A".repeat(43),
    };
    using http = stub(
      globalThis,
      "fetch",
      () => Promise.reject(new Error("unexpected request")),
    );
    try {
      for (
        const invalid of [
          null,
          {},
          { ...valid, version: 2 },
          { ...valid, code: 7 },
          { ...valid, code: "private-invalid-code" },
          { ...valid, inviteId: "invalid-id" },
        ]
      ) {
        const before = JSON.stringify(invalid);
        await Deno.writeTextFile(requestFile, before, { mode: 0o600 });
        await expect(
          buildSpaceInviteCommand().reset().throwErrors().parse([
            "create",
            "--access",
            "READ",
            "--ttl",
            "60",
            "--request-file",
            requestFile,
            "--api-url",
            "https://fabric.example",
            "--space",
            signer.did(),
            "--identity",
            identity,
          ]),
        ).rejects.toThrow("Invalid invitation request file");
        expect(await Deno.readTextFile(requestFile)).toBe(before);
      }
      expect(http.calls).toHaveLength(0);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("refuses creation when the request file cannot be persisted", async () => {
    const signer = await Identity.fromPassphrase("CLI persistence refusal", {
      implementation: "noble",
    });
    const directory = await Deno.makeTempDir();
    const identity = `${directory}/identity.key`;
    await Deno.writeFile(identity, signer.toPkcs8());
    using http = stub(
      globalThis,
      "fetch",
      () => Promise.reject(new Error("unexpected request")),
    );
    const run = (requestFile: string) =>
      buildSpaceInviteCommand().reset().throwErrors().parse([
        "create",
        "--access",
        "READ",
        "--ttl",
        "60",
        "--request-file",
        requestFile,
        "--api-url",
        "https://fabric.example",
        "--space",
        signer.did(),
        "--identity",
        identity,
      ]);
    try {
      await expect(run(`${directory}/missing-parent/prepared.json`)).rejects
        .toBeInstanceOf(Deno.errors.NotFound);
      const destination = `${directory}/prepared.json`;
      const open = Deno.open.bind(Deno);
      using _failure = stub(
        Deno,
        "open",
        (path, options) =>
          path === destination
            ? Promise.reject(
              new Deno.errors.PermissionDenied("request storage unavailable"),
            )
            : open(path, options),
      );
      await expect(run(destination)).rejects.toBeInstanceOf(
        Deno.errors.PermissionDenied,
      );
      expect(http.calls).toHaveLength(0);
      expect(
        (await Array.fromAsync(Deno.readDir(directory))).map((entry) =>
          entry.name
        ),
      )
        .toEqual(["identity.key"]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("transports the requested invite operations and returns caller-only credentials", async () => {
    await using cli = await inviteCli("invite CLI operations");
    const { requests, run } = cli;
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
      space: cli.signer.did(),
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
    await Deno.writeTextFile(cli.codePath, ` ${first.code}\n`);
    expect(await run("redeem", first.inviteId, "--code-file", cli.codePath))
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
    expect(cli.outputs).toHaveLength(8);
  });

  it("redeems, revokes, and lists receipts for an invitation created from random bytes that encode a leading dash", async () => {
    await using cli = await inviteCli("invite CLI leading dash");
    let created;
    {
      // Unpadded base64url encodes a first byte of 0xF8 as "-".
      using _random = stub(
        crypto,
        "getRandomValues",
        <T extends ArrayBufferView | null>(array: T) => {
          new Uint8Array(array!.buffer, array!.byteOffset, array!.byteLength)
            .fill(0xF8);
          return array;
        },
      );
      created = await cli.run("create", "--access", "READ", "--ttl", "60");
    }
    await Deno.writeTextFile(cli.codePath, created.code);
    expect(
      await cli.run("redeem", created.inviteId, "--code-file", cli.codePath),
    )
      .toMatchObject({ outcome: "redeemed" });
    expect(await cli.run("revoke", created.inviteId)).toEqual({
      revoked: true,
    });
    await cli.run("receipts", created.inviteId);
    expect(
      cli.requests.map(({ operation, body }) => [operation, body.inviteId]),
    )
      .toEqual([
        ["create", created.inviteId],
        ["redeem", created.inviteId],
        ["revoke", created.inviteId],
        ["receipts", created.inviteId],
      ]);
  });

  it("sends an invitation ID beginning with `-` when it follows `--`", async () => {
    await using cli = await inviteCli("invite CLI dash IDs");
    const { requests, run } = cli;
    const code = "A".repeat(43);
    await Deno.writeTextFile(cli.codePath, code);
    for (const inviteId of ["-" + "P".repeat(21), "--" + "Q".repeat(20)]) {
      await run("redeem", "--code-file", cli.codePath, "--", inviteId);
      expect(requests.at(-1)).toEqual({
        operation: "redeem",
        body: { inviteId, code },
      });
      await run("receipts", "--", inviteId);
      expect(requests.at(-1)).toEqual({
        operation: "receipts",
        body: { inviteId },
      });
      await run("revoke", "--", inviteId);
      expect(requests.at(-1)).toEqual({
        operation: "revoke",
        body: { inviteId },
      });
    }
    await run("receipts", "--");
    expect(requests.at(-1)).toEqual({ operation: "receipts", body: {} });
    expect(requests).toHaveLength(7);
  });

  it("refuses an invitation ID named twice, followed by other words, or missing, before making a request", async () => {
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
    const dashId = "-" + "P".repeat(21);
    const plainId = "A".repeat(22);
    for (const command of ["redeem", "revoke", "receipts"]) {
      await expect(
        buildSpaceInviteCommand().reset().throwErrors().parse([
          command,
          ...common,
          dashId,
        ]),
      ).rejects.toThrow('Unknown option "-P');
      for (
        const [words, error] of [
          [[plainId, "--", dashId], "not both"],
          [["--", plainId, dashId], "Only the invitation ID may follow `--`"],
          [["--", dashId, "--space", "named-space"], "options go before it"],
        ] as const
      ) {
        await expect(
          buildSpaceInviteCommand().reset().throwErrors().parse([
            command,
            ...common,
            ...words,
          ]),
        ).rejects.toThrow(error);
      }
    }
    for (const command of ["redeem", "revoke"]) {
      for (const words of [[], ["--"]]) {
        await expect(
          buildSpaceInviteCommand().reset().throwErrors().parse([
            command,
            ...common,
            ...words,
          ]),
        ).rejects.toThrow("Missing argument: `invite-id`");
      }
    }
    expect(http.calls).toHaveLength(0);
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
          ["create", "--access", "ADMIN", "--ttl", "60"],
          "--access must be READ, WRITE, or OWNER",
        ],
        [
          ["create", "--access", "owner", "--ttl", "60"],
          "--access must be READ, WRITE, or OWNER",
        ],
        [["create", "--access", "READ"], "--ttl is required"],
        [["create", "--access", "READ", "--ttl", "0"], "--ttl must be between"],
        [
          ["create", "--access", "READ", "--ttl", "2592001"],
          "--ttl must be between",
        ],
        [
          ["create", "--access", "READ", "--ttl", "60", "--max-uses", "0"],
          "--max-uses must be between",
        ],
        [
          ["create", "--access", "READ", "--ttl", "60", "--max-uses", "1001"],
          "--max-uses must be between",
        ],
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
