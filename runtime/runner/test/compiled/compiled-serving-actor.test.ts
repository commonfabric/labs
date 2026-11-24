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
  type PatternProgram,
  setUpCompiledPiece,
} from "../../src/compiled/setup.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const fixture = (name: string, extension: string): URL =>
  new URL(
    `../../../../base/pattern-compiler/compare/fixtures/${name}.${extension}`,
    import.meta.url,
  );

const FIXTURES = ["runtime-builtins", "authored-by-writer"];
const ARTIFACTS = new Map<string, Artifact>();
const PROGRAMS = new Map<string, PatternProgram>();
for (const name of FIXTURES) {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(fixture(name, "emit.json")),
  ) as { patterns: Artifact[] }[];
  ARTIFACTS.set(name, patterns.find(({ name }) => name === "default")!);
  PROGRAMS.set(name, {
    main: `/${name}.tsx`,
    files: [{
      name: `/${name}.tsx`,
      contents: await Deno.readTextFile(fixture(name, "tsx")),
    }],
  });
}

// A client with server execution on appends an event to a stream of a
// compiled piece. The serving loop stamps the transaction of the handler
// with the principal of the session that sent the event, and the piece
// runs the compiled handler in that transaction.
describe("an event a client sends to a compiled piece under the serving loop", () => {
  let signer: Identity;
  let space: MemorySpace;
  let serving: CompiledServingMemoryServer;
  let client: Runtime;
  let cancels: (() => void)[];

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("compiled piece served actor");
    space = signer.did();
    serving = await listenCompiledServingMemoryServer({
      // The crate's binary is not run here: what stands in its place gives
      // the artifact the crate emitted for the fixture the program names.
      compile: (program) =>
        Promise.resolve({
          main: ARTIFACTS.get(program.main.slice(1, -".tsx".length))!,
          artifacts: () => undefined,
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

  /**
   * Sets the fixture `name` up from the client over `argument`, and
   * returns the result as the client reads it once the piece has stored
   * the stream `stream`.
   */
  const setUp = async <T>(
    name: string,
    argument: unknown,
    stream: string,
  ): Promise<Cell<T>> => {
    const result = client.getCell<T>(space, `${name} result`);
    const tx = client.edit();
    setUpCompiledPiece(
      client,
      tx,
      PROGRAMS.get(name)!,
      argument,
      result.withTx(tx),
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    const read = client.getCellFromLink<T>(result.getAsNormalizedFullLink());
    cancels.push(read.sink(() => {}));
    await waitForCellValue<T>(
      client,
      read,
      (value) => (value as Record<string, unknown>)?.[stream] !== undefined,
      { stuckLabel: `the client reads the stream \`${stream}\`` },
    );
    return read;
  };

  it("gives the handler the principal of the session that sent the event", async () => {
    type Held = { last: { by: string; key: string; text: string } };
    const read = await setUp<Held>(
      "runtime-builtins",
      { notes: ["one"] },
      "record",
    );

    (read.key("record" as never) as unknown as Cell<{ text: string }>).send({
      text: "first",
    });
    const held = await waitForCellValue<Held>(
      client,
      read,
      (value) => value?.last?.text === "first",
      { stuckLabel: "the client reads what the handler wrote" },
    );

    expect(held.last.by).toBe(signer.did());
    expect(held.last.key).toMatch(/^evk:/);
    expect(serving.pieces()[0].refusals).toEqual([]);
  });

  // The elements of the list of `fixtures/authored-by-writer.tsx` are
  // declared as authored by the current user and written by the handler
  // `write` alone.
  it("commits a handler whose write is declared as authored by the current user", async () => {
    type Held = { notes: { text: string }[] };
    const read = await setUp<Held>("authored-by-writer", {}, "write");

    (read.key("write" as never) as unknown as Cell<{ text: string }>).send({
      text: "hello",
    });
    await waitForCellValue<Held>(
      client,
      read,
      (value) => value?.notes?.[0]?.text === "hello",
      { stuckLabel: "the client reads what the handler wrote" },
    );

    const [piece] = serving.pieces();
    expect(piece.refusals).toEqual([]);
    expect(piece.counts.events).toBe(1);
    expect(piece.counts.eventsRefused).toBe(0);
  });
});
