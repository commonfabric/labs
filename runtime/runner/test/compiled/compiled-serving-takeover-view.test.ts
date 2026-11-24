import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Cell } from "../../src/cell.ts";
import { setUpCompiledPiece } from "../../src/compiled/setup.ts";
import { rowCell, rowsRead } from "./storage.ts";
import { programOf, servingTakeover } from "./takeover-harness.ts";

type Item = { id: string; title: string; done: boolean };
type Node = { children: unknown[]; props: Record<string, unknown> };
type View = { $UI: { children: [Node, Node[]] }; events: number };

/** The texts of the rows of `count` items that no event changed. */
const titles = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `t${index}!`);

// `fixtures/serving-list-view.tsx` is a `map` over an array that the type
// declares as references, given here as an array of references, each to an
// item in a document of its own. The `map` stands among the children of a
// view node, at no path of the result that the plan names, each row is a
// view node stored in a document of its own, and the body of each element
// binds a handler. Another serving loop takes the space over, finds the
// piece current from its basis, and is then sent one event.
describe("the first event after another serving loop took over a compiled piece whose rows stand in a view node", () => {
  const takeover = servingTakeover("compiled piece unit resume view");
  type Client = Parameters<typeof takeover.until>[0];

  /** Waits until `cell` holds a row for each of `expected`, in order. */
  const holds = (
    runtime: Client,
    cell: Cell<View>,
    expected: string[],
    events?: number,
  ) =>
    takeover.until<View>(
      runtime,
      cell,
      (value) =>
        JSON.stringify(
            rowsRead<Node>(value?.$UI?.children?.[1]).map((row) =>
              row?.children?.[0]
            ),
          ) === JSON.stringify(expected) &&
        (events === undefined || value?.events === events),
      `a client reads ${expected.length} rows`,
    );

  /**
   * Sets the list up over `count` items and has another serving loop take
   * the space over, which finds the piece current and starts no executor.
   */
  const takenOver = async (count: number) => {
    const { space } = takeover;
    const sender = takeover.client();
    const program = await programOf("serving-list-view");
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
    const result = sender.getCell<View>(space, "list");
    await takeover.commit(sender, (tx) => {
      setUpCompiledPiece(sender, tx, program, { items }, result.withTx(tx));
    });
    const cell = takeover.reading(sender, result);
    await holds(sender, cell, titles(count));
    await takeover.serving.host.whenQuiescent();

    await takeover.takeOver();
    // The read of a client that holds nothing is the demand that has the
    // loop reach the piece.
    const reader = takeover.client();
    const read = takeover.reading(reader, result);
    await holds(reader, read, titles(count));
    await takeover.serving.host.whenQuiescent();
    expect(takeover.resumed.map(({ current }) => current)).toEqual([true]);
    expect(takeover.serving.pieces()).toEqual([]);
    return { sender, cell, reader, read, result };
  };

  /** The cell of the stream `name` of the result. */
  const streamOf = (cell: Cell<View>, name: string) =>
    cell.key(name as never) as unknown as Cell<unknown>;

  /** The cell of the stream that the row at `at` holds as `onClick`. */
  const clickOf = (cell: Cell<View>, at: number) =>
    rowCell<Node>(
      cell.key("$UI").key("children").key(1) as unknown as Cell<unknown>,
      at,
    ).key("props").key("onClick") as unknown as Cell<unknown>;

  it("evaluates the body of the row of the item an event gave another title, and of no other row, at 100 rows", async () => {
    const { sender, cell, reader, read } = await takenOver(100);

    await takeover.send(sender, streamOf(cell, "rename"), {
      at: 41,
      title: "renamed",
    });
    const expected = titles(100);
    expected[41] = "renamed!";
    await holds(reader, read, expected, 1);
    await takeover.serving.host.whenQuiescent();

    const [piece] = takeover.serving.pieces();
    expect(piece.refusals).toEqual([]);
    expect(piece.instance.counts.elementEvaluations).toBe(1);
  });

  it("evaluates as many bodies at 1,000 rows as at 100", async () => {
    const { sender, cell, reader, read } = await takenOver(1_000);

    await takeover.send(sender, streamOf(cell, "rename"), {
      at: 641,
      title: "renamed",
    });
    const expected = titles(1_000);
    expected[641] = "renamed!";
    await holds(reader, read, expected, 1);
    await takeover.serving.host.whenQuiescent();

    const [piece] = takeover.serving.pieces();
    expect(piece.refusals).toEqual([]);
    expect(piece.instance.counts.elementEvaluations).toBe(1);
  });

  // The body of the row before the body of its handler, and again by the
  // derivation behind the event, which changed the title the row reads.
  it("handles an event to the stream of a row and evaluates the body of that row and of no other row", async () => {
    const { sender, cell, reader, read } = await takenOver(100);

    await takeover.send(sender, clickOf(cell, 7), { title: "clicked" });
    const expected = titles(100);
    expected[7] = "clicked!";
    await holds(reader, read, expected, 1);
    await takeover.serving.host.whenQuiescent();

    const [piece] = takeover.serving.pieces();
    expect(piece.refusals).toEqual([]);
    expect(piece.instance.counts.elementEvaluations).toBe(2);
  });

  it("goes on from the rows it left as stored: an added item, and a third serving loop that finds the piece current", async () => {
    const { sender, cell, reader, read, result } = await takenOver(100);
    const expected = titles(100);

    await takeover.send(sender, clickOf(cell, 7), { title: "clicked" });
    expected[7] = "clicked!";
    await holds(reader, read, expected, 1);
    await takeover.send(sender, streamOf(cell, "add"), {
      id: "new",
      title: "added",
    });
    expected.push("added!");
    await holds(reader, read, expected, 2);
    await takeover.send(sender, streamOf(cell, "rename"), {
      at: 3,
      title: "third",
    });
    expected[3] = "third!";
    await holds(reader, read, expected, 3);
    await takeover.serving.host.whenQuiescent();
    const [piece] = takeover.serving.pieces();
    expect(piece.refusals).toEqual([]);
    // Two bodies for the event to the stream of a row, one for the row of
    // the added item, and one for the row of the item renamed.
    expect(piece.instance.counts.elementEvaluations).toBe(4);

    await takeover.takeOver();
    const third = takeover.client();
    await holds(third, takeover.reading(third, result), expected, 3);
    await takeover.serving.host.whenQuiescent();

    expect(takeover.resumed.map(({ current }) => current)).toEqual([true]);
    expect(takeover.serving.pieces()).toEqual([]);
  });
});
