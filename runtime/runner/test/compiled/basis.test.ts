import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type {
  Artifact,
  ModuleEvaluator,
} from "../../../../base/pattern-compiler/exec/executor.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  basisDocumentOf,
  basisPartDocumentOf,
} from "../../src/compiled/basis.ts";
import { parseLink } from "../../src/link-utils.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import {
  resumeCompiledPieceFromBasis,
  type ResumedPiece,
} from "../../src/compiled/resume.ts";
import { compartmentEvaluator } from "../../src/compiled/value-code.ts";
import { Runtime } from "../../src/runtime.ts";
import type { URI } from "../../src/sigil-types.ts";
import { type SharedStorage, shareStorage, storedList } from "./storage.ts";

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

// `fixtures/serving-list.tsx` is a `map` over an array that the type
// declares as references, given here as an array of references, each to an
// item in a document of its own. Each row is stored in a document of its
// own, and the handlers write an item, the array and a state cell.
describe("resumeCompiledPieceFromBasis()", () => {
  let signer: Identity;
  let space: MemorySpace;
  let shared: SharedStorage;
  let runtimes: Runtime[];
  let pieces: CompiledPiece[];
  let resumes: ResumedPiece[];
  /** How many module texts of value code were evaluated since `counted()`. */
  let evaluated: number;
  let evaluate: ModuleEvaluator;

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

  const settled = async (runtime: Runtime) => {
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.storageManager.synced();
  };

  /** Stops what runs in `runtime` and disposes it, with its session. */
  const dispose = async (runtime: Runtime) => {
    for (const piece of pieces.splice(0)) piece.stop();
    for (const resumed of resumes.splice(0)) resumed.stop();
    await settled(runtime);
    await runtime.dispose();
    runtimes.splice(runtimes.indexOf(runtime), 1);
  };

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("compiled piece basis");
    space = signer.did();
    shared = shareStorage();
    runtimes = [];
    pieces = [];
    resumes = [];
    evaluated = 0;
    const inCompartment = compartmentEvaluator();
    evaluate = (module, parameters) => {
      evaluated += 1;
      return inCompartment(module, parameters);
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

  const labels = (runtime: Runtime, result: Cell<unknown>): string[] =>
    read(runtime, result, "rows").map((row: { label: string }) => row.label);

  /** The entities of the documents of the rows, as `runtime` holds them. */
  const rowEntities = (runtime: Runtime, result: Cell<unknown>): URI[] => {
    const rows = storedList(runtime, result, ["rows"]) as unknown[];
    return rows.map((link) => parseLink(link as never).id as URI);
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
    return { artifact, result };
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

  /** The entities each commit that `runtime` makes from now on changes. */
  const commitsOf = (runtime: Runtime): string[][] => {
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

  /** The entities of the documents that hold the basis of a piece. */
  const ofBasis = (result: Cell<unknown>): Set<string> => {
    const { id } = result.getAsNormalizedFullLink();
    return new Set([
      `of:${basisDocumentOf(id)}`,
      ...Array.from(
        { length: 256 },
        (_, part) => `of:${basisPartDocumentOf(id, part)}`,
      ),
    ]);
  };

  /** Resumes the piece of `result` in `runtime` from its basis. */
  const resume = async (
    runtime: Runtime,
    artifact: Artifact,
    result: Cell<unknown>,
  ) => {
    const resumed = await resumeCompiledPieceFromBasis(
      runtime,
      artifact,
      runtime.getCellFromLink(result.getAsNormalizedFullLink()),
      { evaluate },
    );
    resumes.push(resumed);
    return resumed;
  };

  /** A handed-over list: three items, one renamed and one added. */
  const handedOver = async () => {
    const first = session();
    const { artifact, result } = await startedList(first, 3);
    await send(first, result, "rename", { at: 1, title: "renamed" });
    await send(first, result, "add", { id: "new", title: "added" });
    const stored = read(first, result);
    const rows = rowEntities(first, result);
    await dispose(first);
    return { artifact, result, stored, rows };
  };

  it("finds the piece current after the runtime before handled events, evaluates no value code, loads no row and commits nothing", async () => {
    const { artifact, result, rows } = await handedOver();
    const second = session();
    const heard = commitsOf(second);

    const resumed = await resume(second, artifact, result);
    await settled(second);

    expect(resumed.current).toBe(true);
    expect(resumed.piece).toBeUndefined();
    expect(evaluated).toBe(0);
    expect(heard).toEqual([]);
    const { replica } = second.storageManager.open(space);
    expect(rows.length).toBe(4);
    expect(rows.map((row) => replica.confirmedDocumentSeq(row))).toEqual([
      0,
      0,
      0,
      0,
    ]);
    // The argument, the list, its four items, the state cell and the
    // counts.
    expect(resumed.sources).toBe(8);
  });

  it("gives, for the events after a piece that was found current is woken, the values one runtime gives for all of them, and leaves the piece current", async () => {
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

    const { artifact, result } = await handedOver();
    const second = session();
    const resumed = await resume(second, artifact, result);
    expect(resumed.current).toBe(true);
    const piece = await resumed.wake();
    await settled(second);
    for (const [name, event] of events.slice(2)) {
      await send(second, result, name, event);
    }
    expect(piece.refusals).toEqual([]);
    expect(read(second, result)).toEqual(expected);
    await dispose(second);

    const third = session();
    evaluated = 0;
    const again = await resume(third, artifact, result);
    expect(again.current).toBe(true);
    expect(evaluated).toBe(0);
  });

  it("finds the piece stale where an input changed while no runtime ran the piece, and a wake then writes the row that differs and the basis", async () => {
    const { artifact, result, rows } = await handedOver();
    const writer = session();
    const item = writer.getCell<Item>(space, "item 2", itemSchema);
    await item.sync();
    await commit(writer, (tx) => item.withTx(tx).key("title").set("late"));
    await dispose(writer);
    const second = session();
    const heard = commitsOf(second);

    const resumed = await resume(second, artifact, result);
    expect(resumed.current).toBe(false);
    const piece = await resumed.wake();
    await settled(second);

    expect(piece.refusals).toEqual([]);
    expect(labels(second, result)).toEqual([
      "t0!",
      "renamed!",
      "late!",
      "added!",
    ]);
    // One commit: the document of the one row, and documents of the basis.
    expect(heard.length).toBe(1);
    expect(heard[0].filter((id) => !ofBasis(result).has(id))).toEqual([
      rows[2],
    ]);
    expect(heard[0].length).toBeGreaterThan(1);
    await dispose(second);

    const third = session();
    expect((await resume(third, artifact, result)).current).toBe(true);
  });

  it("wakes by itself when another writer changes an input of a piece that was found current", async () => {
    const { artifact, result } = await handedOver();
    const second = session();
    const resumed = await resume(second, artifact, result);
    expect(resumed.current).toBe(true);

    const writer = session();
    const item = writer.getCell<Item>(space, "item 0", itemSchema);
    await item.sync();
    await commit(writer, (tx) => item.withTx(tx).key("title").set("first"));
    const piece = await resumed.woken;
    await settled(second);

    expect(piece.refusals).toEqual([]);
    expect(labels(second, result)).toEqual([
      "first!",
      "renamed!",
      "t2!",
      "added!",
    ]);
  });

  it("finds the piece stale where it is resumed with another compiled pattern", async () => {
    const { artifact, result } = await handedOver();
    const other = structuredClone(artifact);
    (other.plan as { patterns: string[] }).patterns[0] = "sha256:another";
    const second = session();

    const resumed = await resume(second, other, result);

    expect(resumed.current).toBe(false);
  });
});
