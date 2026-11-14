import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";

import {
  generateEvent,
  generateInputs,
  generateValue,
  type Schema,
} from "../generate.ts";
import { type Plan, runScenario, scenarioAudience } from "../harness.ts";

const fixture = (name: string) =>
  new URL(`../fixtures/${name}`, import.meta.url);

const planOf = async (name: string) => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(fixture(`${name}.plan.json`)),
  );
  return patterns[0] as {
    plan: Plan & { argumentSchema?: string };
    schemas: { id: string; schema: Schema }[];
  };
};

describe("generateValue", () => {
  it("gives each type a value, with every property of an object and two elements of an array", () => {
    const schema: Schema = {
      type: "object",
      properties: {
        title: { type: "string" },
        count: { type: "number" },
        done: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
        kind: { enum: ["a", "b"] },
        maybe: { anyOf: [{ type: "null" }, { type: "string" }] },
      },
      required: ["title"],
    };

    expect(generateValue(schema, schema, "x")).toEqual({
      title: "x-title-text",
      count: 3,
      done: true,
      tags: ["x-tags-0-text", "x-tags-1-text"],
      kind: "a",
      maybe: "x-maybe-text",
    });
  });

  it("ends a type that refers to itself with an empty array", () => {
    const schema: Schema = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            name: { type: "string" },
            children: { type: "array", items: { $ref: "#/$defs/Node" } },
          },
          required: ["name", "children"],
        },
      },
    };
    const depth = (value: unknown): number => {
      const { children } = value as { children: unknown[] };
      return children.length === 0 ? 0 : 1 + depth(children[0]);
    };

    // An object and an array each count as one level of the three.
    expect(depth(generateValue(schema, schema, "n"))).toBe(1);
  });

  it("leaves out a property that is a stream", () => {
    const schema: Schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        changed: { asCell: ["stream"], type: "object" },
      },
    };

    expect(generateValue(schema, schema, "x")).toEqual({ name: "x-name-text" });
  });
});

describe("a generated scenario for the handler fixture", () => {
  it("gives each input an atom of its own beside the labels its schema declares", async () => {
    const { plan, schemas } = await planOf("handler");
    const inputs = generateInputs(plan, schemas);

    expect(
      Object.fromEntries(
        Object.entries(inputs).map(([name, input]) => [
          name,
          (input.schema as { ifc: { confidentiality: unknown[] } }).ifc
            .confidentiality,
        ]),
      ),
    ).toEqual({
      secret: ["alice", "input:secret"],
      note: ["input:note"],
    });
  });

  it("generates the event of a handler from the type the event declares", async () => {
    const { plan, schemas } = await planOf("handler");

    // The body reads `text` alone. The runtime refuses an event without
    // `extra`, which the declared type requires.
    expect(generateEvent(plan, schemas, 0)).toEqual({
      text: "event-text-text",
      extra: "event-extra-text",
    });
  });

  it("runs the pattern from disk with the generated inputs and event, and compares the handler's writes", async () => {
    const { plan, schemas } = await planOf("handler");
    const run = await runScenario({
      program: {
        main: fromFileUrl(fixture("handler.tsx")),
        root: fromFileUrl(fixture("")),
      },
      plan,
      argument: {},
      inputs: generateInputs(plan, schemas),
      events: [{ binding: 0, event: generateEvent(plan, schemas, 0) }],
    });
    const clauses = (atoms: unknown[]) => [...new Set(atoms)].sort();

    expect(run.skipped).toEqual([]);
    expect(
      Object.fromEntries(
        run.rows.map((row) => [
          row.path.join("/"),
          [clauses(row.runtime.confidentiality), row.comparison.overall],
        ]),
      ),
    ).toEqual({
      // Each is a value the pattern passes on: the template has the atom
      // of the pattern, and the runtime stores none (PL §3.2).
      last: [[], "tighter"],
      log: [[], "tighter"],
      note: [["input:note"], "tighter"],
    });
    expect(run.writes.map((row) => clauses(row.runtime.confidentiality)))
      .toEqual([["alice", "input:secret"], ["alice", "input:secret"]]);
  });
});

describe("a generated scenario for a handler that writes its inputs", () => {
  // The handler of `fixtures/input-writes.tsx` reads `label` and `count`,
  // sets `count`, and pushes an object onto `items`. The run's join has the
  // clause of every input the handler read, and the runtime refuses a write
  // of it to a store whose ceiling does not admit each clause (writer-fit).
  // The store of an input admits the input's own clause alone, and the
  // document of a pushed object admits none, so each generated clause has
  // to be one every store of the space admits.
  it("has the runtime commit the event, and compares both writes", async () => {
    const { plan, schemas } = await planOf("input-writes");
    const run = await runScenario({
      program: {
        main: fromFileUrl(fixture("input-writes.tsx")),
        root: fromFileUrl(fixture("")),
      },
      plan,
      argument: {},
      inputs: generateInputs(plan, schemas, await scenarioAudience()),
      events: [{ binding: 0, event: generateEvent(plan, schemas, 0) }],
    });

    expect(run.events).toEqual([
      { binding: 0, handler: "add", outcome: "committed" },
    ]);
    expect(run.skipped).toEqual([]);
    expect(run.writes.map((row) => [row.write, row.path])).toEqual([
      [0, []],
      [1, ["2"]],
    ]);
  });
});
