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
import { getRegistration } from "@/routes/ingest/ingest.utils.ts";
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

  const bound = () => getMailboxChannels(runtime, operator.did(), MAILBOX);

  describe("processGmailBind()", () => {
    it("binds the mailbox the access token reads to a channel the caller owns", async () => {
      const id = await mintChannel();

      const result = await processGmailBind(deps, alice.did(), {
        id,
        accessToken: "token-1",
      });

      expect(ok(result)).toEqual({ id, emailAddress: MAILBOX });
      expect(lookups).toEqual(["token-1"]);
      expect(await bound()).toEqual([id]);
    });

    it("returns 403 for a caller who does not own the channel's space, without asking Gmail", async () => {
      const id = await mintChannel();

      const result = await processGmailBind(deps, mallory.did(), {
        id,
        accessToken: "token-1",
      });

      expect(result.status).toBe(403);
      expect(lookups).toEqual([]);
      expect(await bound()).toEqual([]);
    });

    it("returns 403 for a channel that does not exist", async () => {
      const result = await processGmailBind(deps, alice.did(), {
        id: "ing_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        accessToken: "token-1",
      });

      expect(result.status).toBe(403);
      expect(lookups).toEqual([]);
    });

    it("returns 400 and binds nothing when Gmail rejects the access token", async () => {
      const id = await mintChannel();
      lookup = { ok: false, reason: "rejected" };

      const result = await processGmailBind(deps, alice.did(), {
        id,
        accessToken: "stale",
      });

      expect(result.status).toBe(400);
      expect(await bound()).toEqual([]);
    });

    it("returns 502 and binds nothing when the Gmail lookup fails", async () => {
      const id = await mintChannel();
      lookup = { ok: false, reason: "unavailable" };

      const result = await processGmailBind(deps, alice.did(), {
        id,
        accessToken: "token-1",
      });

      expect(result.status).toBe(502);
      expect(await bound()).toEqual([]);
    });

    it("returns 409 for a revoked channel", async () => {
      const id = await mintChannel();
      const registration = await getRegistration(runtime, operator.did(), id);
      ok(
        await processRevoke(deps, alice.did(), {
          id,
          requestId: "req-revoke",
          expectedRevision: registration?.revision ?? 0,
        }),
      );

      const result = await processGmailBind(deps, alice.did(), {
        id,
        accessToken: "token-1",
      });

      expect(result.status).toBe(409);
      expect(lookups).toEqual([]);
    });
  });

  describe("processGmailUnbind()", () => {
    it("unbinds a channel the caller owns", async () => {
      const id = await mintChannel();
      ok(await processGmailBind(deps, alice.did(), { id, accessToken: "t" }));

      const result = await processGmailUnbind(deps, alice.did(), { id });

      expect(ok(result)).toEqual({ id, unbound: true });
      expect(await bound()).toEqual([]);
    });

    it("returns `unbound: false` for a channel that was not bound", async () => {
      const id = await mintChannel();

      const result = await processGmailUnbind(deps, alice.did(), { id });

      expect(ok(result)).toEqual({ id, unbound: false });
    });

    it("returns 403 for a caller who does not own the channel's space", async () => {
      const id = await mintChannel();
      ok(await processGmailBind(deps, alice.did(), { id, accessToken: "t" }));

      const result = await processGmailUnbind(deps, mallory.did(), { id });

      expect(result.status).toBe(403);
      expect(await bound()).toEqual([id]);
    });

    it("unbinds a channel that has since been revoked", async () => {
      const id = await mintChannel();
      ok(await processGmailBind(deps, alice.did(), { id, accessToken: "t" }));
      const registration = await getRegistration(runtime, operator.did(), id);
      ok(
        await processRevoke(deps, alice.did(), {
          id,
          requestId: "req-revoke",
          expectedRevision: registration?.revision ?? 0,
        }),
      );

      const result = await processGmailUnbind(deps, alice.did(), { id });

      expect(ok(result)).toEqual({ id, unbound: true });
    });
  });
});
