import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

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

/**
 * An instance of `fixture` over `size` items, each a document of its own
 * that the argument holds a reference to, evaluated for two principals,
 * `ann` and `bob`, with what each derivation writes to the store noted.
 */
const started = async (fixture: string, size: number, plain = false) => {
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
  view("ann");
  view("bob");
  return { instance, view, send, scoped, written, as };
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

// `fixtures/scoped-view-rows.tsx`: the body of the `map` over the array of
// references reads the value of the scope `user` as well. A body in an
// element is not planned apart (P451 plans an expression apart outside
// every element body), so each row is of the scope `user`, the assembly is
// of that scope, and the rows are stored whole in the scope instance of
// each principal, behind a link of that scope in the result, as before.
describe("a rendered tree whose rows of a `map` over an array of references read a value of the scope `user`", () => {
  it("gives each principal the rows its own nickname selects", async () => {
    const { send, view } = await started("scoped-view-rows", 10);
    send("ann", "call", { name: "Ann" });
    send("ann", "rename", { at: 3, title: "renamed" });

    expect(JSON.stringify(view("ann").children?.[2])).toContain("renamed!");
    expect(JSON.stringify(view("bob").children?.[2])).toContain("renamed");
    expect(JSON.stringify(view("bob").children?.[2])).not.toContain(
      "renamed!",
    );
  });

  it("stores the rows in the scope instance of each principal, and none in the result", async () => {
    const small = await started("scoped-view-rows", 10);
    const large = await started("scoped-view-rows", 100);

    expect(large.scoped()).toBeGreaterThan(small.scoped());
    expect(JSON.stringify(large.instance.store.docs.get("result"))).not
      .toContain("item 50");
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
