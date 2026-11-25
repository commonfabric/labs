import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { Runtime } from "../../src/runtime.ts";
import { openStorage } from "./storage.ts";

/** What the tests read of the result of `Filtered`. */
interface ListResult {
  items: { title: string }[];
  pinned: { title: string }[];
  last: string;
}

/** The position of each button of a row among the children of its view. */
const BUTTONS = { remove: 1, pin: 2, note: 3 } as const;

// `fixtures/row-event-reference.tsx`: the rows of `Filtered` are a `map` over
// a `computed` that filters the items, and each row's buttons send the list's
// `removeItem`, `pinItem` and `noteItem` the row's own item, as the rows of
// the todo list do.
describe("an event that a row of a compiled piece sends with the row's item", () => {
  let space: MemorySpace;
  let runtime: Runtime;
  let piece: CompiledPiece | undefined;
  let result: Cell<Record<string, unknown>>;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase(
      "compiled row event reference",
    );
    space = signer.did();
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: openStorage(signer),
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../../../../base/pattern-compiler/compare/fixtures/row-event-reference.emit.json",
          import.meta.url,
        ),
      ),
    ) as { patterns: Artifact[] }[];
    result = runtime.getCell<Record<string, unknown>>(space, "list");
    const tx = runtime.edit();
    piece = startCompiledPiece(
      runtime,
      tx,
      patterns.find(({ name }) => name === "Filtered")!,
      { items: [], pinned: [] },
      result.withTx(tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    for (const title of ["a", "b", "c"]) {
      result.key("addItem").send({ title } as never);
      await runtime.scheduler.idleWithPendingCommits();
    }
  });

  afterEach(async () => {
    piece?.stop();
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.dispose();
  });

  /** Sends the button `button` of the row at `row` an event. */
  const click = async (row: number, button: keyof typeof BUTTONS) => {
    result.key("rows").key(row).key("$UI").key("children")
      .key(BUTTONS[button]).key("props").key("onClick")
      .send({} as never);
    await runtime.scheduler.idleWithPendingCommits();
  };

  /** What the piece holds now. */
  const held = () => piece!.instance.result() as ListResult;

  it("removes the item of the row whose button sends it", async () => {
    await click(1, "remove");

    expect(piece!.refusals).toEqual([]);
    expect(held().items.map(({ title }) => title)).toEqual(["a", "c"]);
  });

  it("pins the item of a row once however often its button sends it", async () => {
    await click(2, "pin");
    await click(2, "pin");
    await click(0, "pin");

    expect(piece!.refusals).toEqual([]);
    expect(held().pinned.map(({ title }) => title)).toEqual(["c", "a"]);
  });

  it("hands the list the title of the item of the row whose button sends it", async () => {
    await click(2, "note");

    expect(piece!.refusals).toEqual([]);
    expect(held().last).toBe("c");
  });

  it("removes the item that an event sent from outside names by a link", async () => {
    result.key("removeItem").send(
      { item: result.key("items").key(2) } as never,
    );
    await runtime.scheduler.idleWithPendingCommits();

    expect(piece!.refusals).toEqual([]);
    expect(held().items.map(({ title }) => title)).toEqual(["a", "b"]);
  });
});
