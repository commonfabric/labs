/**
 * The value comparison of the fixtures under `fixtures/`: each fixture is
 * run on today's runtime and on the executor of `../exec/`, with the
 * scenario the label comparison runs it with where the tests have one,
 * and with a generated scenario otherwise.
 *
 * Each `<name>.emit.json` is the output of the crate for `<name>.tsx`.
 * Regenerate one from `base/pattern-compiler` with
 * `cargo run --release -- emit compare/fixtures/<name>.tsx > compare/fixtures/<name>.emit.json`.
 *
 * `deno run -A base/pattern-compiler/compare/values-fixtures.ts` prints
 * the table.
 */
import type { Artifact } from "../exec/executor.ts";
import { generateEvent, generateInputs, type Schemas } from "./generate.ts";
import { type Plan, scenarioAudience } from "./harness.ts";
import { compareScenarioValues, type ValueComparison } from "./values.ts";

type Written = {
  argument: Record<string, unknown>;
  events?: { binding: number; event: unknown }[];
};

/** The scenarios the tests of the label comparison write by hand. */
const WRITTEN: Record<string, Written[]> = {
  "small": [true, false].map((flag) => ({
    argument: {
      secret: "s3cret",
      note: "n",
      flag,
      items: [{ title: "a", done: false }, { title: "b", done: true }],
    },
  })),
  "is-edited": [true, false].map((edited) => ({
    argument: {
      message: { body: "hello", sentAt: 1, ...(edited ? { editedAt: 2 } : {}) },
    },
  })),
  "defaulted": [true, false].map((given) => ({
    argument: { profile: { name: "ada", ...(given ? { nick: "a" } : {}) } },
  })),
  "chain": [{
    argument: {
      items: [
        { title: "a", done: false },
        { title: "b", done: true },
        { title: "c", done: false },
      ],
      tags: ["x", "skip", "y"],
    },
  }],
  "within": [{
    argument: {
      items: [{ title: "a" }, { title: "b" }],
      tags: ["x", "skip", "y"],
      note: "n",
    },
  }],
  "stream-marker": [true, false].map((shown) => ({
    argument: {
      items: [{ title: "a" }, { title: "b" }],
      tags: ["x", "skip", "y"],
      shown,
    },
    events: [
      { binding: 0, event: { by: 2 } },
      { binding: 1, event: {} },
      { binding: 2, event: {} },
      { binding: 3, event: {} },
    ],
  })),
  "stream-returned": [{
    argument: { items: [{ title: "a" }, { title: "b" }], tags: ["x", "y"] },
    events: [{ binding: 0, event: { by: 2 } }],
  }],
  // An event for the stream of each binding, which the harness finds
  // from where the executor stored its link (ruling Z43).
  "star-kinds": [{
    argument: {
      items: [{ title: "a" }, { title: "b" }],
      tags: ["x", "y", "z"],
    },
    events: [
      { binding: 0, event: { by: 1 } },
      { binding: 1, event: { by: 10 } },
      { binding: 2, event: { by: 100 } },
      { binding: 3, event: { by: 1000 } },
      { binding: 3, event: { by: 1000 } },
      { binding: 4, event: {} },
      { binding: 5, event: {} },
    ],
  }],
  "random": [{
    argument: { note: "n" },
    events: [{ binding: 0, event: {} }, { binding: 0, event: {} }],
  }],
  // A pattern instantiated in a function body: two instances.
  "instantiate": [{
    argument: { note: "n" },
    events: [
      { binding: 1, event: { title: "a" } },
      { binding: 1, event: { title: "b" } },
    ],
  }],
  // Ruling Z43: the callback of a `flatMap` returns an inner `map` that
  // binds a handler. The groups are records a handler pushes, which are
  // references, and the shelves are plain values in place. An event is
  // sent to the stream of the last row of each list.
  "flat-inner": [{
    argument: {
      shelves: [{ name: "s", tags: ["x", "y"] }, { name: "t", tags: ["z"] }],
    },
    events: [
      { binding: 2, event: { name: "g", titles: ["a", "b"] } },
      { binding: 2, event: { name: "h", titles: ["c", "d"] } },
      { binding: 0, event: {} },
      { binding: 1, event: {} },
    ],
  }],
  // A stream at a member written after a spread in an array value, and
  // at a child written after two JSX spread children, each written in a
  // `computed`, which today's runtime runs. The arrays hold plain values
  // in place.
  "spread-stream": [{
    argument: {
      items: [{ title: "a" }, { title: "b" }],
      tags: ["x", "y", "z"],
    },
    events: [
      { binding: 0, event: { by: 1 } },
      { binding: 1, event: { by: 10 } },
    ],
  }],
  "flat-keys": [{
    argument: {
      groups: [
        { name: "g", members: ["a", "b"], people: [{ name: "p" }] },
        { name: "h", members: ["c"], people: [{ name: "q" }, { name: "r" }] },
      ],
      words: ["x", "y"],
      flip: true,
    },
  }],
  "keyed": [{
    argument: { note: "n" },
    events: [
      { binding: 0, event: { id: "a", title: "first" } },
      { binding: 0, event: { id: "b", title: "second" } },
      { binding: 0, event: { id: "a", title: "again" } },
      { binding: 2, event: { title: "t" } },
      { binding: 1, event: { id: "a" } },
    ],
  }],
  // Ruling Z18: the last element of each collection gets a note, leaves
  // the result of the `filter`, and returns.
  "key-returns": [{
    argument: { words: ["x", "y"] },
    events: [
      { binding: 2, event: { title: "a" } },
      { binding: 2, event: { title: "b" } },
      { binding: 0, event: { text: "row" } },
      { binding: 1, event: { text: "label" } },
      { binding: 3, event: { title: "b" } },
      { binding: 3, event: { title: "" } },
      { binding: 3, event: { title: "y" } },
      { binding: 3, event: { title: "" } },
    ],
  }],
  "list-records": [{
    argument: { note: "n" },
    events: [
      { binding: 1, event: { title: "a" } },
      { binding: 2, event: { title: "bb" } },
      { binding: 4, event: { name: "x" } },
      // The row of `bb` stores its position in `center`.
      { binding: 0, event: {} },
      // `bb` leaves the list, and `center` still reads its position.
      { binding: 3, event: {} },
      { binding: 1, event: { title: "ccc" } },
    ],
  }],
  // The elements are plain values in place. The events stop before one
  // that removes an element or writes through one: from there on the
  // values differ from today's by ruling Z12.
  "value-identity": [{
    argument: {
      stops: [
        { title: "a", done: false, position: { lat: 1, lng: 1 } },
        { title: "b", done: false, position: { lat: 2, lng: 2 } },
      ],
      tags: ["x", "y", "x"],
    },
    events: [
      { binding: 0, event: {} },
      { binding: 4, event: {} },
      { binding: 5, event: {} },
    ],
  }],
  // A `set` on a cell that holds a link: `pick` stores the link, `star`
  // writes a member below the cell, and `replace` a plain value to the
  // cell. The values are compared after each event.
  "set-over-link": [{
    argument: { first: { title: "a", stars: 1 } },
    events: [
      { binding: 0, event: {} },
      { binding: 1, event: {} },
      { binding: 2, event: {} },
    ],
  }],
  // A constant at a position of handle type: `increment` reads it
  // through its handle, twice. The event of `widen`, which writes it, is
  // not sent: the compiled path refuses the write (ES §2.4), and today's
  // runtime writes the argument document of the callee.
  "action-constant": [{
    argument: { score: 3 },
    events: [{ binding: 0, event: {} }, { binding: 0, event: {} }],
  }],
  // A constant at a position of handle type that a sandboxed body
  // reads through its handle.
  "body-constant": [{ argument: { words: ["a", "b"] } }],
  // A declaration of policy at module scope, which no run reads.
  "module-policy": [{ argument: { message: "kept" } }],
  // A pattern compiled in that passes its whole argument on.
  "whole-argument": [{ argument: { note: "n", count: 2 } }],
  // A state path declared as a handle or `undefined`.
  "handle-or-undefined": [{
    argument: { item: { title: "a" } },
    events: [{ binding: 0, event: {} }],
  }],
  // The debug renderers, in the reactive tier and in a function body.
  "debug-strings": [{
    argument: { entry: { tags: ["x", "y"], title: "a" } },
  }],
  // A `const` of the block body of a promoted `computed` that a
  // per-element construct names, over arrays of plain values in place.
  "block-const": [false, true].map((second) => ({
    argument: {
      items: [
        { text: "a", done: true },
        { text: "b", done: false },
        { text: "c", done: true },
      ],
      fleet: { ships: [{ text: "x", done: false }, { text: "y", done: true }] },
      spare: {
        ships: [{ text: "z", done: false }, { text: "w", done: false }],
      },
      second,
      skip: second ? "" : " b ",
    },
  })),
  // Rulings Z25 and Z26 over arrays of plain values in place: a card is
  // kept, the piles swap their last cards, and the row of the last card
  // of the first pile discards it.
  "value-copy": [{
    argument: {
      left: [{ suit: "a", rank: 1 }, { suit: "a", rank: 2 }],
      right: [{ suit: "b", rank: 3 }, { suit: "b", rank: 4 }],
    },
    events: [
      { binding: 2, event: {} },
      { binding: 1, event: {} },
      { binding: 0, event: {} },
      { binding: 1, event: {} },
    ],
  }],
  // Ruling Z27: the argument holds nothing at the two paths, and each
  // push starts from the default of its path.
  "push-default": [{
    argument: {},
    events: [
      { binding: 0, event: { text: "x" } },
      { binding: 1, event: { text: "y" } },
    ],
  }],
  "passes-collection": [{
    argument: {
      items: [
        { title: "a", done: false },
        { title: "b", done: true },
        { title: "c", done: false },
      ],
      tags: ["x", "x", "y"],
    },
  }],
  "state-below": [{
    argument: {
      items: [{ title: "a" }, { title: "b" }],
      words: ["x", "skip", "y"],
    },
    events: [
      { binding: 3, event: { text: "hello" } },
      { binding: 4, event: { tag: "second" } },
      { binding: 0, event: { text: "row" } },
      { binding: 1, event: { text: "label" } },
      { binding: 2, event: { text: "kept" } },
    ],
  }],
  "reduce": [{
    argument: {
      items: [{ title: "a", amount: 3 }, { title: "b", amount: 4 }],
      amounts: [5, 6, 7],
      bonus: 1,
    },
  }],
  "absent-state": ["z", "a"].map((wanted) => ({
    argument: { items: [{ id: "a" }], wanted },
    events: [{ binding: 0, event: {} }],
  })),
  "callee-default": [true, false].map((given) => ({
    argument: {
      amount: 420,
      ...(given ? { sign: "kr" } : {}),
      rows: [{ amount: 1 }, { amount: 20, sign: "kr" }, { amount: 2 }],
      words: ["x"],
    },
  })),
  "passed": [{ argument: { secret: "s3cret", items: ["a", "b"] } }],
  // The bindings of `batch.tsx` in the order of its plan: `adding`,
  // `note`, `copy`, `overwrite`, `relay`, `fail`. Each event is a batch
  // of its own on both sides.
  "batch": [{
    argument: {},
    events: [
      { binding: 0, event: { text: "a" } },
      { binding: 0, event: { text: "b" } },
      { binding: 1, event: {} },
      { binding: 2, event: {} },
      { binding: 4, event: { text: "c" } },
      { binding: 3, event: {} },
      { binding: 5, event: {} },
    ],
  }],
  // `setN` to a negative number, `keep`, `mark`, and `setN` back.
  "failing": [{
    argument: { rows: [2, -2, 6] },
    events: [
      { binding: 2, event: { to: -4 } },
      { binding: 0, event: {} },
      { binding: 1, event: {} },
      { binding: 2, event: { to: 6 } },
      { binding: 0, event: {} },
    ],
  }],
  // `bound.tsx` is not here: today's runtime tries a cycle that does not
  // settle again behind a backoff gate, so its run does not become idle
  // and the comparison does not end.
  "side-writes": [{
    argument: { flavor: "mint" },
    events: [{ binding: 0, event: { to: "b" } }],
  }],
  "state-declared": [{ argument: { note: "n" } }],
  "created": [{ argument: { note: "n" } }],
  "handler": [{
    argument: { secret: "s3cret", note: "n" },
    events: [{ binding: 0, event: { text: "hello", extra: "x" } }],
  }],
  "tagged": [{ argument: { secret: "s3cret" } }],
  "element-handlers": [{
    argument: { items: [{ title: "a" }, { title: "b" }], note: "n" },
    events: [{ binding: 0, event: {} }, { binding: 1, event: {} }],
  }],
  "index-nodes": [{
    argument: { items: [{ title: "a" }, { title: "b" }] },
    events: [{ binding: 0, event: {} }, { binding: 1, event: {} }],
  }],
  "equal-values": [{
    argument: { tags: ["a", "a"] },
    events: [{ binding: 0, event: {} }],
  }],
  "outer-stream": [
    {
      argument: { items: ["a", "b"], shown: false },
      events: [{ binding: 0, event: { by: 2 } }],
    },
    {
      argument: { items: ["a", "b"], shown: true },
      events: [{ binding: 0, event: { by: 2 } }],
    },
  ],
};

/**
 * The fixtures that are run with a generated scenario.
 * `fixtures/link-cycle.tsx` is not among them: its handlers make two cells
 * link to each other, and a read of the whole result of today's run then
 * rejects with a `LinkCycleError` outside the read. `fixtures/state-first.tsx`
 * is not either: it gives a state cell a first value that is not a
 * constant, which today's cell constructor refuses. Nor is
 * `fixtures/side-write-undemanded.tsx`: nothing demands its cone with a
 * side-write, which today's runtime evaluates all the same.
 */
const GENERATED = [
  "declared-writes",
  "element-resolved",
  "handle-passed",
  "handler-throws",
  "input-writes",
  "reference-written",
  "stream-target",
];

const read = (name: string) =>
  Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url));

const artifactOf = async (name: string) => {
  const modules = JSON.parse(await read(`${name}.emit.json`)) as {
    patterns: (Artifact & { schemas: Schemas })[];
  }[];
  // The pattern the module exports as its default, which the crate names
  // `default` where it is written in place.
  const patterns = modules[0].patterns;
  return {
    artifact: patterns.find((pattern) => pattern.name === "default") ??
      patterns[patterns.length - 1],
    // The artifact of a pattern of the fixture, by its identity.
    artifacts: (id: string) =>
      patterns.find((pattern) => pattern.plan.patterns?.[0] === id),
  };
};

/** One compared run of a fixture. */
export type FixtureRow = {
  fixture: string;
  scenario: string;
  comparison: ValueComparison;
};

/** Runs every fixture, or the named one, and compares its values. */
export const compareFixtures = async (
  only?: string,
): Promise<FixtureRow[]> => {
  const rows: FixtureRow[] = [];
  const names = [...Object.keys(WRITTEN), ...GENERATED].sort();
  for (const fixture of names) {
    if (only !== undefined && fixture !== only) continue;
    const { artifact, artifacts } = await artifactOf(fixture);
    const plan = artifact.plan as unknown as Plan;
    const program = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: await read(`${fixture}.tsx`) }],
    };
    const written = WRITTEN[fixture];
    if (written !== undefined) {
      for (const [index, scenario] of written.entries()) {
        rows.push({
          fixture,
          scenario: written.length > 1 ? `written ${index}` : "written",
          comparison: await compareScenarioValues(
            { program, plan, ...scenario },
            artifact,
            artifacts,
          ),
        });
      }
      continue;
    }
    const events = (plan.bindings ?? []).flatMap((binding, index) =>
      binding.handler?.body !== undefined
        ? [{
          binding: index,
          event: generateEvent(plan, artifact.schemas, index),
        }]
        : []
    );
    rows.push({
      fixture,
      scenario: "generated",
      comparison: await compareScenarioValues(
        {
          program,
          plan,
          argument: {},
          inputs: generateInputs(
            plan,
            artifact.schemas,
            await scenarioAudience(),
          ),
          events,
        },
        artifact,
        artifacts,
      ),
    });
  }
  return rows;
};

if (import.meta.main) {
  const rows = await compareFixtures(Deno.args[0]);
  let compared = 0;
  let equal = 0;
  for (const { fixture, scenario, comparison } of rows) {
    compared += comparison.compared;
    equal += comparison.equal;
    const state = comparison.notExecuted === undefined
      ? `${comparison.equal} of ${comparison.compared} equal`
      : `not executed: ${comparison.notExecuted.category}`;
    console.log(`${fixture} (${scenario}): ${state}`);
    if (comparison.notExecuted !== undefined) {
      console.log(`    ${comparison.notExecuted.detail}`);
    }
    for (const difference of comparison.differences) {
      console.log(
        `    ${difference.point} ${difference.value} at /${difference.path}: ` +
          `runtime ${difference.runtime}, executor ${difference.executor}`,
      );
    }
    for (const failed of comparison.failedEvents) {
      console.log(`    event not handled: ${failed}`);
    }
    for (const missed of comparison.notSent ?? []) {
      console.log(`    event not sent: ${missed}`);
    }
    if (comparison.documents !== undefined) {
      console.log(
        `    documents ${JSON.stringify(comparison.documents)}, counts ${
          JSON.stringify(comparison.counts)
        }`,
      );
    }
  }
  const executed = rows.filter((row) =>
    row.comparison.notExecuted === undefined
  );
  console.log(
    `${executed.length} of ${rows.length} runs executed, ` +
      `${equal} of ${compared} values equal`,
  );
}
