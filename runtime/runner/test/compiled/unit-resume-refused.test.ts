import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { resumeCompiledPieceFromBasis } from "../../src/compiled/resume.ts";
import { Runtime } from "../../src/runtime.ts";
import { EmulatedStorageManager } from "../../src/storage/cache.deno.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

/** The pattern of `compare/fixtures/refused-commit.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/refused-commit.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns[patterns.length - 1];
};

// A piece whose rows are a `map` over an array of references is started
// and stopped, and the same session starts it again by units, so that it
// holds its rows as the storage holds them. The replica of the session
// holds every document the piece wrote, and the storage manager is made
// to say that a read gives what the store holds (`readsThroughStore`). A
// handler's commit of that piece is then refused: it read a cell that
// another session wrote, which the server tells the session of only when
// the test asks (`flushSessions()`).
describe("a commit that is refused after a compiled piece was woken by units", () => {
  let server: MemoryV2Server.Server;
  let managers: { close(): Promise<void> }[];
  let runtimes: Runtime[];
  let pieces: CompiledPiece[];
  let space: MemorySpace;
  let signer: Identity;

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("compiled piece, refused by units");
    space = signer.did();
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    managers = [];
    runtimes = [];
    pieces = [];
  });

  afterEach(async () => {
    for (const piece of pieces) piece.stop();
    for (const runtime of runtimes) await runtime.dispose();
    for (const manager of managers) await manager.close();
    await server.close();
  });

  /** A session of the space on the server the sessions share. */
  const session = (): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    managers.push(manager);
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
    runtimes.push(runtime);
    return runtime;
  };

  /** Commits what `write` writes in `runtime`, and returns the error. */
  const commit = async (
    runtime: Runtime,
    write: (tx: ReturnType<Runtime["edit"]>) => void,
  ) => {
    const tx = runtime.edit();
    write(tx);
    runtime.prepareTxForCommit(tx);
    const { error } = await tx.commit({ holdSyncedUntilCovered: false })
      .verdict;
    await runtime.storageManager.synced();
    return error;
  };

  /**
   * Starts the pattern in `runtime` over `last`, which holds `start`, and
   * `items`, which holds a reference to each of three items, stops the
   * piece, and wakes it by units.
   */
  const wokenByUnits = async (runtime: Runtime) => {
    const secret = runtime.getCell<string>(space, "secret");
    const last = runtime.getCell<string>(space, "last");
    const items = runtime.getCell<unknown[]>(space, "items");
    const members = ["one", "two", "three"].map((title) => ({
      cell: runtime.getCell<{ title: string }>(space, `item ${title}`),
      title,
    }));
    const result = runtime.getCell<Record<string, unknown>>(space, "result");
    expect(
      await commit(runtime, (tx) => {
        secret.withTx(tx).set("s");
        last.withTx(tx).set("start");
        for (const { cell, title } of members) cell.withTx(tx).set({ title });
        items.withTx(tx).set(members.map(({ cell }) => cell));
      }),
    ).toBeUndefined();
    const compiled = await artifact();
    let first: CompiledPiece | undefined;
    expect(
      await commit(runtime, (tx) => {
        first = startCompiledPiece(
          runtime,
          tx,
          compiled,
          { secret, last, items },
          result.withTx(tx),
          // The load is one transaction: the server tells a session of a
          // commit only when the test asks, and a commit that the piece
          // makes itself would keep `synced()` waiting for that.
          { loadRows: Infinity },
        );
      }),
    ).toBeUndefined();
    first!.stop();
    Object.assign(runtime.storageManager, { readsThroughStore: () => true });
    const resumed = await resumeCompiledPieceFromBasis(
      runtime,
      compiled,
      result,
    );
    expect(resumed.current).toBe(true);
    // The commit of the wake settles once the server told the session of
    // it.
    const waking = resumed.wake();
    await runtime.idle();
    await server.idle();
    const piece = await waking;
    pieces.push(piece);
    await runtime.storageManager.synced();
    return { piece, last };
  };

  /** What the executor holds of the result of a piece. */
  const held = (piece: CompiledPiece) =>
    piece.instance.result() as { shown: string; rows: { label: string }[] };

  it("holds the rows the storage holds after the commit of a derivation that added a row was refused with the handler's", async () => {
    const writer = session();
    const other = session();
    const { piece } = await wokenByUnits(writer);
    expect(piece.instance.counts.elementEvaluations).toBe(0);
    const theirs = other.getCell<string>(space, "last");
    await theirs.sync();
    expect(await commit(other, (tx) => theirs.withTx(tx).set("theirs")))
      .toBeUndefined();
    const [stream] = piece.instance.streams().filter(({ path }) =>
      path.join("/") === "add"
    );

    // The handler adds an item and a derivation adds its row, both over a
    // value of `last` that the store no longer holds.
    const pending = commit(writer, (tx) => {
      piece.transactions.within(
        tx,
        () =>
          piece.instance.handleEvent(
            { binding: stream.binding, keys: stream.keys },
            { text: "+mine" },
          ),
      );
      // The piece has the derivation run after an event it handles.
      piece.derive();
    });
    await writer.idle();
    await server.idle();

    expect((await pending)?.name).toBe("ConflictError");
    expect(piece.refusals.length).toBe(2);
    piece.instance.settle();
    expect(held(piece).rows.map(({ label }) => label)).toEqual([
      "one!",
      "two!",
      "three!",
    ]);
    expect(held(piece).shown).toBe("THEIRS");
    // The body of the added row, and after the refusal the body of each
    // of the three rows: what brings the executor back to the storage
    // gives it the result document with every row, and the rows are then
    // evaluated as those of a piece that was resumed whole.
    expect(piece.instance.counts.elementEvaluations).toBe(4);
  });
});
