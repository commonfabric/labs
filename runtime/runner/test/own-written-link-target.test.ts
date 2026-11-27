import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
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

import type {
  Cell as BuilderCell,
  JSONSchema,
  Stream,
} from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace, URI } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

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

    it("reads another client's change of an array element, where the reader's own `Cell.set()` under no schema stored the element", async () => {
      // A cell write gives each object element of an array a document of its
      // own and stores a link to it in the array. The other client changes
      // the element and appends to the array in one commit, so the frame
      // that brings the reader the longer array is the one the element's
      // change is in.

      type Row = { n: number };
      const tx = reader.edit();
      reader.getCell<Row[]>(space, "rows", undefined, tx).set([{ n: 1 }]);
      expect((await tx.commit().settled).error).toBeUndefined();
      const rows = reader.getCell<Row[]>(space, "rows");
      expect((await rows.pull())?.[0]?.n).toBe(1);

      const theirs = other.getCell<Row[]>(space, "rows", {
        type: "array",
        items: { type: "object", properties: { n: { type: "number" } } },
      });
      await theirs.pull();
      const change = other.edit();
      theirs.withTx(change).key(0).key("n").set(2);
      theirs.withTx(change).push({ n: 0 });
      expect((await change.commit().settled).error).toBeUndefined();

      const value = await waitForCellValue<Row[]>(
        reader,
        rows,
        (held) => held?.length === 2,
      );
      expect(value[0]?.n).toBe(2);
    });
  });

  describe("read through a link once release passes have run", () => {
    it("returns `undefined` from `get()` and the value from `pull()`, where the read through the link loaded a target the reader's own commit stored", async () => {
      // The load gives the target a watch, and a pass releases a watched
      // document that nothing reads or holds. Collection needs
      // `--expose-gc` and the real clock, which this package's test task
      // does not give, so the helper runs in a process of its own.

      const helper = new URL(
        "./own-written-link-target-release-helper.ts",
        import.meta.url,
      );
      // Spawned by name so the launch matches the task's `--allow-run=deno`
      // grant, which resolves the name through PATH the same way.
      const output = await new Deno.Command("deno", {
        args: ["run", "-A", "--v8-flags=--expose-gc", fromFileUrl(helper)],
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stdout = new TextDecoder().decode(output.stdout);
      expect(
        output.success,
        `helper failed:\n${new TextDecoder().decode(output.stderr)}\n${stdout}`,
      ).toBe(true);
      // Loggers may write above the report; the report is the last line.
      const lines = stdout.trim().split("\n");
      expect(JSON.parse(lines[lines.length - 1])).toEqual({
        beforeRelease: 1,
        oneShotAfterRelease: null,
        pulledAfterRelease: 1,
      });
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
      await storage.synced();

      await change("target", { v: 2 });
      await readPastMarker(linking);

      expect(held()).toBe(2);
    });
  });

  describe("read of a running piece's result under no schema", () => {
    // The reader runs a piece, so its own commits store every document the
    // piece is made of, and reads the piece's result through a cell with no
    // schema, which reaches those documents through the links the result
    // holds. The other client writes through those links too, and then marks
    // the result document.

    type Row = { id: string };
    type Result = {
      add: Stream<{ id: string }>;
      sequence: number;
      rows: Row[];
      mark?: number;
    };

    /** Runs the piece at the reader and returns its result under no schema. */
    const runPiece = async (): Promise<Cell<Result>> => {
      const { pattern, cell, handler } = createTrustedBuilder(reader)
        .commonfabric;
      const add = handler<
        { id: string },
        { rows: BuilderCell<Row[]> }
      >(
        { type: "object", properties: { id: { type: "string" } } },
        {
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: {
                type: "object",
                properties: { id: { type: "string" } },
              },
              asCell: ["cell"],
            },
          },
          required: ["rows"],
        },
        (event, context) => context.rows.push({ id: event.id }),
      );
      const piece = pattern<{ rows: Row[] }>(({ rows }) => ({
        add: add({ rows }),
        sequence: cell(0),
        rows,
      }));
      const tx = reader.edit();
      reader.run(
        tx,
        piece,
        { rows: [] },
        reader.getCell(space, "piece", undefined, tx),
      );
      reader.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await reader.idle();
      return reader.getCell<Result>(space, "piece");
    };

    /** The other client's cell for the piece's result, loaded. */
    const theirResult = async (): Promise<Cell<Result>> => {
      const theirs = other.getCell<Result>(space, "piece");
      await theirs.pull();
      return theirs;
    };

    /**
     * Has the other client mark the result document, and returns what the
     * reader holds once the marker has arrived.
     */
    const resultPastMarker = async (
      result: Cell<Result>,
      theirs: Cell<Result>,
    ): Promise<Result> => {
      const tx = other.edit();
      theirs.withTx(tx).key("mark").set(1);
      expect((await tx.commit().settled).error).toBeUndefined();
      return await waitForCellValue<Result>(
        reader,
        result,
        (held) => held?.mark === 1,
      );
    };

    it("reads another client's change of a document the piece's setup made", async () => {
      const result = await runPiece();
      expect((await result.pull())?.sequence).toBe(0);
      await storage.synced();

      const theirs = await theirResult();
      const tx = other.edit();
      theirs.withTx(tx).key("sequence").set(5);
      expect((await tx.commit().settled).error).toBeUndefined();

      expect((await resultPastMarker(result, theirs)).sequence).toBe(5);
    });

    it("reads another client's change of a document a handler of the piece made", async () => {
      const result = await runPiece();
      result.key("add").send({ id: "ours" });
      await reader.idle();
      expect((await result.pull())?.rows[0]?.id).toBe("ours");
      await storage.synced();

      const theirs = await theirResult();
      const tx = other.edit();
      theirs.withTx(tx).key("rows").key(0).key("id").set("theirs");
      expect((await tx.commit().settled).error).toBeUndefined();

      expect((await resultPastMarker(result, theirs)).rows[0]?.id).toBe(
        "theirs",
      );
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

    it("returns `false` for a document its own commit stored, in the turn that starts the document's own load", async () => {
      await store(reader, "target", { v: 1 });
      await storage.synced();
      const load = reader.getCell(space, "target").sync();

      expect(storage.shouldPullDoc(space, idOf(reader, "target"))).toBe(false);
      await load;
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
      tx.writeValueOrThrow(
        { space, id, path: [], scope: "space" },
        targetSchema,
      );
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
