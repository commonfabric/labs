import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { Runtime } from "@commonfabric/runner";

import {
  createAclServer,
  genesisAcl,
  LoopbackSessionFactory,
  TestStorageManager,
} from "@/lib/test-support/memory-acl.ts";
import { durableSet } from "@/lib/custody-ingest.ts";
import { getRegistration, requestClaim } from "@/routes/ingest/ingest.utils.ts";
import {
  getMailboxChannels,
  type MailboxLookup,
} from "@/routes/ingest-push/gmail-push.utils.ts";
import {
  type GmailBindDeps,
  processGmailBind,
  processGmailUnbind,
} from "./gmail-binding.utils.ts";
import {
  type ControlResult,
  processMint,
  processRevoke,
} from "./ingest-channels.utils.ts";

const MAILBOX = "alice@example.com";

/** Narrow a ControlResult to its success body, failing loudly otherwise. */
const ok = <T>(result: ControlResult<T>): T => {
  assert(
    result.status === 200,
    `expected 200, got ${result.status}: ${JSON.stringify(result.body)}`,
  );
  return result.body;
};

describe("gmail-binding.utils", () => {
  // Run against a real memory server enforcing ACLs, so that ownership is
  // decided the way a deployment decides it. The space has a concrete owner,
  // alice, rather than a key derived from a passphrase.

  let server: MemoryV2Server.Server;
  let factory: LoopbackSessionFactory;
  let operator: Identity;
  let alice: Identity;
  let mallory: Identity;
  let space: string;
  let storageManager: TestStorageManager;
  let runtime: Runtime;
  let lookups: string[];
  let lookup: MailboxLookup;
  let deps: GmailBindDeps;

  beforeEach(async () => {
    server = createAclServer(`gmail-binding-${crypto.randomUUID()}`);
    factory = new LoopbackSessionFactory(server);
    operator = await Identity.fromPassphrase("gb-operator");
    alice = await Identity.fromPassphrase("gb-alice");
    mallory = await Identity.fromPassphrase("gb-mallory");
    const spaceIdentity = await Identity.fromPassphrase("gb-space");
    space = spaceIdentity.did();
    storageManager = TestStorageManager.overServer({ as: operator }, factory);
    runtime = new Runtime({
      apiUrl: new URL("https://gb-test.invalid"),
      storageManager,
    });
    lookups = [];
    lookup = { ok: true, emailAddress: MAILBOX };
    deps = {
      runtime,
      serviceSpace: operator.did(),
      operatorDid: operator.did(),
      serviceDids: [],
      hostsSpace: () => true,
      apiUrl: "https://gb-test.invalid",
      fetchMailbox: (accessToken) => {
        lookups.push(accessToken);
        return Promise.resolve(lookup);
      },
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

  /** Mints a channel into alice's space, and returns its id. */
  const mintChannel = async (installId = "loom-1"): Promise<string> =>
    ok(
      await processMint(deps, alice.did(), {
        space,
        installId,
        requestId: `req-${installId}`,
      }),
    ).id;

  const boundTo = (address: string) =>
    getMailboxChannels(runtime, operator.did(), address);
  const bound = () => boundTo(MAILBOX);

  const bind = (id: string, requestId: string, caller = alice) =>
    processGmailBind(deps, caller.did(), {
      id,
      accessToken: "token-1",
      requestId,
    });

  const unbind = (id: string, requestId: string, caller = alice) =>
    processGmailUnbind(deps, caller.did(), { id, requestId });

  const revoke = async (id: string) => {
    const registration = await getRegistration(runtime, operator.did(), id);
    ok(
      await processRevoke(deps, alice.did(), {
        id,
        requestId: "req-revoke",
        expectedRevision: registration?.revision ?? 0,
      }),
    );
  };

  /** Fills alice's claim store with as many live claims as it retains. */
  const fillClaimStore = async () => {
    const { cell } = requestClaim(runtime, operator.did(), {
      owner: alice.did(),
      requestId: "unused",
      channel: "unused",
    });
    await cell.sync();
    await runtime.storageManager.synced();
    const at = Date.now();
    await durableSet(
      cell,
      Array.from(
        { length: 500 },
        (_, n) => ({ id: `filler-${n}`, at, channel: "filler" }),
      ),
    );
  };

  describe("processGmailBind()", () => {
    it("binds the mailbox the access token reads to a channel the caller owns", async () => {
      const id = await mintChannel();

      const result = await bind(id, "req-1");

      expect(ok(result)).toEqual({ id, emailAddress: MAILBOX });
      expect(lookups).toEqual(["token-1"]);
      expect(await bound()).toEqual([id]);
    });

    it("returns 403 for a caller who does not own the channel's space, without asking Gmail", async () => {
      const id = await mintChannel();

      const result = await bind(id, "req-1", mallory);

      expect(result.status).toBe(403);
      expect(lookups).toEqual([]);
      expect(await bound()).toEqual([]);
    });

    it("returns 403 for a channel that does not exist", async () => {
      const result = await bind(
        "ing_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "req-1",
      );

      expect(result.status).toBe(403);
      expect(lookups).toEqual([]);
    });

    it("returns 400 and binds nothing when Gmail rejects the access token", async () => {
      const id = await mintChannel();
      lookup = { ok: false, reason: "rejected" };

      const result = await bind(id, "req-1");

      expect(result.status).toBe(400);
      expect(await bound()).toEqual([]);
    });

    it("returns 502 and binds nothing when the Gmail lookup fails", async () => {
      const id = await mintChannel();
      lookup = { ok: false, reason: "unavailable" };

      const result = await bind(id, "req-1");

      expect(result.status).toBe(502);
      expect(await bound()).toEqual([]);
    });

    it("returns 409 for a revoked channel", async () => {
      const id = await mintChannel();
      await revoke(id);

      const result = await bind(id, "req-1");

      expect(result.status).toBe(409);
      expect(lookups).toEqual([]);
    });

    it("returns 400 for a request id that is not a single clean segment", async () => {
      const id = await mintChannel();

      const result = await bind(id, "req/1");

      expect(result.status).toBe(400);
      expect(lookups).toEqual([]);
    });

    it("returns 409 for a replayed request id, without asking Gmail again", async () => {
      const id = await mintChannel();
      ok(await bind(id, "req-1"));

      const result = await bind(id, "req-1");

      expect(result.status).toBe(409);
      expect(lookups).toHaveLength(1);
    });

    it("leaves a later binding in place when an earlier bind is replayed", async () => {
      const id = await mintChannel();
      ok(await bind(id, "req-1"));
      lookup = { ok: true, emailAddress: "bob@example.com" };
      ok(await bind(id, "req-2"));
      lookup = { ok: true, emailAddress: MAILBOX };

      const result = await bind(id, "req-1");

      expect(result.status).toBe(409);
      expect(await boundTo("bob@example.com")).toEqual([id]);
      expect(await bound()).toEqual([]);
    });

    it("accepts a request id again after the bind that carried it failed", async () => {
      const id = await mintChannel();
      lookup = { ok: false, reason: "unavailable" };
      expect((await bind(id, "req-1")).status).toBe(502);
      lookup = { ok: true, emailAddress: MAILBOX };

      const result = await bind(id, "req-1");

      expect(ok(result)).toEqual({ id, emailAddress: MAILBOX });
    });

    it("returns 429 and binds nothing when the caller's claim store is full", async () => {
      const id = await mintChannel();
      await fillClaimStore();

      const result = await bind(id, "req-1");

      expect(result.status).toBe(429);
      expect(await bound()).toEqual([]);
    });
  });

  describe("processGmailUnbind()", () => {
    it("unbinds a channel the caller owns", async () => {
      const id = await mintChannel();
      ok(await bind(id, "req-1"));

      const result = await unbind(id, "req-u");

      expect(ok(result)).toEqual({ id, unbound: true });
      expect(await bound()).toEqual([]);
    });

    it("returns `unbound: false` for a channel that was not bound", async () => {
      const id = await mintChannel();

      const result = await unbind(id, "req-u");

      expect(ok(result)).toEqual({ id, unbound: false });
    });

    it("returns 403 for a caller who does not own the channel's space", async () => {
      const id = await mintChannel();
      ok(await bind(id, "req-1"));

      const result = await unbind(id, "req-u", mallory);

      expect(result.status).toBe(403);
      expect(await bound()).toEqual([id]);
    });

    it("unbinds a channel that has since been revoked", async () => {
      const id = await mintChannel();
      ok(await bind(id, "req-1"));
      await revoke(id);

      const result = await unbind(id, "req-u");

      expect(ok(result)).toEqual({ id, unbound: true });
    });

    it("returns 400 for a request id that is not a single clean segment", async () => {
      const id = await mintChannel();

      expect((await unbind(id, "..")).status).toBe(400);
    });

    it("leaves a later binding in place when an earlier unbind is replayed", async () => {
      const id = await mintChannel();
      ok(await bind(id, "req-1"));
      ok(await unbind(id, "req-u"));
      ok(await bind(id, "req-2"));

      const result = await unbind(id, "req-u");

      expect(result.status).toBe(409);
      expect(await bound()).toEqual([id]);
    });

    it("leaves a later binding in place when an unbind that found nothing bound is replayed", async () => {
      const id = await mintChannel();
      ok(await unbind(id, "req-u"));
      ok(await bind(id, "req-1"));

      const result = await unbind(id, "req-u");

      expect(result.status).toBe(409);
      expect(await bound()).toEqual([id]);
    });

    it("returns 429 and leaves the binding in place when the caller's claim store is full", async () => {
      // An unbind that went ahead here would leave its request id unrecorded,
      // and a replay of it could then clear a binding made afterwards.

      const id = await mintChannel();
      ok(await bind(id, "req-1"));
      await fillClaimStore();

      const result = await unbind(id, "req-u");

      expect(result.status).toBe(429);
      expect(await bound()).toEqual([id]);
    });
  });
});
