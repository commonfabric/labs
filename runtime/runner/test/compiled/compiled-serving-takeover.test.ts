import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  type CompiledServingMemoryServer,
  listenCompiledServingMemoryServer,
} from "../../src/compiled/serving-memory-server.deno.ts";
import type { ResumedPiece } from "../../src/compiled/resume.ts";
import type { PatternProgram } from "../../src/compiled/serving.ts";
import { setUpCompiledPiece } from "../../src/compiled/setup.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { rowsRead } from "./storage.ts";

const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        `../../../../base/pattern-compiler/compare/fixtures/${name}.emit.json`,
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

/** The program of one file of `compare/fixtures/`. */
const programOf = async (name: string): Promise<PatternProgram> => ({
  main: `/${name}.tsx`,
  files: [{
    name: `/${name}.tsx`,
    contents: await Deno.readTextFile(
      new URL(
        `../../../../base/pattern-compiler/compare/fixtures/${name}.tsx`,
        import.meta.url,
      ),
    ),
  }],
});

type Item = { id: string; title: string; done: boolean };
type Row = { label: string; done: boolean };
type List = { rows: Row[]; events: number };

/** The labels of the rows of a list of `count` items that no event changed. */
const labels = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `t${index}!`);

// `fixtures/serving-list.tsx` is a `map` over an array that the type
// declares as references, given here as an array of references, each to an
// item in a document of its own, and each row is stored in a document of
// its own. Another serving loop takes the space over, finds the piece
// current from its basis, and is then sent one event that gives one item
// another title.
describe("the first event after another serving loop took a compiled piece over", () => {
  let signer: Identity;
  let space: MemorySpace;
  let serving: CompiledServingMemoryServer;
  let clients: Runtime[];
  let cancels: (() => void)[];
  /** The pieces a serving runtime resumed from their basis. */
  let resumed: ResumedPiece[];

  /**
   * A client of the serving memory server, over its websocket, with server
   * execution on: it runs no handler and no derivation of the piece.
   */
  const client = (): Runtime => {
    const runtime = new Runtime({
      apiUrl: serving.url,
      storageManager: StorageManager.open({
        as: signer,
        memoryHost: serving.url,
      }),
      experimental: { serverExecution: true },
    });
    clients.push(runtime);
    return runtime;
  };

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("compiled piece unit resume");
    space = signer.did();
    resumed = [];
    serving = await listenCompiledServingMemoryServer({
      // The crate's binary is not run here: what stands in its place gives
      // the artifact the crate emitted for the fixture.
      compile: async (program) => ({
        main: await artifactOf(program.main.slice(1, -".tsx".length)),
        artifacts: () => undefined,
      }),
      pieces: { resumed: (_result, piece) => resumed.push(piece) },
    });
    clients = [];
    cancels = [];
  });

  afterEach(async () => {
    for (const cancel of cancels) cancel();
    await serving.host.close();
    for (const runtime of clients) await runtime.dispose();
    await serving.close();
  });

  /** Commits what `write` writes in `runtime`. */
  const commit = async (
    runtime: Runtime,
    write: (tx: ReturnType<Runtime["edit"]>) => void,
  ) => {
    const tx = runtime.edit();
    write(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  /** Waits until `cell` holds rows with `expected` as their labels. */
  const holds = (runtime: Runtime, cell: Cell<List>, expected: string[]) =>
    waitForCellValue<List>(
      runtime,
      cell,
      (value) =>
        JSON.stringify(rowsRead<Row>(value?.rows).map((row) => row?.label)) ===
          JSON.stringify(expected),
      { stuckLabel: `a client reads ${expected.length} rows` },
    );

  /** The result cell of the piece as `runtime` reads it, kept in sync. */
  const reading = (runtime: Runtime, result: Cell<List>): Cell<List> => {
    const cell = runtime.getCellFromLink<List>(
      result.getAsNormalizedFullLink(),
    );
    cancels.push(cell.sink(() => {}));
    return cell;
  };

  /**
   * Sets the list up over `count` items and has another serving loop take
   * the space over, which finds the piece current and starts no executor.
   * Returns the client that set the list up with its cell of the result,
   * a second client that holds the result, and how many documents the
   * replica of the serving runtime had read from the store by then.
   */
  const takenOver = async (count: number) => {
    const sender = client();
    const program = await programOf("serving-list");
    const items = sender.getCell<Item[]>(space, "items");
    await commit(sender, (tx) => {
      const members = Array.from({ length: count }, (_, index) => {
        const member = sender.getCell<Item>(
          space,
          `item ${index}`,
          undefined,
          tx,
        );
        member.set({ id: `i${index}`, title: `t${index}`, done: false });
        return member;
      });
      items.withTx(tx).set(members as never);
    });
    const result = sender.getCell<List>(space, "list");
    await commit(sender, (tx) => {
      setUpCompiledPiece(sender, tx, program, { items }, result.withTx(tx));
    });
    const cell = reading(sender, result);
    await holds(sender, cell, labels(count));
    await serving.host.whenQuiescent();

    await serving.restart();
    // The read of a client that holds nothing is the demand that has the
    // loop reach the piece.
    const reader = client();
    const read = reading(reader, result);
    await holds(reader, read, labels(count));
    await serving.host.whenQuiescent();
    expect(resumed.map(({ current }) => current)).toEqual([true]);
    expect(serving.pieces()).toEqual([]);
    return {
      sender,
      cell,
      reader,
      read,
      result,
      readBefore: serving.host.stats().storeReads,
    };
  };

  /** Sends `event` to the stream `name` of the result `cell` holds. */
  const send = (cell: Cell<List>, name: string, event: unknown) =>
    (cell.key(name as never) as unknown as Cell<unknown>).send(event);

  /**
   * What the serving runtime that took a list of `count` items over did
   * for the event that gives the item at `at` the title `renamed`, counted
   * from when its loop was quiescent after the takeover: how many entries
   * its executor evaluated and how many documents its replica read from
   * the store.
   */
  const firstEventAfterTakeover = async (count: number, at: number) => {
    const { cell, reader, read, readBefore } = await takenOver(count);

    send(cell, "rename", { at, title: "renamed" });
    const expected = labels(count);
    expected[at] = "renamed!";
    const value = await holds(reader, read, expected);
    await serving.host.whenQuiescent();

    const [piece] = serving.pieces();
    return {
      evaluations: piece.instance.counts.evaluations,
      storeReads: serving.host.stats().storeReads - readBefore,
      refusals: piece.refusals,
      events: value.events,
    };
  };

  // The four evaluations: the result, the assembly of the rows with no
  // body evaluated, the body of the element whose item changed, and the
  // assembly again for that row.
  it("evaluates the row of the item an event gave another title and no other row, at 100 rows", async () => {
    const counted = await firstEventAfterTakeover(100, 41);

    expect(counted.refusals).toEqual([]);
    expect(counted.events).toBe(1);
    expect(counted.evaluations).toBe(4);
  });

  it("evaluates as many entries at 1,000 rows as at 100", async () => {
    const counted = await firstEventAfterTakeover(1_000, 641);

    expect(counted.refusals).toEqual([]);
    expect(counted.evaluations).toBe(4);
  });

  it("reads a number of documents from the store that does not follow the rows, at 100 rows", async () => {
    const counted = await firstEventAfterTakeover(100, 41);

    expect(counted.storeReads).toBeLessThan(20);
  });

  it("reads no more documents from the store at 1,000 rows than at 100", async () => {
    const counted = await firstEventAfterTakeover(1_000, 641);

    expect(counted.storeReads).toBeLessThan(20);
  });

  it("evaluates the row of an item a client changed, and no other row, when that change wakes the piece", async () => {
    const { sender, reader, read } = await takenOver(100);
    const item = sender.getCell<Item>(space, "item 7");
    await item.sync();

    await commit(sender, (tx) => item.withTx(tx).key("title").set("late"));

    const expected = labels(100);
    expected[7] = "late!";
    await holds(reader, read, expected);
    await serving.host.whenQuiescent();
    const [piece] = serving.pieces();
    expect(piece.refusals).toEqual([]);
    // The result, the assembly of the rows, and the body of the one row.
    expect(piece.instance.counts.evaluations).toBe(3);
  });

  it("goes on from the rows it left as stored: an added item, another item renamed, and a third serving loop that finds the piece current", async () => {
    const { cell, reader, read, result } = await takenOver(100);
    const expected = labels(100);

    send(cell, "rename", { at: 41, title: "renamed" });
    expected[41] = "renamed!";
    await holds(reader, read, expected);
    send(cell, "add", { id: "new", title: "added" });
    expected.push("added!");
    await holds(reader, read, expected);
    send(cell, "rename", { at: 100, title: "again" });
    expected[100] = "again!";
    await holds(reader, read, expected);
    send(cell, "rename", { at: 3, title: "third" });
    expected[3] = "third!";
    await holds(reader, read, expected);
    await serving.host.whenQuiescent();
    const [piece] = serving.pieces();
    expect(piece.refusals).toEqual([]);
    // The body of each row an event reached, once for each event that
    // reached it: the row of the added item twice. No other body.
    expect(piece.instance.counts.elementEvaluations).toBe(4);

    resumed = [];
    await serving.restart();
    const third = client();
    await holds(third, reading(third, result), expected);
    await serving.host.whenQuiescent();

    expect(resumed.map(({ current }) => current)).toEqual([true]);
    expect(serving.pieces()).toEqual([]);
  });
});
