/**
 * A builtin's run turns each object it writes into a list into a document of
 * its own. These cases pin which documents those are: the ones every runtime
 * running the same node mints for the same write, so a client's speculative
 * run of a builtin converges with the served one (speculation.md §2), and
 * never one an earlier run of the node gave a different object, since a
 * builtin reads back and rewrites the stores it keeps.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { createNodeFactory } from "../src/builder/module.ts";
import { pattern } from "../src/builder/pattern.ts";
import type { Cell } from "../src/cell.ts";
import { parseLink } from "../src/link-utils.ts";
import { raw } from "../src/module.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("builtin run element identity");
const space = signer.did();

type Seen = { word: string };

/**
 * A builtin that keeps, in a store of its own, every word its input has held,
 * one object per word, appending the new word to what its earlier runs wrote.
 */
const seenWords = raw(
  (
    inputsCell: Cell<{ word?: string }>,
    sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
    _addCancel: unknown,
    cause: unknown,
    parentCell: Cell<unknown>,
    runtime: Runtime,
  ) =>
  (tx: IExtendedStorageTransaction) => {
    const store = runtime.getCell<{ seen?: Seen[] }>(
      parentCell.space,
      { seenWords: cause },
      undefined,
      tx,
    );
    const word = inputsCell.withTx(tx).key("word").get();
    const seen = store.key("seen").get() ?? [];
    if (word !== undefined && !seen.some((entry) => entry.word === word)) {
      store.key("seen").set([...seen, { word }]);
    }
    sendResult(tx, store);
  },
);

/** The piece: one node of the builtin over the argument's word. Built once a
 * runtime exists, since a pattern is built in a runtime's frame. */
const buildPiece = () =>
  pattern<{ word: string }>(({ word }) => ({
    words: createNodeFactory({ type: "ref", implementation: "seen_words" })({
      word,
    }),
  }));

const cancels: Array<() => void> = [];

const opened: Array<{ runtime: Runtime; storage: EmulatedStorageManager }> = [];

/** A runtime with the builtin registered, over a store of its own. */
function openRuntime(): Runtime {
  const storage = EmulatedStorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  runtime.moduleRegistry.addModuleByRef("seen_words", seenWords);
  opened.push({ runtime, storage });
  return runtime;
}

/** Runs the piece over `word` in `runtime`, and returns its argument. */
async function start(
  runtime: Runtime,
  word: string,
): Promise<{ argument: Cell<{ word: string }>; result: Cell<unknown> }> {
  const piece = buildPiece();
  const tx = runtime.edit();
  const argument = runtime.getCell<{ word: string }>(
    space,
    "builtin run element identity argument",
    undefined,
    tx,
  );
  argument.set({ word });
  const result = runtime.getCell<unknown>(
    space,
    "builtin run element identity result",
    piece.resultSchema,
    tx,
  );
  runtime.run(tx, piece, argument, result);
  expect((await tx.commit().settled).error).toBeUndefined();
  // Demand the node's output, as a view of the piece would.
  cancels.push(result.key("words").sink(() => {}));
  await runtime.idle();
  return { argument, result };
}

/** The store the node keeps, as the node's output names it. */
function storeOf(result: Cell<unknown>): Cell<{ seen?: Seen[] }> {
  return result.key("words").resolveAsCell() as Cell<{ seen?: Seen[] }>;
}

/** The ids of the documents the store's list holds its objects in. */
function elementIds(result: Cell<unknown>): string[] {
  const store = storeOf(result);
  const raw = store.key("seen").getRaw() as unknown[];
  return raw.map((element) => parseLink(element, store)!.id);
}

describe("builtin-run-element-identity", () => {
  afterEach(async () => {
    for (const cancel of cancels.splice(0)) cancel();
    for (const { runtime, storage } of opened.splice(0)) {
      await runtime.dispose();
      await storage.close();
    }
  });

  it("keeps an object an earlier run wrote when a later run writes another beside it", async () => {
    const runtime = openRuntime();
    const { argument, result } = await start(runtime, "first");
    {
      const change = runtime.edit();
      argument.withTx(change).key("word").set("second");
      expect((await change.commit().settled).error).toBeUndefined();
      await runtime.idle();

      const seen = storeOf(result).key("seen").get()!;
      expect(seen.map((entry) => entry.word)).toEqual(["first", "second"]);
      expect(new Set(elementIds(result)).size).toBe(2);
    }
  });

  it("mints the same documents for the same write in every runtime that runs the node", async () => {
    const one = openRuntime();
    const other = openRuntime();
    // Objects written into a list outside any run draw on the runtime's own
    // count; this runtime's count is ahead of the first one's.
    const warm = other.edit();
    other.getCell<Seen[]>(
      space,
      "builtin run element identity warm",
      undefined,
      warm,
    )
      .set([{ word: "unrelated" }, { word: "also unrelated" }]);
    expect((await warm.commit().settled).error).toBeUndefined();

    const { result: oneResult } = await start(one, "first");
    const { result: otherResult } = await start(other, "first");

    expect(elementIds(oneResult)).toHaveLength(1);
    expect(elementIds(otherResult)).toEqual(elementIds(oneResult));
  });
});
