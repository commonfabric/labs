import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Cell } from "../../src/cell.ts";
import { setUpCompiledPiece } from "../../src/compiled/setup.ts";
import { rowCell, rowsRead } from "./storage.ts";
import { programOf, servingTakeover } from "./takeover-harness.ts";

type Item = { id: string; title: string; done: boolean };
type Row = { label: string; done: boolean; retitle: unknown; touch: unknown };
type List = { rows: Row[]; events: number };

/** The labels of the rows of a list of `count` items that no event changed. */
const labels = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `t${index}!`);

// `fixtures/serving-list-handlers.tsx` is a `map` over an array that the
// type declares as references, given here as an array of references, each
// to an item in a document of its own. Each row is stored in a document of
// its own and holds the streams of two handlers that the body of its
// element binds. Another serving loop takes the space over, finds the piece
// current from its basis, and is then sent an event for the stream of one
// row.
describe("an event to the stream of a row after another serving loop took a compiled piece over", () => {
  const takeover = servingTakeover("compiled piece unit resume handlers");

  /** Waits until `cell` holds rows with `expected` as their labels. */
  const holds = (
    runtime: Parameters<typeof takeover.until>[0],
    cell: Cell<List>,
    expected: string[],
    events?: number,
  ) =>
    takeover.until<List>(
      runtime,
      cell,
      (value) =>
        JSON.stringify(rowsRead<Row>(value?.rows).map((row) => row?.label)) ===
          JSON.stringify(expected) &&
        (events === undefined || value?.events === events),
      `a client reads ${expected.length} rows`,
    );

  /**
   * Sets the list up over `count` items and has another serving loop take
   * the space over, which finds the piece current and starts no executor.
   */
  const takenOver = async (count: number) => {
    const { space, serving } = takeover;
    const sender = takeover.client();
    const program = await programOf("serving-list-handlers");
    const items = sender.getCell<Item[]>(space, "items");
    await takeover.commit(sender, (tx) => {
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
    await takeover.commit(sender, (tx) => {
      setUpCompiledPiece(sender, tx, program, { items }, result.withTx(tx));
    });
    const cell = takeover.reading(sender, result);
    await holds(sender, cell, labels(count));
    await serving.host.whenQuiescent();

    await takeover.takeOver();
    // The read of a client that holds nothing is the demand that has the
    // loop reach the piece.
    const reader = takeover.client();
    const read = takeover.reading(reader, result);
    await holds(reader, read, labels(count));
    await takeover.serving.host.whenQuiescent();
    expect(takeover.resumed.map(({ current }) => current)).toEqual([true]);
    expect(takeover.serving.pieces()).toEqual([]);
    return {
      sender,
      cell,
      reader,
      read,
      result,
      readBefore: takeover.serving.host.stats().storeReads,
    };
  };

  /** Sends `event` to the stream `name` of the row at `at`. */
  const send = (
    runtime: Parameters<typeof takeover.until>[0],
    cell: Cell<List>,
    at: number,
    name: string,
    event: unknown,
  ) =>
    takeover.send(
      runtime,
      rowCell<Row>(cell.key("rows") as unknown as Cell<unknown>, at).key(
        name as never,
      ) as unknown as Cell<unknown>,
      event,
    );

  /**
   * What the serving runtime that took a list of `count` items over did
   * for the event that gives the item of the row at `at` another title,
   * sent to the stream of that row.
   */
  const retitled = async (count: number, at: number) => {
    const { sender, cell, reader, read, readBefore } = await takenOver(count);

    await send(sender, cell, at, "retitle", { title: "renamed" });
    const expected = labels(count);
    expected[at] = "renamed!";
    const value = await holds(reader, read, expected, 1);
    await takeover.serving.host.whenQuiescent();

    const [piece] = takeover.serving.pieces();
    return {
      evaluations: piece.instance.counts.evaluations,
      bodies: piece.instance.counts.elementEvaluations,
      storeReads: takeover.serving.host.stats().storeReads - readBefore,
      refusals: piece.refusals,
      events: value.events,
    };
  };

  // What the event to the stream of one row evaluates: the result, the
  // assembly of the rows with no body evaluated, the body of the row
  // before the body of its handler, and behind the event the body again,
  // the assembly for that row and the result.
  const EVALUATIONS = 5;

  // The body of the row is evaluated before the body of its handler, and
  // again by the derivation behind the event, which changed the title the
  // row reads.
  it("handles the event and evaluates the body of that row and of no other row, at 100 rows", async () => {
    const counted = await retitled(100, 41);

    expect(counted.refusals).toEqual([]);
    expect(counted.events).toBe(1);
    expect(counted.bodies).toBe(2);
    expect(counted.evaluations).toBe(EVALUATIONS);
  });

  it("evaluates as many entries at 1,000 rows as at 100", async () => {
    const counted = await retitled(1_000, 641);

    expect(counted.refusals).toEqual([]);
    expect(counted.bodies).toBe(2);
    expect(counted.evaluations).toBe(EVALUATIONS);
  });

  it("reads no more documents from the store at 1,000 rows than at 100", async () => {
    const counted = await retitled(1_000, 641);

    expect(counted.storeReads).toBeLessThan(24);
  });

  it("evaluates the body of the row once for an event whose handler writes nothing a row reads", async () => {
    const { sender, cell, reader, read } = await takenOver(100);

    await send(sender, cell, 7, "touch", {});
    await holds(reader, read, labels(100), 1);
    await takeover.serving.host.whenQuiescent();

    const [piece] = takeover.serving.pieces();
    expect(piece.refusals).toEqual([]);
    expect(piece.instance.counts.elementEvaluations).toBe(1);
  });

  it("evaluates the body of the row of an item that a client changes after an event woke the piece", async () => {
    const { sender, cell, reader, read } = await takenOver(100);
    await send(sender, cell, 7, "touch", {});
    await holds(reader, read, labels(100), 1);
    await takeover.serving.host.whenQuiescent();
    const item = sender.getCell<Item>(takeover.space, "item 9");
    await item.sync();

    await takeover.commit(
      sender,
      (tx) => item.withTx(tx).key("title").set("late"),
    );

    const expected = labels(100);
    expected[9] = "late!";
    await holds(reader, read, expected, 1);
    await takeover.serving.host.whenQuiescent();
    const [piece] = takeover.serving.pieces();
    expect(piece.refusals).toEqual([]);
    // The body of the row whose stream took the event, and the body of
    // the row whose item changed.
    expect(piece.instance.counts.elementEvaluations).toBe(2);
  });

  it("handles events to the streams of two rows and of a row added since, and a third serving loop finds the piece current", async () => {
    const { sender, cell, reader, read, result } = await takenOver(100);
    const expected = labels(100);

    await send(sender, cell, 41, "retitle", { title: "renamed" });
    expected[41] = "renamed!";
    await holds(reader, read, expected, 1);
    await takeover.send(
      sender,
      cell.key("add" as never) as unknown as Cell<unknown>,
      { id: "new", title: "added" },
    );
    expected.push("added!");
    await holds(reader, read, expected, 2);
    await holds(sender, cell, expected, 2);
    await send(sender, cell, 100, "retitle", { title: "again" });
    expected[100] = "again!";
    await holds(reader, read, expected, 3);
    await send(sender, cell, 3, "retitle", { title: "third" });
    expected[3] = "third!";
    await holds(reader, read, expected, 4);
    await takeover.serving.host.whenQuiescent();
    const [piece] = takeover.serving.pieces();
    expect(piece.refusals).toEqual([]);
    // Two bodies for each of the two events to the stream of a row left
    // as stored, one for the row of the added item, and one for the event
    // to the stream of that row, which this executor had evaluated.
    expect(piece.instance.counts.elementEvaluations).toBe(6);

    await takeover.takeOver();
    const third = takeover.client();
    await holds(third, takeover.reading(third, result), expected, 4);
    await takeover.serving.host.whenQuiescent();

    expect(takeover.resumed.map(({ current }) => current)).toEqual([true]);
    expect(takeover.serving.pieces()).toEqual([]);
  });
});
