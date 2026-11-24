import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";
import { argumentOf, Ref } from "../store.ts";

const ARGUMENT = argumentOf("result");

/** The pattern `name` of `compare/fixtures/body-argument.tsx`. */
const artifact = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../compare/fixtures/body-argument.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === name)!;
};

/**
 * Counts the reads of the store that no other read of the store made, and
 * returns the paths of the argument they read, as text.
 */
const outermostReads = (instance: Instance): string[] => {
  const { store } = instance;
  const read = store.read.bind(store);
  const paths: string[] = [];
  let depth = 0;
  store.read = (...given: Parameters<typeof read>) => {
    const [ref] = given as [Ref];
    if (depth === 0 && ref.doc === ARGUMENT) paths.push(ref.path.join("/"));
    depth += 1;
    try {
      return read(...given);
    } finally {
      depth -= 1;
    }
  };
  return paths;
};

describe("what a function body is handed", () => {
  it("reads an array that a `lift` is handed whole once for a call of the body", async () => {
    const instance = new Instance(await artifact("Whole"), {
      items: [0, 1, 2].map((index) => ({
        title: `t${index}`,
        done: index === 1,
      })),
    });
    expect(instance.result()).toEqual({ open: 2 });
    const reads = outermostReads(instance);

    instance.writeArgument(["items", "0", "done"], true);

    expect(instance.result()).toEqual({ open: 1 });
    expect(reads).toEqual(["items"]);
  });

  const board = () => ({
    kind: "board",
    rows: Object.fromEntries(
      ["a", "b", "c"].map((
        name,
      ) => [name, { title: `title of ${name}`, done: false }]),
    ),
  });

  it("reads nothing of a record that a `lift` declares as a cell but what the body reads through the handle", async () => {
    const instance = new Instance(await artifact("One"), {
      board: board(),
      name: "a",
    });
    expect(instance.result()).toEqual({ title: "title of a" });
    const reads = outermostReads(instance);

    instance.writeArgument(["name"], "b");

    expect(instance.result()).toEqual({ title: "title of b" });
    expect(reads.filter((path) => path === "board" || path === "board/rows"))
      .toEqual([]);
  });

  it("evaluates such a body again for the member it read, and not for another member of the record", async () => {
    const instance = new Instance(await artifact("One"), {
      board: board(),
      name: "a",
    });
    expect(instance.result()).toEqual({ title: "title of a" });
    const before = instance.counts.evaluations;

    instance.writeArgument(["board", "rows", "b", "title"], "edited");

    expect(instance.counts.evaluations).toBe(before);

    instance.writeArgument(["board", "rows", "a", "title"], "edited");

    expect(instance.result()).toEqual({ title: "edited" });
  });
});

describe("a body handed the reference that each row of a `map` holds", () => {
  /** The pattern of `compare/fixtures/element-reference.tsx`. */
  const elementReference = async (): Promise<Artifact> => {
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../../compare/fixtures/element-reference.emit.json",
          import.meta.url,
        ),
      ),
    ) as { patterns: Artifact[] }[];
    return patterns.find(({ name }) => name === "default")!;
  };

  const items = [0, 1, 2].map((index) => ({
    id: `item-${index}`,
    kind: "item",
    value: { title: `t${index}`, n: index },
  }));

  it("is handed a handle at each row of a `map` over an array of references, which resolves to the element's cell", async () => {
    const instance = new Instance(
      await elementReference(),
      { items: items.map(({ id }) => ({ $link: { doc: id, path: [] } })) },
      { documents: items },
    );

    expect(instance.result()).toEqual({
      keys: items.map(({ id }) => instance.equalsKey(new Ref(id, []))),
      big: 1,
    });
  });

  it("evaluates nothing when a member of an element is written that neither the rows nor the body read", async () => {
    const instance = new Instance(
      await elementReference(),
      { items: items.map(({ id }) => ({ $link: { doc: id, path: [] } })) },
      { documents: items },
    );
    const before = instance.result();
    const evaluations = instance.counts.evaluations;

    instance.store.write(new Ref("item-1", ["title"]), "edited");
    instance.settle();

    expect(instance.counts.evaluations).toBe(evaluations);
    expect(instance.result()).toEqual(before);
  });

  it("is handed a handle at each row of a `map` over an array of plain values in place, which resolves to the element's position", async () => {
    const instance = new Instance(await elementReference(), {
      items: items.map(({ value }) => value),
    });

    expect(instance.result()).toEqual({
      keys: items.map((_, index) =>
        instance.equalsKey(new Ref(ARGUMENT, ["items", `${index}`]))
      ),
      big: 1,
    });
  });
});
