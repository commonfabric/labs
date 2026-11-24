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
import { openStorage, storedList, type TestStorage } from "./storage.ts";

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

// The inverse of a relation that each member holds as a list of
// references (`compare/fixtures/crossref.tsx`): a `flatMap` over an array
// of topic references into one pair for each mention, a `groupBy` of the
// pairs by the topic mentioned, which is a cell, a `map` over the topics
// that looks up each topic by its reference, and an index of the rows by
// name that the result keeps. Every topic is a cell under a clause of its
// own, named `clause-` and the name of the cell. Which topics mention a
// topic depends on the list of mentions of every topic, so a row's
// `mentionedBy` has the clause of every topic of the array. A topic that
// is mentioned and is not in the array is compared as a reference and not
// read. Its clause is in the label all the same: the runtime stores, with
// a link, the label of what the link names, and a read of which reference
// a position holds consumes that.
describe("the stored labels of the inverse of a relation of references: a grouping of the pairs of a `flatMap` by a cell, and a lookup by a reference", () => {
  let runtime: Runtime;
  let storageManager: TestStorage;
  let space: MemorySpace;
  let pieces: CompiledPiece[];

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("pattern-compiler-compare");
    space = signer.did();
    storageManager = openStorage(signer);
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
      `crossref ${name}`,
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
      `crossref result ${name}`,
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
   * Four topics, each of which mentions the two before it, and the first
   * of which mentions the topic `tz`, which the array does not hold.
   */
  const crossed = async () => {
    const topics = await Promise.all(TOPICS.map(labeled));
    const outside = await labeled("tz");
    const list = runtime.getCell<unknown[]>(space, "crossref topics");
    await commit((tx) => {
      outside.withTx(tx).set({ title: "tz", shortName: "z", mentions: [] });
      topics.forEach((cell, index) =>
        cell.withTx(tx).set({
          title: TOPICS[index],
          shortName: `${index + 1}`,
          mentions: index === 0
            ? [outside]
            : topics.slice(Math.max(0, index - 2), index).reverse(),
        })
      );
      list.withTx(tx).set(topics);
    });
    const result = await started("crossref", { topics: list });
    return { result, topics };
  };

  /** The titles of the topics that mention each topic, by its title. */
  const mentionedBy = (result: Cell<Record<string, unknown>>) =>
    Object.fromEntries(
      (valueOf(result).rows as {
        topic: { title: string };
        mentionedBy: { title: string }[];
      }[]).map((row) => [
        row.topic.title,
        row.mentionedBy.map(({ title }) => title),
      ]),
    );

  it("gives each row the topics of the array that mention its topic", async () => {
    const { result } = await crossed();

    expect(valueOf(result).count).toBe(4);
    expect(mentionedBy(result)).toEqual({
      ta: ["tb", "tc"],
      tb: ["tc", "td"],
      tc: ["td"],
      td: [],
    });
  });

  it("stores the clause of every topic of the array for the topics that mention a topic, for a topic that is mentioned and for one that is not", async () => {
    const { result } = await crossed();

    expect(consumed(result, ["rows", "0", "mentionedBy", "length"])).toEqual(
      clauses(...TOPICS, "tz"),
    );
    expect(consumed(result, ["rows", "3", "mentionedBy", "length"])).toEqual(
      clauses(...TOPICS, "tz"),
    );
  });

  it("stores the clause of the row's topic alone for the name of a row, and no clause for the number of topics", async () => {
    const { result } = await crossed();

    expect(consumed(result, ["rows", "1", "name"])).toEqual(clauses("tb"));
    expect(consumed(result, ["count"])).toEqual([]);
  });

  it("files each row under its name in the index the result keeps, as a link to the document of the row", async () => {
    const { result } = await crossed();

    const byName = valueOf(result).byName as {
      buckets: Record<string, { name: string; topic: { title: string } }[]>;
    };
    expect(byName.buckets["s:2"]).toMatchObject([{
      name: "2",
      topic: { title: "tb" },
    }]);
    const tx = runtime.edit();
    try {
      // The bucket is a document of its own, which the document of the
      // bucket links of the index links to.
      const bucket = (storedList(runtime, result, ["byName", "buckets"]) as {
        [key: string]: unknown;
      })["s:2"];
      expect(isPrimitiveCellLink(bucket)).toBe(true);
      const [stored] = tx.readValueOrThrow({
        space,
        id: parseLink(bucket as never).id!,
        path: [],
        scope: "space",
      }) as unknown[];
      expect(isPrimitiveCellLink(stored)).toBe(true);
    } finally {
      tx.abort();
    }
  });

  it("stores the clause of every topic of the array for a bucket of the index of the rows by name, and for the record of its buckets", async () => {
    const { result } = await crossed();

    expect(consumed(result, ["byName", "buckets", "s:2", "length"])).toEqual(
      clauses(...TOPICS),
    );
    // A read of the record of the buckets follows the link to each
    // bucket's document, to each row and to each topic a row holds, the
    // topic that is mentioned and is in no array among them.
    expect(consumed(result, ["byName", "buckets"])).toEqual(
      clauses(...TOPICS, "tz"),
    );
  });

  it("moves a topic between the rows of the topics it mentions when another writer writes its mentions, under the clause of every topic", async () => {
    const { result, topics } = await crossed();

    await commit((tx) => topics[3].withTx(tx).key("mentions").set([topics[0]]));

    expect(mentionedBy(result)).toEqual({
      ta: ["tb", "tc", "td"],
      tb: ["tc"],
      tc: [],
      td: [],
    });
    expect(consumed(result, ["rows", "2", "mentionedBy", "length"])).toEqual(
      clauses(...TOPICS, "tz"),
    );
    expect(consumed(result, ["rows", "2", "name"])).toEqual(clauses("tc"));
  });

  it("gives no record of the index of the rows by name when another writer writes the title of a topic, which no body reads", async () => {
    const { result, topics } = await crossed();
    const recorded: string[] = [];
    pieces[0].transactions.onRecorded((writes) => {
      for (const { target } of writes) recorded.push(target.path.join("/"));
    });

    await commit((tx) => topics[1].withTx(tx).key("title").set("written"));

    expect(recorded.filter((path) => path.startsWith("byName"))).toEqual([]);
    expect(consumed(result, ["byName", "buckets"])).toEqual(
      clauses(...TOPICS, "tz"),
    );
  });
});
