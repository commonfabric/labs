import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";

/** The pattern of `compare/fixtures/member-order.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../compare/fixtures/member-order.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

type Result = { names: string; madeNames: string; listed: string };

/** An instance over a document that holds `record` as it is given. */
const started = async (record: Record<string, string>) => {
  const instance = new Instance(
    await artifact(),
    { record: { $link: { doc: "record", path: [] } } },
    { documents: [{ id: "record", kind: "record", value: record }] },
  );
  const binding = (name: string) =>
    instance.plan.bindings.findIndex((binding) => binding.name === name);
  return {
    instance,
    result: () => instance.result() as Result,
    put: (name: string, value: string) =>
      instance.send(binding("put"), { name, value }),
    list: () => instance.send(binding("list"), {}),
  };
};

// The storage gives the members of a record in the order of their names
// as UTF-8, and a process that wrote the record holds them as written. The
// executor hands value code the order of the storage in both.
describe("the order in which value code reads the members of a record", () => {
  it("is the order of the names for a stored record, whatever order its document holds them in", async () => {
    const { result } = await started({ zeta: "z", beta: "b", alpha: "a" });

    expect(result().names).toBe("alpha,beta,zeta");
  });

  it("stays the order of the names when a handler adds a member", async () => {
    const { result, put } = await started({ zeta: "z", beta: "b" });

    expect(put("alpha", "a").committed).toBe(true);

    expect(result().names).toBe("alpha,beta,zeta");
  });

  it("is the order of the names for a handler that reads the record through a handle", async () => {
    const { result, list } = await started({ zeta: "z", beta: "b" });

    expect(list().committed).toBe(true);

    expect(result().listed).toBe("beta,zeta");
  });

  it("is the order of the names for a record that one computation made and another reads", async () => {
    const { result } = await started({ zeta: "z" });

    expect(result().madeNames).toBe("alpha,zeta");
  });

  it("orders a name beyond the Basic Multilingual Plane behind one within it, as UTF-8 does", async () => {
    // U+FF5A sorts behind U+1F600 by UTF-16 code units and before it by
    // code points.
    const { result } = await started({ "\u{1F600}": "1", "ｚ": "2" });

    expect(result().names).toBe("ｚ,\u{1F600}");
  });
});
