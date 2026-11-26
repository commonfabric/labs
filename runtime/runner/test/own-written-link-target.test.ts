import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/api";
import { taggedHashStringOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace, URI } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("own-written link target");
const space = signer.did();
const otherSpace =
  (await Identity.fromPassphrase("own-written link target, other space")).did();

/** What a linking document holds: a link to the target, and a marker. */
type Linking = { inner?: { v?: number }; mark?: number };

const targetSchema = {
  type: "object",
  properties: { v: { type: "number" } },
} as const satisfies JSONSchema;

describe("own-written link target", () => {
  // Each case has one client store a target document and a document linking
  // to it, has a second client change the target, and reads the target
  // through the link at the first. The second client then writes a marker to
  // the linking document, which the first client's cell is loaded from, and
  // the first client waits for the marker. The server sends a session what
  // its watches reach as storage stands, so the frame that carries the marker
  // comes no earlier than the target's change does where a watch reaches the
  // target, and a read made once the marker has arrived is past that change.

  let server: MemoryV2Server.Server;
  let storage: EmulatedStorageManager;
  let reader: Runtime;
  let other: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const client = (storageManager: EmulatedStorageManager) =>
      new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    reader = client(storage);
    other = client(EmulatedStorageManager.connectTo(server, { as: signer }));
  });

  afterEach(async () => {
    await reader.dispose();
    await other.dispose();
    await server.close();
  });

  /** The id of the document `runtime` names `name` in `inSpace`. */
  const idOf = (
    runtime: Runtime,
    name: string,
    inSpace: MemorySpace = space,
  ): URI => runtime.getCell(inSpace, name).getAsNormalizedFullLink().id;

  /**
   * Has `writer` commit `value` to the document named `name` with a
   * transaction write, which loads nothing, and waits for the server to
   * accept it.
   */
  const store = async (
    writer: Runtime,
    name: string,
    value: FabricValue,
    inSpace: MemorySpace = space,
  ): Promise<void> => {
    const tx = writer.edit();
    tx.writeValueOrThrow(
      writer.getCell(inSpace, name).getAsNormalizedFullLink(),
      value,
    );
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  /**
   * Has the other client load the document named `name`, so that its write
   * rests on the stored version, and commit `value` to it.
   */
  const change = async (
    name: string,
    value: FabricValue,
    inSpace: MemorySpace = space,
  ): Promise<void> => {
    await other.getCell(inSpace, name).sync();
    await store(other, name, value, inSpace);
  };

  /** The value of a document that links to the target named `name`. */
  const linkTo = (name: string, inSpace: MemorySpace = space) => ({
    inner: {
      "/": {
        "link@1": {
          id: idOf(reader, name, inSpace),
          path: [],
          ...(inSpace === space ? {} : { space: inSpace }),
        },
      },
    },
  });

  /**
   * Loads the linking document at the reader under `schema`, reads it once
   * with everything that read started loaded, and returns the cell.
   */
  const readLinking = async (schema?: JSONSchema): Promise<Cell<Linking>> => {
    const linking = reader.getCell<Linking>(space, "linking", schema);
    await linking.pull();
    return linking;
  };

  /**
   * Has the other client mark the linking document, and returns what the
   * reader reads through the link once the marker has arrived.
   */
  const readPastMarker = async (
    linking: Cell<Linking>,
    targetName = "target",
    inSpace: MemorySpace = space,
  ): Promise<number | undefined> => {
    await change("linking", { ...linkTo(targetName, inSpace), mark: 1 });
    const value = await waitForCellValue<Linking>(
      reader,
      linking,
      (held) => held?.mark === 1,
    );
    return value.inner?.v;
  };

  describe("read through a link under no schema", () => {
    it("reads another client's change, where the reader's own commit stored the target", async () => {
      await store(reader, "target", { v: 1 });
      await store(reader, "linking", linkTo("target"));
      const linking = await readLinking();
      expect(linking.get()?.inner?.v).toBe(1);

      await change("target", { v: 2 });

      expect(await readPastMarker(linking)).toBe(2);
    });

    it("reads another client's change, where a third client stored the target", async () => {
      await store(other, "target", { v: 1 });
      await store(other, "linking", linkTo("target"));
      const linking = await readLinking();
      expect(linking.get()?.inner?.v).toBe(1);

      await change("target", { v: 2 });

      expect(await readPastMarker(linking)).toBe(2);
    });

    it("reads another client's change, where the reader's own commit is still pending at the read", async () => {
      await store(other, "linking", linkTo("target"));
      const tx = reader.edit();
      tx.writeValueOrThrow(
        reader.getCell(space, "target").getAsNormalizedFullLink(),
        { v: 1 },
      );
      const commit = tx.commit();
      const linking = reader.getCell<Linking>(space, "linking");
      expect((await linking.pull())?.inner?.v).toBe(1);
      expect((await commit.settled).error).toBeUndefined();

      await change("target", { v: 2 });

      expect(await readPastMarker(linking)).toBe(2);
    });

    it("reads another client's value, where the reader stored the target and then deleted it", async () => {
      await store(reader, "target", { v: 1 });
      await store(reader, "linking", linkTo("target"));
      const linking = await readLinking();
      expect(linking.get()?.inner?.v).toBe(1);
      await store(reader, "target", undefined);
      expect((await linking.pull())?.inner).toBeUndefined();

      await change("target", { v: 3 });

      expect(await readPastMarker(linking)).toBe(3);
    });

    it("reads another client's change, where the reader's own commit stored the target in another space", async () => {
      await store(reader, "far target", { v: 1 }, otherSpace);
      await store(reader, "linking", linkTo("far target", otherSpace));
      const linking = await readLinking();
      expect(linking.get()?.inner?.v).toBe(1);

      await change("far target", { v: 2 }, otherSpace);
      // The marker's frame says nothing of another space's session, so the
      // reader waits for the target's own change.
      const target = reader.getCell<{ v?: number }>(otherSpace, "far target");
      await waitForCellValue<{ v?: number }>(
        reader,
        target,
        (held) => held?.v === 2,
      );

      expect(await readPastMarker(linking, "far target", otherSpace)).toBe(2);
    });
  });

  describe("read through a link under a schema", () => {
    it("reads another client's change by `key()`, where the schema lists no property holding the link and the reader's own commit stored the target", async () => {
      // The load of the linking document carries this schema, so the server
      // follows no link from it, and `key()` hands the load on to the cells
      // it returns.

      await store(reader, "target", { v: 1 });
      await store(reader, "linking", linkTo("target"));
      const linking = await readLinking({
        type: "object",
        properties: { mark: { type: "number" } },
      });
      const held = () => linking.key("inner").key("v").get();
      expect(held()).toBe(1);

      await change("target", { v: 2 });
      await readPastMarker(linking);

      expect(held()).toBe(2);
    });
  });

  describe("read of the target's own cell", () => {
    it("reads another client's change, where the reader's own commit stored the target", async () => {
      await store(reader, "target", { v: 1 });
      const target = reader.getCell<{ v?: number }>(space, "target");
      expect((await target.pull())?.v).toBe(1);

      await change("target", { v: 2 });

      const value = await waitForCellValue<{ v?: number }>(
        reader,
        target,
        (held) => held?.v !== 1,
      );
      expect(value.v).toBe(2);
    });
  });

  describe("shouldPullDoc()", () => {
    // `shouldPullDoc()` reserves the pull it returns `true` for, so each case
    // asks once, after everything it set up has settled.

    it("returns `true` for a document the manager's own commit stored and nothing loaded", async () => {
      await store(reader, "target", { v: 1 });
      await storage.synced();

      expect(storage.shouldPullDoc(space, idOf(reader, "target"))).toBe(true);
    });

    it("returns `false` for a document its own cell loaded", async () => {
      await store(reader, "target", { v: 1 });
      await reader.getCell(space, "target").sync();
      await storage.synced();

      expect(storage.shouldPullDoc(space, idOf(reader, "target"))).toBe(false);
    });

    it("returns `false` for a document a `Cell.set()` stored", async () => {
      const tx = reader.edit();
      reader.getCell(space, "target", targetSchema, tx).set({ v: 1 });
      expect((await tx.commit().settled).error).toBeUndefined();
      await storage.synced();

      expect(storage.shouldPullDoc(space, idOf(reader, "target"))).toBe(false);
    });

    it("returns `false` for a document a schema's walk delivered", async () => {
      await store(reader, "target", { v: 1 });
      await store(reader, "linking", linkTo("target"));
      const linking = await readLinking({
        type: "object",
        properties: { inner: targetSchema },
      });
      expect(linking.get()?.inner?.v).toBe(1);
      await storage.synced();

      expect(storage.shouldPullDoc(space, idOf(reader, "target"))).toBe(false);
    });

    it("returns `false` for content the manager's own commit stored under the id its hash gives", async () => {
      const id: URI = `cid:${taggedHashStringOf(targetSchema)}`;
      const tx = reader.edit();
      tx.writeValueOrThrow({ space, id, path: [] }, targetSchema);
      expect((await tx.commit().settled).error).toBeUndefined();
      await storage.synced();

      expect(storage.shouldPullDoc(space, id)).toBe(false);
    });

    it("returns `false` for a session-scoped document of a runtime that keeps those to itself", async () => {
      const keptStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const keeping = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: keptStorage,
        experimental: { localSessionDocuments: true, serverExecution: false },
      });
      try {
        const id = idOf(keeping, "target");
        const tx = keeping.edit();
        tx.writeValueOrThrow({ space, id, path: [], scope: "session" }, 42);
        expect((await tx.commit().settled).error).toBeUndefined();
        await keptStorage.synced();

        expect(keptStorage.shouldPullDoc(space, id, "session")).toBe(false);
      } finally {
        await keeping.dispose();
      }
    });

    it("returns `false` for a document its own commit stored, of a manager that reads the space's store directly", async () => {
      // A serving runtime's manager reads the store it runs beside, and
      // learns from that store's feed of each write to a document it holds.
      // This one is handed a read that finds nothing, which is never asked
      // about a document the replica holds.

      await store(reader, "target", { v: 1 });
      await storage.synced();
      storage.installStoreReadThrough(space, () => undefined);

      expect(storage.shouldPullDoc(space, idOf(reader, "target"))).toBe(false);
    });

    it("returns `false` for a document the manager's own commit stored once a read through a link has pulled it", async () => {
      await store(reader, "target", { v: 1 });
      await store(reader, "linking", linkTo("target"));
      await readLinking();
      await storage.synced();

      expect(storage.shouldPullDoc(space, idOf(reader, "target"))).toBe(false);
    });
  });
});
