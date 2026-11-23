import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Artifact } from "../executor.ts";
import { rowDocumentCollections } from "../row-documents.ts";
import { storedRowCollections } from "../stored-units.ts";

/** The pattern `name` of `compare/fixtures/unit-resume-derived.tsx`. */
const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../compare/fixtures/unit-resume-derived.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === name)!;
};

/** The collections of a pattern whose rows can be left as stored. */
const storedOf = async (
  name: string,
): Promise<[number, readonly string[] | undefined][]> => {
  const artifact = await artifactOf(name);
  return [...storedRowCollections(artifact, rowDocumentCollections(artifact))];
};

describe("storedRowCollections() by what a `map` is over", () => {
  it("gives a `map` over the output of a `lift` that gives a reference at each member", async () => {
    expect(await storedOf("OverLift")).toEqual([[0, ["rows"]]]);
  });

  it("gives a `map` over a `filter` over an array of references, and not the `filter`", async () => {
    expect(await storedOf("OverFilter")).toEqual([[1, ["rows"]]]);
  });

  it("gives a `map` over a `sortBy` over an array of references, and not the `sortBy`", async () => {
    expect(await storedOf("OverSort")).toEqual([[1, ["rows"]]]);
  });

  it("gives a `map` of a pattern that is compiled in at a call site", async () => {
    expect(await storedOf("AtSite")).toEqual([[0, ["rows"]]]);
  });

  it("gives the first of two `map`s in a chain, which the result keeps at no path, and not the second, whose rows are in place", async () => {
    expect(await storedOf("OverMap")).toEqual([[0, undefined]]);
  });
});
