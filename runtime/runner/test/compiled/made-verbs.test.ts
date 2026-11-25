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
import { setUpCompiledPiece } from "../../src/compiled/setup.ts";
import { getMetaLink, parseLink } from "../../src/link-utils.ts";
import { readResultSchemaMeta } from "../../src/result-schema-meta.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const fixture = (extension: string): URL =>
  new URL(
    `../../../../base/pattern-compiler/compare/fixtures/made-verbs.${extension}`,
    import.meta.url,
  );

const [{ patterns }] = JSON.parse(
  await Deno.readTextFile(fixture("emit.json")),
) as { patterns: Artifact[] }[];
const MAIN = patterns.find(({ name }) => name === "default")!;
const ITEM = patterns.find(({ name }) => name === "Item")!;
const PROGRAM = {
  main: "/made-verbs.tsx",
  files: [{
    name: "/made-verbs.tsx",
    contents: await Deno.readTextFile(fixture("tsx")),
  }],
};

type Held = { titles: string[]; add: unknown };

// `fixtures/made-verbs.tsx`: a handler makes an instance of `Item`, as the
// Topics board's `addTopic` makes a topic, inside the board's piece. A
// client addresses the instance as a piece of its own, as it addresses a
// child piece of today's runtime: by the link the board's list holds to its
// result, which names its argument, and through which the client sends to
// its verb and writes its title.
describe("an instance a handler of a compiled piece made, addressed by a client under the serving loop", () => {
  let serving: CompiledServingMemoryServer;
  let client: Runtime;
  let cancels: (() => void)[];
  let space: MemorySpace;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("compiled made verbs");
    space = signer.did();
    serving = await listenCompiledServingMemoryServer({
      compile: () =>
        Promise.resolve({
          main: MAIN,
          artifacts: (id) =>
            (ITEM.plan as { patterns?: string[] }).patterns?.[0] === id
              ? ITEM
              : undefined,
        }),
    });
    client = new Runtime({
      apiUrl: serving.url,
      storageManager: StorageManager.open({
        as: signer,
        memoryHost: serving.url,
      }),
      experimental: { serverExecution: true },
    });
    cancels = [];
  });

  afterEach(async () => {
    for (const cancel of cancels) cancel();
    await serving.host.close();
    await client.dispose();
    await serving.close();
  });

  /** Resolves when the client reads `expected` as the board's titles. */
  const titles = async (read: Cell<Held>, expected: string[]) => {
    const held = read.key("titles") as unknown as Cell<string[]>;
    cancels.push(held.sink(() => {}));
    await waitForCellValue<string[]>(
      client,
      held,
      (value) => JSON.stringify(value) === JSON.stringify(expected),
      { stuckLabel: `the client reads the titles ${expected}` },
    );
  };

  /**
   * The board, set up and holding one item titled `First`, and the result
   * of that item, as the board's list links it.
   */
  const withItem = async () => {
    const result = client.getCell<Held>(space, "made-verbs result");
    const tx = client.edit();
    setUpCompiledPiece(client, tx, PROGRAM, { items: [] }, result.withTx(tx));
    expect((await tx.commit().settled).error).toBeUndefined();
    const read = client.getCellFromLink<Held>(result.getAsNormalizedFullLink());
    cancels.push(read.sink(() => {}));
    await waitForCellValue<Held>(
      client,
      read,
      (held) => held?.add !== undefined,
      {
        stuckLabel: "the client reads the board's stream",
      },
    );
    (read.key("add") as unknown as Cell<{ title: string }>).send({
      title: "First",
    });
    await titles(read, ["First"]);
    // The position of the list that holds the link to the item's result.
    const position = (read.key("items" as never) as unknown as Cell<unknown[]>)
      .key(0).resolveAsCell();
    await position.sync();
    const item = client.getCellFromLink(
      parseLink(position.getRaw() as never, position)!,
    );
    await item.sync();
    return { read, item };
  };

  it("names the item's argument, under its argument schema, and its result schema in the metadata of its result", async () => {
    const { item } = await withItem();

    const argument = getMetaLink(item, "argument");
    expect(argument).toBeDefined();
    expect(argument?.schema).toBeDefined();
    expect(readResultSchemaMeta(item)).toBeDefined();
    // The argument document links back to the item's result, as a piece's
    // argument links to the piece.
    const argumentDocument = client.getCellFromLink({
      ...argument!,
      path: [],
      schema: undefined,
    });
    await argumentDocument.sync();
    expect(getMetaLink(argumentDocument, "result")?.id).toBe(
      item.getAsNormalizedFullLink().id,
    );
    expect(serving.pieces()[0].refusals).toEqual([]);
  });

  it("handles an event the client sends to the item's verb by the item's own address", async () => {
    const { read, item } = await withItem();
    const verb = item.key("rename" as never) as unknown as Cell<
      { title: string }
    >;
    await verb.sync();

    verb.send({ title: "Renamed" });

    await titles(read, ["Renamed"]);
    expect(serving.pieces()[0].refusals).toEqual([]);
  });
});
