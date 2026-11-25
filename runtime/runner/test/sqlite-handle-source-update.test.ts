/**
 * Updates a piece that declares a database or an indexed collection to
 * another source, through the calls the updater makes, and reads the handle
 * the piece holds and the rows its database holds afterward.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fabricFromConvertibleJsValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/cell.ts";
import { stripEntityUriScheme } from "../src/entity-kind.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { parseLink } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { setResultCell } from "../src/result-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

/**
 * A piece with a database of notes and a verb that writes a note; `tagged`
 * declares a `tag` column as well.
 */
const databaseProgram = (tagged: boolean): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `
import {
  cfSqlite,
  handler,
  pattern,
  sqliteDatabase,
  type SqliteDb,
  type Stream,
} from "commonfabric";

const insert = handler<{ body: string }, { db: SqliteDb }>(
  ({ body }, { db }) => {
    db.exec("INSERT INTO notes (body) VALUES (?)", [body]);
  },
);

export default pattern<Record<string, never>, {
  db: SqliteDb;
  insert: Stream<{ body: string }>;
}>(() => {
  const db = sqliteDatabase({
    tables: {
      notes: cfSqlite.table({
        id: "integer primary key",
        body: "text",
        ${tagged ? 'tag: "text",' : ""}
      }),
    },
  });
  return { db, insert: insert({ db }) };
});
`,
  }],
});

/**
 * A piece with an indexed collection of topics, guarded by a cell its `add`
 * verb alone may write, whose source differs by `limit` alone.
 */
const collectionProgram = (limit: number): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `
import {
  handler,
  indexedCollections,
  type IndexedCollections,
  pattern,
  type Stream,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

export const LIMIT = ${limit};

type TopicOutput = { title: string };

const Topic = pattern<{ title: Writable<string> }, TopicOutput>(
  ({ title }) => ({ title }),
);

type Board = IndexedCollections<{ topics: TopicOutput }>;

const add = handler<{ title: string }, { board: Board }>(
  ({ title }, { board }) => {
    if (title.length > LIMIT) return;
    board.add("topics", Topic({ title }));
  },
);

type Guard = WriteAuthorizedBy<number, typeof add>;

export default pattern<Record<string, never>, {
  db: Board;
  guard: Guard;
  insert: Stream<{ title: string }>;
}>(() => {
  const guard = new Writable<Guard>(0);
  const board = indexedCollections<{ topics: TopicOutput }>({
    topics: { columns: { title: "text" } },
  }, { guard });
  return { db: board, guard, insert: add({ board }) };
});
`,
  }],
});

type Piece = Cell<Record<string, unknown>>;

describe("sqlite-handle-source-update", () => {
  let signer: Identity;
  let space: `did:${string}:${string}`;
  let server: MemoryV2Server.Server;
  let runtime: Runtime;

  /** A runtime of its own over the shared server. */
  const connect = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });

  beforeEach(async () => {
    // The storage provider names a database file from the handle's id, so a
    // fixed space would find the rows an earlier run left.
    signer = await Identity.fromPassphrase(
      `sqlite-handle-source-update-${crypto.randomUUID()}`,
    );
    space = signer.did();
    server = newSharedServer();
    runtime = connect();
  });

  afterEach(async () => {
    await runtime.dispose();
    await server.close();
  });

  /** Starts a piece running `program` and returns its result cell. */
  async function start(program: RuntimeProgram): Promise<Piece> {
    const pattern = await runtime.patternManager.compilePattern(program, {
      space,
    });
    const piece = runtime.getCell<Record<string, unknown>>(space, "piece");
    await runtime.runSynced(piece, pattern, {});
    await settle(piece);
    return piece;
  }

  /**
   * Updates `piece` to `program` as the updater does: it points the piece at
   * the new pattern, then sets the piece up under it.
   */
  async function update(piece: Piece, program: RuntimeProgram): Promise<void> {
    const pattern = await runtime.patternManager.compilePattern(program, {
      space,
    });
    const ref = runtime.patternManager.getArtifactEntryRef(pattern)!;
    const stamp = runtime.edit();
    piece.withTx(stamp).setMetaRaw("patternIdentity", {
      identity: ref.identity,
      symbol: ref.symbol,
    }, rawMetaWriteAuthorization);
    expect((await stamp.commit().settled).error).toBeUndefined();
    await runtime.runSynced(piece.withTx(), pattern, undefined, {
      expectedPatternIdentity: ref,
    });
    await settle(piece);
  }

  async function settle(piece: Piece): Promise<void> {
    await runtime.settled();
    await piece.pull();
    await runtime.settled();
  }

  /** The value of the handle `piece` holds. */
  function handleOf(piece: Piece): SqliteDbRef {
    return piece.key("db").resolveAsCell().getRaw() as unknown as SqliteDbRef;
  }

  /** The schema of the reference to the guard on `piece`'s result. */
  function guardSchemaOf(piece: Piece): unknown {
    return parseLink(piece.getRaw()?.guard, piece)?.schema;
  }

  async function send(piece: Piece, event: unknown): Promise<void> {
    piece.key("insert").send(event);
    await settle(piece);
  }

  async function rows(
    db: SqliteDbRef,
    sql: string,
  ): Promise<Record<string, unknown>[]> {
    const result = await runtime.storageManager.open(space).sqliteQuery!(
      db,
      sql,
    );
    return result.rows as Record<string, unknown>[];
  }

  describe("a database", () => {
    it("keeps its handle and rows when its declaration gains a column", async () => {
      const piece = await start(databaseProgram(false));
      const before = handleOf(piece);
      await send(piece, { body: "first" });

      await update(piece, databaseProgram(true));

      const after = handleOf(piece);
      expect(after.id).toBe(before.id);
      await send(piece, { body: "second" });
      expect(await rows(after, "SELECT body, tag FROM notes ORDER BY id"))
        .toEqual([
          { body: "first", tag: null },
          { body: "second", tag: null },
        ]);
    });
  });

  describe("an indexed collection", () => {
    it("keeps its handle and members when a module constant changes", async () => {
      // The guard's write policy names `add` by the identity of its module,
      // which any change to the module's source changes. The collection is
      // declared over a reference to the guard carrying that schema, so the
      // update changes what the collection is declared with.

      const piece = await start(collectionProgram(200));
      const before = handleOf(piece);
      const guardSchema = guardSchemaOf(piece);
      await send(piece, { title: "first" });

      await update(piece, collectionProgram(199));

      expect(guardSchemaOf(piece)).not.toEqual(guardSchema);
      const after = handleOf(piece);
      expect(after.id).toBe(before.id);
      expect(await rows(after, "SELECT title FROM topics")).toEqual([
        { title: "first" },
      ]);
    });
  });

  describe("a piece whose output spot links to a handle of its own", () => {
    it("keeps that handle and its rows in a runtime that has not loaded them", async () => {
      // The piece is set up without running its node, so the handle the node
      // mints holds nothing, and the node's output spot links to a handle the
      // piece holds under another cause, as a piece can. A second runtime,
      // which has read none of it, makes the update.

      const pattern = await runtime.patternManager.compilePattern(
        databaseProgram(false),
        { space },
      );
      const setUp = runtime.getCell<Record<string, unknown>>(space, "piece");
      await runtime.setup(undefined, pattern, {}, setUp);
      await settle(setUp);
      const spot = runtime.getCellFromLink(
        parseLink(setUp.getRaw()?.db, setUp)!,
      );
      const earlier = runtime.getCell(space, "earlier-handle");
      const held: SqliteDbRef = {
        id: stripEntityUriScheme(earlier.getAsNormalizedFullLink().id),
        tables: { notes: table({ id: "integer primary key", body: "text" }) },
        scope: "space",
      };
      const plant = runtime.edit();
      earlier.withTx(plant).setRawUntyped(fabricFromConvertibleJsValue(held));
      setResultCell(earlier.withTx(plant), setUp);
      spot.withTx(plant).setRawUntyped(earlier.getAsLink());
      plant.recordSqliteWrite!(space, {
        op: "sqlite",
        db: held,
        sql: "INSERT INTO notes (body) VALUES (?)",
        params: ["first"],
      });
      expect((await plant.commit().settled).error).toBeUndefined();
      await runtime.dispose();
      runtime = connect();
      const piece = runtime.getCell<Record<string, unknown>>(space, "piece");
      await piece.sync();

      await update(piece, databaseProgram(true));

      const after = handleOf(piece);
      expect(after.id).toBe(held.id);
      await send(piece, { body: "second" });
      expect(await rows(after, "SELECT body, tag FROM notes ORDER BY id"))
        .toEqual([
          { body: "first", tag: null },
          { body: "second", tag: null },
        ]);
    });
  });
});
