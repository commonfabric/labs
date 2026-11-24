import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { Runtime } from "../../src/runtime.ts";
import { openStorage, type TestStorage } from "./storage.ts";

/** The pattern of `compare/fixtures/handler-positions.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/handler-positions.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

type Filed = { count: number; file: { title: string; name: string } };

describe("what a handler of a compiled piece writes of an input it changes at one position", () => {
  let runtime: Runtime;
  let storageManager: TestStorage;
  let space: MemorySpace;
  let piece: CompiledPiece;
  /** The path of each change the commits wrote, by the entity. */
  let written: Map<string, string[]>;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("pattern-compiler-compare");
    space = signer.did();
    storageManager = openStorage(signer);
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
    written = new Map();
    storageManager.subscribe({
      next(notification) {
        if (notification.type !== "commit") return undefined;
        for (const { address } of notification.changes) {
          const paths = written.get(address.id) ?? [];
          paths.push(address.path.join("/"));
          written.set(address.id, paths);
        }
        return undefined;
      },
    });
  });

  afterEach(async () => {
    piece.stop();
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.dispose();
    await storageManager.close();
  });

  const commit = async (write: (tx: ReturnType<Runtime["edit"]>) => void) => {
    const tx = runtime.edit();
    write(tx);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.scheduler.idleWithPendingCommits();
  };

  /** Starts the piece over `count` items, each a cell, and as many names. */
  const started = async (count: number) => {
    const cells = Array.from(
      { length: count },
      (_, index) =>
        runtime.getCell<Record<string, unknown>>(space, `filed item ${index}`),
    );
    const items = runtime.getCell<unknown[]>(space, "filed items");
    const names = runtime.getCell<Record<string, string>>(space, "filed names");
    const result = runtime.getCell<Filed>(space, "filed result");
    await commit((tx) => {
      cells.forEach((cell, index) =>
        cell.withTx(tx).set({ title: `t${index}` })
      );
      items.withTx(tx).set(cells);
      names.withTx(tx).set(
        Object.fromEntries(cells.map((_, index) => [`n${index}`, `t${index}`])),
      );
    });
    const compiled = await artifact();
    await commit((tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        compiled,
        { items, names },
        result.withTx(tx),
      );
    });
    expect(piece.refusals).toEqual([]);
    return { result, items, names };
  };

  /** Sends `file` one event and returns the paths written of each input. */
  const filed = async (count: number) => {
    const { result, items, names } = await started(count);
    written.clear();
    const recorded: string[] = [];
    piece.transactions.onRecorded((writes) => {
      for (const { target, unchanged } of writes) {
        if (!unchanged) recorded.push(`${target.id}/${target.path.join("/")}`);
      }
    });
    result.key("file").send({ title: "new", name: "added" });
    await runtime.scheduler.idleWithPendingCommits();
    expect(piece.refusals).toEqual([]);
    const pathsOf = (cell: Cell<unknown>) =>
      [...(written.get(cell.getAsNormalizedFullLink().id) ?? [])].sort();
    /** The paths of `cell` that the write records of the event name. */
    const recordsOf = (cell: Cell<unknown>) => {
      const { id } = cell.getAsNormalizedFullLink();
      return recorded.filter((at) => at.startsWith(`${id}/`)).map((at) =>
        at.slice(id.length + 1)
      ).sort();
    };
    return {
      result,
      items: { written: pathsOf(items), records: recordsOf(items) },
      names: { written: pathsOf(names), records: recordsOf(names) },
    };
  };

  it("gives the records of the position added, of the number of members and of the membership for a `push` to an array of references of 3 members and of 300", async () => {
    for (const count of [3, 300]) {
      const { items } = await filed(count);

      expect(items.records).toEqual(["", `${count}`, "length"]);
      // The storage names the array as what the commit changed: its
      // members are other ones.
      expect(items.written).toEqual(["cfc", "value"]);
      piece.stop();
    }
  });

  it("writes the member set, and no other path of the record, for a `set` of one member of a record of 3 members and of 300", async () => {
    for (const count of [3, 300]) {
      const { names } = await filed(count);

      expect(names.written).toEqual(["value/added"]);
      piece.stop();
    }
  });
});
