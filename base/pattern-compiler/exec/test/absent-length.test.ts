import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";

/** An instance of the pattern of `compare/fixtures/absent-length.tsx`. */
const instanceOver = async (argument: unknown): Promise<Instance> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../compare/fixtures/absent-length.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return new Instance(patterns[0], argument);
};

// `fixtures/absent-length.tsx`: `items.length` in the reactive tier and in
// a `computed` whose body is an expression.
describe("absent-length", () => {
  it("gives the length of an array the argument holds", async () => {
    const instance = await instanceOver({
      items: [{ title: "a" }, { title: "b" }],
    });

    expect(instance.result()).toEqual({ count: 2, name: "Items: 2" });
    expect(instance.failed).toEqual([]);
  });

  it("gives nothing for the length of an array the argument does not hold, and no error state", async () => {
    const instance = await instanceOver({});

    expect(instance.result()).toEqual({ name: "Items" });
    expect(instance.failed).toEqual([]);
  });
});
