import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Cell } from "../../src/cell.ts";
import { setUpCompiledPiece } from "../../src/compiled/setup.ts";
import { rowCell, rowsRead } from "./storage.ts";
import { programOf, servingTakeover } from "./takeover-harness.ts";

type Item = { id: string; title: string; done: boolean };
type Row = { label: string; retitle: unknown };
type List = { rows: Row[]; events: number };

/** The labels of the rows of a list of `count` items that no event changed. */
const labels = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `${index} t${index}`);

// `fixtures/serving-list-derived.tsx` is a `map` over a `filter` over an
// array that the type declares as references, given here as an array of
// references, each to an item in a document of its own. The body of an
// element of the `map` reads the position of its element and binds a
// handler. Another serving loop takes the space over, finds the piece
// current from its basis, and is then sent an event.
describe("the first event after another serving loop took over a compiled piece whose rows are those of a `map` over a `filter`", () => {
  const takeover = servingTakeover("compiled piece unit resume derived");

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
    const program = await programOf("serving-list-derived");
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
    return { sender, cell, reader, read };
  };

  // The body of the `filter` for each item, which the wake evaluates
  // once, and the body of the row before the body of its handler and
  // again behind the event.
  it("handles an event to the stream of a row and evaluates the body of that row and of no other row", async () => {
    const count = 100;
    const { sender, cell, reader, read } = await takenOver(count);

    await takeover.send(
      sender,
      rowCell<Row>(cell.key("rows") as unknown as Cell<unknown>, 41).key(
        "retitle" as never,
      ) as unknown as Cell<
        unknown
      >,
      { title: "renamed" },
    );
    const expected = labels(count);
    expected[41] = "41 renamed";
    await holds(reader, read, expected, 1);
    await takeover.serving.host.whenQuiescent();

    const [piece] = takeover.serving.pieces();
    expect(piece.refusals).toEqual([]);
    expect(piece.instance.counts.rowsLeftStored).toBe(count);
    expect(piece.instance.counts.elementEvaluations).toBe(count + 2);
  });

  // The item at 90 leaves the result of the `filter`: its row is taken
  // out, and the position of each of the nine rows behind it changes.
  it("evaluates the body of each row behind one that the `filter` drops", async () => {
    const count = 100;
    const { sender, cell, reader, read } = await takenOver(count);

    await takeover.send(
      sender,
      cell.key("finish" as never) as unknown as Cell<unknown>,
      { at: 90, done: true },
    );
    const expected = labels(count).filter((_, index) => index !== 90).map(
      (label, index) => index < 90 ? label : `${index} t${index + 1}`,
    );
    await holds(reader, read, expected, 1);
    await takeover.serving.host.whenQuiescent();

    const [piece] = takeover.serving.pieces();
    expect(piece.refusals).toEqual([]);
    // The body of the `filter` for each item at the wake and for the item
    // that changed, and the body of each of the nine rows that moved.
    expect(piece.instance.counts.elementEvaluations).toBe(count + 1 + 9);
  });
});
