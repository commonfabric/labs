import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { resumeCompiledPiece } from "../../src/compiled/resume.ts";
import { isPrimitiveCellLink } from "../../src/link-types.ts";
import { parseLink } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

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

/** The sizes of the collection each case is run at. */
const SIZES = [100, 1_000, 10_000];

/**
 * The most bytes, as JSON text, of the documents that the commits of one
 * step may change, at every size: a few chunks of 64 links and the row.
 */
const BOUND = 64_000;

// The result of a compiled piece keeps, for a `map` over an array of
// references whose rows are documents of their own, a list of links to the
// rows, and for an index it keeps, a record of links to the buckets. With
// the option `lists` at `documents`, each is stored in documents of its
// own, an array of more than 128 rows in chunks, and the result document
// holds a link to it. So a step that changes one link of an array writes
// documents whose size does not follow the number of rows.
describe("the lists of links of the result of a compiled piece, with the option `lists` at `documents`", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let space: MemorySpace;
  let piece: CompiledPiece | undefined;
  /** The size as JSON of each document a commit changed, by its entity. */
  let changed: Map<string, number>;

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
    changed = new Map();
    storageManager.subscribe({
      next(notification) {
        if (notification.type !== "commit") return undefined;
        for (const { address, after } of notification.changes) {
          changed.set(
            address.id,
            after === undefined ? 0 : JSON.stringify(after).length,
          );
        }
        return undefined;
      },
    });
    piece = undefined;
  });

  afterEach(async () => {
    piece?.stop();
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

  const start = async (
    name: string,
    argument: Record<string, unknown>,
  ): Promise<Cell<Record<string, unknown>>> => {
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      `link lists result ${name}`,
    );
    const compiled = await artifact(name);
    await commit((tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        compiled,
        argument,
        result.withTx(tx),
        { lists: "documents" },
      );
    });
    expect(piece!.refusals).toEqual([]);
    return result;
  };

  /**
   * The bytes of the documents that the commits of `step` changed, without
   * the documents of `inputs`, which the step itself writes.
   */
  const bytesOf = async (
    inputs: Cell<unknown>[],
    step: (tx: ReturnType<Runtime["edit"]>) => void,
  ): Promise<number> => {
    changed.clear();
    await commit(step);
    expect(piece!.refusals).toEqual([]);
    const own = new Set(
      inputs.map((cell) => cell.getAsNormalizedFullLink().id as string),
    );
    let bytes = 0;
    for (const [id, size] of changed) if (!own.has(id)) bytes += size;
    return bytes;
  };

  /** What `value` holds, with each link it is, in turn, followed. */
  const followed = (tx: ReturnType<Runtime["edit"]>, value: unknown) => {
    while (isPrimitiveCellLink(value)) {
      const { id, path } = parseLink(value as never);
      value = at(tx, id!, path);
    }
    return value;
  };

  /** What the document `id` holds at `path`, each link on the way followed. */
  const at = (
    tx: ReturnType<Runtime["edit"]>,
    id: string,
    path: readonly string[],
  ): unknown => {
    let value: unknown = tx.readValueOrThrow({
      space,
      id: id as never,
      path: [],
      scope: "space",
    });
    for (const segment of path) {
      value = (followed(tx, value) as Record<string, unknown> | undefined)
        ?.[segment];
    }
    return followed(tx, value);
  };

  /**
   * The members of the list the result holds at `name`, in order, read
   * from the storage with each link followed: a member that is itself an
   * array is a chunk of the list, whose members stand in its place. `read`
   * gives what is kept of each member.
   */
  const listOf = <T>(
    result: Cell<Record<string, unknown>>,
    name: string,
    read: (
      member: Record<string, unknown>,
      follow: (value: unknown) => unknown,
    ) => T,
  ): T[] => {
    const tx = runtime.edit();
    try {
      const follow = (value: unknown) => followed(tx, value);
      const list = at(tx, result.getAsNormalizedFullLink().id, [name]);
      return (list as unknown[]).flatMap((member) => {
        const held = follow(member);
        return Array.isArray(held) ? held.map(follow) : [held];
      }).map((member) => read(member as Record<string, unknown>, follow));
    } finally {
      tx.abort();
    }
  };

  /** The title of the topic of a row, and of each topic that mentions it. */
  const rowOf = (
    row: Record<string, unknown>,
    follow: (value: unknown) => unknown,
  ) => ({
    title: (follow(row.topic) as { title: string }).title,
    mentionedBy: (follow(row.mentionedBy) as { from: unknown }[]).map((
      { from },
    ) => (follow(from) as { title: string }).title),
  });

  /** `count` topics, each of which mentions the two before it. */
  const topics = async (count: number) => {
    const cells = Array.from(
      { length: count },
      (_, index) =>
        runtime.getCell<Record<string, unknown>>(
          space,
          `link lists topic ${index}`,
        ),
    );
    const list = runtime.getCell<unknown[]>(space, "link lists topics");
    await commit((tx) => {
      cells.forEach((cell, index) =>
        cell.withTx(tx).set({
          title: `t${index}`,
          mentions: cells.slice(Math.max(0, index - 2), index),
        })
      );
      list.withTx(tx).set(cells);
    });
    return { cells, list };
  };

  /** `count` items, the item `index` with the rank `index`. */
  const ranked = async (count: number) => {
    const items = Array.from(
      { length: count },
      (_, index) =>
        runtime.getCell<Record<string, unknown>>(
          space,
          `link lists item ${index}`,
        ),
    );
    const list = runtime.getCell<unknown[]>(space, "link lists items");
    await commit((tx) => {
      items.forEach((cell, index) =>
        cell.withTx(tx).set({ title: `t${index}`, rank: index })
      );
      list.withTx(tx).set(items);
    });
    return { items, list };
  };

  /** The titles of the cards of the sorted order, in order. */
  const cardsOf = (result: Cell<Record<string, unknown>>) =>
    listOf(result, "cards", ({ title }, follow) => follow(title));

  it("holds in the result document a link at the place of the array of rows and of the record of buckets, and gives a reader that follows the links the rows of a long array in order", async () => {
    const { list } = await topics(150);
    const result = await start("bucket-reference", { topics: list });

    const tx = runtime.edit();
    try {
      const stored = tx.readValueOrThrow(
        result.getAsNormalizedFullLink(),
      ) as { rows: unknown; byMentioned: { buckets: unknown } };
      expect(isPrimitiveCellLink(stored.rows)).toBe(true);
      expect(isPrimitiveCellLink(stored.byMentioned.buckets)).toBe(true);
      expect(JSON.stringify(stored).length).toBeLessThan(4_000);
    } finally {
      tx.abort();
    }
    const rows = listOf(result, "rows", rowOf);
    expect(rows.map(({ title }) => title)).toEqual(
      Array.from({ length: 150 }, (_, index) => `t${index}`),
    );
    expect(rows[147].mentionedBy).toEqual(["t148", "t149"]);
  });

  it("holds the rows of an array of at most 128 in the document the link leads to, so that a reader reads the array at its path", async () => {
    const { list } = await ranked(40);
    const result = await start("sorted-rows", { items: list });

    const tx = runtime.edit();
    try {
      const cards = result.withTx(tx).key("cards").get() as {
        title: string;
      }[];
      expect(cards.map(({ title }) => title)).toEqual(
        Array.from({ length: 40 }, (_, index) => `t${index}`),
      );
    } finally {
      tx.abort();
    }
  });

  it("stores the link to a bucket that comes to exist in the document of the links of the index, and leaves the value of the result document as it was", async () => {
    const { cells, list } = await topics(100);
    const result = await start("bucket-reference", { topics: list });
    const read = () => {
      const tx = runtime.edit();
      try {
        return JSON.stringify(
          tx.readValueOrThrow(result.getAsNormalizedFullLink()),
        );
      } finally {
        tx.abort();
      }
    };
    const before = read();

    // No topic mentions the last one until the first one does.
    await commit((tx) => cells[0].withTx(tx).key("mentions").set([cells[99]]));

    expect(piece!.refusals).toEqual([]);
    expect(read()).toBe(before);
    expect(listOf(result, "rows", rowOf)[99].mentionedBy).toEqual(["t0"]);
  });

  it("keeps the chunks the storage holds when the piece is resumed, and writes those that a move after the resume touches", async () => {
    const { items, list } = await ranked(1_000);
    const result = await start("sorted-rows", { items: list });
    await commit((tx) => items[500].withTx(tx).key("rank").set(-1));
    piece!.stop();
    await runtime.scheduler.idleWithPendingCommits();

    changed.clear();
    piece = await resumeCompiledPiece(
      runtime,
      await artifact("sorted-rows"),
      result,
      { lists: "documents" },
    );
    await runtime.scheduler.idleWithPendingCommits();
    expect(piece.refusals).toEqual([]);
    let resumed = 0;
    for (const size of changed.values()) resumed += size;
    const bytes = await bytesOf(
      [items[700]],
      (tx) => items[700].withTx(tx).key("rank").set(-2),
    );

    expect(resumed).toBeLessThan(BOUND);
    expect(bytes).toBeLessThan(BOUND);
    const cards = cardsOf(result);
    expect(cards).toHaveLength(1_000);
    expect(cards.slice(0, 3)).toEqual(["t700", "t500", "t0"]);
    expect(cards[999]).toBe("t999");
  });

  for (const size of SIZES) {
    it(`writes documents of a bounded size when a topic is appended to ${size} topics`, async () => {
      const { list } = await topics(size);
      const result = await start("bucket-reference", { topics: list });
      const entering = runtime.getCell<Record<string, unknown>>(
        space,
        "link lists topic entering",
      );

      const bytes = await bytesOf([list, entering], (tx) => {
        entering.withTx(tx).set({ title: "entered", mentions: [] });
        list.withTx(tx).push(entering);
      });

      expect(bytes).toBeLessThan(BOUND);
      const rows = listOf(result, "rows", rowOf);
      expect(rows).toHaveLength(size + 1);
      expect(rows[size].title).toBe("entered");
      expect(rows[size - 3].mentionedBy).toEqual([
        `t${size - 2}`,
        `t${size - 1}`,
      ]);
    });

    it(`writes documents of a bounded size when one of ${size} items moves to the front of a sorted order`, async () => {
      const { items, list } = await ranked(size);
      const result = await start("sorted-rows", { items: list });
      const moved = items[size - 3];

      const bytes = await bytesOf(
        [moved],
        (tx) => moved.withTx(tx).key("rank").set(-1),
      );

      expect(bytes).toBeLessThan(BOUND);
      const cards = cardsOf(result);
      expect(cards).toHaveLength(size);
      expect(cards.slice(0, 2)).toEqual([`t${size - 3}`, "t0"]);
      expect(cards[size - 1]).toBe(`t${size - 1}`);
    });
  }
});
