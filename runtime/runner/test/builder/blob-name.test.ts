import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { hashOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { blobDocumentId, type BlobRecord } from "../../src/blob-record.ts";
import { nameBlob } from "../../src/builder/blob-name.ts";
import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("name-blob signer");
const home = signer.did();

/** A blob of a few bytes, stored under `photo.png`. */
const photo: BlobRecord = {
  type: "image/png",
  body: new FabricBytes(new Uint8Array([137, 80, 78, 71])),
  name: "photo.png",
};

/** Returns the id the blob store gives `record`. */
const idOf = (record: BlobRecord): string => hashOf(record).toString();

describe("nameBlob()", () => {
  let server: MemoryV2Server.Server;
  let runtime: Runtime;

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await server.close();
  });

  /** Stores `record` in the home space as the blob store would. */
  const storeBlob = async (record: BlobRecord): Promise<string> => {
    const id = idOf(record);
    await server.writeDocument(home, blobDocumentId(id), record);
    return id;
  };

  /**
   * Runs a root pattern whose `rename` handler calls `nameBlob()` on a cell in
   * the home space and writes what it returns into `named`. Each run of the
   * handler records that return in `seen`, and in `refusals` the message any
   * call throws.
   */
  const spawnRoot = async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, pattern } = commonfabric;
    const seen: unknown[] = [];
    const refusals: string[] = [];
    const stateSchema = {
      type: "object",
      properties: { named: { type: "string", asCell: ["cell"] } },
      required: ["named"],
    } as const;
    const rename = handler<
      { blobId: unknown; name: unknown },
      { named: Cell<string> }
    >(
      {
        type: "object",
        properties: { blobId: {}, name: {} },
        required: ["blobId", "name"],
      },
      stateSchema,
      ({ blobId, name }, { named }) => {
        try {
          const id = commonfabric.nameBlob(
            named,
            blobId as string,
            name as string,
          );
          seen.push(id);
          named.set(id ?? "");
        } catch (error) {
          refusals.push((error as Error).message);
        }
      },
    );
    const Root = pattern<{ named: Cell<string> }>(
      ({ named }) => ({ named, rename: rename({ named }) }),
      stateSchema,
    );
    const tx = runtime.edit();
    const named = runtime.getCell<string>(
      home,
      `name-blob named ${crypto.randomUUID()}`,
      undefined,
      tx,
    );
    named.set("");
    const result = runtime.run(
      tx,
      Root,
      { named },
      runtime.getCell(
        home,
        `name-blob root ${crypto.randomUUID()}`,
        undefined,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();
    return {
      seen,
      refusals,
      rename: async (blobId: unknown, name: unknown) => {
        result.key("rename").send({ blobId, name });
        await runtime.idle();
        await runtime.storageManager.synced();
      },
      named: async (): Promise<string> => {
        await named.pull();
        return named.get();
      },
    };
  };

  it("returns the id of a blob holding the same bytes and type under the new name", async () => {
    const blobId = await storeBlob(photo);
    const root = await spawnRoot();

    await root.rename(blobId, "holiday.png");

    const expected = idOf({ ...photo, name: "holiday.png" });
    expect(await root.named()).toBe(expected);
    expect(expected).not.toBe(blobId);
  });

  it("stores the new blob's record when the handler's transaction commits", async () => {
    const blobId = await storeBlob(photo);
    const root = await spawnRoot();

    await root.rename(blobId, "holiday.png");

    const newId = await root.named();
    expect(
      (await server.readDocument(home, blobDocumentId(newId)))?.value,
    ).toEqual({ ...photo, name: "holiday.png" });
  });

  it("withdraws the run that reads a blob still loading, and returns its new id in the run after it", async () => {
    // The blob is stored straight to the server, so this runtime has never
    // loaded it when the handler first reads it.

    const blobId = await storeBlob(photo);
    const root = await spawnRoot();

    await root.rename(blobId, "holiday.png");

    expect(root.seen).toEqual([
      undefined,
      idOf({ ...photo, name: "holiday.png" }),
    ]);
  });

  it("returns the blob's own id when it is already named `name`", async () => {
    const blobId = await storeBlob(photo);
    const root = await spawnRoot();

    await root.rename(blobId, "photo.png");

    expect(await root.named()).toBe(blobId);
  });

  it("returns an id for a blob stored with no name", async () => {
    const { name: _, ...unnamed } = photo;
    const blobId = await storeBlob(unnamed);
    const root = await spawnRoot();

    await root.rename(blobId, "photo.png");

    expect(await root.named()).toBe(idOf(photo));
  });

  it("returns an id for a blob stored with its body as an array of byte values", async () => {
    const stored = { type: photo.type, body: [137, 80, 78, 71] };
    const blobId = hashOf(stored).toString();
    await server.writeDocument(home, blobDocumentId(blobId), stored);
    const root = await spawnRoot();

    await root.rename(blobId, "photo.png");

    expect(await root.named()).toBe(idOf(photo));
  });

  it("returns an id for a blob stored with its body as a record of byte values", async () => {
    const stored = {
      type: photo.type,
      body: { "0": 137, "1": 80, "2": 78, "3": 71 },
    };
    const blobId = hashOf(stored).toString();
    await server.writeDocument(home, blobDocumentId(blobId), stored);
    const root = await spawnRoot();

    await root.rename(blobId, "photo.png");

    expect(await root.named()).toBe(idOf(photo));
  });

  it("returns `undefined` for a blob whose body is a record holding anything but its bytes in order", async () => {
    const root = await spawnRoot();

    for (
      const body of [
        { "0": 137, "1": 300 },
        { "0": 137, "1": 80, note: "x" },
        { "0": 137, "2": 80 },
      ]
    ) {
      const stored = { type: photo.type, body };
      const blobId = hashOf(stored).toString();
      await server.writeDocument(home, blobDocumentId(blobId), stored);
      await root.rename(blobId, "photo.png");
    }

    expect(root.seen.filter((id) => id !== undefined)).toEqual([]);
    expect(await root.named()).toBe("");
  });

  it("returns `undefined` for a blob the space does not hold", async () => {
    const root = await spawnRoot();

    await root.rename(idOf(photo), "holiday.png");

    expect(root.seen.at(-1)).toBeUndefined();
    expect(await root.named()).toBe("");
  });

  it("returns `undefined` for a document that holds no blob", async () => {
    const notBlob = { type: "image/png", body: "not bytes" };
    const id = hashOf(notBlob).toString();
    await server.writeDocument(home, blobDocumentId(id), notBlob);
    const root = await spawnRoot();

    await root.rename(id, "holiday.png");

    expect(root.seen.at(-1)).toBeUndefined();
  });

  it("throws for a name that is not a non-empty string of well-formed Unicode of at most 1024 bytes", async () => {
    const blobId = await storeBlob(photo);
    const root = await spawnRoot();

    for (const name of ["", "\ud800.png", "é".repeat(513), 7]) {
      await root.rename(blobId, name);
    }

    expect(root.refusals).toHaveLength(4);
    expect(root.refusals.every((message) => message.includes("`name`")))
      .toBe(true);
  });

  it("throws for a `blobId` that is not a string", async () => {
    const root = await spawnRoot();

    await root.rename(7, "holiday.png");

    expect(root.refusals).toHaveLength(1);
    expect(root.refusals[0]).toContain("`blobId`");
  });

  it("throws when called anywhere but a handler", () => {
    const frame = pushFrame({
      runtime,
      tx: runtime.edit(),
      space: home,
      frameKind: "lift",
    });
    try {
      expect(() => nameBlob(undefined, idOf(photo), "holiday.png")).toThrow(
        "`nameBlob()` can only be called from a handler.",
      );
    } finally {
      popFrame(frame);
    }
  });
});
