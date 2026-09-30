import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { fromFileUrl, toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { type ACL, aclDocId } from "../acl.ts";
import {
  createInviteCredentials,
  type InviteAccess,
  inviteCodeVerifier,
  SpaceInviteError,
} from "../space-invites.ts";
import * as Engine from "../v2/engine.ts";
import { snapshotSpaceStore } from "../v2/dump.ts";
import { executeInvite, type InviteOperation } from "../v2/invites.ts";

const space = "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8MuKWGmRfDCwAZDGBnSpXXX";
const host = "https://invites.example";
const initialTime = 1_800_000_000_000;

async function fixture() {
  const directory = await Deno.makeTempDir();
  const url = toFileUrl(`${directory}/space.sqlite`);
  let engine = await Engine.open({ url });
  const owner = (await Identity.generate()).did();
  const guest = (await Identity.generate()).did();
  const second = (await Identity.generate()).did();
  let now = initialTime;
  const acl = (value: ACL) =>
    Engine.applyCommit(engine, {
      sessionId: crypto.randomUUID(),
      space,
      commitClass: "system",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: aclDocId(space), value: { value } }],
      },
    });
  acl({ [owner]: "OWNER" });
  const run = (operation: InviteOperation, principal: string = owner) =>
    executeInvite(engine, { host, space, principal, now, ...operation }).result;
  const create = (
    options: {
      maxUses?: number;
      access?: InviteAccess;
      ttlSeconds?: number;
    } = {},
  ) => {
    const credentials = createInviteCredentials();
    const body = {
      ...credentials,
      codeVerifier: inviteCodeVerifier({ host, space, ...credentials }),
      access: "READ" as const,
      ttlSeconds: 60,
      ...options,
    };
    const { code, ...request } = body;
    const result = run({ operation: "create", body: request });
    return { code, inviteId: body.inviteId, request, result };
  };
  return {
    get engine() {
      return engine;
    },
    owner,
    guest,
    second,
    url,
    acl,
    run,
    create,
    advance(ms: number) {
      now += ms;
    },
    async reopen() {
      Engine.close(engine);
      engine = await Engine.open({ url });
    },
    async close() {
      Engine.close(engine);
      await Deno.remove(directory, { recursive: true });
    },
  };
}

function unavailable(fn: () => unknown) {
  let failure: unknown;
  try {
    fn();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(SpaceInviteError);
  if (!(failure instanceof SpaceInviteError)) throw failure;
  expect(failure.code).toBe("invite-unavailable");
}

async function processAttempt(
  f: Awaited<ReturnType<typeof fixture>>,
  invite: { inviteId: string; code: string },
  principal: string,
  mode: "normal" | "before-commit" | "after-commit" = "normal",
  operation: "redeem" | "revoke" = "redeem",
) {
  // This streaming test needs a readiness barrier, so it uses the same temporary
  // frozen-lock discipline as isolated-deno's non-streaming command helper.
  const directory = await Deno.makeTempDir();
  let child: Deno.ChildProcess | undefined;
  let output: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stderr: Promise<string> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    closing ??= (async () => {
      try {
        await child?.[Symbol.asyncDispose]();
        await output?.cancel();
        await stderr;
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    })();
  try {
    const lock = `${directory}/deno.lock`;
    await Deno.copyFile(new URL("../../../deno.lock", import.meta.url), lock);
    const process = child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        `--lock=${lock}`,
        "--frozen=true",
        fromFileUrl(new URL("./invite-process.ts", import.meta.url)),
        JSON.stringify({
          url: f.url.href,
          request: {
            host,
            space,
            principal,
            now: initialTime,
            operation,
            body: operation === "redeem"
              ? { inviteId: invite.inviteId, code: invite.code }
              : { inviteId: invite.inviteId },
          },
          mode,
        }),
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const reader = output = process.stdout.getReader();
    const errors = stderr = new Response(process.stderr).text();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    return {
      [Symbol.asyncDispose]: close,
      async start() {
        const writer = process.stdin.getWriter();
        try {
          await writer.write(new Uint8Array([1]));
          await writer.close();
        } catch (error) {
          await close();
          throw error;
        } finally {
          writer.releaseLock();
        }
      },
      async finish() {
        try {
          let text = "";
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            text += new TextDecoder().decode(item.value);
          }
          return { text, status: await process.status, stderr: await errors };
        } finally {
          await close();
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

describe("invites", () => {
  it("awaits the same in-flight process cleanup for concurrent disposal", async () => {
    const f = await fixture();
    const directory = await Deno.makeTempDir();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      const attempt = await (async () => {
        using _directory = stub(
          Deno,
          "makeTempDir",
          () => Promise.resolve(directory),
        );
        return await processAttempt(f, f.create(), f.guest);
      })();
      const remove = Deno.remove.bind(Deno);
      using _remove = stub(Deno, "remove", async (path, options) => {
        if (path === directory) {
          entered.resolve();
          await release.promise;
        }
        await remove(path, options);
      });
      first = attempt[Symbol.asyncDispose]();
      await entered.promise;
      let completed = false;
      second = attempt[Symbol.asyncDispose]().then(() => {
        completed = true;
      });
      await Promise.resolve();
      expect(completed).toBe(false);
      release.resolve();
      await Promise.all([first, second]);
      expect(completed).toBe(true);
      await expect(Deno.stat(directory)).rejects.toBeInstanceOf(
        Deno.errors.NotFound,
      );
    } finally {
      release.resolve();
      await Promise.all([first, second]);
      await f.close();
    }
  });
  it("cleans up a child that exits before readiness and an unstarted attempt", async () => {
    const f = await fixture();
    try {
      const invite = f.create();
      const directory = await Deno.makeTempDir();
      {
        using _directory = stub(
          Deno,
          "makeTempDir",
          () => Promise.resolve(directory),
        );
        await expect(processAttempt(
          { ...f, url: new URL("./", f.url) },
          invite,
          f.guest,
        )).rejects.toThrow();
      }
      await expect(Deno.stat(directory)).rejects.toBeInstanceOf(
        Deno.errors.NotFound,
      );
      {
        await using _attempt = await processAttempt(f, invite, f.guest);
      }
      expect(f.run({ operation: "receipts", body: {} })).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("requires explicit ownership for administration while preserving implicit owner access on redemption", async () => {
    const f = await fixture();
    try {
      const invite = f.create();
      const envelope = {
        host,
        space,
        principal: f.guest,
        now: initialTime,
        implicitOwner: true,
      };
      expect(() =>
        executeInvite(f.engine, {
          ...envelope,
          operation: "create",
          body: invite.request,
        })
      ).toThrow("not-owner");
      expect(executeInvite(f.engine, {
        ...envelope,
        operation: "redeem",
        body: invite,
      })).toMatchObject({
        result: { outcome: "redeemed", currentAccess: "OWNER" },
      });
      expect(Engine.read(f.engine, { id: aclDocId(space) })?.value).toEqual({
        [f.owner]: "OWNER",
      });
    } finally {
      await f.close();
    }
  });
  it("lets an explicit owner issue an OWNER invitation that grants OWNER", async () => {
    const f = await fixture();
    try {
      const invite = f.create({ access: "OWNER", maxUses: 2 });
      expect(invite.result).toMatchObject({
        access: "OWNER",
        issuedBy: f.owner,
        maxUses: 2,
      });
      expect(f.run({ operation: "list", body: {} })).toMatchObject([
        { inviteId: invite.inviteId, access: "OWNER" },
      ]);
      expect(f.run({ operation: "redeem", body: invite }, f.guest)).toEqual({
        outcome: "redeemed",
        redemption: { inviteId: invite.inviteId, did: f.guest },
        currentAccess: "OWNER",
      });
      expect(Engine.read(f.engine, { id: aclDocId(space) })?.value).toEqual({
        [f.owner]: "OWNER",
        [f.guest]: "OWNER",
      });
      // The grant is a real OWNER: the new owner may administer invitations.
      expect(f.run({ operation: "list", body: {} }, f.guest)).toMatchObject([
        { inviteId: invite.inviteId, usedCount: 1, remainingUses: 1 },
      ]);
      // An exact retry of the OWNER issuance is idempotent; a retry that
      // changes the access is refused.
      expect(f.run({ operation: "create", body: invite.request }))
        .toMatchObject({ access: "OWNER", usedCount: 1 });
      expect(() =>
        f.run({
          operation: "create",
          body: { ...invite.request, access: "WRITE" },
        })
      ).toThrow("invite-id-unavailable");
    } finally {
      await f.close();
    }
  });
  it("refuses OWNER invitations from READ and WRITE holders and unknown access", async () => {
    const f = await fixture();
    try {
      f.acl({ [f.owner]: "OWNER", [f.guest]: "WRITE", [f.second]: "READ" });
      for (const principal of [f.guest, f.second]) {
        for (const access of ["OWNER", "WRITE", "READ"] as const) {
          const credentials = createInviteCredentials();
          expect(() =>
            f.run({
              operation: "create",
              body: {
                inviteId: credentials.inviteId,
                codeVerifier: inviteCodeVerifier({
                  host,
                  space,
                  ...credentials,
                }),
                access,
                ttlSeconds: 60,
              },
            }, principal)
          ).toThrow("not-owner");
        }
      }
      for (const access of ["ADMIN", "owner", ""]) {
        expect(() => f.create({ access: access as InviteAccess })).toThrow(
          "invalid-request",
        );
      }
      expect(f.run({ operation: "list", body: {} })).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("never lowers access on redemption and raises a lesser grant to OWNER", async () => {
    const f = await fixture();
    try {
      const third = (await Identity.generate()).did();
      f.acl({ [f.owner]: "OWNER", [f.guest]: "OWNER", [f.second]: "WRITE" });
      const write = f.create({ access: "WRITE" });
      expect(f.run({ operation: "redeem", body: write }, f.guest))
        .toMatchObject({ outcome: "redeemed", currentAccess: "OWNER" });
      const read = f.create({ access: "READ" });
      expect(f.run({ operation: "redeem", body: read }, f.second))
        .toMatchObject({ outcome: "redeemed", currentAccess: "WRITE" });
      const owner = f.create({ access: "OWNER", maxUses: 2 });
      expect(f.run({ operation: "redeem", body: owner }, f.second))
        .toMatchObject({ outcome: "redeemed", currentAccess: "OWNER" });
      expect(f.run({ operation: "redeem", body: owner }, third))
        .toMatchObject({ outcome: "redeemed", currentAccess: "OWNER" });
      expect(Engine.read(f.engine, { id: aclDocId(space) })?.value).toEqual({
        [f.owner]: "OWNER",
        [f.guest]: "OWNER",
        [f.second]: "OWNER",
        [third]: "OWNER",
      });
    } finally {
      await f.close();
    }
  });
  it("refuses expired, revoked, exhausted, wrong-code, and orphaned OWNER invitations", async () => {
    const f = await fixture();
    try {
      const third = (await Identity.generate()).did();
      const expired = f.create({ access: "OWNER", ttlSeconds: 1 });
      const revoked = f.create({ access: "OWNER" });
      const exhausted = f.create({ access: "OWNER" });
      const wrong = f.create({ access: "OWNER" });
      f.run({ operation: "revoke", body: revoked });
      f.run({ operation: "redeem", body: exhausted }, f.second);
      unavailable(() =>
        f.run({ operation: "redeem", body: exhausted }, f.guest)
      );
      unavailable(() => f.run({ operation: "redeem", body: revoked }, f.guest));
      unavailable(() =>
        f.run({
          operation: "redeem",
          body: { ...wrong, code: createInviteCredentials().code },
        }, f.guest)
      );
      f.advance(1000);
      unavailable(() => f.run({ operation: "redeem", body: expired }, f.guest));
      // An issuer who no longer owns the space cannot admit anyone.
      const orphaned = f.create({ access: "OWNER" });
      f.acl({ [f.second]: "OWNER" });
      unavailable(() => f.run({ operation: "redeem", body: orphaned }, third));
      expect(Engine.read(f.engine, { id: aclDocId(space) })?.value).toEqual({
        [f.second]: "OWNER",
      });
    } finally {
      await f.close();
    }
  });
  it("checks an unavailable operation with one invocation", () => {
    let calls = 0;
    unavailable(() => {
      calls++;
      throw new SpaceInviteError("invite-unavailable");
    });
    expect(calls).toBe(1);
  });
  it("rejects invalid service envelopes without creating admission or receipt state", async () => {
    const f = await fixture();
    try {
      for (
        const invalid of [
          { now: -1 },
          { now: 1.5 },
          { now: Number.NaN },
          { principal: "not-a-did" },
          { space: "not-a-did" },
        ]
      ) {
        expect(() =>
          executeInvite(f.engine, {
            host,
            space,
            principal: f.owner,
            now: initialTime,
            operation: "list",
            body: {},
            ...invalid,
          })
        ).toThrow("invalid-request");
      }
      expect(f.run({ operation: "list", body: {} })).toEqual([]);
      expect(f.run({ operation: "receipts", body: {} })).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("rejects malformed redemption and owner query identifiers without consuming a use", async () => {
    const f = await fixture();
    try {
      const invite = f.create();
      for (
        const operation of [
          {
            operation: "redeem",
            body: { inviteId: "invalid", code: invite.code },
          },
          {
            operation: "redeem",
            body: { inviteId: invite.inviteId, code: "invalid" },
          },
          { operation: "receipts", body: { inviteId: "invalid" } },
          { operation: "revoke", body: { inviteId: "invalid" } },
        ] satisfies InviteOperation[]
      ) {
        expect(() => f.run(operation)).toThrow("invalid-request");
      }
      expect(f.run({ operation: "list", body: {} })).toMatchObject([
        { inviteId: invite.inviteId, usedCount: 0, remainingUses: 1 },
      ]);
      expect(f.run({ operation: "redeem", body: invite }, f.guest))
        .toMatchObject({
          outcome: "redeemed",
          currentAccess: "READ",
        });
    } finally {
      await f.close();
    }
  });
  it("grants access and retains one receipt when the final use is retried after restart", async () => {
    const f = await fixture();
    try {
      const invite = f.create();
      expect(invite.result).toMatchObject({ maxUses: 1, remainingUses: 1 });
      expect(f.run({ operation: "redeem", body: invite }, f.guest)).toEqual({
        outcome: "redeemed",
        redemption: { inviteId: invite.inviteId, did: f.guest },
        currentAccess: "READ",
      });
      expect(f.run({ operation: "list", body: {} })).toEqual([]);
      await f.reopen();
      expect(f.run({ operation: "redeem", body: invite }, f.guest))
        .toMatchObject({ outcome: "already-redeemed", currentAccess: "READ" });
      unavailable(() => f.run({ operation: "redeem", body: invite }, f.second));
      expect(f.run({ operation: "receipts", body: {} })).toEqual([{
        inviteId: invite.inviteId,
        did: f.guest,
      }]);
      expect(() => f.run({ operation: "create", body: invite.request }))
        .toThrow("invite-id-unavailable");
    } finally {
      await f.close();
    }
  });
  it("counts distinct DIDs per invite and preserves independent ACL changes on retries", async () => {
    const f = await fixture();
    try {
      const invite = f.create({ maxUses: 2, access: "WRITE" });
      f.run({ operation: "redeem", body: invite }, f.guest);
      f.run({ operation: "redeem", body: invite }, f.guest);
      expect(f.run({ operation: "list", body: {} })).toMatchObject([{
        remainingUses: 1,
        usedCount: 1,
      }]);
      expect(f.run({ operation: "create", body: invite.request }))
        .toMatchObject({ usedCount: 1, remainingUses: 1 });
      f.acl({ [f.owner]: "OWNER", [f.second]: "READ" });
      expect(f.run({ operation: "redeem", body: invite }, f.guest))
        .toMatchObject({ outcome: "already-redeemed", currentAccess: null });
      expect(f.run({ operation: "redeem", body: invite }, f.second))
        .toMatchObject({ outcome: "redeemed", currentAccess: "WRITE" });
      const replacement = f.create();
      expect(f.run({ operation: "redeem", body: replacement }, f.guest))
        .toMatchObject({ outcome: "redeemed", currentAccess: "READ" });
      expect(f.run({ operation: "receipts", body: {} })).toHaveLength(3);
    } finally {
      await f.close();
    }
  });
  it("preserves a stronger wildcard without masking its independent removal", async () => {
    const f = await fixture();
    try {
      f.acl({ [f.owner]: "OWNER", "*": "WRITE" });
      const invite = f.create({ maxUses: 2 });
      expect(f.run({ operation: "redeem", body: invite }, f.guest))
        .toMatchObject({ currentAccess: "WRITE" });
      expect(Engine.read(f.engine, { id: aclDocId(space) })?.value).toEqual({
        [f.owner]: "OWNER",
        "*": "WRITE",
      });
      f.acl({ [f.owner]: "OWNER" });
      expect(f.run({ operation: "redeem", body: invite }, f.guest))
        .toMatchObject({ outcome: "already-redeemed", currentAccess: null });
    } finally {
      await f.close();
    }
  });
  it("rejects expiry, revoked codes, wrong codes, and removed issuers while retaining receipts", async () => {
    const f = await fixture();
    try {
      const expired = f.create({ ttlSeconds: 1, maxUses: 2 });
      f.run({ operation: "redeem", body: expired }, f.guest);
      f.advance(1000);
      unavailable(() =>
        f.run({ operation: "redeem", body: expired }, f.second)
      );
      expect(f.run({ operation: "redeem", body: expired }, f.guest))
        .toMatchObject({ outcome: "already-redeemed" });
      const revoked = f.create();
      f.run({ operation: "revoke", body: revoked });
      unavailable(() =>
        f.run({ operation: "redeem", body: revoked }, f.second)
      );
      expect(() => f.run({ operation: "create", body: revoked.request }))
        .toThrow("invite-id-unavailable");
      const wrong = f.create();
      unavailable(() =>
        f.run({
          operation: "redeem",
          body: { ...wrong, code: createInviteCredentials().code },
        }, f.second)
      );
      const removed = f.create();
      f.acl({ [f.second]: "OWNER" });
      unavailable(() => f.run({ operation: "redeem", body: removed }, f.guest));
    } finally {
      await f.close();
    }
  });
  it("preserves original expiry on identical issuance retries and rejects changed parameters", async () => {
    const f = await fixture();
    try {
      const invite = f.create();
      f.advance(1000);
      expect(f.run({ operation: "create", body: invite.request })).toEqual(
        invite.result,
      );
      expect(() =>
        f.run({ operation: "create", body: { ...invite.request, maxUses: 2 } })
      ).toThrow("invite-id-unavailable");
      for (const maxUses of [0, -1, 1.5, 1001, Infinity]) {
        expect(() => f.create({ maxUses })).toThrow("invalid-request");
      }
      expect(() =>
        f.run({ operation: "create", body: invite.request }, f.guest)
      ).toThrow("not-owner");
    } finally {
      await f.close();
    }
  });
  it("rolls back the ACL and receipt together when durable receipt insertion fails", async () => {
    const f = await fixture();
    try {
      const invite = f.create();
      f.engine.database.exec(
        "CREATE TRIGGER abort_receipt BEFORE INSERT ON space_invite_redemptions BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END",
      );
      expect(() => f.run({ operation: "redeem", body: invite }, f.guest))
        .toThrow("injected disk failure");
      expect(Engine.read(f.engine, { id: aclDocId(space) })?.value).toEqual({
        [f.owner]: "OWNER",
      });
      expect(f.run({ operation: "receipts", body: {} })).toEqual([]);
      f.engine.database.exec("DROP TRIGGER abort_receipt");
      // Reuse the rolled-back revision with a different grant. Stale staged
      // cache entries must not turn this committed WRITE into the failed READ.
      f.acl({ [f.owner]: "OWNER", [f.second]: "WRITE" });
      await f.reopen();
      expect(f.run({ operation: "redeem", body: invite }, f.guest))
        .toMatchObject({ outcome: "redeemed" });
      expect(Engine.read(f.engine, { id: aclDocId(space) })?.value).toEqual({
        [f.owner]: "OWNER",
        [f.second]: "WRITE",
        [f.guest]: "READ",
      });
    } finally {
      await f.close();
    }
  });
  it("serializes the last use across separate persistent engine connections", async () => {
    const f = await fixture();
    const second = await Engine.open({ url: f.url });
    try {
      const invite = f.create();
      // These calls verify sequential visibility across connections.
      // Competing child processes below exercise simultaneous redemption.
      const results = await Promise.allSettled([
        Promise.resolve().then(() =>
          executeInvite(f.engine, {
            host,
            space,
            principal: f.guest,
            now: initialTime,
            operation: "redeem",
            body: invite,
          })
        ),
        Promise.resolve().then(() =>
          executeInvite(second, {
            host,
            space,
            principal: f.second,
            now: initialTime,
            operation: "redeem",
            body: invite,
          })
        ),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(f.run({ operation: "receipts", body: {} })).toHaveLength(1);
    } finally {
      Engine.close(second);
      await f.close();
    }
  });
  it("admits only one competing process for the final use", async () => {
    const f = await fixture();
    try {
      const invite = f.create();
      await using first = await processAttempt(f, invite, f.guest);
      await using second = await processAttempt(f, invite, f.second);
      await Promise.all([first.start(), second.start()]);
      const outcomes = await Promise.all([first.finish(), second.finish()]);
      expect(outcomes.map((o) => o.status.code)).toEqual([0, 0]);
      const values = outcomes.map((o) => JSON.parse(o.text));
      expect(values.filter((v) => v.outcome === "redeemed")).toHaveLength(1);
      expect(values.filter((v) => v.error === "invite-unavailable"))
        .toHaveLength(1);
      await f.reopen();
      expect(f.run({ operation: "receipts", body: {} })).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it("recovers an uncommitted process death and a committed lost response", async () => {
    const f = await fixture();
    try {
      const invite = f.create();
      await using before = await processAttempt(
        f,
        invite,
        f.guest,
        "before-commit",
      );
      await before.start();
      expect((await before.finish()).status.code).toBe(73);
      await f.reopen();
      expect(f.run({ operation: "receipts", body: {} })).toEqual([]);
      expect(Engine.read(f.engine, { id: aclDocId(space) })?.value).toEqual({
        [f.owner]: "OWNER",
      });
      await using after = await processAttempt(
        f,
        invite,
        f.guest,
        "after-commit",
      );
      await after.start();
      expect((await after.finish()).status.code).toBe(74);
      await f.reopen();
      expect(f.run({ operation: "redeem", body: invite }, f.guest))
        .toMatchObject({ outcome: "already-redeemed", currentAccess: "READ" });
      expect(f.run({ operation: "receipts", body: {} })).toEqual([{
        inviteId: invite.inviteId,
        did: f.guest,
      }]);
    } finally {
      await f.close();
    }
  });
  it("fsyncs invitation decisions before acknowledging them and restores the engine setting", async () => {
    const f = await fixture();
    try {
      const invite = f.create();
      const mode = () =>
        f.engine.database.prepare("PRAGMA synchronous").get<
          { synchronous: number }
        >()!.synchronous;
      const original = mode();
      let during = -1;
      f.engine.database.function("observe_invite_sync", () => {
        during = mode();
        return 0;
      });
      f.engine.database.exec(
        "CREATE TRIGGER observe_sync AFTER INSERT ON space_invite_redemptions BEGIN SELECT observe_invite_sync(); END",
      );
      f.run({ operation: "redeem", body: invite }, f.guest);
      expect(during).toBe(2);
      expect(mode()).toBe(original);
    } finally {
      await f.close();
    }
  });
  it("preserves private receipt history in full backups while excluding invite secrets from the graph", async () => {
    const f = await fixture();
    try {
      const invite = f.create({ maxUses: 2 });
      f.run({ operation: "redeem", body: invite }, f.guest);
      expect(Engine.listEntityIds(f.engine)).toEqual([aclDocId(space)]);
      const columns = f.engine.database.prepare(
        "PRAGMA table_info(space_invite_redemptions)",
      ).all<{ name: string }>().map((row) => row.name);
      expect(columns).toEqual(["inviteId", "did"]);
      const snapshot = fromFileUrl(f.url) + ".snapshot.sqlite";
      snapshotSpaceStore(fromFileUrl(f.url), snapshot);
      const restored = await Engine.open({ url: toFileUrl(snapshot) });
      try {
        const request = {
          host,
          space,
          principal: f.guest,
          now: initialTime,
          operation: "redeem" as const,
          body: invite,
        };
        expect(executeInvite(restored, request).result).toMatchObject({
          outcome: "already-redeemed",
        });
        expect(
          executeInvite(restored, { ...request, principal: f.second }).result,
        ).toMatchObject({ outcome: "redeemed" });
        expect(restored.database.prepare("SELECT * FROM space_invites").all())
          .toEqual([]);
        expect(
          restored.database.prepare("SELECT * FROM space_invite_redemptions")
            .all(),
        ).toHaveLength(2);
      } finally {
        Engine.close(restored);
      }
      f.advance(60_000);
      unavailable(() => f.run({ operation: "redeem", body: invite }, f.second));
      expect(f.engine.database.prepare("SELECT * FROM space_invites").all())
        .toEqual([]);
      expect(
        f.engine.database.prepare("SELECT * FROM space_invite_redemptions")
          .all(),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it("serializes revocation against a first redemption in separate processes", async () => {
    const f = await fixture();
    try {
      const invite = f.create();
      await using redeem = await processAttempt(f, invite, f.guest);
      await using revoke = await processAttempt(
        f,
        invite,
        f.owner,
        "normal",
        "revoke",
      );
      await Promise.all([redeem.start(), revoke.start()]);
      const [redemption, revocation] = await Promise.all([
        redeem.finish(),
        revoke.finish(),
      ]);
      expect(redemption.status.code).toBe(0);
      expect(revocation.status.code).toBe(0);
      expect(JSON.parse(revocation.text)).toEqual({ revoked: true });
      const result = JSON.parse(redemption.text);
      const receipts = f.run({ operation: "receipts", body: {} });
      if (result.outcome === "redeemed") {
        expect(receipts).toEqual([{ inviteId: invite.inviteId, did: f.guest }]);
      } else {
        expect(result.error).toBe("invite-unavailable");
        expect(receipts).toEqual([]);
      }
      expect(f.run({ operation: "list", body: {} })).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
