import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import {
  basisDocumentOf,
  basisPartDocumentOf,
} from "../../src/compiled/basis.ts";
import { resumeCompiledPiece } from "../../src/compiled/resume.ts";
import { Runtime } from "../../src/runtime.ts";
import { type SharedStorage, shareStorage } from "./storage.ts";

/** The artifact of the pattern `default` of a fixture of the crate. */
const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        `../../../../base/pattern-compiler/compare/fixtures/${name}.emit.json`,
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

type Item = { id: string; title: string; done: boolean };

const itemSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    done: { type: "boolean" },
  },
} as JSONSchema;

describe("resumeCompiledPiece()", () => {
  let signer: Identity;
  let space: MemorySpace;
  let shared: SharedStorage;
  let runtimes: Runtime[];
  let pieces: CompiledPiece[];

  /** A runtime on a session of its own of the shared server. */
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

  /** Stops the pieces of `runtime` and disposes it, with its session. */
  const dispose = async (runtime: Runtime) => {
    for (const piece of pieces.splice(0)) piece.stop();
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.storageManager.synced();
    await runtime.dispose();
    runtimes.splice(runtimes.indexOf(runtime), 1);
  };

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("compiled piece resume");
    space = signer.did();
    shared = shareStorage();
    runtimes = [];
    pieces = [];
  });

  afterEach(async () => {
    for (const piece of pieces) piece.stop();
    for (const runtime of runtimes) {
      await runtime.scheduler.idleWithPendingCommits();
      await runtime.dispose();
    }
    await shared.close();
  });

  const settled = async (runtime: Runtime) => {
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.storageManager.synced();
  };

  /** Commits what `write` writes in `runtime`. */
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

  /** A path of the result of a piece, with every link followed. */
  const read = (runtime: Runtime, result: Cell<unknown>, ...path: string[]) => {
    const tx = runtime.edit();
    try {
      let at = runtime.getCellFromLink(result.getAsNormalizedFullLink())
        .withTx(tx);
      for (const segment of path) at = at.key(segment as never);
      return JSON.parse(JSON.stringify(at.get()));
    } finally {
      tx.abort();
    }
  };

  /**
   * Starts `fixtures/serving-list.tsx` in `runtime` over an array of
   * `count` references, each to an item in a document of its own, which a
   * transaction before the start committed.
   */
  const startedList = async (runtime: Runtime, count: number) => {
    const items = runtime.getCell<Item[]>(space, "items", {
      type: "array",
      items: itemSchema,
    } as JSONSchema);
    await commit(runtime, (tx) => {
      const members = Array.from({ length: count }, (_, index) => {
        const member = runtime.getCell<Item>(
          space,
          `item ${index}`,
          itemSchema,
          tx,
        );
        member.set({ id: `i${index}`, title: `t${index}`, done: false });
        return member;
      });
      items.withTx(tx).set(members as never);
    });
    const artifact = await artifactOf("serving-list");
    const result = runtime.getCell<Record<string, unknown>>(space, "list");
    await commit(runtime, (tx) => {
      pieces.push(
        startCompiledPiece(runtime, tx, artifact, { items }, result.withTx(tx)),
      );
    });
    return { artifact, result, items };
  };

  /** Sends `event` to the stream `name` of `result` and waits. */
  const send = async (
    runtime: Runtime,
    result: Cell<unknown>,
    name: string,
    event: unknown,
  ) => {
    runtime.getCellFromLink(result.getAsNormalizedFullLink()).key(
      name as never,
    ).send(event as never);
    await settled(runtime);
  };

  /** The entities each commit that `runtime` hears of from now on changes. */
  const changesHeard = (runtime: Runtime): string[][] => {
    const heard: string[][] = [];
    runtime.storageManager.subscribe({
      next(notification) {
        if (notification.type === "commit") {
          const ids = new Set(
            [...notification.changes].map(({ address }) => address.id),
          );
          if (ids.size > 0) heard.push([...ids]);
        }
        return undefined;
      },
    });
    return heard;
  };

  describe("over a `map` over an array of references with a state cell", () => {
    it("holds, in a second runtime, the state and the rows the first one stored, and writes nothing", async () => {
      const first = session();
      const { artifact, result } = await startedList(first, 3);
      await send(first, result, "rename", { at: 1, title: "renamed" });
      await send(first, result, "add", { id: "new", title: "added" });
      const stored = read(first, result);
      expect(stored.events).toBe(2);
      await dispose(first);

      const second = session();
      const heard = changesHeard(second);
      const piece = await resumeCompiledPiece(
        second,
        artifact,
        second.getCellFromLink(result.getAsNormalizedFullLink()),
      );
      pieces.push(piece);
      await settled(second);

      expect(piece.refusals).toEqual([]);
      expect(heard).toEqual([]);
      expect(read(second, result)).toEqual(stored);
      expect((piece.instance.result() as { events: number }).events).toBe(2);
      expect(
        read(second, result, "rows").map((
          row: { label: string },
        ) => row.label),
      ).toEqual(["t0!", "renamed!", "t2!", "added!"]);
    });

    it("gives, for an event sent after the resume, the values the first runtime gives for the same events", async () => {
      const events: [string, unknown][] = [
        ["rename", { at: 1, title: "renamed" }],
        ["add", { id: "new", title: "added" }],
        ["rename", { at: 3, title: "again" }],
        ["add", { id: "last", title: "last" }],
      ];
      // The control: one runtime handles every event.
      const control = session();
      const whole = await startedList(control, 3);
      for (const [name, event] of events) {
        await send(control, whole.result, name, event);
      }
      const expected = read(control, whole.result);
      await dispose(control);
      await shared.close();
      shared = shareStorage();

      const first = session();
      const { artifact, result } = await startedList(first, 3);
      for (const [name, event] of events.slice(0, 2)) {
        await send(first, result, name, event);
      }
      await dispose(first);
      const second = session();
      const piece = await resumeCompiledPiece(
        second,
        artifact,
        second.getCellFromLink(result.getAsNormalizedFullLink()),
      );
      pieces.push(piece);
      await settled(second);
      const heard = changesHeard(second);
      for (const [name, event] of events.slice(2)) {
        await send(second, result, name, event);
      }

      expect(piece.refusals).toEqual([]);
      expect(piece.counts.events).toBe(2);
      expect(read(second, result)).toEqual(expected);
      // An event after the resume writes what one on the first runtime
      // writes: the item, the array for an added item, the state cell and
      // the counts in the event's transaction, and the row and the result
      // in the derivation's, with the basis. The derivation behind an added
      // item also writes the part of the lists of the readers that names
      // the item, the document of the units where that part is new, and
      // the part of the list of the documents the piece made that names
      // the item. No row that stayed is written.
      expect(heard.filter((ids) => ids.length > 7)).toEqual([]);
    });

    it("derives again what an input that changed while no runtime ran the piece makes stale, and writes that and the basis alone", async () => {
      const first = session();
      const { artifact, result } = await startedList(first, 3);
      await send(first, result, "rename", { at: 1, title: "renamed" });
      await dispose(first);

      const writer = session();
      const item = writer.getCell<Item>(space, "item 2", itemSchema);
      await item.sync();
      await commit(writer, (tx) => item.withTx(tx).key("title").set("late"));
      await dispose(writer);

      const second = session();
      const heard = changesHeard(second);
      const piece = await resumeCompiledPiece(
        second,
        artifact,
        second.getCellFromLink(result.getAsNormalizedFullLink()),
      );
      pieces.push(piece);
      await settled(second);

      expect(piece.refusals).toEqual([]);
      expect(
        read(second, result, "rows").map((
          row: { label: string },
        ) => row.label),
      ).toEqual(["t0!", "renamed!", "late!"]);
      expect(read(second, result, "events")).toBe(1);
      // One commit, of the document of the one row and of documents of the
      // basis, which takes the number the item has now.
      expect(heard.length).toBe(1);
      const { id } = result.getAsNormalizedFullLink();
      const ofBasis = new Set([
        `of:${basisDocumentOf(id)}`,
        ...Array.from(
          { length: 256 },
          (_, part) => `of:${basisPartDocumentOf(id, part)}`,
        ),
      ]);
      expect(heard[0].filter((entity) => !ofBasis.has(entity)).length).toBe(1);
    });
  });

  describe("over a handler that writes two state cells", () => {
    it("holds the state the first runtime stored and appends to it", async () => {
      const artifact = await artifactOf("handler");
      const first = session();
      const result = first.getCell<Record<string, unknown>>(space, "handler");
      await commit(first, (tx) => {
        pieces.push(
          startCompiledPiece(
            first,
            tx,
            artifact,
            { secret: "s", note: "n" },
            result.withTx(tx),
          ),
        );
      });
      await send(first, result, "record", { text: "a", extra: "e" });
      await dispose(first);

      const second = session();
      const heard = changesHeard(second);
      const piece = await resumeCompiledPiece(
        second,
        artifact,
        second.getCellFromLink(result.getAsNormalizedFullLink()),
      );
      pieces.push(piece);
      await settled(second);
      expect(heard).toEqual([]);
      expect(read(second, result, "last")).toBe("as");

      await send(second, result, "record", { text: "b", extra: "e" });

      expect(piece.refusals).toEqual([]);
      expect(read(second, result, "last")).toBe("bs");
      expect(read(second, result, "log")).toEqual([{ text: "a" }, {
        text: "b",
      }]);
      expect(read(second, result, "note")).toBe("n");
    });
  });
});
