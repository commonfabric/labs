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
  "callee-default": [true, false].map((given) => ({
    argument: { amount: 420, ...(given ? { sign: "kr" } : {}) },
  })),
  "passed": [{ argument: { secret: "s3cret", items: ["a", "b"] } }],
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
  return patterns.find((pattern) => pattern.name === "default") ??
    patterns[patterns.length - 1];
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
    const artifact = await artifactOf(fixture);
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
          ),
        });
      }
      continue;
    }
    const events = (plan.bindings ?? []).flatMap((binding, index) =>
      binding.handler?.body !== undefined && binding.result !== undefined
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
