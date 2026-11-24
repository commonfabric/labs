import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import { inputClause } from "../../../../base/pattern-compiler/compare/generate.ts";
import { scenarioAudience } from "../../../../base/pattern-compiler/compare/harness.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import { deriveFlowJoin } from "../../src/cfc/prepare.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { isPrimitiveCellLink } from "../../src/link-types.ts";
import { parseLink } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { storedList } from "./storage.ts";

/** The default pattern of `compare/fixtures/<name>.tsx`. */
const artifact = async (name: string): Promise<Artifact> => {
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

// A `map` over an array of topic references whose row holds what it looked
// up in a grouping that the result keeps
// (`compare/fixtures/bucket-reference.tsx`): the pairs of a `flatMap` over
// the array, grouped by the topic mentioned, which is a cell. Each bucket
// of the kept index is a document of its own, and a row whose bucket
// exists holds a link to the position of the bucket in the result. Every
// topic is a cell under a clause of its own, named `clause-` and the name
// of the cell. Which topics mention a topic depends on the list of
// mentions of every topic, so a read of the bucket a row holds consumes
// the clause of every topic of the array.
describe("the rows of a `map` over an array of references that each hold the bucket they looked up in an index the result keeps", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let space: MemorySpace;
  let pieces: CompiledPiece[];

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("pattern-compiler-compare");
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
    pieces = [];
  });

  afterEach(async () => {
    for (const piece of pieces) piece.stop();
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

  /** A cell named `name` under the one clause `clause-<name>`. */
  const labeled = async (name: string) =>
    runtime.getCell<Record<string, unknown>>(
      space,
      `bucket reference ${name}`,
      {
        type: "object",
        ifc: {
          confidentiality: [
            inputClause(`clause-${name}`, await scenarioAudience()),
          ],
        },
      } as JSONSchema,
    );

  const clauses = (...names: string[]) =>
    names.map((name) => `input:clause-${name}`).sort();

  /** Starts the pattern of the fixture `name` on `argument`. */
  const started = async (name: string, argument: Record<string, unknown>) => {
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      `bucket reference result ${name}`,
    );
    const compiled = await artifact(name);
    let piece: CompiledPiece | undefined;
    await commit((tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        compiled,
        argument,
        result.withTx(tx),
      );
      pieces.push(piece);
    });
    expect(piece!.refusals).toEqual([]);
    return result;
  };

  /** The value a cell holds, with every link followed. */
  const valueOf = <T>(cell: Cell<T>): T => {
    const tx = runtime.edit();
    try {
      return JSON.parse(JSON.stringify(cell.withTx(tx).get())) as T;
    } finally {
      tx.abort();
    }
  };

  /**
   * The clauses of the inputs that a read of the value at `path` of
   * `result` consumes, in the runtime's own resolution.
   */
  const consumed = (
    result: Cell<Record<string, unknown>>,
    path: string[],
  ): string[] => {
    const tx = runtime.edit();
    try {
      // deno-lint-ignore no-explicit-any
      let cell: any = result.withTx(tx);
      for (const segment of path) cell = cell.key(segment);
      JSON.stringify(cell.get());
      const text = JSON.stringify(deriveFlowJoin(tx).confidentiality);
      return [...new Set(text.match(/input:clause-[a-z0-9]+/g) ?? [])].sort();
    } finally {
      tx.abort();
    }
  };

  const TOPICS = ["ta", "tb", "tc", "td"];

  /**
   * Four topics, each of which mentions the two before it, so that the
   * last is mentioned by none.
   */
  const crossed = async () => {
    const topics = await Promise.all(TOPICS.map(labeled));
    const list = runtime.getCell<unknown[]>(space, "bucket reference topics");
    await commit((tx) => {
      topics.forEach((cell, index) =>
        cell.withTx(tx).set({
          title: TOPICS[index],
          mentions: topics.slice(Math.max(0, index - 2), index).reverse(),
        })
      );
      list.withTx(tx).set(topics);
    });
    const result = await started("bucket-reference", { topics: list });
    return { result, topics, list };
  };

  /** What the document of the row at `index` stores at `mentionedBy`. */
  const storedBucketOf = (
    result: Cell<Record<string, unknown>>,
    index: number,
  ): unknown => {
    const tx = runtime.edit();
    try {
      const row = (storedList(runtime, result, ["rows"]) as unknown[])[index];
      return tx.readValueOrThrow({
        space,
        id: parseLink(row as never).id!,
        path: ["mentionedBy"],
        scope: "space",
      });
    } finally {
      tx.abort();
    }
  };

  /** The titles of the topics that mention each topic, by its title. */
  const mentionedBy = (result: Cell<Record<string, unknown>>) =>
    Object.fromEntries(
      (valueOf(result).rows as {
        topic: { title: string };
        mentionedBy: { from: { title: string } }[];
      }[]).map((row) => [
        row.topic.title,
        row.mentionedBy.map(({ from }) => from.title),
      ]),
    );

  it("gives each row the pairs of the topics that mention its topic", async () => {
    const { result } = await crossed();

    expect(mentionedBy(result)).toEqual({
      ta: ["tb", "tc"],
      tb: ["tc", "td"],
      tc: ["td"],
      td: [],
    });
  });

  it("stores, in the row of a topic that is mentioned, a link to the position of its bucket in the index of the result, and in the row of a topic that is not, an empty array", async () => {
    const { result } = await crossed();

    const held = storedBucketOf(result, 0);
    expect(isPrimitiveCellLink(held)).toBe(true);
    const link = parseLink(held as never, result);
    expect(link.id).toBe(result.getAsNormalizedFullLink().id);
    expect(link.path.slice(0, 2)).toEqual(["byMentioned", "buckets"]);
    expect(link.path).toHaveLength(3);
    expect(storedBucketOf(result, 3)).toEqual([]);
  });

  it("consumes the clause of every topic for a read of the bucket a row holds, for a topic that is mentioned and for one that is not", async () => {
    const { result } = await crossed();

    expect(consumed(result, ["rows", "0", "mentionedBy", "length"])).toEqual(
      clauses(...TOPICS),
    );
    expect(consumed(result, ["rows", "3", "mentionedBy", "length"])).toEqual(
      clauses(...TOPICS),
    );
  });

  it("gives the record of the bucket of the row of a topic that enters the array, and of no other row", async () => {
    const { result, list } = await crossed();
    const entering = await labeled("te");
    const recorded: string[] = [];
    pieces[0].transactions.onRecorded((writes) => {
      for (const { target } of writes) recorded.push(target.path.join("/"));
    });

    await commit((tx) => {
      entering.withTx(tx).set({ title: "te", mentions: [] });
      list.withTx(tx).push(entering);
    });

    expect(recorded.filter((path) => path === "mentionedBy")).toHaveLength(1);
    expect(mentionedBy(result).te).toEqual([]);
  });

  it("gives the record of the index again, and of no row that holds its bucket by a link, when the list of mentions of a topic comes under another clause, and a read of a bucket that stayed then consumes that clause", async () => {
    const { result } = await crossed();
    const recorded: string[] = [];
    pieces[0].transactions.onRecorded((writes) => {
      for (const { target } of writes) recorded.push(target.path.join("/"));
    });
    // The cell of the second topic under the clause `clause-tx`.
    const relabeled = runtime.getCell<Record<string, unknown>>(
      space,
      "bucket reference tb",
      {
        type: "object",
        ifc: {
          confidentiality: [
            inputClause("clause-tx", await scenarioAudience()),
          ],
        },
      } as JSONSchema,
    );

    await commit((tx) => relabeled.withTx(tx).key("mentions").set([]));

    expect(mentionedBy(result)).toEqual({
      ta: ["tc"],
      tb: ["tc", "td"],
      tc: ["td"],
      td: [],
    });
    // The row of the last topic, which holds an empty array in place under
    // a label that names every topic, and no row that holds a link.
    expect(recorded.filter((path) => path === "mentionedBy")).toHaveLength(1);
    expect(recorded).toContain("byMentioned");
    // The bucket of the second topic holds the members it held, and its
    // document is not written.
    expect(consumed(result, ["rows", "1", "mentionedBy", "length"])).toContain(
      "input:clause-tx",
    );
  });

  it("stores a link in the row of a topic when a first topic mentions it, and an empty array again when none does", async () => {
    const { result, topics } = await crossed();

    // The last topic mentions none, so that a topic it mentioned can
    // mention it.
    await commit((tx) => topics[3].withTx(tx).key("mentions").set([]));

    expect(storedBucketOf(result, 2)).toEqual([]);

    await commit((tx) => topics[0].withTx(tx).key("mentions").set([topics[3]]));

    expect(isPrimitiveCellLink(storedBucketOf(result, 3))).toBe(true);
    expect(mentionedBy(result).td).toEqual(["ta"]);
    expect(consumed(result, ["rows", "3", "mentionedBy", "length"])).toEqual(
      clauses(...TOPICS),
    );

    await commit((tx) => topics[0].withTx(tx).key("mentions").set([]));

    expect(storedBucketOf(result, 3)).toEqual([]);
    expect(mentionedBy(result).td).toEqual([]);
  });

  it("writes no document of a row when a topic enters the bucket the row holds by a link", async () => {
    const { result, topics } = await crossed();
    const recorded: string[] = [];
    pieces[0].transactions.onRecorded((writes) => {
      for (const { target } of writes) recorded.push(target.path.join("/"));
    });

    await commit((tx) => topics[3].withTx(tx).key("mentions").set([topics[0]]));

    expect(mentionedBy(result)).toEqual({
      ta: ["tb", "tc", "td"],
      tb: ["tc"],
      tc: [],
      td: [],
    });
    // The row of `tc`, whose bucket emptied, and no other.
    expect(recorded.filter((path) => path === "mentionedBy")).toHaveLength(1);
  });
});
