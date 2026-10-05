/**
 * What `handlePieceGet()` loads into a fresh replica. The answer is an
 * address — a cell with the schema it is read under — so the fixture is a
 * piece whose result reaches documents the answer does not need: a list, and
 * the items the list's entries link to. Those must stay cold whichever way the
 * address is given — the piece's id, a slug naming the piece, a slug naming a
 * cell inside it, or a slug naming a document that is no piece. A second
 * runtime on the same server is what makes "never asked for" observable: the
 * reader's replica holds a record for every document it examined and none for
 * the rest. Nothing runs: the handler only asks whether a document carries a
 * pattern pointer, which a stamped `patternIdentity` is.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { JSONSchema } from "@commonfabric/api";
import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { createSession, Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { assignSlug, setSlugLink } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  entityIdFrom,
  type Pattern,
  Runtime,
  slugIdForSpace,
} from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import type { SpaceReplica } from "@commonfabric/runner/storage/v2";

import { createCellRef } from "@/backends/utils.ts";
import { RequestType } from "@/protocol/mod.ts";
import { buildProcessor } from "./build-processor.ts";

const signer = await Identity.fromPassphrase("runtime-client piece get");

/** The shape of one item, and so of the list's entries. */
const itemSchema = {
  type: "object",
  properties: { title: { type: "string" } },
} as const satisfies JSONSchema;

/** The shape of the list, as the piece's argument and result both declare it. */
const listSchema = {
  type: "array",
  items: itemSchema,
} as const satisfies JSONSchema;

/** The piece's result: the list, under `items`. */
const resultSchema = {
  type: "object",
  properties: { items: listSchema },
} as const satisfies JSONSchema;

describe("handlePieceGet()", () => {
  let server: MemoryV2Server.Server;
  let space: MemorySpace;
  let writerStorage: EmulatedStorageManager;
  let writerRuntime: Runtime;
  let writerPieces: PiecesController;
  let readerStorage: EmulatedStorageManager;
  let readerRuntime: Runtime;
  let readerPieces: PiecesController;
  let pieceId: string;
  let pieceUri: URI;
  let noteUri: URI;
  let listUri: URI;
  let itemUri: URI;

  /** The document `slug` redirects from, as a piece id the handler takes. */
  function slugDocumentId(slug: string): string {
    return entityIdFrom(slugIdForSpace(space, slug)).taggedHashString;
  }

  /** The schema a ref carries for a cell read under `schema`. */
  function refSchema(schema: JSONSchema): JSONSchema | undefined {
    return createCellRef(writerRuntime.getCell(space, "schema-probe", schema))
      .schema;
  }

  /** Whether the reader's replica ever examined the document at `uri`. */
  function readerExamined(uri: URI): boolean {
    const replica = readerStorage.open(space).replica as SpaceReplica;
    return replica.accessForTestingOnly.hasDocumentRecord(uri, "space");
  }

  /** The handler over the reader, awaited until every load it began landed. */
  async function get(requested: string) {
    const processor = buildProcessor({
      runtime: readerRuntime,
      cc: readerPieces,
      space,
      identity: signer,
    });
    const response = await processor.handlePieceGet({
      type: RequestType.PieceGet,
      pieceId: requested,
      space,
      runIt: false,
    });
    // Every load the reads registered has been issued and answered, so a
    // document the reader never examined here was never asked for.
    await readerPieces.synced();
    return response;
  }

  beforeEach(async () => {
    server = newLoopbackServer();
    space = (await Identity.generate()).did();
    writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    writerRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: writerStorage,
    });
    writerPieces = new PiecesController(
      createSession({ identity: signer, spaceDid: space }),
      writerRuntime,
    );
    await writerPieces.synced();

    // The list holds links to its items, so reading the list's value reaches
    // the items' documents.
    const item = writerRuntime.getCell<{ title: string }>(
      space,
      "item-" + crypto.randomUUID(),
      itemSchema,
    );
    const list = writerRuntime.getCell<{ title: string }[]>(
      space,
      "list-" + crypto.randomUUID(),
      listSchema,
    );
    await writerRuntime.editWithRetry((tx) => {
      item.withTx(tx).set({ title: "first" });
      list.withTx(tx).set([item]);
    });
    itemUri = item.getAsNormalizedFullLink().id;
    listUri = list.getAsNormalizedFullLink().id;

    // The piece's result reaches the list through its argument. Stamped with
    // a pattern pointer rather than compiled from source: the handler asks
    // whether the pointer is there and never follows it.
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: { items: listSchema } },
      resultSchema,
      result: { items: { $alias: { cell: "argument", path: ["items"] } } },
      nodes: [],
    };
    const piece = await writerPieces.runPersistent<{ items: unknown[] }>(
      writerRuntime.unsafeTrustPattern(pattern, {
        reason: "piece get test fixture",
      }),
      { items: list },
      undefined,
      { start: false },
    );
    await writerRuntime.editWithRetry((tx) => {
      piece.withTx(tx).setMetaRaw(
        "patternIdentity",
        { identity: "pattern-piece-get", symbol: "default" },
        rawMetaWriteAuthorization,
      );
    });
    pieceId = entityRefToString(piece.entityId);
    pieceUri = piece.getAsNormalizedFullLink().id;
    await assignSlug(writerPieces, piece, "board");
    await setSlugLink(writerPieces, "inside", piece.key("items"));

    // A document that is no piece, holding the same list.
    const note = writerRuntime.getCell<{ items: unknown }>(
      space,
      "note-" + crypto.randomUUID(),
    );
    await writerRuntime.editWithRetry((tx) => {
      note.withTx(tx).set({ items: list });
    });
    noteUri = note.getAsNormalizedFullLink().id;
    await setSlugLink(writerPieces, "note", note);
    await writerPieces.synced();

    readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    readerRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: readerStorage,
    });
    readerPieces = new PiecesController(
      createSession({ identity: signer, spaceDid: space }),
      readerRuntime,
    );
    await readerPieces.synced();
  });

  afterEach(async () => {
    await readerRuntime?.dispose();
    await readerStorage?.close();
    await writerRuntime?.dispose();
    await writerStorage?.close();
    await server?.close();
  });

  it("returns the piece with its result schema for its id, leaving the result's documents cold", async () => {
    const response = await get(pieceId);
    expect(response.piece.cell).toMatchObject({ id: pieceUri, path: [] });
    expect(response.piece.cell.schema).toEqual(refSchema(resultSchema));
    expect(readerExamined(listUri)).toBe(false);
    expect(readerExamined(itemUri)).toBe(false);
  });

  it("returns the piece with its result schema for a slug naming it, leaving the result's documents cold", async () => {
    const response = await get(slugDocumentId("board"));
    expect(response.piece.cell).toMatchObject({ id: pieceUri, path: [] });
    expect(response.piece.cell.schema).toEqual(refSchema(resultSchema));
    expect(readerExamined(listUri)).toBe(false);
    expect(readerExamined(itemUri)).toBe(false);
  });

  it("returns a cell inside the piece under the result schema at its path for a slug naming it, leaving the items cold", async () => {
    // The server resolves a redirect through the links on its path when it
    // serves the slug document, so the list the path reaches arrives with
    // it; what the handler must not add is the value behind the address,
    // which is where the items are.
    const response = await get(slugDocumentId("inside"));
    expect(response.piece.cell).toMatchObject({
      id: pieceUri,
      path: ["items"],
    });
    expect(response.piece.cell.schema).toEqual(refSchema(listSchema));
    expect(readerExamined(itemUri)).toBe(false);
  });

  it("returns a document that is no piece for a slug naming it, leaving what its value reaches cold", async () => {
    const response = await get(slugDocumentId("note"));
    expect(response.piece.cell).toMatchObject({ id: noteUri, path: [] });
    expect(response.piece.cell.schema).toBeUndefined();
    expect(readerExamined(listUri)).toBe(false);
    expect(readerExamined(itemUri)).toBe(false);
  });
});
