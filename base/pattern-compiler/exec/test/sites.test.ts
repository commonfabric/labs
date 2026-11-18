import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";

// The call sites of a pattern that is compiled in, on the artifacts of
// `compare/fixtures/<name>.emit.json`.

const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../../compare/fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === "default") ??
    patterns[patterns.length - 1];
};

type ViewNode = { name: string; children: unknown[] };

// Three tags of one pattern in one body (`fixtures/same-name-sites.tsx`).
describe("three call sites of one name in one body", () => {
  const argument = { title: "c", first: ["x", "y"], second: ["z"] };

  it("have a `site` step with an ordinal each, in source order", async () => {
    const { plan } = await artifactOf("same-name-sites");

    expect(plan.stateCells.map(({ name, within }) => ({ name, within })))
      .toEqual([1, 2, 3].map((ordinal) => ({
        name: "count",
        within: [{ site: { name: "Counter", ordinal } }],
      })));
  });

  it("give the document of the array that the callee computes an identifier of its own", async () => {
    const instance = new Instance(
      await artifactOf("same-name-sites"),
      argument,
    );
    const { outputs, cones } = instance.plan;
    // The output of the `computed` of each site, whose cone is written
    // in the callee's body and in no element body.
    const loud = outputs.flatMap((output, index) =>
      output.interim === "loud" && cones[output.cone].within.length === 1
        ? [index]
        : []
    );

    const identifiers = loud.map((output) => instance.outputDocument(output));

    expect(loud.length).toBe(3);
    expect(new Set(identifiers).size).toBe(3);
  });

  it("write the state cell of the site whose stream gets the event", async () => {
    const instance = new Instance(
      await artifactOf("same-name-sites"),
      argument,
    );
    const counts = () => {
      const { $UI } = instance.result() as { $UI: ViewNode };
      return $UI.children.map((button) => (button as ViewNode).children[2]);
    };
    const second = instance.streams().find(({ path }) =>
      path.join("/") === "$UI/children/1/props/onClick"
    );

    instance.send(second!.binding, {});

    expect(counts()).toEqual([0, 1, 0]);
    expect(new Set(instance.stateCells().map(({ id }) => id)).size).toBe(3);
  });
});
