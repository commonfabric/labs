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
import { atomKey } from "../template.ts";

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

describe("generateEvent", () => {
  it("leaves out a member the event's type declares as a handle and does not require", () => {
    // A handler that is sent a plain value where its event declares a
    // handle gets a handle it can read and cannot write, and its `set`
    // throws.
    const schema: Schema = {
      type: "object",
      properties: {
        text: { type: "string" },
        source: { asCell: ["cell"], type: "string" },
        result: { asCell: ["cell"], type: "string" },
      },
      required: ["source"],
    };
    const plan = {
      slots: [],
      outputs: [],
      bindings: [{ name: "h", handler: { body: 0 }, eventSchema: "event" }],
    } as unknown as Plan;

    expect(generateEvent(plan, [{ id: "event", schema }], 0)).toEqual({
      text: "event-text-text",
      source: "event-source-text",
    });
  });
});

describe("a generated scenario for the handler fixture", () => {
  it("gives each input an atom of its own where its schema declares no clause at its root", async () => {
    const { plan, schemas } = await planOf("handler");
    const inputs = generateInputs(plan, schemas);

    expect(
      Object.fromEntries(
        Object.entries(inputs).map(([name, input]) => [
          name,
          [
            (input.schema as { ifc: { confidentiality: unknown[] } }).ifc
              .confidentiality,
            input.declared,
          ],
        ]),
      ),
    ).toEqual({
      secret: [["alice"], {}],
      note: [["input:note"], { clause: "input:note" }],
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
      .toEqual([["alice"], ["alice"]]);
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

describe("a generated scenario for a handler that writes an input with a declared label", () => {
  // `fixtures/declared-writes.tsx`. The runtime refuses a write that
  // declares fewer clauses at a path than the store declares there
  // ("confidentiality cannot be weakened"). The handler writes under the
  // schema of its own type, so the input's store has to declare what that
  // schema declares: no generated clause where the type declares clauses
  // at its root, and the atom the runtime has for a `PolicyOf`, which the
  // crate's schema names by module and binding.
  it("has the runtime commit both events", async () => {
    const { plan, schemas } = await planOf("declared-writes");
    const run = await runScenario({
      program: {
        main: fromFileUrl(fixture("declared-writes.tsx")),
        root: fromFileUrl(fixture("")),
      },
      plan,
      argument: {},
      inputs: generateInputs(plan, schemas, await scenarioAudience()),
      events: [0, 1].map((binding) => ({
        binding,
        event: generateEvent(plan, schemas, binding),
      })),
    });

    expect(run.events).toEqual([
      { binding: 0, handler: "overwrite", outcome: "committed" },
      { binding: 1, handler: "seal", outcome: "committed" },
    ]);
  });
});

describe("a handler that passes a handle on without reading through it", () => {
  // `fixtures/handle-passed.tsx`: the handler sets `mine` and gives the
  // handles of `mine` and `other` to a child. Ruling U1: a handle a body
  // passes on without reading through it adds nothing of the label of its
  // cell to what the body writes. The argument's link to the cell of
  // `other` carries the clause that the cell's own type declares, as an
  // entry of origin `link`, and the run's join does not hold it.
  it("has no clause of the cell of the handle in the label of what the handler writes", async () => {
    const modules = JSON.parse(
      await Deno.readTextFile(fixture("handle-passed.plan.json")),
    );
    const { plan, schemas } = modules[0].patterns.find((
      pattern: { name: string },
    ) => pattern.name === "default");
    const run = await runScenario({
      program: {
        main: fromFileUrl(fixture("handle-passed.tsx")),
        root: fromFileUrl(fixture("")),
      },
      plan,
      argument: {},
      inputs: generateInputs(plan, schemas, await scenarioAudience()),
      events: [{ binding: 0, event: generateEvent(plan, schemas, 0) }],
    });
    const clauses = (atoms: unknown[]) =>
      [...new Set(atoms.flatMap((atom) => atomKey(atom).match(/input:\w+/g)))]
        .sort();
    const mine = "input:mine";

    expect(run.events).toEqual([
      { binding: 0, handler: "join", outcome: "committed" },
    ]);
    // The write through `mine`. The writes to the child's argument have
    // no cell the harness can name.
    expect(run.writes.map((row) => [row.write, row.path])).toEqual([[3, []]]);
    const [row] = run.writes;
    expect(clauses(row.runtime.confidentiality)).toEqual([mine]);
    // The body writes through `mine`, so the reference it writes through
    // is read, and the template keeps the label of that link.
    expect(clauses(row.template.label.confidentiality)).toEqual([mine]);
    expect(row.comparison.confidentiality).toBe("equal");
    expect(row.comparison.integrity).toBe("equal");
  });
});
