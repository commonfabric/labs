import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Artifact } from "../executor.ts";
import { rowDocumentCollections } from "../row-documents.ts";
import { boundInElement, storedRowCollections } from "../stored-units.ts";

/** The pattern `name` of a fixture of `compare/fixtures/`. */
const artifactOf = async (
  fixture: string,
  name = "default",
): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../../compare/fixtures/${fixture}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === name)!;
};

/** The collections of a pattern whose rows can be left as stored. */
const storedOf = (artifact: Artifact): [number, readonly string[]][] => [
  ...storedRowCollections(artifact, rowDocumentCollections(artifact)),
];

describe("storedRowCollections()", () => {
  it("gives a `map` over a slot that holds an array of references, with the path that keeps its rows", async () => {
    // `serving-list.tsx`: `items.map((item) => ({ label, done }))`, kept at
    // `rows`.
    const artifact = await artifactOf("serving-list");

    expect(storedOf(artifact)).toEqual([[0, ["rows"]]]);
  });

  it("gives nothing where the rows are stored in place", async () => {
    const artifact = await artifactOf("serving-list");

    expect([...storedRowCollections(artifact, new Set())]).toEqual([]);
  });

  it("leaves out a `map` whose element body holds another collection", async () => {
    // `index-in-body.tsx`: the body of the `map` over the groups maps the
    // bucket of an index.
    const artifact = await artifactOf("index-in-body");

    expect([...rowDocumentCollections(artifact)]).toEqual([0]);
    expect(storedOf(artifact)).toEqual([]);
  });

  it("leaves out a `map` over the entries of a record", async () => {
    // `names-table.tsx`: `Object.entries(names).map(...)`.
    const artifact = await artifactOf("names-table");

    expect([...rowDocumentCollections(artifact)]).toEqual([0]);
    expect(storedOf(artifact)).toEqual([]);
  });

  it("leaves out a `map` that a label template folds over", async () => {
    const artifact = structuredClone(await artifactOf("serving-list"));
    // A template that folds over the rows, as that of an output computed
    // from every row is, put on the output of the state cell.
    const output = artifact.plan.outputs.find(({ path }) =>
      path.length === 1 && path[0] === "events"
    )!;
    output.template = { op: "fold", collection: 0 } as never;

    expect(storedOf(artifact)).toEqual([]);
  });

  it("gives a `map` whose element body binds handlers", async () => {
    // `serving-list-handlers.tsx`: each row holds the streams of `retitle`
    // and of `touch`, which the body of its element binds.
    const artifact = await artifactOf("serving-list-handlers");

    expect(storedOf(artifact)).toEqual([[0, ["rows"]]]);
  });

  it("leaves out a `map` whose element body declares a state cell", async () => {
    const artifact = structuredClone(await artifactOf("serving-list"));
    // The state cell `events`, declared inside the element body of the
    // rows.
    artifact.plan.stateCells[0].within = [{ element: 0 }];

    expect(storedOf(artifact)).toEqual([]);
  });
});

describe("boundInElement()", () => {
  it("gives the bindings that the element body of a collection declares", async () => {
    // `retitle` and `touch` are bound in the body, `add` in the pattern.
    const artifact = await artifactOf("serving-list-handlers");

    expect(boundInElement(artifact, 0)).toEqual([0, 1]);
  });
});
