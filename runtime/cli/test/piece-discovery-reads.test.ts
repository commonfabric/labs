import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { createSession, Identity } from "@commonfabric/identity";
import type { Cell } from "@commonfabric/runner";
import { Runtime } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "@commonfabric/piece/ops";

import {
  describePiece,
  getCellValue,
  listPieceCallables,
} from "../lib/piece.ts";

/**
 * A pattern shaped like the piece this file is about: one verb, a collection
 * whose members are documents of their own, a name, and two inline scalars.
 *
 * The collection is where a real piece's documents are — a board's topics, a
 * note's blocks — so its element type is the widest read anything could take,
 * and `Item` is what a watch under the declared result type would descend
 * into. The scalars and the name are the other half of the surface: they are
 * data, they sit beside the verb in the same result, and a discovery that
 * classifies from anything but the pattern's own declaration has a way to
 * mistake one of them for a callable.
 */
const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { action, Default, NAME, pattern, Stream } from "commonfabric";',
      "",
      "interface AddEvent { title: string; }",
      "interface Item { title: string; body: string; }",
      "",
      "interface In { items: Default<Item[], []>; }",
      "",
      "interface Out {",
      "  [NAME]: string;",
      "  title: string;",
      "  count: number;",
      "  items: Item[];",
      "  add: Stream<AddEvent>;",
      "}",
      "",
      "export default pattern<In, Out>(({ items }) => {",
      "  const add = action((event: AddEvent) => {",
      "    items.push({ title: event.title, body: 'body' });",
      "  });",
      "  return {",
      "    [NAME]: 'Test board',",
      "    title: 'Board',",
      "    count: 0,",
      "    items,",
      "    add,",
      "  };",
      "});",
    ].join("\n"),
  }],
};

/** The one verb the pattern declares. Asserted as the WHOLE list rather than
 * as membership: every other name in the result is data, and a listing that
 * offers data as callable is the failure that matters here — a caller shown
 * `count` as a verb cannot tell it from `add` until the call is refused. */
const DECLARED_VERBS = ["add"];

/** Whether `schema` is the pattern's declared result type — the read this file
 * exists to prove discovery never takes. Recognized by the element type only
 * the declared type names, so a bounded schema that happens to mention the
 * same property cannot pass for it. */
function isDeclaredResultType(schema: unknown): boolean {
  return JSON.stringify(schema ?? null).includes('"#/$defs/Item"');
}

/** The reader replica's loads, in the order it issued them: one entry per
 * document sync, carrying the schema the sync went out under. */
interface RecordedSync {
  id: string;
  schema: unknown;
}

/** How many documents the collection holds. Three rather than one, so a read
 * that reached the collection at all is distinguishable from one that reached
 * a single document by another route. */
const ITEM_COUNT = 3;

/** What a cold discovery did: the answer it produced, every sync it issued,
 * and which of the collection's documents its replica holds afterwards. */
interface ColdDiscovery<T> {
  result: T;
  syncs: RecordedSync[];

  /** The collection documents the reader's replica held once every load it
   * registered had been answered. Empty is the property under test. */
  itemsHeld: string[];
}

/**
 * Run `read` against a piece the reader replica has never seen, and return
 * what it read alongside what the read cost.
 *
 * Two replicas over one server, because the point is which documents travel: a
 * replica that wrote the piece already holds them, and a cold one asks for
 * exactly what it needs.
 *
 * The collection's members are separate documents, reached from the piece's
 * result through links, which is what makes `itemsHeld` an observation rather
 * than a restatement of the piece document. Inline members would travel inside
 * the piece's own document and could never be absent from it.
 */
async function readsOfColdDiscovery<T>(
  read: (
    pieces: PiecesController,
    pieceId: string,
    space: string,
  ) => Promise<T>,
): Promise<ColdDiscovery<T>> {
  // Every resource is registered for release the moment it exists, so a
  // failure while the next one is being built still closes what came before:
  // a loopback server or a runtime left open outlives the test that made it.
  const closers: (() => Promise<void>)[] = [];
  const release = async () => {
    for (const close of closers.reverse()) await close();
  };
  try {
    const signer = await Identity.fromPassphrase("cli piece discovery reads");
    const server = newLoopbackServer();
    closers.push(() => server.close());
    const spaceDid = (await Identity.generate()).did();

    const writerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    closers.push(() => writerStorage.close());
    const writerRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: writerStorage,
    });
    closers.push(() => writerRuntime.dispose());
    const writerPieces = new PiecesController(
      createSession({ identity: signer, spaceDid }),
      writerRuntime,
    );

    const readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    closers.push(() => readerStorage.close());
    const readerRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: readerStorage,
    });
    closers.push(() => readerRuntime.dispose());
    const readerPieces = new PiecesController(
      createSession({ identity: signer, spaceDid }),
      readerRuntime,
    );

    await writerPieces.synced();
    const space = writerPieces.getSpace();
    const compiled = await writerRuntime.patternManager.compilePattern(
      PROGRAM as never,
      { space },
    );

    // One document per member, each holding a value of its own, handed to the
    // pattern as cells so the piece's result reaches them through links.
    const items = Array.from(
      { length: ITEM_COUNT },
      (_unused, index) =>
        writerRuntime.getCell(
          space,
          `discovery-reads-item-${index}-` + crypto.randomUUID(),
          {
            type: "object",
            properties: { title: { type: "string" }, body: { type: "string" } },
          },
        ),
    );
    await writerRuntime.editWithRetry((tx) => {
      for (const [index, item] of items.entries()) {
        item.withTx(tx).set({ title: `Item ${index}`, body: `body ${index}` });
      }
    });
    const itemUris = items.map((item) =>
      item.getAsNormalizedFullLink().id as string
    );

    const piece = await writerPieces.runPersistent(
      compiled,
      { items },
      undefined,
      { start: true },
    );
    await writerPieces.synced();

    await readerPieces.synced();
    const syncs: RecordedSync[] = [];
    const manager = readerRuntime.storageManager as unknown as {
      syncCell: (cell: unknown, options?: unknown) => Promise<unknown>;
    };
    const syncCell = manager.syncCell.bind(manager);
    manager.syncCell = (cell: unknown, options?: unknown) => {
      const link = (cell as Cell<unknown>).getAsNormalizedFullLink();
      syncs.push({ id: link.id, schema: link.schema });
      return syncCell(cell, options);
    };

    const result = await read(
      readerPieces,
      entityRefToString(piece.entityId),
      space,
    );
    // Every load the read registered has been issued and answered, so a
    // document still absent below was never asked for, rather than still on
    // its way.
    await readerPieces.synced();

    // The replica's own record of what it holds. This is the observation the
    // sync log cannot make: a sync records what the reader NAMED, while a
    // watch delivers every document its schema reaches, named or not — which
    // is the whole shape of the cost this file is about.
    const provider = readerStorage.open(space) as {
      get?: (uri: string) => unknown;
    };
    const itemsHeld = itemUris.filter((uri) =>
      provider.get?.(uri) !== undefined
    );

    return { result, syncs, itemsHeld };
  } finally {
    await release();
  }
}

describe("piece discovery reads", () => {
  it("reads one result field without loading its linked siblings", async () => {
    const { result, itemsHeld } = await readsOfColdDiscovery((
      pieces,
      piece,
      space,
    ) =>
      getCellValue(
        {
          apiUrl: "http://localhost:8000",
          identity: "/tmp/test-identity.pem",
          piece,
          space,
        },
        ["title"],
        {},
        {
          loadPieces: () => Promise.resolve(pieces as never),
        },
      )
    );

    expect(result).toBe("Board");
    expect(itemsHeld).toEqual([]);
  });

  it("loads the linked members when reading their collection", async () => {
    const { result, itemsHeld } = await readsOfColdDiscovery((
      pieces,
      piece,
      space,
    ) =>
      getCellValue(
        {
          apiUrl: "http://localhost:8000",
          identity: "/tmp/test-identity.pem",
          piece,
          space,
        },
        ["items"],
        {},
        {
          loadPieces: () => Promise.resolve(pieces as never),
        },
      )
    );

    expect(result).toEqual(Array.from({ length: ITEM_COUNT }, (_, index) => ({
      title: `Item ${index}`,
      body: `body ${index}`,
    })));
    expect(itemsHeld).toHaveLength(ITEM_COUNT);
  });

  it("lists the verb without syncing under the declared result type", async () => {
    const { result, syncs, itemsHeld } = await readsOfColdDiscovery((
      pieces,
      piece,
      space,
    ) =>
      listPieceCallables({
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece,
        space,
      }, { loadPieces: () => Promise.resolve(pieces as never) })
    );

    // The listing is the whole point of paying anything at all, so it is
    // asserted beside the reads: a discovery that syncs nothing and lists
    // nothing has not been made cheaper, it has been broken. The name, the
    // two scalars and the collection are all in the declared result beside
    // the verb, and none of them is callable.
    expect(result.verbs.map((verb) => verb.name)).toEqual(DECLARED_VERBS);
    expect(result.verbs[0].kind).toBe("handler");
    // The event type the pattern declares, which is what
    // `cf piece call add --help` renders its flags from.
    expect(result.verbs[0].inputSchema).toMatchObject({
      properties: { title: { type: "string" } },
    });

    expect(itemsHeld).toEqual([]);
    expect(syncs.filter((sync) => isDeclaredResultType(sync.schema)))
      .toEqual([]);
  });

  it("describes the piece without syncing under the declared result type", async () => {
    const { result, syncs, itemsHeld } = await readsOfColdDiscovery((
      pieces,
      piece,
      space,
    ) =>
      describePiece({
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece,
        space,
      }, { loadPieces: () => Promise.resolve(pieces as never) })
    );

    // `describe`'s STATE section comes from the compiled pattern, not from a
    // projection of the piece, so it names every non-callable property of the
    // declared result without reading any of their values. The piece's name
    // is the one field `describe` does read, and it rides the piece's own
    // document.
    expect(result.name).toBe("Test board");
    expect(result.verbs.map((verb) => verb.name)).toEqual(DECLARED_VERBS);
    expect(result.state?.map((field) => field.name)).toEqual([
      "title",
      "count",
      "items",
    ]);

    expect(itemsHeld).toEqual([]);
    expect(syncs.filter((sync) => isDeclaredResultType(sync.schema)))
      .toEqual([]);
  });
});
