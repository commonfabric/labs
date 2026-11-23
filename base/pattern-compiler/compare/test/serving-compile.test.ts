import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import type { Cell, MemorySpace } from "../../../../runtime/runner/src/cell.ts";
import {
  type CompiledServingMemoryServer,
  listenCompiledServingMemoryServer,
} from "../../../../runtime/runner/src/compiled/serving-memory-server.deno.ts";
import {
  compiledFailureOf,
  type PatternProgram,
  setUpCompiledPiece,
} from "../../../../runtime/runner/src/compiled/setup.ts";
import { Runtime } from "../../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../../runtime/runner/src/storage/cache.deno.ts";

/** The program of one file of `compare/fixtures/`. */
const programOf = async (fixture: string): Promise<PatternProgram> => ({
  main: `/${fixture}`,
  files: [{
    name: `/${fixture}`,
    contents: await Deno.readTextFile(
      new URL(`../fixtures/${fixture}`, import.meta.url),
    ),
  }],
});

type Result = { last?: string; note?: string; record?: unknown };

// These cases run the release build of the crate, which
// `cargo build --release` in `base/pattern-compiler` makes.
describe("a serving runtime that compiles the source a client wrote with the crate's binary", () => {
  let space: MemorySpace;
  let serving: CompiledServingMemoryServer;
  let client: Runtime;
  let cancels: (() => void)[];

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("serving compile");
    space = signer.did();
    serving = await listenCompiledServingMemoryServer();
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

  /** Sets a piece of `program` up from the client and reads its result. */
  const setUp = async (program: PatternProgram): Promise<Cell<Result>> => {
    const result = client.getCell<Result>(space, "handler");
    const tx = client.edit();
    setUpCompiledPiece(
      client,
      tx,
      program,
      { secret: "s", note: "n" },
      result.withTx(tx),
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    const cell = client.getCellFromLink<Result>(
      result.getAsNormalizedFullLink(),
    );
    cancels.push(cell.sink(() => {}));
    return cell;
  };

  it("runs the piece, which handles an event the client sends", async () => {
    const cell = await setUp(await programOf("handler.tsx"));
    await waitForCellValue<Result>(
      client,
      cell,
      (value) => value?.note === "n" && value.record !== undefined,
      { stuckLabel: "the client reads the result of the load" },
    );

    (cell.key("record") as unknown as Cell<unknown>).send({
      text: "t",
      extra: "e",
    });

    const value = await waitForCellValue<Result>(
      client,
      cell,
      (value) => typeof value?.last === "string",
      { stuckLabel: "the client reads what the handler stored" },
    );
    expect(value.last).toBe("ts");
    expect(serving.pieces().length).toBe(1);
  });

  it("starts no piece of a source whose body names the host object of the value code, and the client reads the diagnostic", async () => {
    const program = await programOf("handler.tsx");
    program.files[0].contents = program.files[0].contents.replace(
      "last.set(event.text + secret);",
      "last.set(String($h));",
    );
    const cell = await setUp(program);
    const refusal = client.getCellFromLink<{ reason: string }>({
      space,
      id: compiledFailureOf(cell.getAsNormalizedFullLink().id),
      path: [],
      scope: "space",
    });
    cancels.push(refusal.sink(() => {}));

    const { reason } = await waitForCellValue<{ reason: string }>(
      client,
      refusal,
      (value) => typeof value?.reason === "string",
      { stuckLabel: "the client reads why its piece did not start" },
    );

    expect(reason).toContain("`$h` is not a listed");
    expect(serving.pieces()).toEqual([]);
  });
});
