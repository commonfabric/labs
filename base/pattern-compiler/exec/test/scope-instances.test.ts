import { expect } from "@std/expect";
import { beforeEach, describe, it } from "@std/testing/bdd";

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

type Held = {
  nickname: string;
  count: number;
  summary: string;
  greeting: string;
};

// `fixtures/scoped.tsx` declares a nickname of the scope `user`, reads a
// list of the space, and asks for the profile of the acting user. The
// test says which principal each evaluation is for.
describe("an instance with state of the scope `user`, evaluated for two principals", () => {
  let acting: string;
  let instance: Instance;

  const as = <T>(principal: string, run: () => T): T => {
    acting = principal;
    return run();
  };

  /** The result as `principal` reads it, after a derivation for them. */
  const resultOf = (principal: string): Held =>
    as(principal, () => {
      instance.settle();
      return instance.result() as Held;
    });

  const send = (principal: string, stream: string, event: unknown) =>
    as(principal, () => {
      const binding = instance.streams().find(({ path }) =>
        path.join("/") === stream
      )!;
      return instance.send(binding.binding, event);
    });

  /** How many times the cone of the output at `path` was evaluated. */
  const evaluationsOf = (path: string): number => {
    const output = instance.plan.outputs.find((output) =>
      output.path.join("/") === path
    )!;
    const { entry } = instance.plan.cones[output.cone];
    return instance.trace.filter((name) => name === entry).length;
  };

  beforeEach(async () => {
    acting = "ann";
    instance = new Instance(
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
  });

  it("keeps the state of each principal apart", () => {
    expect(send("ann", "rename", { name: "Ann" }).committed).toBe(true);

    expect(resultOf("ann").nickname).toBe("Ann");
    expect(resultOf("bob").nickname).toBe("nobody");

    expect(send("bob", "rename", { name: "Bob" }).committed).toBe(true);

    expect(resultOf("bob").nickname).toBe("Bob");
    expect(resultOf("ann").nickname).toBe("Ann");
  });

  it("derives a value of state of the user and state of the space for each principal", () => {
    send("ann", "rename", { name: "Ann" });
    send("bob", "rename", { name: "Bob" });

    expect(resultOf("ann").summary).toBe("Ann reads 1");
    expect(resultOf("bob").summary).toBe("Bob reads 1");

    send("bob", "post", { text: "two" });

    expect(resultOf("ann").summary).toBe("Ann reads 2");
    expect(resultOf("bob").summary).toBe("Bob reads 2");
  });

  it("resolves a `wish` of the scope `user` for each principal", () => {
    expect(resultOf("ann").greeting).toBe("hello the profile of ann");
    expect(resultOf("bob").greeting).toBe("hello the profile of bob");
    expect(resultOf("ann").greeting).toBe("hello the profile of ann");
  });

  it("derives a value of the space once, whoever it is evaluated for", () => {
    expect(resultOf("ann").count).toBe(1);
    expect(resultOf("bob").count).toBe(1);
    const before = evaluationsOf("count");

    resultOf("ann");
    resultOf("bob");
    resultOf("ann");

    expect(evaluationsOf("count")).toBe(before);
  });

  it("does not evaluate again what it holds for a principal it comes back to", () => {
    resultOf("ann");
    resultOf("bob");
    const before = evaluationsOf("summary");

    resultOf("ann");
    resultOf("bob");

    expect(evaluationsOf("summary")).toBe(before);
  });

  it("writes the instances of the acting principal alone", () => {
    resultOf("ann");
    const scopedOf = (principal: string) =>
      [...instance.store.docs.keys()].filter((doc) =>
        doc.endsWith(`~user:${principal}`)
      );
    expect(scopedOf("bob")).toEqual([]);
    const held = scopedOf("ann").map((doc) =>
      JSON.stringify(instance.store.docs.get(doc))
    );

    send("bob", "rename", { name: "Bob" });
    resultOf("bob");

    expect(scopedOf("bob").length).toBeGreaterThan(0);
    expect(
      scopedOf("ann").map((doc) =>
        JSON.stringify(instance.store.docs.get(doc))
      ),
    ).toEqual(held);
  });

  it("stores a value of the scope `user` in no document of the space", () => {
    send("ann", "rename", { name: "Annabel" });
    resultOf("ann");

    // The event of the handler is an entry of its stream, which is a
    // document of the space.
    const shared = [...instance.store.docs]
      .filter(([doc, { kind }]) => !doc.includes("~") && kind !== "stream")
      .map(([, document]) => JSON.stringify(document));

    expect(shared.some((text) => text.includes("Annabel"))).toBe(false);
    expect(shared.some((text) => text.includes("the profile of ann"))).toBe(
      false,
    );
  });
});

type Rows = { rows: { text: string; mine: boolean }[]; plain: string[] };

// `fixtures/scoped-rows.tsx`: a `map` over an array of plain values in
// place, a list of the space, whose body reads what the acting user
// picked, and a second `map` over the same array that reads nothing of a
// user.
describe("a per-element construct whose body reads state of the scope `user`", () => {
  let acting: string;
  let instance: Instance;

  const as = <T>(principal: string, run: () => T): T => {
    acting = principal;
    return run();
  };

  const resultOf = (principal: string): Rows =>
    as(principal, () => {
      instance.settle();
      return instance.result() as Rows;
    });

  const send = (principal: string, stream: string, event: unknown) =>
    as(principal, () => {
      const binding = instance.streams().find(({ path }) =>
        path.join("/") === stream
      )!;
      return instance.send(binding.binding, event);
    });

  const mine = (principal: string): string[] =>
    resultOf(principal).rows.filter((row) => row.mine).map((row) => row.text);

  beforeEach(async () => {
    acting = "ann";
    instance = new Instance(
      await artifact("scoped-rows"),
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
    instance.settle();
  });

  it("gives each principal the rows as its own state has them", () => {
    send("ann", "pick", { text: "one" });
    send("bob", "pick", { text: "three" });

    expect(mine("ann")).toEqual(["one"]);
    expect(mine("bob")).toEqual(["three"]);
    expect(mine("ann")).toEqual(["one"]);
  });

  it("gives each principal a row another principal added", () => {
    send("ann", "pick", { text: "four" });
    send("bob", "post", { text: "four" });

    expect(resultOf("bob").rows.map((row) => row.text)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
    expect(mine("ann")).toEqual(["four"]);
    expect(mine("bob")).toEqual([]);
    expect(resultOf("ann").plain).toEqual(["one", "two", "three", "four"]);
  });

  it("evaluates the body of a row once for each principal", () => {
    resultOf("ann");
    resultOf("bob");
    const before = instance.counts.elementEvaluations;

    resultOf("ann");
    resultOf("bob");
    resultOf("ann");

    expect(instance.counts.elementEvaluations).toBe(before);
  });

  it("stores the rows of each principal in the instance of that principal", () => {
    send("ann", "pick", { text: "two" });
    resultOf("ann");
    resultOf("bob");

    // The outputs of a scope are in the instances of a document of their
    // own, at the paths they have in the result.
    const held = (principal: string) =>
      JSON.stringify(
        [...instance.store.docs].filter(([doc, { kind }]) =>
          kind === "scope instance" && doc.endsWith(`~user:${principal}`)
        ).map(([, document]) => document),
      );
    expect(held("ann")).toContain('"mine":true');
    expect(held("bob")).not.toContain('"mine":true');
    expect(JSON.stringify(instance.store.docs.get("result"))).not.toContain(
      '"mine"',
    );
  });
});

type Sites = {
  rows: { title: string; open: boolean; label: string }[];
  first: { title: string; open: boolean; label: string };
};

// `fixtures/scoped-site.tsx`: a pattern called through `asScope("user")`
// in the body of a `map` over an array of plain values in place, and once
// outside it. The call is compiled into the instance, and the state cell
// the callee declares is of the scope `user`.
describe("a pattern compiled in through `asScope(\"user\")`", () => {
  let acting: string;
  let instance: Instance;

  const as = <T>(principal: string, run: () => T): T => {
    acting = principal;
    return run();
  };

  const resultOf = (principal: string): Sites =>
    as(principal, () => {
      instance.settle();
      return instance.result() as Sites;
    });

  /** Sends to the stream the result holds at `path`, as `principal`. */
  const toggle = (principal: string, path: string) =>
    as(principal, () => {
      const stream = instance.streams().find((held) =>
        held.path.join("/") === path
      )!;
      return instance.send(stream.binding, {}, stream.elements ?? []);
    });

  beforeEach(async () => {
    acting = "ann";
    instance = new Instance(
      await artifact("scoped-site"),
      { items: [{ title: "one" }, { title: "two" }] },
      {
        scopes: {
          keyOf: (scope: Scope) =>
            scope === "user" ? `user:${acting}` : `session:${acting}:s`,
        },
      },
    );
    instance.settle();
  });

  it("keeps the state of the callee for each principal, in an element body", () => {
    expect(toggle("ann", "rows/0/toggle").committed).toBe(true);

    expect(resultOf("ann").rows.map((row) => row.label)).toEqual([
      "one (open)",
      "two",
    ]);
    expect(resultOf("bob").rows.map((row) => row.label)).toEqual([
      "one",
      "two",
    ]);

    expect(toggle("bob", "rows/1/toggle").committed).toBe(true);

    expect(resultOf("bob").rows.map((row) => row.open)).toEqual([false, true]);
    expect(resultOf("ann").rows.map((row) => row.open)).toEqual([true, false]);
  });

  it("keeps the state of the callee for each principal, outside an element body", () => {
    expect(toggle("bob", "first/toggle").committed).toBe(true);

    expect(resultOf("bob").first.label).toBe("first (open)");
    expect(resultOf("ann").first.label).toBe("first");
  });
});
