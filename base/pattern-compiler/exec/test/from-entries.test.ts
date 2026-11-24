import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";

// `compare/fixtures/from-entries.tsx`: two bodies that count the keys of
// what `Object.fromEntries` makes (FA §3.4).
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../compare/fixtures/from-entries.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === "default")!;
};

const start = async () =>
  new Instance(await artifact(), {
    pairs: [["a", 1], ["b", 2], ["a", 3]],
    donuts: [
      { name: "plain", price: 2 },
      { name: "sugar", price: 3 },
      { name: "plain", price: 4 },
    ],
  });

describe("a body that calls `Object.fromEntries`", () => {
  it("is handed the pairs of an input and the key of each", async () => {
    const instance = await start();

    // Two of the three pairs have the key `a`.
    expect(instance.result()).toMatchObject({ keys: 2 });
  });

  it("runs again when the key of a pair of the input changes", async () => {
    const instance = await start();
    instance.result();

    instance.writeArgument(["pairs", "2", "0"], "c");

    expect(instance.result()).toMatchObject({ keys: 3 });
  });

  it("is handed the key of each pair that it built from an element of an array of plain values in place", async () => {
    const instance = await start();
    expect(instance.result()).toMatchObject({ names: 2 });

    instance.writeArgument(["donuts", "2", "name"], "jam");

    expect(instance.result()).toMatchObject({ names: 3 });
  });
});
