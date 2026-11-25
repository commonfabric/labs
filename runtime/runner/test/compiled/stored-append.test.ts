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
import {
  argumentDocumentOf,
  setUpCompiledPiece,
} from "../../src/compiled/setup.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const fixture = (extension: string): URL =>
  new URL(
    `../../../../base/pattern-compiler/compare/fixtures/authored-input.${extension}`,
    import.meta.url,
  );

const [{ patterns }] = JSON.parse(
  await Deno.readTextFile(fixture("emit.json")),
) as { patterns: Artifact[] }[];
const MAIN = patterns.find(({ name }) => name === "default")!;
const PROGRAM = {
  main: "/authored-input.tsx",
  files: [{
    name: "/authored-input.tsx",
    contents: await Deno.readTextFile(fixture("tsx")),
  }],
};

type Held = { count: number; write: unknown };

// `fixtures/authored-input.tsx`: a list of the argument whose members are
// declared as authored by the current user, which the argument the client
// writes leaves out, so the handler's first append makes it, as a FabriChat
// room's first message makes its list of messages. The storage, and a
// serving loop that takes the space over and reads it from there, are to
// hold the list as the array it is.
describe("a list a handler of a compiled piece appends to, whose members declare a policy, under the serving loop", () => {
  let signer: Identity;
  let space: MemorySpace;
  let serving: CompiledServingMemoryServer;
  let clients: Runtime[];
  let cancels: (() => void)[];

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("compiled stored append");
    space = signer.did();
    serving = await listenCompiledServingMemoryServer({
      compile: () =>
        Promise.resolve({ main: MAIN, artifacts: () => undefined }),
    });
    clients = [];
    cancels = [];
  });

  afterEach(async () => {
    for (const cancel of cancels) cancel();
    await serving.host.close();
    for (const client of clients) await client.dispose();
    await serving.close();
  });

  const clientOf = (): Runtime => {
    const client = new Runtime({
      apiUrl: serving.url,
      storageManager: StorageManager.open({
        as: signer,
        memoryHost: serving.url,
      }),
      experimental: { serverExecution: true },
    });
    clients.push(client);
    return client;
  };

  /** The result as `client` reads it, once it holds its stream. */
  const opened = async (client: Runtime): Promise<Cell<Held>> => {
    const read = client.getCellFromLink<Held>(
      client.getCell<Held>(space, "authored-input result")
        .getAsNormalizedFullLink(),
    );
    cancels.push(read.sink(() => {}));
    await waitForCellValue<Held>(
      client,
      read,
      (held) => held?.write !== undefined,
      { stuckLabel: "a client reads the stream of the piece" },
    );
    return read;
  };

  /** Sends `text` and resolves when `client` reads `count` notes. */
  const wrote = async (
    client: Runtime,
    read: Cell<Held>,
    text: string,
    count: number,
  ) => {
    (read.key("write") as unknown as Cell<{ text: string }>).send({ text });
    const counted = read.key("count") as unknown as Cell<number>;
    cancels.push(counted.sink(() => {}));
    await waitForCellValue<number>(client, counted, (held) => held === count, {
      stuckLabel: `a client reads ${count} notes`,
    });
  };

  /**
   * The list of notes as the argument document stores it: the number of
   * its members where it is an array, and what it is otherwise.
   */
  const stored = async (client: Runtime): Promise<unknown> => {
    const notes = client.getCellFromLink({
      space,
      id: argumentDocumentOf(
        client.getCell(space, "authored-input result").getAsNormalizedFullLink()
          .id,
      ),
      path: ["notes"],
      scope: "space",
    });
    await notes.sync();
    const raw = notes.getRaw();
    return Array.isArray(raw) ? { members: raw.length } : raw;
  };

  it("stores the list the first append made as an array", async () => {
    const client = clientOf();
    const result = client.getCell(space, "authored-input result");
    const tx = client.edit();
    setUpCompiledPiece(client, tx, PROGRAM, {}, result.withTx(tx));
    expect((await tx.commit().settled).error).toBeUndefined();
    const read = await opened(client);

    await wrote(client, read, "one", 1);
    await wrote(client, read, "two", 2);

    // A client that did not watch the piece reads the stored list.
    expect(await stored(clientOf())).toEqual({ members: 2 });
    expect(serving.pieces()[0].refusals).toEqual([]);
  });

  it("keeps every note when another serving loop takes the space over and a note is appended", async () => {
    const client = clientOf();
    const result = client.getCell(space, "authored-input result");
    const tx = client.edit();
    setUpCompiledPiece(client, tx, PROGRAM, {}, result.withTx(tx));
    expect((await tx.commit().settled).error).toBeUndefined();
    const read = await opened(client);
    await wrote(client, read, "one", 1);
    await wrote(client, read, "two", 2);
    await serving.host.whenQuiescent();

    await serving.restart();
    const later = clientOf();
    const again = await opened(later);
    await wrote(later, again, "three", 3);

    expect(await stored(clientOf())).toEqual({ members: 3 });
    expect(serving.pieces().flatMap((piece) => piece.refusals)).toEqual([]);
  });
});
