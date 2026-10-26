/**
 * A FabriFile store over blobs its space really holds. A pattern test cannot
 * hold a blob, since nothing a pattern runs writes a blob's record, so this
 * runs `FileStoreCore` in a runtime over an in-process store, writes each
 * blob's record there as the blob store would, and drives the store's streams
 * as a client would.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { hashOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { DID } from "@commonfabric/identity/did";
import { type Cell, type JSONSchema, Runtime } from "@commonfabric/runner";
import {
  blobDocumentId,
  type BlobRecord,
} from "@commonfabric/runner/blob-record";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

const owner = await Identity.fromPassphrase("fabrifile-store");
// A member of the store's space, who may write in it but does not own it.
const member = await Identity.fromPassphrase("fabrifile-store member");
const PATTERNS = fromFileUrl(new URL("..", import.meta.url));

/** The bytes of a small image, stored as `photo.png`. */
const photo: BlobRecord = {
  type: "image/png",
  body: new FabricBytes(new Uint8Array([137, 80, 78, 71])),
  name: "photo.png",
};

/** Returns the id the blob store gives `record`. */
const idOf = (record: BlobRecord): string => hashOf(record).toString();

// Reads a store's facts with each entry as a link, not a copy.
const storeSchema = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: { type: "unknown", asCell: ["cell"] },
    },
    byName: {
      type: "object",
      additionalProperties: { type: "unknown", asCell: ["cell"] },
    },
    requests: { type: "object", additionalProperties: true },
  },
} as const satisfies JSONSchema;

// Reads one entry's fields, as a client does.
const entrySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    mediaType: { type: "string" },
    blob: {
      type: "object",
      properties: { space: { type: "string" }, id: { type: "string" } },
    },
    size: { type: "number" },
    removedAt: {},
  },
} as const satisfies JSONSchema;

/** What a client reads of one entry. */
interface EntryValue {
  name: string;
  mediaType: string;
  blob: { space: string; id: string };
  size: number;
  removedAt?: unknown;
}

describe("FabriFile store", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;
  // The space the store and its blobs are in, which grants `owner` OWNER.
  let home: DID;

  beforeEach(async () => {
    server = newLoopbackServer();
    storage = EmulatedStorageManager.connectTo(server, { as: owner });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    home = await runtime.createSpace({ grants: { [member.did()]: "WRITE" } });
  });

  afterEach(async () => {
    await runtime?.idle();
    await storage?.synced();
    await runtime?.dispose();
    await storage?.close();
    await server?.close();
  });

  /** Writes `record` to the home space as the blob store would. */
  const storeBlob = async (record: BlobRecord): Promise<string> => {
    const id = idOf(record);
    await server.writeDocument(home, blobDocumentId(id), record);
    return id;
  };

  /** Returns the record of the blob `id` the home space holds, if any. */
  const blobRecord = async (id: string): Promise<unknown> =>
    (await server.readDocument(home, blobDocumentId(id)))?.value;

  /**
   * Writes a profile named `name`, in a space of its own, labeled as a
   * person's profile is, since an entry may link only a labeled document.
   */
  const writeProfile = async (name: string) => {
    const space = await runtime.createSpace({
      grants: { [member.did()]: "READ" },
    });
    const tx = runtime.edit();
    const profile = runtime.getCell(space, `profile ${name}`, {
      type: "object",
      properties: { name: { type: "string" } },
      ifc: { addIntegrity: ["fabrifile-test-profile"] },
    }, tx);
    profile.set({ name });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    return profile;
  };

  /**
   * Starts a store in the home space whose viewer's profile is `profile`, and
   * returns it with the means to drive it.
   */
  const startStore = async (profile: Cell<unknown> | undefined) => {
    const program = {
      ...await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        {
          main: fromFileUrl(
            new URL("../fabrifile/store.tsx", import.meta.url),
          ),
          root: PATTERNS,
        },
      ),
      mainExport: "FileStoreCore",
    };
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(program, {
      space: home,
      tx,
    });
    const store = runtime.run(
      tx,
      pattern,
      { myProfile: profile },
      runtime.getCell(home, `store ${crypto.randomUUID()}`, undefined, tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await store.pull();

    const send = async (stream: string, event: Record<string, unknown>) => {
      const sendTx = runtime.edit();
      store.withTx(sendTx).key(stream).send(event);
      expect((await sendTx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      await storage.synced();
    };
    const facts = async () => {
      const value = await store.asSchema(storeSchema).pull();
      return {
        entries: (value?.entries ?? []) as Cell<EntryValue>[],
        byName: (value?.byName ?? {}) as Record<string, Cell<EntryValue>>,
        requests: (value?.requests ?? {}) as Record<
          string,
          Record<string, unknown>
        >,
      };
    };
    const values = async (): Promise<EntryValue[]> => {
      const { entries } = await facts();
      return await Promise.all(entries.map(read));
    };
    /**
     * Waits until the store, as this runtime sees it, has recorded an outcome
     * for `requestId`, such as one a member's runtime sent.
     */
    const outcomeOf = async (requestId: string) =>
      (await waitForCellValue<{ requests?: Record<string, unknown> }>(
        runtime,
        store.asSchema(storeSchema),
        (value) => value?.requests?.[requestId] !== undefined,
      )).requests![requestId];
    return { store, send, facts, values, outcomeOf };
  };

  /**
   * Runs `act` with a runtime of `member`'s over the same store, whose `send`
   * sends to the stream `stream` of `store` as `member`, and whose `link`
   * returns `member`'s cell for `cell`, and returns what `act` returns. The
   * runtime is disposed of once `act` returns, so `act` waits there for what
   * its sends must have done.
   */
  const asMember = async <T>(
    act: (as: {
      send: (
        store: Cell<unknown>,
        stream: string,
        event: Record<string, unknown>,
      ) => Promise<void>;
      link: (cell: Cell<unknown>) => Cell<unknown>;
    }) => Promise<T>,
  ): Promise<T> => {
    const memberStorage = EmulatedStorageManager.connectTo(server, {
      as: member,
    });
    const memberRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: memberStorage,
    });
    const link = (cell: Cell<unknown>) =>
      memberRuntime.getCellFromLink(cell.getAsNormalizedFullLink());
    try {
      return await act({
        link,
        send: async (store, stream, event) => {
          // The member's runtime loads the store before writing to it, as a
          // client showing it would have.
          const own = link(store);
          await own.pull();
          await memberStorage.synced();
          const tx = memberRuntime.edit();
          own.withTx(tx).key(stream).send(event);
          expect((await tx.commit().settled).error).toBeUndefined();
          await memberRuntime.idle();
          await memberStorage.synced();
          await runtime.idle();
          await storage.synced();
        },
      });
    } finally {
      await memberRuntime.dispose();
      await memberStorage.close();
    }
  };

  /** Returns what a client reads of `entry`. */
  const read = async (entry: Cell<unknown>): Promise<EntryValue> =>
    (await entry.asSchema(entrySchema).pull()) as EntryValue;

  /** Adds the file `name` for the blob `blobId`. */
  const addEvent = (
    requestId: string,
    name: string,
    blobId: string,
    extra: Record<string, unknown> = {},
  ) => ({
    requestId,
    name,
    mediaType: "image/png",
    blob: { space: home, id: blobId },
    size: 4,
    ...extra,
  });

  describe("add", () => {
    it("adds an entry for a blob the space holds, under the blob's own name", async () => {
      const blobId = await storeBlob(photo);
      const { send, facts, values } = await startStore(
        await writeProfile("Ada"),
      );

      await send("add", addEvent("a1", "photo.png", blobId));

      expect(await values()).toMatchObject([{
        name: "photo.png",
        mediaType: "image/png",
        blob: { space: home, id: blobId },
        size: 4,
      }]);
      expect((await facts()).requests.a1).toMatchObject({
        status: "done",
        name: "photo.png",
      });
    });

    it("finds an entry it adds by its name", async () => {
      const blobId = await storeBlob(photo);
      const { send, facts } = await startStore(await writeProfile("Ada"));

      await send("add", addEvent("a1", "photo.png", blobId));

      const { byName } = await facts();
      expect(Object.keys(byName)).toEqual(["photo.png"]);
      expect((await read(byName["photo.png"])).blob.id).toBe(blobId);
    });

    it("stores the blob again under a free name it chooses, and records the name", async () => {
      const blobId = await storeBlob(photo);
      const { send, facts, values } = await startStore(
        await writeProfile("Ada"),
      );

      await send("add", addEvent("a1", "photo.png", blobId));
      await send(
        "add",
        addEvent("a2", "photo.png", blobId, { onConflict: "rename" }),
      );

      const renamed = { ...photo, name: "photo (2).png" };
      expect((await values()).map(({ name }) => name)).toEqual([
        "photo.png",
        "photo (2).png",
      ]);
      expect((await values())[1].blob.id).toBe(idOf(renamed));
      expect(await blobRecord(idOf(renamed))).toEqual(renamed);
      expect((await facts()).requests.a2).toMatchObject({
        status: "done",
        name: "photo (2).png",
      });
    });

    it("refuses a name another entry has, by default", async () => {
      const blobId = await storeBlob(photo);
      const { send, facts, values } = await startStore(
        await writeProfile("Ada"),
      );

      await send("add", addEvent("a1", "photo.png", blobId));
      await send("add", addEvent("a2", "photo.png", blobId));

      expect(await values()).toHaveLength(1);
      expect((await facts()).requests.a2).toMatchObject({
        status: "refused",
        code: "name-taken",
      });
    });

    it("refuses a name that is not a valid file name", async () => {
      const blobId = await storeBlob(photo);
      const { send, facts, values } = await startStore(
        await writeProfile("Ada"),
      );

      await send("add", addEvent("a1", "../photo.png", blobId));

      expect(await values()).toEqual([]);
      expect((await facts()).requests.a1).toMatchObject({
        status: "refused",
        code: "invalid-name",
      });
    });

    it("refuses a request missing its name, media type, size or blob, or naming an unknown conflict rule", async () => {
      const blobId = await storeBlob(photo);
      const { send, facts } = await startStore(await writeProfile("Ada"));

      await send("add", { requestId: "a1", name: "photo.png", blobId });
      const { name: _, ...unnamed } = addEvent("a2", "photo.png", blobId);
      await send("add", unnamed);
      await send("add", {
        ...addEvent("a3", "photo.png", blobId),
        blob: { space: home, id: "" },
      });
      await send(
        "add",
        addEvent("a4", "photo.png", blobId, { onConflict: "overwrite" }),
      );

      const { requests } = await facts();
      for (const id of ["a1", "a2", "a3", "a4"]) {
        expect({ id, ...requests[id] }).toMatchObject({
          id,
          status: "refused",
          code: "invalid-request",
        });
      }
    });

    it("refuses a blob in another space", async () => {
      const blobId = await storeBlob(photo);
      const { send, facts } = await startStore(await writeProfile("Ada"));

      await send("add", {
        ...addEvent("a1", "photo.png", blobId),
        blob: { space: "did:key:z6MkElsewhere", id: blobId },
      });

      expect((await facts()).requests.a1).toMatchObject({
        status: "refused",
        code: "other-space",
      });
    });

    it("refuses a blob the space does not hold", async () => {
      const { send, facts, values } = await startStore(
        await writeProfile("Ada"),
      );

      await send("add", addEvent("a1", "photo.png", idOf(photo)));

      expect(await values()).toEqual([]);
      expect((await facts()).requests.a1).toMatchObject({
        status: "refused",
        code: "no-blob",
      });
    });

    it("refuses an adder with no profile", async () => {
      const blobId = await storeBlob(photo);
      const { send, facts, values } = await startStore(undefined);

      await send("add", addEvent("a1", "photo.png", blobId));

      expect(await values()).toEqual([]);
      expect((await facts()).requests.a1).toMatchObject({
        status: "refused",
        code: "not-permitted",
      });
    });

    it("changes nothing when a request is sent again", async () => {
      const blobId = await storeBlob(photo);
      const { send, values } = await startStore(await writeProfile("Ada"));

      await send("add", addEvent("a1", "photo.png", blobId));
      await send(
        "add",
        addEvent("a1", "photo.png", blobId, { onConflict: "rename" }),
      );

      expect(await values()).toHaveLength(1);
    });
  });

  describe("rename", () => {
    it("renames an entry and stores its bytes again under the new name", async () => {
      const blobId = await storeBlob(photo);
      const { send, facts, values } = await startStore(
        await writeProfile("Ada"),
      );
      await send("add", addEvent("a1", "photo.png", blobId));
      const [entry] = (await facts()).entries;

      await send("rename", { requestId: "r1", entry, name: "holiday.png" });

      const renamed = { ...photo, name: "holiday.png" };
      expect(await values()).toMatchObject([{
        name: "holiday.png",
        blob: { space: home, id: idOf(renamed) },
      }]);
      expect(await blobRecord(idOf(renamed))).toEqual(renamed);
      expect(Object.keys((await facts()).byName)).toEqual(["holiday.png"]);
    });

    it("refuses a name another entry has, by default", async () => {
      const blobId = await storeBlob(photo);
      const other = await storeBlob({ ...photo, name: "other.png" });
      const { send, facts } = await startStore(await writeProfile("Ada"));
      await send("add", addEvent("a1", "photo.png", blobId));
      await send("add", addEvent("a2", "other.png", other));
      const [entry] = (await facts()).entries;

      await send("rename", { requestId: "r1", entry, name: "other.png" });

      expect((await facts()).requests.r1).toMatchObject({
        status: "refused",
        code: "name-taken",
      });
    });
  });

  describe("remove", () => {
    it("takes an entry out of the store and marks it removed in place", async () => {
      const blobId = await storeBlob(photo);
      const { send, facts, values } = await startStore(
        await writeProfile("Ada"),
      );
      await send("add", addEvent("a1", "photo.png", blobId));
      const [entry] = (await facts()).entries;

      await send("remove", { requestId: "x1", entry });

      expect(await values()).toEqual([]);
      expect((await facts()).byName).toEqual({});
      expect((await read(entry)).removedAt).toBeDefined();
      expect(await blobRecord(blobId)).toEqual(photo);
    });

    it("refuses a request naming no entry", async () => {
      const { send, facts } = await startStore(await writeProfile("Ada"));

      await send("remove", { requestId: "x1" });
      await send("rename", { requestId: "r1", name: "holiday.png" });
      await send("remove", { requestId: "x2", entry: "photo.png" });

      const { requests } = await facts();
      expect(requests.x1).toMatchObject({ code: "invalid-request" });
      expect(requests.r1).toMatchObject({ code: "invalid-request" });
      expect(requests.x2).toMatchObject({ code: "invalid-request" });
    });

    it("frees the removed entry's name", async () => {
      const blobId = await storeBlob(photo);
      const { send, facts, values } = await startStore(
        await writeProfile("Ada"),
      );
      await send("add", addEvent("a1", "photo.png", blobId));
      const [entry] = (await facts()).entries;
      await send("remove", { requestId: "x1", entry });

      await send("add", addEvent("a2", "photo.png", blobId));

      expect((await values()).map(({ name }) => name)).toEqual(["photo.png"]);
    });
  });

  describe("who may change an entry", () => {
    it("refuses a remove from a member who neither added the entry nor owns the space", async () => {
      const blobId = await storeBlob(photo);
      const { store, send, facts, values, outcomeOf } = await startStore(
        await writeProfile("Ada"),
      );
      await send("add", addEvent("a1", "photo.png", blobId));
      const [entry] = (await facts()).entries;

      // The member's runtime stays up until the store records the outcome,
      // since its event may commit only on a retry.
      const outcome = await asMember(async ({ send, link }) => {
        await send(store, "remove", { requestId: "x1", entry: link(entry) });
        return await outcomeOf("x1");
      });

      expect(outcome).toMatchObject({
        status: "refused",
        code: "not-permitted",
      });
      expect(await values()).toHaveLength(1);
    });

    it("renames an entry for the member who added it", async () => {
      const blobId = await storeBlob(photo);
      const { store, facts, values, outcomeOf } = await startStore(
        await writeProfile("Ada"),
      );

      const outcome = await asMember(async ({ send, link }) => {
        await send(store, "add", addEvent("a1", "photo.png", blobId));
        await outcomeOf("a1");
        const [entry] = (await facts()).entries;
        await send(store, "rename", {
          requestId: "r1",
          entry: link(entry),
          name: "holiday.png",
        });
        return await outcomeOf("r1");
      });

      expect(outcome).toMatchObject({
        status: "done",
        name: "holiday.png",
      });
      expect((await values()).map(({ name }) => name)).toEqual([
        "holiday.png",
      ]);
    });

    it("removes an entry another member added, for an owner of the space", async () => {
      const blobId = await storeBlob(photo);
      const { store, send, facts, values, outcomeOf } = await startStore(
        await writeProfile("Ada"),
      );
      await asMember(async ({ send }) => {
        await send(store, "add", addEvent("a1", "photo.png", blobId));
        await outcomeOf("a1");
      });
      const [entry] = (await facts()).entries;

      await send("remove", { requestId: "x1", entry });

      expect(await outcomeOf("x1")).toMatchObject({ status: "done" });
      expect(await values()).toEqual([]);
    });
  });
});
