import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";
import { argumentOf } from "../store.ts";

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

/**
 * What an instance holds: its result, each state cell with its
 * identifier, its name and its value, and each document with its kind.
 */
type Held = {
  result: unknown;
  cells: unknown[][];
  documents: [string, string][];
};

const held = (instance: Instance): Held => ({
  result: JSON.parse(JSON.stringify(instance.result())),
  cells: instance.stateCells().map(({ id, name, value }) => [id, name, value])
    .sort(),
  documents: [...instance.store.docs].flatMap((
    [id, { kind }],
  ): [string, string][] => kind === "held constant" ? [] : [[id, kind]]).sort(),
});

/**
 * What the instances of these tests held when the plan had each pattern
 * that is compiled in written out at each call site: the values and the
 * identifier of every stored document. `sites-pinned.json` was written
 * from that form of the plan, and a plan that holds a callee once has to
 * give the same.
 */
const pinned = async (name: string): Promise<Held> =>
  (JSON.parse(
    await Deno.readTextFile(new URL("./sites-pinned.json", import.meta.url)),
  ) as Record<string, Held>)[name];

// Two call sites per level, three levels deep, with a state cell in the
// innermost pattern (`fixtures/nested-sites.tsx`, the source that the
// test of the size of a plan in `tests/plan.rs` generates for a depth of
// three).
describe("a pattern compiled in at two sites per level, three levels deep", () => {
  it("computes the value and stores the documents of the written-out form", async () => {
    const instance = new Instance(await artifactOf("nested-sites"), { n: 1 }, {
      secret: "s",
    });

    expect(instance.result()).toEqual({ v: 20 });
    expect(held(instance)).toEqual(await pinned("nested"));
    expect(held(instance).cells.length).toBe(8);
    expect(instance.counts).toMatchObject({
      evaluations: 23,
      slotsNotListed: 0,
      readsWithoutSlot: 0,
      outputsWithoutEdge: 0,
    });
  });

  it("evaluates the cones of one chain of sites when the argument changes", async () => {
    const instance = new Instance(await artifactOf("nested-sites"), { n: 1 }, {
      secret: "s",
    });

    instance.writeArgument(["n"], 2);

    expect(instance.result()).toEqual({ v: 28 });
  });
});

// Call sites two levels deep, with state, a stream and a generated array
// in the callees, outside every element body and inside one
// (`fixtures/sites-in-elements.tsx`).
describe("call sites of patterns with state, two levels deep and in element bodies", () => {
  const ARGUMENT = argumentOf("result");
  const link = (name: string) => ({
    $link: { doc: ARGUMENT, path: ["pool", name] },
  });
  const arguments_: Record<string, () => unknown> = {
    // `items` over an array of references.
    references: () => ({
      pool: { a: { title: "ab" }, b: { title: "skip" } },
      items: [link("a"), link("b")],
      words: ["x", "yz"],
      lead: "go",
    }),
    // `items` over an array of plain values in place.
    inPlace: () => ({
      items: [{ title: "ab" }, { title: "skip" }],
      words: ["x", "yz"],
      lead: "go",
    }),
  };
  // One event for a stream of each kind of call site: outside every
  // element body at two depths, over `items`, over plain values in
  // place, over the result of a `filter`, and over a plain array
  // generated from scratch.
  const events = [
    "first/right/bump",
    "rows/0/left/bump",
    "tagged/1/bump",
    "kept/0/bump",
    "spelled/1/bump",
    "second/left/bump",
  ];
  const run = async (name: string) => {
    const instance = new Instance(
      await artifactOf("sites-in-elements"),
      arguments_[name](),
      { secret: "s" },
    );
    const settled = held(instance);
    const outcomes = events.map((path) => {
      const stream = instance.streams().find((stream) =>
        stream.path.join("/") === path
      );
      return instance.send(stream!.binding, {}, stream!.elements ?? [])
        .committed;
    });
    return { instance, settled, outcomes };
  };

  for (const name of ["references", "inPlace"]) {
    it(`hold the values and the documents of the written-out form, with \`items\` given as ${name}`, async () => {
      const { instance, settled, outcomes } = await run(name);

      expect(outcomes).toEqual(events.map(() => true));
      expect(settled).toEqual(await pinned(`${name}: settled`));
      expect(held(instance)).toEqual(await pinned(`${name}: after the events`));
      expect(instance.counts).toMatchObject({
        slotsNotListed: 0,
        readsWithoutSlot: 0,
        outputsWithoutEdge: 0,
      });
    });
  }

  it("keep the state of a site under its chain of sites and its element key", async () => {
    const { instance } = await run("inPlace");
    const result = instance.result() as Record<string, unknown>;
    const count = (...path: (string | number)[]) =>
      path.reduce(
        (found: unknown, segment) =>
          (found as Record<string, unknown>)[segment],
        result,
      );

    // Each event wrote the cell of its own site and no other.
    expect([
      count("first", "left", "count"),
      count("first", "right", "count"),
      count("second", "left", "count"),
      count("second", "right", "count"),
      count("rows", 0, "left", "count"),
      count("rows", 0, "right", "count"),
      count("rows", 1, "left", "count"),
      count("tagged", 0, "count"),
      count("tagged", 1, "count"),
      count("kept", 0, "count"),
      count("spelled", 0, "count"),
      count("spelled", 1, "count"),
    ]).toEqual([0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1]);
    // The path `step` that a call leaves out reads the callee's default,
    // and a literal that a call writes is read as written.
    expect(count("second", "left", "shown")).toBe("fixed:2");
    expect(count("first", "right", "shown")).toBe("go':3");
    expect(count("kept", 0, "shown")).toBe("ab:5");
  });
});
