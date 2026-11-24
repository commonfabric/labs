import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell } from "../../src/cell.ts";
import {
  type CompiledServingMemoryServer,
  listenCompiledServingMemoryServer,
} from "../../src/compiled/serving-memory-server.deno.ts";
import { setUpCompiledPiece } from "../../src/compiled/setup.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const fixture = (extension: string): URL =>
  new URL(
    `../../../../base/pattern-compiler/compare/fixtures/made-session.${extension}`,
    import.meta.url,
  );

const [{ patterns }] = JSON.parse(
  await Deno.readTextFile(fixture("emit.json")),
) as { patterns: Artifact[] }[];
const MAIN = patterns.find(({ name }) => name === "default")!;
const PROGRAM = {
  main: "/made-session.tsx",
  files: [{
    name: "/made-session.tsx",
    contents: await Deno.readTextFile(fixture("tsx")),
  }],
};

// `fixtures/made-session.tsx`: the handler of `add` makes an instance of
// `Note`, which holds state of the scope `session`, and a `map` over the
// list, an array of references, reads the label of each member. The
// pattern reads state of the scope `session` of its own. Two clients of one
// principal, each a session of its own, read the piece under the serving
// loop, which derives it for each session in one pass.
describe("an instance that a handler made, in a piece that two sessions demand under the serving loop", () => {
  let servers: CompiledServingMemoryServer[];
  let clients: Runtime[];
  let cancels: (() => void)[];

  beforeEach(() => {
    servers = [];
    clients = [];
    cancels = [];
  });

  afterEach(async () => {
    for (const cancel of cancels) cancel();
    for (const serving of servers) await serving.host.close();
    for (const client of clients) await client.dispose();
    for (const serving of servers) await serving.close();
  });

  /** Resolves when `runtime` reads `count` labels in the result. */
  const readsLabels = async (
    runtime: Runtime,
    result: Cell<unknown>,
    count: number,
  ) => {
    const labels = runtime.getCellFromLink<string[]>(
      result.getAsNormalizedFullLink(),
    ).key("labels" as never) as unknown as Cell<string[]>;
    cancels.push(labels.sink(() => {}));
    await waitForCellValue<string[]>(
      runtime,
      labels,
      (held) => Array.isArray(held) && held.length === count,
      { stuckLabel: `a client reads ${count} labels` },
    );
  };

  /**
   * The commits of the piece refused, and the write records it gave, while
   * a client sends one `add` to a piece over a list of `size` members and
   * both clients read the added label.
   */
  const added = async (size: number) => {
    const signer = await Identity.fromPassphrase(
      `compiled piece made session ${size}`,
    );
    const space = signer.did();
    const serving = await listenCompiledServingMemoryServer({
      // What stands in the place of the crate's binary gives the artifacts
      // the crate emitted for the fixture.
      compile: () =>
        Promise.resolve({
          main: MAIN,
          artifacts: (id: string) =>
            patterns.find(({ plan }) => plan.patterns?.[0] === id),
        }),
    });
    servers.push(serving);
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
    const sender = client();
    const result = sender.getCell<Record<string, unknown>>(space, "notes");
    const tx = sender.edit();
    setUpCompiledPiece(
      sender,
      tx,
      PROGRAM,
      {
        members: Array.from({ length: size }, (_, index) => ({
          label: `member ${index}`,
          shown: `member ${index}:`,
        })),
      },
      result.withTx(tx),
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    const reader = client();
    await readsLabels(sender, result, size);
    await readsLabels(reader, result, size);
    const read = sender.getCellFromLink<{ add?: unknown }>(
      result.getAsNormalizedFullLink(),
    );
    cancels.push(read.sink(() => {}));
    await waitForCellValue<{ add?: unknown }>(
      sender,
      read,
      (held) => held?.add !== undefined,
      { stuckLabel: "the sender reads the stream `add`" },
    );
    await serving.host.whenQuiescent();
    const [piece] = serving.pieces();
    const refusals = piece.refusals.length;
    const records = piece.transactions.counts.recordsGiven;
    (read.key("add" as never) as unknown as Cell<unknown>).send(
      { label: "added" } as never,
    );
    await readsLabels(sender, result, size + 1);
    await readsLabels(reader, result, size + 1);
    await serving.host.whenQuiescent();
    return {
      refused: piece.refusals.slice(refusals),
      records: piece.transactions.counts.recordsGiven - records,
    };
  };

  // The run that makes the first derivation of the instance commits it in
  // a transaction of its own. A run for the other session in the same pass
  // read the result of the instance as its replica held it before that
  // commit: its commit was refused, and the restore that followed gave the
  // records of the whole result again.
  it("commits the derivation of each session with no refusal, and gives as many records over 10 members as over 100", async () => {
    const small = await added(10);
    const large = await added(100);

    expect(small.refused).toEqual([]);
    expect(large.refused).toEqual([]);
    expect(large.records).toBe(small.records);
  });
});
