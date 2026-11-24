import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
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

/** The pattern of `compare/fixtures/staged-read.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/staged-read.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

/** The members of the result that follow from `items`, with `items`. */
type Derived = {
  items: string[];
  count: number;
  total: string;
  joined: string;
  loud: string;
};

const NAMES = ["items", "count", "total", "joined", "loud"] as const;

/** What follows from `items` where it holds `items`. */
const derivedFrom = (items: string[]): Derived => ({
  items,
  count: items.length,
  total: `${items.length} in all`,
  joined: items.join(","),
  loud: items.join(",").toUpperCase(),
});

// `fixtures/staged-read.tsx` as a compiled piece: the handler `stage`
// pushes onto the input `items`, an array of plain values in place with no
// per-element construct over it, and reads `joined`, which a cone writes
// from `items`. A write of a handler that does not reach the storage
// leaves no derived value behind, in the executor or in the storage, that
// follows from it.
describe("the derived values of a compiled piece behind a write that did not reach the storage", () => {
  let server: MemoryV2Server.Server;
  let managers: { close(): Promise<void> }[];
  let runtimes: Runtime[];
  let pieces: CompiledPiece[];
  let space: MemorySpace;
  let signer: Identity;

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("compiled piece, staged read");
    space = signer.did();
    // The server of the sessions that share a space tells a session of
    // another session's commit when the test asks it to, so that a
    // session holds a stale document for as long as the test needs it to.
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
   * A session of the space: with `alone`, one on a server of its own, and
   * otherwise one of those that share the server.
   */
  const session = (alone = false): Runtime => {
    const manager = alone
      ? StorageManager.emulate({ as: signer })
      : EmulatedStorageManager.connectTo(server, { as: signer });
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

  /** Starts the pattern in `runtime` over the cell `items`, which is empty. */
  const started = async (runtime: Runtime) => {
    const items = runtime.getCell<string[]>(space, "items");
    const result = runtime.getCell<Record<string, unknown>>(space, "result");
    expect(await commit(runtime, (tx) => items.withTx(tx).set([])))
      .toBeUndefined();
    let piece: CompiledPiece | undefined;
    const pattern = await artifact();
    expect(
      await commit(runtime, (tx) => {
        piece = startCompiledPiece(
          runtime,
          tx,
          pattern,
          { items },
          result.withTx(tx),
          // The load is one transaction: the server tells a session of a
          // commit only when the test asks, and a commit that the piece
          // makes itself would keep `synced()` waiting for that.
          { loadRows: Infinity },
        );
        pieces.push(piece);
      }),
    ).toBeUndefined();
    return { piece: piece!, items, result };
  };

  /** What the storage of `runtime` holds of the result, read alone. */
  const stored = (runtime: Runtime, result: Cell<unknown>): Derived => {
    const tx = runtime.edit();
    try {
      // deno-lint-ignore no-explicit-any
      const at: any = result.withTx(tx);
      return Object.fromEntries(
        NAMES.map((
          name,
        ) => [name, JSON.parse(JSON.stringify(at.key(name).get() ?? null))]),
      ) as Derived;
    } finally {
      tx.abort();
    }
  };

  /** What the executor holds of the result of a piece. */
  const held = (piece: CompiledPiece): Derived & { seen: string[] } => {
    const result = piece.instance.result() as Derived & { seen: string[] };
    return {
      ...Object.fromEntries(NAMES.map((name) => [name, result[name]])),
      seen: result.seen,
    } as Derived & { seen: string[] };
  };

  /** Handles an event of the stream at `name` in a transaction of its own. */
  const handle = (
    runtime: Runtime,
    piece: CompiledPiece,
    name: string,
    event: unknown,
  ) => {
    const [stream] = piece.instance.streams().filter(({ path }) =>
      path.join("/") === name
    );
    return commit(runtime, (tx) => {
      piece.transactions.within(
        tx,
        () =>
          piece.instance.handleEvent(
            { binding: stream.binding, keys: stream.keys },
            event,
          ),
      );
      // The piece has the derivation run after an event it handles.
      piece.derive();
    });
  };

  /**
   * Has the piece of `runtime` derive from what the refusals left and its
   * commit reach the storage. The session learns of the last refusal, that
   * of a derivation that read a refused write, when it has caught up with
   * the server, and the piece then derives once more.
   */
  const settled = async (runtime: Runtime) => {
    await runtime.idle();
    await server.idle();
    await runtime.storageManager.synced();
    await runtime.idle();
    await server.idle();
    await runtime.storageManager.synced();
  };

  it("are those of the stored input after a handler threw behind its write and its read", async () => {
    const runtime = session(true);
    const { piece, result } = await started(runtime);
    result.key("stage").send({ text: "a" } as never);
    await runtime.scheduler.idleWithPendingCommits();

    result.key("stage").send({ text: "b", fail: true } as never);
    await runtime.scheduler.idleWithPendingCommits();

    expect(stored(runtime, result)).toEqual(derivedFrom(["a"]));
    expect(held(piece)).toEqual({ ...derivedFrom(["a"]), seen: [""] });
  });

  it("are those of the stored input after a handler that read what a cone wrote in its transaction threw", async () => {
    const runtime = session(true);
    const { piece, result } = await started(runtime);

    // The two events are queued together: the cones that the first makes
    // stale are evaluated for the second.
    result.key("stage").send({ text: "a" } as never);
    result.key("look").send({ fail: true } as never);
    await runtime.scheduler.idleWithPendingCommits();

    expect(stored(runtime, result)).toEqual(derivedFrom(["a"]));
    expect(held(piece)).toEqual({ ...derivedFrom(["a"]), seen: [""] });
  });

  it("are those of what the storage holds after the commit of a handler was refused, where a derivation had read the handler's write", async () => {
    const writer = session();
    const other = session();
    const { piece, items, result } = await started(writer);
    // The other session writes the cell, and the writer's session is not
    // told of it.
    const theirs = other.getCell<string[]>(space, "items");
    await theirs.sync();
    expect(await commit(other, (tx) => theirs.withTx(tx).set(["theirs"])))
      .toBeUndefined();

    // The handler pushes onto an array that the store no longer holds,
    // and the derivation behind it reads what the handler wrote.
    const pending = handle(writer, piece, "stage", { text: "mine" });
    await writer.idle();
    expect(held(piece)).toMatchObject(derivedFrom(["mine"]));
    await server.idle();

    expect((await pending)?.name).toBe("ConflictError");
    expect(piece.refusals.length).toBe(2);
    expect(
      piece.instance.store.peek(items.getAsNormalizedFullLink().id, []),
    ).toEqual(["theirs"]);
    await settled(writer);
    expect(held(piece)).toEqual({ ...derivedFrom(["theirs"]), seen: [] });
    expect(stored(writer, result)).toEqual(derivedFrom(["theirs"]));
  });

  it("are those of what the storage holds after an event read the write of an event before it whose commit was then refused", async () => {
    const writer = session();
    const other = session();
    const { piece, items, result } = await started(writer);
    const theirs = other.getCell<string[]>(space, "items");
    await theirs.sync();
    expect(await commit(other, (tx) => theirs.withTx(tx).set(["theirs"])))
      .toBeUndefined();

    // The second handler runs before the refusal of the first is known:
    // it reads `count`, `joined` and `loud` as they follow from the first
    // handler's write.
    const first = handle(writer, piece, "stage", { text: "mine" });
    const second = handle(writer, piece, "look", {});
    await writer.idle();
    expect(held(piece).seen).toEqual(["", "1 mine MINE"]);
    await server.idle();

    expect((await first)?.name).toBe("ConflictError");
    expect(await second).toBeDefined();
    expect(
      piece.instance.store.peek(items.getAsNormalizedFullLink().id, []),
    ).toEqual(["theirs"]);
    await settled(writer);
    // Neither handler's push onto `seen` reached the storage.
    expect(held(piece)).toEqual({ ...derivedFrom(["theirs"]), seen: [] });
    expect(stored(writer, result)).toEqual(derivedFrom(["theirs"]));
  });
});
