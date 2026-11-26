import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";

import {
  generateEvent,
  generateInputs,
  generateValue,
  type Schema,
} from "../generate.ts";
import type { Artifact } from "../../exec/executor.ts";
import { type Plan, scenarioAudience } from "../harness.ts";
import { atomKey, namedTemplate } from "../template.ts";
import { runBesideExecutor } from "../values.ts";

const fixture = (name: string) =>
  new URL(`../fixtures/${name}`, import.meta.url);

// The plan of a fixture, with the artifact the executor runs beside
// today's run: the harness sends an event where the executor stored the
// link to the stream.
const planOf = async (name: string) => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(fixture(`${name}.emit.json`)),
  );
  return { ...patterns[0], artifact: patterns[0] } as {
    plan: Plan & { argumentSchema?: string };
    schemas: { id: string; schema: Schema }[];
    artifact: Artifact;
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

describe("the values of a generated event", () => {
  const plan = (schema: Schema): [Plan, { id: string; schema: Schema }[]] => [
    {
      slots: [],
      outputs: [],
      bindings: [{ name: "h", handler: { body: 0 }, eventSchema: "event" }],
    } as unknown as Plan,
    [{ id: "event", schema }],
  ];

  it("differ from the values of a generated input, and an index is inside a generated array", () => {
    // A handler that sets a cell to a value of its event writes nothing
    // where the cell already holds that value, and a handler that takes
    // an index returns early where the index is past the end. An input
    // holds 3 for a number, `true`, the first member of an `enum`, and
    // two elements in an array.
    const schema: Schema = {
      type: "object",
      properties: {
        index: { type: "number" },
        on: { type: "boolean" },
        status: { enum: ["want", "reading", "done"] },
      },
    };

    expect(generateEvent(...plan(schema), 0)).toEqual({
      index: 1,
      on: false,
      status: "done",
    });
    expect(generateValue(schema, schema, "x")).toEqual({
      index: 3,
      on: true,
      status: "want",
    });
  });

  it("is a string where the event's type is a string", () => {
    // `action((to: string) => path.set(to))`.
    expect(generateEvent(...plan({ type: "string" }), 0)).toBe("event-text");
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
    const { plan, schemas, artifact } = await planOf("handler");
    const run = await runBesideExecutor(artifact, {
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
    const { plan, schemas, artifact } = await planOf("input-writes");
    const run = await runBesideExecutor(artifact, {
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
    const { plan, schemas, artifact } = await planOf("declared-writes");
    const run = await runBesideExecutor(artifact, {
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
  // cell to what the body writes. The label of an `identity` slot is the
  // label of the link the body was given the handle through (PL §2.2).
  const run = async () => {
    const modules = JSON.parse(
      await Deno.readTextFile(fixture("handle-passed.emit.json")),
    );
    const artifact = modules[0].patterns.find((
      pattern: { name: string },
    ) => pattern.name === "default");
    const { plan, schemas } = artifact;
    return await runBesideExecutor(artifact, {
      program: {
        main: fromFileUrl(fixture("handle-passed.tsx")),
        root: fromFileUrl(fixture("")),
      },
      plan,
      argument: {},
      inputs: generateInputs(plan, schemas, await scenarioAudience()),
      events: [{ binding: 0, event: generateEvent(plan, schemas, 0) }],
    });
  };
  const clauses = (atoms: unknown[]) =>
    [...new Set(atoms.flatMap((atom) => atomKey(atom).match(/input:\w+/g)))]
      .sort();

  it("compares the write through the handle the body writes through", async () => {
    const { events, writes } = await run();

    expect(events).toEqual([
      { binding: 0, handler: "join", outcome: "committed" },
    ]);
    // The writes to the child's argument have no cell the harness can
    // name.
    expect(writes.map((row) => [row.write, row.path])).toEqual([[3, []]]);
    expect(clauses(writes[0].runtime.confidentiality)).toEqual(["input:mine"]);
  });

  it("leaves the link entry of the handle that was passed on out of the label of its slot", async () => {
    // The argument's link to the cell of `other` carries, as an entry of
    // origin `link`, the clause the link's schema declares, which is the
    // clause of the cell's own type. "The `link` entry of a handle that
    // is only passed on is not in" the label of the `identity` slot, and
    // the stamp of the run that wrote the link is (PL §2.2). The
    // handler's run reads no link it only passes on, so the runtime's
    // label has no clause of `other` either.
    const [row] = (await run()).writes;

    expect(clauses(row.template.label.confidentiality)).toEqual([
      "input:mine",
    ]);
    expect(row.comparison.confidentiality).toBe("equal");
    expect(row.comparison.integrity).toBe("equal");
    // No run wrote the link to `other` under a label, so the stamp adds
    // nothing.
    expect(row.looserByLinkStamp).toBe(false);
  });
});

describe("a handler that writes a reference it passes on", () => {
  // `fixtures/reference-written.tsx`: the handler sets `selected` to a
  // record whose `room` is the value of `first`, unchanged. The edge at
  // `room` has a `reference` member.
  it("compares the written link with both sides reading its target", async () => {
    const { plan, schemas, artifact } = await planOf("reference-written");
    const run = await runBesideExecutor(artifact, {
      program: {
        main: fromFileUrl(fixture("reference-written.tsx")),
        root: fromFileUrl(fixture("")),
      },
      plan,
      argument: {},
      inputs: generateInputs(plan, schemas, await scenarioAudience()),
      events: [{ binding: 0, event: generateEvent(plan, schemas, 0) }],
    });
    const inputsOf = (atoms: unknown[]) =>
      [...new Set(atoms.flatMap((atom) => atomKey(atom).match(/input:\w+/g)))]
        .sort();

    expect(run.events.map((event) => event.outcome)).toEqual(["committed"]);
    expect(run.writes.map((row) => [row.write, row.path])).toEqual([
      [0, []],
      [1, []],
    ]);
    const [, room] = run.writes;
    // "Only an edge with a `reference` member, whose written value is the
    // reference, is joined with what a value read through the stored link
    // consumes, so that both sides read one target" (PL §3.1). The atom
    // the template mints is on the link and vouches for the reference, so
    // a read of the value through the link does not have it, as it does
    // not have the integrity of a stored `followRef` entry.
    expect(inputsOf(room.runtime.confidentiality)).toEqual([
      "input:first",
      "input:selected",
    ]);
    expect(room.comparison.confidentiality).toBe("equal");
    expect(room.comparison.integrity).toBe("equal");
  });
});

describe("a handler of an element body that resolves the handle of its element", () => {
  // `fixtures/element-resolved.tsx`: the handler calls `spaceOf` on the
  // handle of its element and writes the result to a state cell. The
  // `identity` slot of the handle has `resolved`: the body observes the
  // reference, so the handle is not one that is only passed on (PL §2.2,
  // "A `resolved` slot"; §2.5, "A resolved reference").
  it("has the label the list declares for its element, and is equal to the run", async () => {
    const { plan, schemas, artifact } = await planOf("element-resolved");
    const run = await runBesideExecutor(artifact, {
      program: {
        main: fromFileUrl(fixture("element-resolved.tsx")),
        root: fromFileUrl(fixture("")),
      },
      plan,
      argument: {},
      inputs: generateInputs(plan, schemas, await scenarioAudience()),
      events: [{ binding: 0, event: generateEvent(plan, schemas, 0) }],
    });
    const inputsOf = (atoms: unknown[]) =>
      [...new Set(atoms.flatMap((atom) => atomKey(atom).match(/input:\w+/g)))]
        .sort();

    expect(run.events.map((event) => [event.outcome, event.elements])).toEqual(
      [["committed", [{ collection: 0, key: "1" }]]],
    );
    const [row] = run.writes;
    // The run of today reads the handle at `element` of the argument
    // document of the element's instance, whose entries hold the clause
    // of the list's cell: the coordinator's join, on entries of origin
    // `structure`. The document has no entry of origin `link`. The slot
    // of the plan is read at the element's position in the list, and
    // since the body resolves the handle, its label has "the label that
    // the declaration of the source collection gives the element" (PL
    // §2.2; §8, question 85), which is the same clause.
    expect(inputsOf(row.runtime.confidentiality)).toEqual(["input:items"]);
    expect(inputsOf(row.template.label.confidentiality)).toEqual([
      "input:items",
    ]);
    expect(row.comparison.confidentiality).toBe("equal");
    expect(row.comparison.integrity).toBe("equal");
    expect(row.byCoordinatorJoin).toBe(false);
    expect(row.noAtomBesideCoordinatorJoin).toBe(false);
  });
});

describe("a handler that sends to the stream of another binding", () => {
  // `fixtures/stream-target.tsx`: the write edge of the inline handler
  // has the stream of `inc` as its target. A stream stores no value, so
  // the edge has no stored label to compare.
  it("has a write edge that is not compared, under a reason that names the stream", async () => {
    const { plan, schemas, artifact } = await planOf("stream-target");
    const binding = (plan.bindings ?? []).findIndex((binding) =>
      binding.name === "onClick"
    );
    const run = await runBesideExecutor(artifact, {
      program: {
        main: fromFileUrl(fixture("stream-target.tsx")),
        root: fromFileUrl(fixture("")),
      },
      plan,
      argument: {},
      inputs: generateInputs(plan, schemas, await scenarioAudience()),
      events: [{ binding, event: generateEvent(plan, schemas, binding) }],
    });

    expect(run.events.map((event) => event.outcome)).toEqual(["committed"]);
    expect(run.writes).toEqual([]);
    expect(run.skipped.filter((entry) => entry.binding === binding)).toEqual([
      {
        what: "event of onClick, write 0",
        reason: "a write edge whose target is the stream of a binding",
        binding,
      },
    ]);
  });
});

describe("a handler whose write leaves a cycle of links", () => {
  // `fixtures/link-cycle.tsx`: `keep` stores a link to `center` in `area`,
  // and `go` then sets `center` to a link to that position. A read of
  // `center` resolves no value, and the runtime's read of the label there
  // says that it failed (`cfcLabelViewForResolvedCellWithStatus`).
  const cycle = async (bindings: number[]) => {
    const { plan, schemas, artifact } = await planOf("link-cycle");
    return runBesideExecutor(artifact, {
      program: {
        main: fromFileUrl(fixture("link-cycle.tsx")),
        root: fromFileUrl(fixture("")),
      },
      plan,
      argument: {},
      inputs: generateInputs(plan, schemas, await scenarioAudience()),
      events: bindings.map((binding) => ({
        binding,
        event: generateEvent(plan, schemas, binding),
      })),
    });
  };

  it("does not take a label the runtime fails to read as the label of the write", async () => {
    const run = await cycle([0, 1]);

    expect(run.events.map(({ handler, outcome }) => [handler, outcome]))
      .toEqual([["keep", "committed"], ["go", "committed"]]);
    expect(run.writes.filter((row) => row.handler === "go")).toEqual([]);
    expect(
      run.skipped.filter(({ binding }) => binding === 1).map((
        { what, reason },
      ) => [what, reason]),
    ).toEqual([
      ["event of go, write 0, ", "a label the runtime fails to read"],
      ["event of go, write 1, ", "a label the runtime fails to read"],
    ]);
  });
});

describe("a handler whose run stores a link at the target of an edge with no `reference`", () => {
  // `fixtures/link-cycle.tsx`, `go` alone: `center.set(area.center)`. The
  // plan has an edge for a value (write 0) and an edge with `reference`
  // (write 1) for the one write, and the run stores a link.
  it("compares the edge with `reference` and counts the other apart", async () => {
    // PL §3.1, "A written path that holds a link, for an edge with no
    // `reference`": "such a row is not a row of the comparison and is
    // counted apart, and where the plan has an edge with `reference` for
    // the same write, that edge's row is the row of the write."
    const { plan, schemas, artifact } = await planOf("link-cycle");
    const run = await runBesideExecutor(artifact, {
      program: {
        main: fromFileUrl(fixture("link-cycle.tsx")),
        root: fromFileUrl(fixture("")),
      },
      plan,
      argument: {},
      inputs: generateInputs(plan, schemas, await scenarioAudience()),
      events: [{ binding: 1, event: generateEvent(plan, schemas, 1) }],
    });

    expect(run.events.map(({ handler, outcome }) => [handler, outcome]))
      .toEqual([["go", "committed"]]);
    expect(run.writes.map((row) => [row.handler, row.write, row.path]))
      .toEqual([["go", 1, []]]);
    expect(run.writes[0].comparison.overall).not.toBe("looser");
    expect(run.skipped.filter(({ binding }) => binding === 1)).toEqual([
      {
        what: "event of go, write 0, ",
        reason:
          "a written path that holds a link, for an edge with no `reference`",
        binding: 1,
      },
    ]);
  });
});

describe("an event whose transaction the runtime does not commit", () => {
  // `fixtures/handler-throws.tsx`: the handler throws before its write
  // while its target holds no value. The target holds none after the event
  // either, which is no sign of a write: the event wrote nothing.
  it("has no write edge compared", async () => {
    const { plan, schemas, artifact } = await planOf("handler-throws");
    const run = await runBesideExecutor(artifact, {
      program: {
        main: fromFileUrl(fixture("handler-throws.tsx")),
        root: fromFileUrl(fixture("")),
      },
      plan,
      argument: {},
      inputs: generateInputs(plan, schemas, await scenarioAudience()),
      events: [{ binding: 0, event: generateEvent(plan, schemas, 0) }],
    });

    expect(run.events).toMatchObject([
      {
        handler: "record",
        outcome: "refused",
        aborted: "Error: nothing recorded yet",
      },
    ]);
    expect(run.writes).toEqual([]);
    expect(
      run.skipped.filter(({ binding }) => binding === 0).map((
        { what, reason },
      ) => [what, reason]),
    ).toEqual([
      ["event of record, write 0", "a write edge of an event not committed"],
    ]);
  });
});

describe("the template of a write edge", () => {
  // The handler of `fixtures/input-writes.tsx` reads `label` and `count`
  // and sets `count`. With the read of `label` taken out of the edge's
  // template, the template lacks the clause of `label`, which the run's
  // write has. The slot of `count` has that clause once the event's run
  // has written `count`, so a template evaluated on what is stored after
  // the event hides what it lacks.
  it("is evaluated on the labels stored when the event's transaction begins", async () => {
    const { plan, schemas, artifact } = await planOf("input-writes");
    const label = plan.slots.findIndex((slot) =>
      slot.root.kind === "binding" && slot.path.join("/") === "label"
    );
    const [write] = plan.bodies?.[0].writes ?? [];
    // The plan holds the template of the body once, for all its write
    // edges: this edge gets a template of its own, without the read.
    const named = namedTemplate(write.template, plan) as {
      inputs: { op: string; slot?: number }[];
    };
    write.template = {
      ...named,
      inputs: named.inputs.filter((input) => input.slot !== label),
    } as typeof write.template;

    const run = await runBesideExecutor(artifact, {
      program: {
        main: fromFileUrl(fixture("input-writes.tsx")),
        root: fromFileUrl(fixture("")),
      },
      plan,
      argument: {},
      inputs: generateInputs(plan, schemas, await scenarioAudience()),
      events: [{ binding: 0, event: generateEvent(plan, schemas, 0) }],
    });

    const row = run.writes.find((row) => row.write === 0);
    expect(row?.comparison.confidentiality).toBe("tighter");
  });
});
