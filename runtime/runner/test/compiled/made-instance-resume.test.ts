import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  type CompiledPieceOptions,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import {
  resumeCompiledPieceFromBasis,
  type ResumedPiece,
} from "../../src/compiled/resume.ts";
import { Runtime } from "../../src/runtime.ts";
import { type SharedStorage, shareStorage } from "./storage.ts";

type Counter = { label: string; count: number; shown: string };

// `fixtures/made-counter.tsx`: the handler of `add` makes an instance of
// `Counter` and pushes it onto the list. The instance has a state cell, a
// stream `bump` whose handler adds to the cell, and a computation over it.
describe("an instance that a handler of a compiled piece made, in a runtime that resumes the piece", () => {
  let signer: Identity;
  let space: MemorySpace;
  let shared: SharedStorage;
  let runtimes: Runtime[];
  let pieces: CompiledPiece[];
  let resumes: ResumedPiece[];
  let main: Artifact;
  let options: CompiledPieceOptions;

  const session = (): Runtime => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: shared.open(signer),
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
    runtimes.push(runtime);
    return runtime;
  };

  const settled = async (runtime: Runtime) => {
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.storageManager.synced();
  };

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("compiled piece made instance");
    space = signer.did();
    shared = shareStorage();
    runtimes = [];
    pieces = [];
    resumes = [];
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../../../../base/pattern-compiler/compare/fixtures/made-counter.emit.json",
          import.meta.url,
        ),
      ),
    ) as { patterns: Artifact[] }[];
    main = patterns.find(({ name }) => name === "default")!;
    options = {
      artifacts: (id) => patterns.find(({ plan }) => plan.patterns?.[0] === id),
    };
  });

  afterEach(async () => {
    for (const piece of pieces) piece.stop();
    for (const resumed of resumes) resumed.stop();
    for (const runtime of runtimes) {
      await runtime.scheduler.idleWithPendingCommits();
      await runtime.dispose();
    }
    await shared.close();
  });

  const commit = async (
    runtime: Runtime,
    write: (tx: ReturnType<Runtime["edit"]>) => void,
  ) => {
    const tx = runtime.edit();
    write(tx);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await settled(runtime);
  };

  /** The members of the result as `runtime` reads them. */
  const members = (runtime: Runtime, result: Cell<unknown>): Counter[] => {
    const tx = runtime.edit();
    try {
      const cell = runtime.getCellFromLink(result.getAsNormalizedFullLink())
        .withTx(tx).key("members" as never);
      return (JSON.parse(JSON.stringify(cell.get())) as Counter[]).map((
        { label, count, shown },
        // A state cell that nothing wrote has no document, and reads as
        // nothing where the executor reads the default of its schema.
      ) => ({ label, count: count ?? 0, shown }));
    } finally {
      tx.abort();
    }
  };

  /** Sends `event` to the stream at `path` of the result and waits. */
  const send = async (
    runtime: Runtime,
    result: Cell<unknown>,
    path: (string | number)[],
    event: unknown,
  ) => {
    // deno-lint-ignore no-explicit-any
    let cell: any = runtime.getCellFromLink(result.getAsNormalizedFullLink());
    for (const segment of path) cell = cell.key(segment);
    cell.send(event);
    await settled(runtime);
  };

  /** A piece whose handler made two counters, the first bumped once. */
  const handedOver = async () => {
    const first = session();
    const list = first.getCell<unknown[]>(space, "members");
    await commit(first, (tx) => list.withTx(tx).set([]));
    const result = first.getCell<Record<string, unknown>>(space, "counters");
    await commit(first, (tx) => {
      pieces.push(
        startCompiledPiece(
          first,
          tx,
          main,
          { members: list },
          result.withTx(tx),
          options,
        ),
      );
    });
    await send(first, result, ["add"], { label: "a" });
    await send(first, result, ["add"], { label: "b" });
    await send(first, result, ["members", 0, "bump"], { by: 1 });
    expect(pieces[0].refusals).toEqual([]);
    expect(members(first, result)).toEqual([
      { label: "a", count: 1, shown: "a:1" },
      { label: "b", count: 0, shown: "b:0" },
    ]);
    for (const piece of pieces.splice(0)) piece.stop();
    await settled(first);
    await first.dispose();
    runtimes.splice(runtimes.indexOf(first), 1);
    return result;
  };

  const resumedIn = async (runtime: Runtime, result: Cell<unknown>) => {
    const resumed = await resumeCompiledPieceFromBasis(
      runtime,
      main,
      runtime.getCellFromLink(result.getAsNormalizedFullLink()),
      options,
    );
    resumes.push(resumed);
    return resumed;
  };

  it("handles an event to a stream of the instance and derives what reads the cell its handler wrote", async () => {
    const result = await handedOver();
    const second = session();
    const resumed = await resumedIn(second, result);
    expect(resumed.current).toBe(true);
    const piece = await resumed.wake();
    await settled(second);

    await send(second, result, ["members", 0, "bump"], { by: 2 });
    await send(second, result, ["members", 1, "bump"], { by: 5 });

    expect(piece.refusals).toEqual([]);
    expect(members(second, result)).toEqual([
      { label: "a", count: 3, shown: "a:3" },
      { label: "b", count: 5, shown: "b:5" },
    ]);
  });

  it("gives an instance that a handler makes after the resume a name of its own, and a third runtime starts all of them again", async () => {
    const result = await handedOver();
    const second = session();
    const resumed = await resumedIn(second, result);
    await resumed.wake();
    await settled(second);
    await send(second, result, ["add"], { label: "c" });
    await send(second, result, ["members", 2, "bump"], { by: 7 });
    expect(members(second, result).map(({ shown }) => shown)).toEqual([
      "a:1",
      "b:0",
      "c:7",
    ]);
    for (const one of resumes.splice(0)) one.stop();
    await settled(second);
    await second.dispose();
    runtimes.splice(runtimes.indexOf(second), 1);

    const third = session();
    const again = await resumedIn(third, result);
    expect(again.current).toBe(true);
    const piece = await again.wake();
    await settled(third);
    for (const at of [0, 1, 2]) {
      await send(third, result, ["members", at, "bump"], { by: 1 });
    }

    expect(piece.refusals).toEqual([]);
    expect(members(third, result).map(({ shown }) => shown)).toEqual([
      "a:2",
      "b:1",
      "c:8",
    ]);
  });
});
