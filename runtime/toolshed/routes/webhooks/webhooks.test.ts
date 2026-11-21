import { expect } from "@std/expect";
import { refuseCommits } from "@/test/support/refuse-commits.ts";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  type Cell,
  cellRuntime,
  type CommitError,
  type IExtendedStorageTransaction,
  type JSONSchema,
  Runtime,
} from "@commonfabric/runner";
import {
  linkRefFrom,
  linkRefPayloadToString,
} from "@commonfabric/runner/shared";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  addToIndex,
  addToServiceIndex,
  deleteRegistration,
  extractSpaceFromCellLink,
  generateWebhookId,
  generateWebhookSecret,
  getRegistration,
  getServiceIndex,
  removeFromIndex,
  removeFromServiceIndex,
  saveRegistration,
  sendToStream,
  verifyWebhookSecret,
  webhookEntityId,
  type WebhookRegistration,
} from "./webhooks.utils.ts";
import env from "@/env.ts";
import { identity } from "@/lib/identity.ts";
import { sha256 } from "@/lib/sha2.ts";
import {
  createAclServer,
  LoopbackSessionFactory,
  TestStorageManager,
} from "@/test/support/memory-acl.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

describe("Webhook Utilities", () => {
  describe("generateWebhookId", () => {
    it("generates an ID with wh_ prefix", () => {
      const id = generateWebhookId();
      expect(id.startsWith("wh_")).toBe(true);
    });

    it("generates an ID with correct length (wh_ + 20 chars)", () => {
      const id = generateWebhookId();
      expect(id.length).toBe(23); // "wh_" (3) + 20
    });

    it("generates unique IDs", () => {
      const ids = new Set(
        Array.from({ length: 100 }, () => generateWebhookId()),
      );
      expect(ids.size).toBe(100);
    });
  });

  describe("generateWebhookSecret", () => {
    it("generates a secret with whsec_ prefix", () => {
      const { secret } = generateWebhookSecret();
      expect(secret.startsWith("whsec_")).toBe(true);
    });

    it("returns a hash promise that resolves to hex string", async () => {
      const { hashPromise } = generateWebhookSecret();
      const hash = await hashPromise;
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("generates unique secrets", () => {
      const secrets = new Set(
        Array.from({ length: 100 }, () => generateWebhookSecret().secret),
      );
      expect(secrets.size).toBe(100);
    });
  });

  describe("verifyWebhookSecret", () => {
    it("returns true for matching secret", async () => {
      const { secret, hashPromise } = generateWebhookSecret();
      const hash = await hashPromise;
      const result = await verifyWebhookSecret(secret, hash);
      expect(result).toBe(true);
    });

    it("returns false for wrong secret", async () => {
      const { hashPromise } = generateWebhookSecret();
      const hash = await hashPromise;
      const result = await verifyWebhookSecret("whsec_wrong", hash);
      expect(result).toBe(false);
    });

    it("returns false for a stored hash of another length", async () => {
      const { secret } = generateWebhookSecret();
      expect(await verifyWebhookSecret(secret, "0".repeat(63))).toBe(false);
    });

    it("returns false for empty secret", async () => {
      const { hashPromise } = generateWebhookSecret();
      const hash = await hashPromise;
      const result = await verifyWebhookSecret("", hash);
      expect(result).toBe(false);
    });
  });

  describe("extractSpaceFromCellLink", () => {
    it("extracts space from an fcl1: cell link", () => {
      const cellLink = linkRefPayloadToString({
        id: "of:bafe123",
        space: "did:key:z6Mktest123",
        path: ["webhooks", "github"],
      });
      // Sanity: it really is the fcl1: wire form, not raw JSON.
      expect(cellLink.startsWith("fcl1:")).toBe(true);
      const space = extractSpaceFromCellLink(cellLink);
      expect(space).toBe("did:key:z6Mktest123");
    });

    it("throws for a string without the fcl1: prefix", () => {
      expect(() => extractSpaceFromCellLink("not json")).toThrow();
      expect(() => extractSpaceFromCellLink(JSON.stringify({}))).toThrow();
    });

    it("throws for missing space", () => {
      const cellLink = linkRefPayloadToString({ id: "of:bafe123" });
      expect(() => extractSpaceFromCellLink(cellLink)).toThrow(
        "Cell link missing space",
      );
    });
  });

  describe("webhookEntityId", () => {
    it("produces deterministic entity IDs", async () => {
      const id1 = await webhookEntityId("wh_test123");
      const id2 = await webhookEntityId("wh_test123");
      expect(id1).toBe(id2);
    });

    it("starts with of: prefix", async () => {
      const id = await webhookEntityId("wh_test123");
      expect(id.startsWith("of:")).toBe(true);
    });

    it("produces different IDs for different webhooks", async () => {
      const id1 = await webhookEntityId("wh_abc");
      const id2 = await webhookEntityId("wh_xyz");
      expect(id1).not.toBe(id2);
    });

    it("contains a 64-char hex hash after prefix", async () => {
      const id = await webhookEntityId("wh_test123");
      const hash = id.slice(3); // strip "of:"
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("uses the cf webhook salt", async () => {
      const id = await webhookEntityId("wh_test123");
      expect(id).toBe(`of:${await sha256("cf:webhook:wh_test123")}`);
    });
  });

  describe("service index", () => {
    // Several sessions on one memory server, each with its own replica, so
    // that a session can hold a copy of the index that another session's
    // commit has made stale. That is the state in which a read outside the
    // transaction lets a write overwrite what it never saw.

    let server: MemoryV2Server.Server;
    let factory: LoopbackSessionFactory;
    let signer: Identity;
    let space: ReturnType<Identity["did"]>;
    let entityId: `of:${string}`;
    let sessions: { runtime: Runtime; storageManager: TestStorageManager }[];

    beforeEach(async () => {
      server = createAclServer(`webhooks-index-${crypto.randomUUID()}`, "off");
      factory = new LoopbackSessionFactory(server);
      signer = await Identity.fromPassphrase(
        `webhooks index ${crypto.randomUUID()}`,
      );
      space = signer.did();
      entityId = `of:${await sha256("cf:webhooks-for:" + space)}`;
      sessions = [];
    });

    afterEach(async () => {
      for (const { runtime, storageManager } of sessions) {
        await runtime.dispose();
        await storageManager.close();
      }
      await server.close();
    });

    /** A fresh session's synced view of the index cell. */
    const openIndex = async (): Promise<Cell<string[]>> => {
      const storageManager = TestStorageManager.overServer(
        { as: signer },
        factory,
      );
      const runtime = new Runtime({
        apiUrl: new URL("https://webhooks-index-test.invalid"),
        storageManager,
      });
      sessions.push({ runtime, storageManager });
      const cell = runtime.getCellFromLink(
        linkRefFrom({ id: entityId, space, path: ["webhooks"] }),
      ) as Cell<string[]>;
      await cell.sync();
      await storageManager.synced();
      return cell;
    };

    /** The index as a session that has seen nothing yet reads it. */
    const durableIndex = async (): Promise<string[]> =>
      [...(await openIndex()).get()].sort();

    /**
     * Commit one staged change to the index through `editWithRetry()`, and
     * report how many times the change was staged: once, plus once per
     * commit rejected as stale.
     */
    const commit = async (
      cell: Cell<string[]>,
      stage: (tx: IExtendedStorageTransaction) => void,
    ): Promise<number> => {
      let staged = 0;
      const { error } = await cellRuntime(cell).editWithRetry((tx) => {
        staged += 1;
        stage(tx);
      });
      if (error) throw error;
      return staged;
    };

    // `editWithRetry()` runs its callback before it sends the commit, so two
    // commits started in one synchronous stretch both stage against the list
    // as it stood before either landed. The one the server takes second is
    // rejected as stale and staged again against the first, which the staging
    // counts pin: a run in which the commits serialized would pass on the
    // final list alone without exercising the retry.

    it("keeps both IDs when two sessions add to the index concurrently", async () => {
      const first = await openIndex();
      await commit(first, (tx) => addToIndex(first, tx, "wh_seed"));
      const second = await openIndex();
      expect(second.get()).toEqual(["wh_seed"]);

      const staged = await Promise.all([
        commit(first, (tx) => addToIndex(first, tx, "wh_a")),
        commit(second, (tx) => addToIndex(second, tx, "wh_b")),
      ]);

      expect([...staged].sort()).toEqual([1, 2]);
      expect(await durableIndex()).toEqual(["wh_a", "wh_b", "wh_seed"]);
    });

    it("removes both IDs when two sessions remove from the index concurrently", async () => {
      const first = await openIndex();
      for (const id of ["wh_a", "wh_b", "wh_c"]) {
        await commit(first, (tx) => addToIndex(first, tx, id));
      }
      const second = await openIndex();
      expect(second.get()).toEqual(["wh_a", "wh_b", "wh_c"]);

      const staged = await Promise.all([
        commit(first, (tx) => removeFromIndex(first, tx, "wh_a")),
        commit(second, (tx) => removeFromIndex(second, tx, "wh_b")),
      ]);

      expect([...staged].sort()).toEqual([1, 2]);
      expect(await durableIndex()).toEqual(["wh_c"]);
    });

    it("does not add an ID the index already holds", async () => {
      const index = await openIndex();
      await commit(index, (tx) => addToIndex(index, tx, "wh_a"));
      await commit(index, (tx) => addToIndex(index, tx, "wh_a"));

      expect(await durableIndex()).toEqual(["wh_a"]);
    });

    it("reads the index through the transaction when it stages no write", async () => {
      // Adding an ID the index holds writes nothing, so only the read itself
      // can put the index document into the commit's read set.
      const index = await openIndex();
      await commit(index, (tx) => addToIndex(index, tx, "wh_a"));

      const tx = cellRuntime(index).edit();
      addToIndex(index, tx, "wh_a");
      const reads = [
        ...(tx.getReadActivities?.() ?? tx.tx.getReadActivities?.() ?? []),
      ];
      expect(reads.map((read) => read.id)).toContain(entityId);
      await tx.commit().settled;
    });
  });

  describe("writes the storage layer refuses", () => {
    // Each write below commits through `editWithRetry()`, and each reports a
    // commit the storage layer refuses by throwing the refusal rather than
    // returning as though the write had landed.

    /**
     * The refusal every case injects. `AuthorizationError` without the
     * server's `retriable` marker is outside the retryable vocabulary, so
     * `editWithRetry()` reports it after a single commit.
     */
    const REFUSAL: CommitError = {
      name: "AuthorizationError",
      message: "the space refused the write",
    };

    const STREAM_SCHEMA: JSONSchema = {
      asCell: ["stream"],
      type: "object",
      properties: { data: { type: "string" } },
    };

    const registration = (id: string): WebhookRegistration => ({
      id,
      name: "refused",
      cellLink: "fcl1:unused",
      secretHash: "0".repeat(64),
      createdBy: identity.did(),
      createdAt: "2026-11-12T00:00:00.000Z",
      enabled: true,
    });

    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;

    /** Starts a runtime over emulated storage, with `serverExecution`. */
    const start = (serverExecution: boolean) => {
      storageManager = StorageManager.emulate({ as: identity });
      runtime = new Runtime({
        apiUrl: new URL("https://webhooks-refused-test.invalid"),
        storageManager,
        experimental: { serverExecution },
      });
    };

    afterEach(async () => {
      await runtime.dispose();
      await storageManager.close();
    });

    const refuse = (wanted: (written: readonly string[]) => boolean) =>
      refuseCommits(runtime, REFUSAL, wanted);

    /** Accepts a transaction that writes the document `id`. */
    const writing = (id: string) => (written: readonly string[]) =>
      written.includes(id);

    /** The document holding the service index of `space`. */
    const indexDocument = async (space: string) =>
      `of:${await sha256("cf:webhooks-for:" + space)}`;

    /** The inbox stream a delivery targets, as an `fcl1:` wire string. */
    const inboxLink = async (): Promise<string> => {
      const tx = runtime.edit();
      const inbox = runtime.getCell(
        identity.did(),
        "webhook-inbox",
        STREAM_SCHEMA,
        tx,
      );
      await tx.commit().settled;
      const link = inbox.getAsNormalizedFullLink();
      return linkRefPayloadToString({
        id: link.id,
        space: link.space,
        path: link.path.map((p) => String(p)),
      });
    };

    it("throws the refusal from `saveRegistration()`, saving nothing", async () => {
      start(false);
      const refused = refuse(writing(await webhookEntityId("wh_save")));

      await expect(saveRegistration(runtime, registration("wh_save")))
        .rejects.toEqual(REFUSAL);

      expect(refused()).toBe(1);
      expect(await getRegistration(runtime, "wh_save")).toBe(null);
    });

    it("throws the refusal from `deleteRegistration()`, keeping the registration", async () => {
      start(false);
      await saveRegistration(runtime, registration("wh_delete"));
      const refused = refuse(
        writing(await webhookEntityId("wh_delete")),
      );

      await expect(deleteRegistration(runtime, "wh_delete"))
        .rejects.toEqual(REFUSAL);

      expect(refused()).toBe(1);
      expect(await getRegistration(runtime, "wh_delete")).toEqual(
        registration("wh_delete"),
      );
    });

    it("throws the refusal from `addToServiceIndex()`, adding nothing", async () => {
      start(false);
      const refused = refuse(
        writing(await indexDocument(identity.did())),
      );

      await expect(addToServiceIndex(runtime, identity.did(), "wh_add"))
        .rejects.toEqual(REFUSAL);

      expect(refused()).toBe(1);
      expect(await getServiceIndex(runtime, identity.did())).toEqual([]);
    });

    it("throws the refusal from `removeFromServiceIndex()`, removing nothing", async () => {
      start(false);
      await addToServiceIndex(runtime, identity.did(), "wh_remove");
      const refused = refuse(
        writing(await indexDocument(identity.did())),
      );

      await expect(removeFromServiceIndex(runtime, identity.did(), "wh_remove"))
        .rejects.toEqual(REFUSAL);

      expect(refused()).toBe(1);
      expect(await getServiceIndex(runtime, identity.did())).toEqual([
        "wh_remove",
      ]);
    });

    it("throws the refusal from `sendToStream()` with `serverExecution` false", async () => {
      start(false);
      const link = await inboxLink();
      // The send queues the event rather than writing it, so the transaction
      // that carries it writes no document to name it by.
      const refused = refuse(() => true);

      await expect(sendToStream(runtime, link, { data: "x" }))
        .rejects.toEqual(REFUSAL);

      expect(refused()).toBe(1);
    });

    it("throws the refusal from `sendToStream()` with `serverExecution` true", async () => {
      start(true);
      const link = await inboxLink();
      // The send queues the event rather than writing it, so the transaction
      // that carries it writes no document to name it by.
      const refused = refuse(() => true);

      await expect(sendToStream(runtime, link, { data: "x" }))
        .rejects.toEqual(REFUSAL);

      expect(refused()).toBe(1);
    });
  });
});
