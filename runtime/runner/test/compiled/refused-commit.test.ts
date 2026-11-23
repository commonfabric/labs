import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { Runtime } from "../../src/runtime.ts";
import {
  EmulatedStorageManager,
  StorageManager,
} from "../../src/storage/cache.deno.ts";
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

// A commit of a compiled piece that the storage refuses. The executor has
// gone on when the refusal is known: it holds what the refused transaction
// wrote. The piece brings its documents back to what the storage holds for
// the documents of that transaction, and derives again from them.
describe("a commit of a compiled piece that is refused", () => {
  let server: MemoryV2Server.Server;
  let managers: { close(): Promise<void> }[];
  let runtimes: Runtime[];
  let pieces: CompiledPiece[];
  let space: MemorySpace;
  let signer: Identity;

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("compiled piece, refused commit");
    space = signer.did();
    // The server of the sessions that share a space tells a session of
    // another session's commit when the test asks it to
    // (`flushSessions()`), so that a session holds a stale document for as
    // long as the test needs it to.
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

  /**
   * A session of the space: with `strict`, one alone on a server of its
   * own, where a clause that a store does not admit refuses the commit,
   * and otherwise one of those that share the server.
   */
  const session = (strict = false): Runtime => {
    const manager = strict
      ? StorageManager.emulate({ as: signer })
      : EmulatedStorageManager.connectTo(server, { as: signer });
    managers.push(manager);
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      cfcFlowLabels: "persist",
      ...(strict ? { cfcEnforcementMode: "enforce-strict" as const } : {}),
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
   * Starts the pattern in `runtime` over the cells `secret`, under a clause
   * that names a principal of no space, `last`, which holds `start`, and
   * `items`, which holds a reference to one item.
   */
  const started = async (runtime: Runtime) => {
    const secret = runtime.getCell<string>(
      space,
      "secret",
      {
        ifc: { confidentiality: ["did:example:another-principal"] },
      } as JSONSchema,
    );
    const last = runtime.getCell<string>(space, "last");
    const items = runtime.getCell<unknown[]>(space, "items");
    const first = runtime.getCell<{ title: string }>(space, "first item");
    const result = runtime.getCell<Record<string, unknown>>(space, "result");
    expect(
      await commit(runtime, (tx) => {
        secret.withTx(tx).set("s");
        last.withTx(tx).set("start");
        first.withTx(tx).set({ title: "one" });
        items.withTx(tx).set([first]);
      }),
    ).toBeUndefined();
    let piece: CompiledPiece | undefined;
    const started = await artifact();
    expect(
      await commit(runtime, (tx) => {
        piece = startCompiledPiece(
          runtime,
          tx,
          started,
          { secret, last, items },
          result.withTx(tx),
          // The load is one transaction: the server tells a session of a
          // commit only when the test asks, and a commit that the piece
          // makes itself would keep `synced()` waiting for that.
          { loadRows: Infinity },
        );
        pieces.push(piece);
      }),
    ).toBeUndefined();
    return { piece: piece!, secret, last, result };
  };

  /** What a cell holds in the storage of `runtime`, read alone. */
  const stored = (runtime: Runtime, cell: Cell<unknown>, ...path: string[]) => {
    const tx = runtime.edit();
    try {
      // deno-lint-ignore no-explicit-any
      let at: any = cell.withTx(tx);
      for (const segment of path) at = at.key(segment);
      return JSON.parse(JSON.stringify(at.get() ?? null));
    } finally {
      tx.abort();
    }
  };

  /** What the executor holds of the result of a piece. */
  const held = (piece: CompiledPiece) =>
    piece.instance.result() as { shown: string; rows: { label: string }[] };

  it("derives from what the storage holds after the preparation of Contextual Flow Control refused a handler's commit", async () => {
    const runtime = session(true);
    const { piece, last, result } = await started(runtime);
    expect(stored(runtime, result, "shown")).toBe("START");

    result.key("keep").send({ text: "a" } as never);
    await runtime.scheduler.idleWithPendingCommits();

    // The write of a text that holds the secret into a cell that admits no
    // such clause is refused, and the cell holds what it held.
    expect(piece.refusals.length).toBe(1);
    expect(stored(runtime, last)).toBe("start");
    // The executor holds what the storage holds, and so does what it
    // derived.
    expect(held(piece).shown).toBe("START");
    expect(stored(runtime, result, "shown")).toBe("START");
  });

  it("handles the next event from what the storage holds after such a refusal", async () => {
    const runtime = session(true);
    const { piece, last, result } = await started(runtime);
    result.key("keep").send({ text: "a" } as never);
    await runtime.scheduler.idleWithPendingCommits();
    expect(piece.refusals.length).toBe(1);

    result.key("append").send({ text: "+b" } as never);
    await runtime.scheduler.idleWithPendingCommits();

    expect(piece.refusals.length).toBe(1);
    expect(stored(runtime, last)).toBe("start+b");
    expect(stored(runtime, result, "shown")).toBe("START+B");
  });

  it("holds what the storage holds after a handler's commit met a write of another session", async () => {
    const writer = session();
    const other = session();
    const { piece, last } = await started(writer);
    // The other session writes the cell, and the writer's session is not
    // told of it.
    const theirs = other.getCell<string>(space, "last");
    await theirs.sync();
    expect(await commit(other, (tx) => theirs.withTx(tx).set("theirs")))
      .toBeUndefined();
    const [stream] = piece.instance.streams().filter(({ path }) =>
      path.join("/") === "append"
    );

    // The handler reads `start`, which the store no longer holds. The
    // commit is on its way before the writer's session is told of the
    // other session's write, which the refusal waits for.
    const pending = commit(writer, (tx) => {
      const outcome = piece.transactions.within(
        tx,
        () =>
          piece.instance.handleEvent(
            { binding: stream.binding, keys: stream.keys },
            { text: "+mine" },
          ),
      );
      expect(outcome.committed).toBe(true);
      // The piece has the derivation run after an event it handles.
      piece.derive();
    });
    await server.idle();
    const error = await pending;

    expect(error?.name).toBe("ConflictError");
    // The derivation that ran behind the handler read what the handler
    // wrote, so its commit is refused with the handler's.
    expect(piece.refusals.length).toBe(2);
    expect(piece.refusals[0]).toContain("stale confirmed read");
    expect(piece.refusals[1]).toContain("pending dependency rejected");
    // The executor holds for the cell what the writer's storage holds, and
    // not what the refused handler wrote.
    expect(stored(writer, last)).toBe("theirs");
    expect(
      piece.instance.store.peek(last.getAsNormalizedFullLink().id, []),
    ).toBe("theirs");
    // What it derives from the cell is derived from that.
    piece.instance.settle();
    expect(held(piece).shown).toBe("THEIRS");
  });

  it("holds the rows the storage holds after the commit of a derivation that added a row was refused with the handler's", async () => {
    const writer = session();
    const other = session();
    const { piece } = await started(writer);
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
    expect(held(piece).rows.map(({ label }) => label)).toEqual([
      "one!",
      "start+mine!",
    ]);
    await server.idle();

    expect((await pending)?.name).toBe("ConflictError");
    expect(piece.refusals.length).toBe(2);
    piece.instance.settle();
    expect(held(piece).rows.map(({ label }) => label)).toEqual(["one!"]);
    expect(held(piece).shown).toBe("THEIRS");
  });
});
