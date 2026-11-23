import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { InputsDigests } from "../inputs-digest.ts";
import { InputsTable } from "../plan-write.ts";

/** A table whose one set of inputs reads `paths` of the document `doc`. */
const tableOf = (paths: string[], outputs: string[] = []) => {
  const table = new InputsTable();
  const read = (path: string) =>
    table.binding({
      chain: [{ doc: "doc", path: path.split("/") }],
      observes: "value",
    });
  const named = table.place({
    slots: Object.fromEntries(outputs.map((path, slot) => [slot, read(path)])),
  });
  const index = table.place({
    slots: Object.fromEntries(paths.map((path, slot) => [slot, read(path)])),
    ...(outputs.length === 0 ? {} : { outputs: { 0: named } }),
  });
  return { table, index };
};

describe("InputsDigests", () => {
  it("gives the inputs of two tables one number where they hold the same content", () => {
    const digests = new InputsDigests();
    const first = tableOf(["a", "b/c"], ["d"]);
    const second = tableOf(["a", "b/c"], ["d"]);

    expect(digests.of(second.table, second.index, [])).toBe(
      digests.of(first.table, first.index, []),
    );
  });

  it("gives another number where a binding, an output named, or an element key differs", () => {
    const digests = new InputsDigests();
    const { table, index } = tableOf(["a", "b/c"], ["d"]);
    const base = digests.of(table, index, [[0, "k"]]);
    const binding = tableOf(["a", "b/x"], ["d"]);
    const output = tableOf(["a", "b/c"], ["e"]);
    const again = tableOf(["a", "b/c"], ["d"]);

    expect(digests.of(binding.table, binding.index, [[0, "k"]])).not.toBe(base);
    expect(digests.of(output.table, output.index, [[0, "k"]])).not.toBe(base);
    expect(digests.of(again.table, again.index, [[0, "other"]])).not.toBe(base);
    expect(digests.of(again.table, again.index, [[0, "k"]])).toBe(base);
  });

  it("gives a content it let go another number, and no number that another content has", () => {
    const digests = new InputsDigests();
    const long = (name: string) => `${name}/${"x".repeat(3_000_000)}`;
    const numbers = new Map<number, string>();
    const numberOf = (name: string) => {
      const { table, index } = tableOf([long(name)]);
      const number = digests.of(table, index, []);
      // No number stands for two contents.
      expect(numbers.get(number) ?? name).toBe(name);
      numbers.set(number, name);
      return number;
    };
    const first = numberOf("a");

    // Each further content fills more than a third of a generation.
    for (const name of ["b", "c", "d", "e", "f", "g"]) numberOf(name);

    expect(numberOf("a")).not.toBe(first);
    expect(numberOf("g")).toBe(numberOf("g"));
  });
});
