import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { maxOf } from "@commonfabric/collections/math";

import { type Artifact, Instance } from "../executor.ts";
import type { Scope } from "../scope-instances.ts";

/** The pattern of `compare/fixtures/<name>.tsx`. */
const artifact = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../../compare/fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

type Node = {
  name?: string;
  props?: Record<string, unknown>;
  children?: unknown[];
};

/** The principals an instance is evaluated for, in order. */
const PRINCIPALS = ["ann", "bob", "cat", "dan", "eve"];

/**
 * An instance of `fixture` over `size` items, each a document of its own
 * that the argument holds a reference to, or with `plain` each a plain
 * value in place, evaluated for `principals` principals, `ann`, `bob` and
 * those after them, with what each derivation writes to the store noted.
 * Each principal acts in one session, `s`.
 */
const started = async (
  fixture: string,
  size: number,
  plain = false,
  principals = 2,
) => {
  let acting = "ann";
  const items = Array.from({ length: size }, (_, index) => ({
    id: `item ${index}`,
    kind: "item",
    value: { title: `item ${index}` },
  }));
  const instance = new Instance(
    await artifact(fixture),
    { items: { $link: { doc: "items", path: [] } } },
    {
      documents: plain
        ? [{
          id: "items",
          kind: "items",
          value: items.map(({ value }) => value.title),
        }]
        : [
          {
            id: "items",
            kind: "items",
            value: items.map(({ id }) => ({ $link: { doc: id, path: [] } })),
          },
          ...items,
        ],
      scopes: {
        keyOf: (scope: Scope) =>
          scope === "user" ? `user:${acting}` : `session:${acting}:s`,
      },
    },
  );
  const as = <T>(principal: string, run: () => T): T => {
    acting = principal;
    return run();
  };
  const view = (principal: string): Node =>
    as(principal, () => {
      instance.settle();
      return (instance.result() as { $UI: Node }).$UI;
    });
  const send = (principal: string, stream: string, event: unknown) =>
    as(principal, () => {
      const binding = instance.streams().find(({ path }) =>
        path.join("/") === stream
      )!;
      return instance.send(binding.binding, event);
    });
  /** The size as JSON of every scope instance the store holds. */
  const scoped = () =>
    [...instance.store.docs].filter(([, { kind }]) => kind === "scope instance")
      .reduce((sum, [, document]) => sum + JSON.stringify(document).length, 0);
  /** The documents and paths `run` writes to the store. */
  const written = (run: () => void): string[] => {
    const writes: string[] = [];
    const { store } = instance;
    const put = store.put.bind(store);
    const splice = store.splice.bind(store);
    const write = store.write.bind(store);
    store.write = (ref, value) => {
      writes.push(`${ref.doc} ${ref.path.join("/")} write`);
      return write(ref, value);
    };
    store.put = (doc, path, value) => {
      writes.push(`${doc} ${path.join("/")}`);
      return put(doc, path, value);
    };
    store.splice = (ref, start, removed, members) => {
      writes.push(`${ref.doc} ${ref.path.join("/")} splice`);
      return splice(ref, start, removed, members);
    };
    try {
      run();
    } finally {
      store.put = put;
      store.splice = splice;
      store.write = write;
    }
    return writes;
  };
  /** The scope instances the store holds for `principal`, by name. */
  const instancesOf = (principal: string) =>
    [...instance.store.docs].filter(([id, { kind }]) =>
      kind === "scope instance" &&
      (id.endsWith(`~session:${principal}:s`) ||
        id.endsWith(`~user:${principal}`))
    );
  /**
   * The size as JSON of the instance of `principal` of each document named
   * for a scope that `writes` (from `written`) name.
   */
  const sizesWritten = (writes: string[], principal: string): number[] =>
    as(
      principal,
      () =>
        writes.filter((write) => write.includes("~")).map((write) =>
          JSON.stringify(instance.store.docs.get(write.split(" ")[0])?.value)
            .length
        ),
    );
  /** The entries of a scope key brought up to date by `run`. */
  const pulled = (run: () => void): number => {
    const before = instance.counts.scopedPulls;
    run();
    return instance.counts.scopedPulls - before;
  };
  const keys = PRINCIPALS.slice(0, principals);
  for (const principal of keys) view(principal);
  return {
    instance,
    view,
    send,
    scoped,
    written,
    as,
    instancesOf,
    sizesWritten,
    pulled,
    keys,
  };
};

// `fixtures/scoped-view.tsx`: a rendered tree that holds the rows of a
// `map` over an array of references, whose rows read nothing of a user,
// and reads whether the acting user has a nickname, a value of the scope
// `user`, in the condition of a branch and in an attribute. The crate
// plans each of those two expressions as a value of its own (P451), so
// the cone of the tree places them and reads nothing of a user.
describe("a rendered tree that reads a value of the scope `user` in two places, beside the rows of a `map` over an array of references", () => {
  it("holds no row in a scope instance, at 10 items as at 100", async () => {
    const small = await started("scoped-view", 10);
    const large = await started("scoped-view", 100);

    expect(large.scoped()).toBe(small.scoped());
  });

  it("writes one row and no scope instance for an edit of one item, at 10 items as at 100", async () => {
    const edits = await Promise.all([10, 100].map(async (size) => {
      const { send, view, written } = await started("scoped-view", size);
      return written(() => {
        send("ann", "rename", { at: 3, title: "renamed" });
        view("ann");
        view("bob");
      });
    }));

    for (const writes of edits) {
      expect(writes.filter((write) => write.includes("~"))).toEqual([]);
    }
    expect(edits[1]).toEqual(edits[0]);
  });

  it("gives each principal the branch and the attribute its own nickname selects", async () => {
    const { send, view } = await started("scoped-view", 10);
    send("ann", "call", { name: "Ann" });

    const ann = view("ann");
    const bob = view("bob");
    expect(JSON.stringify(ann.children?.[0])).toContain("Ann");
    expect(JSON.stringify(bob.children?.[0])).toContain("nobody");
    expect((ann.children?.[1] as Node).props?.disabled).toBe(false);
    expect((bob.children?.[1] as Node).props?.disabled).toBe(true);
    expect(JSON.stringify(view("ann").children?.[2])).toContain("item 3!");
  });
});

// The rows of a per-element construct whose body reads a value of the
// scope `session`: the crate plans the expression that reads it as a cone
// of its own per element key, which the row places without reading it
// (P454). The row stays a row of the space, evaluated once for every key,
// and holds a reference to the value's place, which is a document of its
// own for each row, with a scope instance for each key that reads it.
// Each case over two principals at 10 and at 100 items, counting what is
// written and brought up to date, not time.
const ROW_CASES = [
  {
    fixture: "scoped-view-rows",
    case: "a rendered tree whose rows of a `map` over an array of references",
    plain: false,
    rowsOf: (result: unknown) =>
      ((result as { $UI: Node }).$UI.children?.[2] as unknown[]) ?? [],
    shown: (row: unknown) => JSON.stringify(row),
  },
  {
    fixture: "scoped-rows-plain",
    case: "records returned by a `map` over an array of plain values in place",
    plain: true,
    rowsOf: (result: unknown) => (result as { rows: unknown[] }).rows,
    shown: (row: unknown) => JSON.stringify(row),
  },
  {
    fixture: "scoped-rows-filter",
    case:
      "records returned by a `map` over the result of a `filter` over an array of references",
    plain: false,
    rowsOf: (result: unknown) => (result as { rows: unknown[] }).rows,
    shown: (row: unknown) => JSON.stringify(row),
  },
];

/**
 * Writes as `written` gives them, each document named by the order in
 * which it is first written: the names of the documents of the rows of
 * plain values follow the secret of the store, which each instance mints.
 */
const normalized = (writes: string[]): string[] => {
  const names = new Map<string, string>();
  return writes.map((write) => {
    const [doc, ...rest] = write.split(" ");
    if (!names.has(doc)) {
      names.set(
        doc,
        `${doc.endsWith("~session") ? "place" : "doc"} ${names.size}`,
      );
    }
    return [names.get(doc), ...rest].join(" ");
  });
};

/** What a principal reads of the rows of `held`, each as its JSON. */
const rowsRead = (
  held: Awaited<ReturnType<typeof started>>,
  principal: string,
  rowsOf: (result: unknown) => unknown[],
): string[] =>
  held.as(principal, () => {
    held.instance.settle();
    return rowsOf(held.instance.result()).map((row) => JSON.stringify(row));
  });

for (const { fixture, case: written, plain, rowsOf } of ROW_CASES) {
  describe(`${written}, whose body reads a value of the scope \`session\``, () => {
    it("gives each principal the rows its own nickname selects", async () => {
      const held = await started(fixture, 10, plain);
      held.send("ann", "call", { name: "Ann" });
      held.send("ann", "rename", { at: 3, title: "renamed" });

      const ann = rowsRead(held, "ann", rowsOf);
      const bob = rowsRead(held, "bob", rowsOf);
      expect(ann.some((row) => row.includes("renamed!"))).toBe(true);
      expect(bob.some((row) => row.includes("renamed"))).toBe(true);
      expect(bob.some((row) => row.includes("!"))).toBe(false);
    });

    it("holds each row in the result and one place per row in the scope instances of each principal, at 10 items as at 100", async () => {
      const [small, large] = await Promise.all(
        [10, 100].map((size) => started(fixture, size, plain)),
      );

      for (const principal of ["ann", "bob"]) {
        const counts = [small, large].map((held) =>
          held.instancesOf(principal).length
        );
        expect(counts[1] - counts[0]).toBe(90);
        // No scope instance holds more as the rows grow, beyond the digit
        // more that an item's title has at 100 items.
        const largest = [small, large].map((held) =>
          maxOf(
            held.instancesOf(principal).map(([, document]) =>
              JSON.stringify(document.value).length
            ),
          )
        );
        expect(largest[1] - largest[0]).toBeLessThanOrEqual(2);
      }
      expect(JSON.stringify(large.instance.store.docs.get("result")))
        .toContain("~session");
    });

    it("writes the item, and the place of its row for each principal, and the same documents at 10 items as at 100, for an edit of one item", async () => {
      const edits = await Promise.all([10, 100].map(async (size) => {
        const held = await started(fixture, size, plain);
        const writes = held.written(() => {
          held.send("ann", "rename", { at: 3, title: "renamed" });
          held.view("ann");
          held.view("bob");
        });
        return { writes, sizes: held.sizesWritten(writes, "ann") };
      }));

      for (const { writes } of edits) {
        const scoped = writes.filter((write) => write.includes("~"));
        // One place, written once for each principal.
        expect(scoped.length).toBe(2);
        expect(new Set(scoped.map((write) => write.split(" ")[0])).size)
          .toBe(1);
      }
      expect(normalized(edits[1].writes)).toEqual(normalized(edits[0].writes));
      // No document written follows the rows.
      expect(edits[1].sizes).toEqual(edits[0].sizes);
    });

    it("brings up to date the place of the edited row alone for each principal, at 10 and 100 items with 2 and 5 principals", async () => {
      // What each principal's derivation after the edit brings up to date.
      const passes: number[][] = [];
      for (const principals of [2, 5]) {
        for (const size of [10, 100]) {
          const held = await started(fixture, size, plain, principals);
          held.send("ann", "rename", { at: 3, title: "renamed" });
          passes.push(
            held.keys.map((principal) =>
              held.pulled(() => held.view(principal))
            ),
          );
        }
      }

      expect(passes[1]).toEqual(passes[0]);
      expect(passes[3]).toEqual(passes[2]);
      expect(passes[2].slice(0, 2)).toEqual(passes[0]);
      // Each further principal brings up to date what the second does, and
      // that is the one place of the edited row.
      expect(passes[2].slice(2)).toEqual([
        passes[0][1],
        passes[0][1],
        passes[0][1],
      ]);
      expect(maxOf(passes[2])).toBeLessThanOrEqual(1);
    });

    it("brings up to date the places of the principal whose nickname changed and of no other", async () => {
      for (const size of [10, 100]) {
        const held = await started(fixture, size, plain, 5);
        const ann = held.pulled(() => {
          held.send("ann", "call", { name: "Ann" });
          held.view("ann");
        });
        const others = held.pulled(() => {
          for (const principal of held.keys.slice(1)) held.view(principal);
        });

        expect(ann).toBeGreaterThanOrEqual(size);
        expect(others).toBe(0);
      }
    });

    it("stores again, after a refused commit, the place the acting principal's commit wrote and no place of another principal", async () => {
      for (const size of [10, 100]) {
        const held = await started(fixture, size, plain);
        const before = new Map(
          held.instancesOf("ann").map(([id, document]) => [
            id,
            document.value,
          ]),
        );
        // The place the derivation of `ann` stores for the edited row.
        const [place] = held.written(() => {
          held.send("ann", "rename", { at: 3, title: "renamed" });
          held.view("ann");
        }).filter((write) => write.includes("~"))
          .map((write) => write.split(" ")[0]);
        held.view("bob");
        const stored = held.as(
          "ann",
          () => JSON.stringify(held.instance.store.docs.get(place)?.value),
        );
        const bob = JSON.stringify(held.instancesOf("bob"));
        let writes: string[] = [];
        // The storage refused the commit that stored it: it holds what the
        // place held before the edit, or nothing where the edited row is a
        // row of a key of its own, and the executor takes that.
        const restored = held.as("ann", () => {
          held.instance.restore(place, before.get(`${place}:ann:s`));
          return held.pulled(() => {
            writes = held.written(() => held.view("ann"));
          });
        });

        expect(restored).toBe(1);
        expect(writes.map((write) => write.split(" ")[0])).toEqual([place]);
        expect(
          held.as(
            "ann",
            () => JSON.stringify(held.instance.store.docs.get(place)?.value),
          ),
        ).toBe(stored);
        expect(held.pulled(() => held.view("bob"))).toBe(0);
        expect(JSON.stringify(held.instancesOf("bob"))).toBe(bob);
      }
    });
  });
}

describe("records returned by a `map` over an array of plain values in place, whose body reads a value of the scope `session`, when an item is appended", () => {
  it("writes the new row and its place for each principal, the same at 10 items as at 100", async () => {
    const appends = await Promise.all([10, 100].map(async (size) => {
      const held = await started("scoped-rows-plain", size, true);
      const writes = held.written(() => {
        held.send("ann", "add", { title: "added" });
        held.view("ann");
        held.view("bob");
      });
      return {
        writes: normalized(writes).map((write) =>
          write.replace(/\/\d+( |$)/g, "/n$1")
        ),
        sizes: held.sizesWritten(writes, "ann"),
      };
    }));

    for (const { writes } of appends) {
      expect(writes.filter((write) => write.startsWith("place")).length)
        .toBe(2);
    }
    expect(appends[1].writes).toEqual(appends[0].writes);
    expect(appends[1].sizes).toEqual(appends[0].sizes);
  });
});

// `fixtures/scoped-view-plain.tsx`: `scoped-view.tsx` over an array of
// plain values in place, whose rows read nothing of a user.
describe("a rendered tree that reads a value of the scope `user` in two places, beside the rows of a `map` over an array of plain values in place", () => {
  it("holds no row in a scope instance, and writes no scope instance for an edit of one item, at 10 items as at 100", async () => {
    const sizes = await Promise.all([10, 100].map(async (size) => {
      const held = await started("scoped-view-plain", size, true);
      const writes = held.written(() => {
        held.send("ann", "rename", { at: 3, title: "renamed" });
        held.view("ann");
        held.view("bob");
      });
      return { scoped: held.scoped(), writes, view: held.view("bob") };
    }));

    expect(sizes[1].scoped).toBe(sizes[0].scoped);
    for (const { writes } of sizes) {
      expect(writes.filter((write) => write.includes("~"))).toEqual([]);
    }
    expect(sizes[1].writes.length).toBe(sizes[0].writes.length);
    expect(JSON.stringify(sizes[1].view.children?.[2])).toContain("renamed!");
  });
});

// `fixtures/scoped-source.tsx`: a `map` over the result of a `computed` that
// reads state of the scope `user`, an array of plain values the `computed`
// generates. The assembly of the collection reads its source as the value
// it is: the reference to a scoped place is given to the cone of another
// value alone, and an assembly is none.
describe("a `map` over the result of a `computed` of the scope `user`", () => {
  it("gives each principal the rows of the notes it did not hide", async () => {
    let acting = "ann";
    const instance = new Instance(
      await artifact("scoped-source"),
      { notes: { $link: { doc: "notes", path: [] } } },
      {
        documents: [{
          id: "notes",
          kind: "notes",
          value: [{ text: "one" }, { text: "two" }, { text: "three" }],
        }],
        scopes: {
          keyOf: (scope: Scope) =>
            scope === "user" ? `user:${acting}` : `session:${acting}:s`,
        },
      },
    );
    const rowsOf = (principal: string): string[] => {
      acting = principal;
      instance.settle();
      return (instance.result() as { rows: string[] }).rows;
    };
    rowsOf("ann");
    acting = "bob";
    const binding = instance.streams().find(({ path }) =>
      path.join("/") === "hide"
    )!;
    instance.send(binding.binding, { text: "two" });

    expect(rowsOf("bob")).toEqual(["one!", "three!"]);
    expect(rowsOf("ann")).toEqual(["one!", "two!", "three!"]);
  });
});

// `fixtures/scoped.tsx`: `summary` is an output of the result that reads
// state of the scope `user`. The place of an output of the result in the
// scope instance holds its value, which the entry of that place evaluates
// outside every cone; only the cone of another value is given the
// reference to a scoped place (`Host.output`).
describe("an output of the result of the scope `user`", () => {
  it("holds its value, and no reference to another scoped place, in the scope instance", async () => {
    let acting = "ann";
    const instance = new Instance(
      await artifact("scoped"),
      { notes: { $link: { doc: "notes", path: [] } } },
      {
        documents: [{ id: "notes", kind: "notes", value: ["one"] }],
        scopes: {
          keyOf: (scope: Scope) =>
            scope === "user" ? `user:${acting}` : `session:${acting}:s`,
        },
        wishes: () => ({ result: { name: `the profile of ${acting}` } }),
      },
    );
    instance.settle();
    acting = "bob";
    instance.settle();

    const summaries = [...instance.store.docs]
      .filter(([, { kind }]) => kind === "scope instance")
      .map(([, { value }]) => (value as { summary?: unknown }).summary)
      .filter((summary) => summary !== undefined);
    expect(summaries.sort()).toEqual(["nobody reads 1", "nobody reads 1"]);
  });
});

// `fixtures/scoped-bare.tsx`, the value of the scope placed as a bare name
// and the state cell placed as a child, and `fixtures/scoped-computed.tsx`,
// the value computed by an authored `computed` whose block body is not
// promoted: in both, the cone of the tree places a value of another cone
// and reads nothing of a scope (ruling Z94).
for (const fixture of ["scoped-bare", "scoped-computed"]) {
  describe(`a rendered tree over \`fixtures/${fixture}.tsx\`, beside the rows of a \`map\` over an array of references`, () => {
    it("holds no row in a scope instance, and writes the same documents and no scope instance for an edit of one item, at 10 items as at 100", async () => {
      const sizes = await Promise.all([10, 100].map(async (size) => {
        const held = await started(fixture, size);
        const writes = held.written(() => {
          held.send("ann", "rename", { at: 3, title: "renamed" });
          held.view("ann");
          held.view("bob");
        });
        return { scoped: held.scoped(), writes };
      }));

      expect(sizes[1].scoped).toBe(sizes[0].scoped);
      for (const { writes } of sizes) {
        expect(writes.filter((write) => write.includes("~"))).toEqual([]);
      }
      expect(sizes[1].writes).toEqual(sizes[0].writes);
    });

    it("gives each principal the attribute its own nickname selects", async () => {
      const { send, view } = await started(fixture, 10);
      send("ann", "call", { name: "Ann" });

      expect((view("ann").children?.[1] as Node).props?.disabled).toBe(
        fixture === "scoped-bare",
      );
      expect((view("bob").children?.[1] as Node).props?.disabled).toBe(
        fixture !== "scoped-bare",
      );
      expect(JSON.stringify(view("ann"))).toContain("Ann");
      expect(JSON.stringify(view("bob"))).not.toContain("Ann");
    });
  });
}
