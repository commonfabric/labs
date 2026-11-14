/**
 * Runs the comparison over the corpus: every module the crate emits a
 * plan for with no unsupported construct, each with a generated scenario
 * (`generate.ts`), in this process and with no server.
 *
 * Run from the repository root, after `cargo build --release` in
 * `base/pattern-compiler`:
 *
 * `deno run -A --no-check base/pattern-compiler/compare/corpus.ts run <results.jsonl>`
 * `deno run -A --no-check base/pattern-compiler/compare/corpus.ts report <results.jsonl>`
 *
 * `run` appends one line per module to the results file and leaves out a
 * module the file already has, so a run that stopped is continued by
 * running it again. A module the file says was started and not finished
 * is recorded as one that ended the process.
 */
import { fromFileUrl } from "@std/path";

import { generateEvent, generateInputs, type Schemas } from "./generate.ts";
import {
  type Plan,
  type Row,
  type Run,
  runScenario,
  scenarioAudience,
  type WriteRow,
} from "./harness.ts";
import { showLabel } from "./scenarios.ts";
import {
  type Category,
  categoryOf,
  type Relation,
  type Template,
} from "./template.ts";

type CorpusPlan = Plan & {
  argumentSchema?: string;
  operations?: { kind?: string; name?: string }[];
};

type CorpusModule = {
  module: string;
  patterns: {
    name: string;
    plan: CorpusPlan;
    schemas: Schemas;
    unsupported: unknown[];
  }[];
};

/** One compared path, as the results file holds it. */
export type ResultRow = {
  kind: "output" | "write";
  path: string;
  /** The `op` of the root of the template. */
  root: string;
  runtime: string;
  runtimeWithoutStatic: string;
  template: string;
  confidentiality: Relation;
  integrity: Relation;
  overall: Relation;
  /** The category the row is counted in (PL §3.1). */
  category: Category;
  /** The category against the runtime's label without its static part. */
  withoutStatic: Category;
  /**
   * For an output: the category of the template's label before the atom
   * of a kept output is added to it.
   */
  templateAlone?: Category;
  /** A selector or a pick of the template was not found from the run. */
  bound: boolean;
};

/** One module, as the results file holds it. */
export type ModuleResult = {
  module: string;
  pattern?: string;
  /** Why the module was not run, where it was not. */
  skipped?: string;
  rows?: ResultRow[];
  /** What the run did not compare, by reason. */
  notCompared?: Record<string, number>;
  decided?: Run["decided"];
  events?: number;
  /** What became of each event, with the event the generator made. */
  outcomes?: (Run["events"][number] & { event: string })[];
  /** The kept outputs the run holds no value at. */
  missing?: {
    path: string;
    root: string;
    absentFrom: number;
    above: string;
    stored: boolean;
    raw?: string;
    rawAtAbsent?: string;
    rawAbove?: string;
    runtime: string;
    template?: string;
    afterPull: boolean;
  }[];
  /** What the run wrote to the console as an error or a warning. */
  logged?: string[];
};

const repository = fromFileUrl(new URL("../../../", import.meta.url));
const patterns = `${repository}patterns`;

/** The plans of the accepted corpus modules, from the crate. */
const corpusPlans = async (): Promise<CorpusModule[]> => {
  const { success, stdout, stderr } = await new Deno.Command(
    `${repository}base/pattern-compiler/target/release/pattern-compiler`,
    { args: ["plan", "--corpus", ".", "--json"], cwd: patterns },
  ).output();
  if (!success) throw new Error(new TextDecoder().decode(stderr));
  return JSON.parse(new TextDecoder().decode(stdout));
};

// What a pattern needs that a test process with no server does not have,
// by the kind of the plan's operation.
const NEEDS: Record<string, string> = {
  wish: "needs `wish`",
  effect: "requests an effect",
};

const resultRow = (
  kind: "output" | "write",
  row: Row | WriteRow,
  template: Template | undefined,
): ResultRow => {
  const evaluated = "reached" in row ? row.reached : row.template;
  return {
    kind,
    path: "handler" in row
      ? `${row.handler}#${row.write}/${row.path.join("/")}`
      : row.path.join("/"),
    root: template?.op ?? "",
    runtime: showLabel(row.runtime),
    runtimeWithoutStatic: showLabel(row.runtimeByOrigin.withoutStatic),
    template: showLabel(evaluated.label),
    confidentiality: row.comparison.confidentiality,
    integrity: row.comparison.integrity,
    overall: row.comparison.overall,
    category: categoryOf(row.comparison),
    withoutStatic: categoryOf(row.comparisonWithoutStatic),
    ...("comparisonOfTemplateAlone" in row
      ? { templateAlone: categoryOf(row.comparisonOfTemplateAlone) }
      : {}),
    bound: evaluated.bound,
  };
};

/** Runs one module of the corpus with a generated scenario. */
export const runModule = async (
  module: CorpusModule,
): Promise<ModuleResult> => {
  // The pattern the module exports as its default, written in place or
  // by name, and otherwise the first one it exports by name.
  const source = await Deno.readTextFile(`${patterns}${module.module}`);
  const byName = source.match(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;/)
    ?.[1];
  const main = module.patterns.find((pattern) =>
    pattern.name === "default" || pattern.name === byName
  );
  const named = module.patterns.find((pattern) =>
    new RegExp(`export\\s+const\\s+${pattern.name}\\b`).test(source)
  );
  const pattern = main ?? named;
  if (pattern === undefined) {
    return { module: module.module, skipped: "exports no pattern" };
  }
  const { plan, schemas, name } = pattern;
  const base = { module: module.module, pattern: name };
  for (const operation of plan.operations ?? []) {
    const reason = NEEDS[operation.kind ?? ""];
    if (reason !== undefined) return { ...base, skipped: reason };
  }
  const events = (plan.bindings ?? []).flatMap((binding, index) =>
    binding.handler?.body !== undefined && binding.result !== undefined &&
      (binding.within ?? []).length === 0
      ? [{ binding: index, event: generateEvent(plan, schemas, index) }]
      : []
  );
  let run: Run;
  // What the runtime reports while the scenario runs: a write it refuses
  // is logged and does not fail the run.
  const logged = new Map<string, number>();
  const { error: consoleError, warn: consoleWarn } = console;
  const log = (...parts: unknown[]) => {
    const line = parts.map((part) =>
      part instanceof Error ? `${part.name}: ${part.message}` : `${part}`
    ).join(" ").split("\n")[0].slice(0, 160);
    logged.set(line, (logged.get(line) ?? 0) + 1);
  };
  console.error = log;
  console.warn = log;
  try {
    run = await runScenario({
      program: {
        main: `${patterns}${module.module}`,
        root: repository,
        ...(pattern === main ? {} : { export: name }),
      },
      plan,
      argument: {},
      inputs: generateInputs(plan, schemas, await scenarioAudience()),
      events,
    });
  } catch (error) {
    const message = `${(error as Error)?.message ?? error}`.split("\n")[0];
    return { ...base, skipped: `the run fails: ${message.slice(0, 100)}` };
  } finally {
    console.error = consoleError;
    console.warn = consoleWarn;
  }
  const notCompared: Record<string, number> = {};
  for (const { reason } of run.skipped) {
    notCompared[reason] = (notCompared[reason] ?? 0) + 1;
  }
  return {
    ...base,
    rows: [
      ...run.rows.map((row) =>
        resultRow("output", row, plan.outputs[row.output].template)
      ),
      ...run.writes.map((row) =>
        resultRow(
          "write",
          row,
          plan.bodies?.[plan.bindings?.[row.binding]?.handler?.body ?? -1]
            ?.writes?.[row.write]?.template,
        )
      ),
    ],
    notCompared,
    decided: run.decided,
    events: events.length,
    outcomes: run.events.map((outcome, index) => ({
      ...outcome,
      event: JSON.stringify(events[index]?.event)?.slice(0, 300) ?? "",
    })),
    missing: run.missing.map((entry) => ({
      path: entry.path.join("/"),
      root: entry.root,
      absentFrom: entry.absentFrom,
      above: entry.above,
      stored: entry.stored,
      raw: entry.raw,
      rawAtAbsent: entry.rawAtAbsent,
      rawAbove: entry.rawAbove,
      runtime: showLabel(entry.runtime),
      ...(entry.template === undefined
        ? {}
        : { template: showLabel(entry.template) }),
      afterPull: entry.afterPull,
    })),
    logged: [...logged].sort((a, b) => b[1] - a[1]).slice(0, 12).map((
      [line, times],
    ) => `${times}x ${line}`),
  };
};

const readResults = async (file: string): Promise<ModuleResult[]> => {
  let text = "";
  try {
    text = await Deno.readTextFile(file);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const lines = text.split("\n").filter((line) => line !== "").map((line) =>
    JSON.parse(line) as ModuleResult | { started: string }
  );
  const finished = lines.filter((line): line is ModuleResult =>
    "module" in line
  );
  const done = new Set(finished.map((result) => result.module));
  // A module that was started and has no result ended the process.
  for (const line of lines) {
    if ("started" in line && !done.has(line.started)) {
      done.add(line.started);
      finished.push({
        module: line.started,
        skipped: "the run ends the process or does not settle",
      });
    }
  }
  return finished;
};

const run = async (file: string, only: string | undefined) => {
  const modules = (await corpusPlans()).filter((module) =>
    module.patterns.length > 0 &&
    module.patterns.every((pattern) => pattern.unsupported.length === 0) &&
    (only === undefined || module.module.includes(only))
  );
  const earlier = await readResults(file);
  const done = new Set(earlier.map((result) => result.module));
  // Rewrite the file with a result for each module an earlier run left
  // started.
  await Deno.writeTextFile(
    file,
    earlier.map((result) => `${JSON.stringify(result)}\n`).join(""),
  );
  for (const module of modules) {
    if (done.has(module.module)) continue;
    await Deno.writeTextFile(
      file,
      `${JSON.stringify({ started: module.module })}\n`,
      { append: true },
    );
    console.error(module.module);
    const result = await runModule(module);
    await Deno.writeTextFile(file, `${JSON.stringify(result)}\n`, {
      append: true,
    });
  }
};

const count = <T>(items: T[], key: (item: T) => string) => {
  const counts = new Map<string, T[]>();
  for (const item of items) {
    counts.set(key(item), [...(counts.get(key(item)) ?? []), item]);
  }
  return [...counts.entries()].sort((a, b) => b[1].length - a[1].length);
};

const report = async (file: string) => {
  const results = await readResults(file);
  const ran = results.filter((result) => result.rows !== undefined);
  console.log(`modules attempted: ${results.length}`);
  console.log(`modules run: ${ran.length}`);
  console.log("modules not run, by reason:");
  for (
    const [reason, modules] of count(
      results.filter((result) => result.skipped !== undefined),
      (result) => result.skipped!,
    )
  ) {
    console.log(`  ${`${modules.length}`.padStart(4)}  ${reason}`);
  }
  const rows = ran.flatMap((result) =>
    result.rows!.map((row) => ({ ...row, module: result.module }))
  );
  for (const kind of ["output", "write"] as const) {
    const of = rows.filter((row) => row.kind === kind && !row.bound);
    const by = (category: Category, field: "category" | "withoutStatic") =>
      of.filter((row) => row[field] === category).length;
    console.log(
      `${
        kind === "output" ? "outputs" : "write edges"
      } compared: ${of.length}` +
        `, and ${
          rows.filter((row) => row.kind === kind && row.bound).length
        } more whose label is a bound`,
    );
    for (
      const category of [
        "equal",
        "tighter",
        "atom names the pattern",
        "looser",
        "incomparable",
      ] as const
    ) {
      console.log(
        `  ${category.padEnd(22)} ${
          `${by(category, "category")}`.padStart(6)
        }` +
          `   without the static part ${
            `${by(category, "withoutStatic")}`.padStart(6)
          }`,
      );
    }
    // What each row was before the atom of a kept output was added.
    if (kind === "output") {
      for (
        const [was, group] of count(
          of,
          (row) =>
            `${row.category}, and ${row.templateAlone} before the atom of a kept output is added`,
        )
      ) {
        console.log(`    ${`${group.length}`.padStart(6)}  ${was}`);
      }
    }
    // A row counted under "atom names the pattern" is equal or tighter
    // on each axis otherwise.
    const named = of.filter((row) => row.category === "atom names the pattern");
    console.log(
      `  of the rows whose atom names the pattern, ${
        named.filter((row) => row.overall === "equal").length
      } are equal otherwise and ${
        named.filter((row) => row.overall === "tighter").length
      } tighter`,
    );
  }
  console.log("not compared, by reason:");
  const reasons = new Map<string, number>();
  for (const result of ran) {
    for (const [reason, number] of Object.entries(result.notCompared ?? {})) {
      reasons.set(reason, (reasons.get(reason) ?? 0) + number);
    }
  }
  for (const [reason, number] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${`${number}`.padStart(5)}  ${reason}`);
  }
  const decided = { byValue: 0, byCondition: 0, stated: 0, unobserved: 0 };
  for (const result of ran) {
    for (const key of Object.keys(decided) as (keyof typeof decided)[]) {
      decided[key] += result.decided?.[key] ?? 0;
    }
  }
  console.log(
    `selectors and picks: ${decided.byValue} found from a stored value, ` +
      `${decided.byCondition} from the condition's or the key's slot, ` +
      `${decided.unobserved} not found`,
  );
  console.log(
    `events sent: ${
      ran.reduce((sum, result) => sum + (result.events ?? 0), 0)
    }`,
  );
  console.log("\nrows that are looser or incomparable, by what differs:");
  const looser = rows.filter((row) =>
    !row.bound &&
    (row.overall === "looser" || row.withoutStatic === "looser" ||
      row.withoutStatic === "incomparable")
  );
  for (
    const [cause, group] of count(
      looser,
      (row) =>
        `${row.kind}, template root \`${row.root}\`, C ${row.confidentiality}, I ${row.integrity}, without the static part ${row.withoutStatic}`,
    )
  ) {
    const [example] = group;
    console.log(
      `  ${`${group.length}`.padStart(5)}  ${cause}\n` +
        `         ${example.module} ${example.path}\n` +
        `         runtime  ${example.runtime}\n` +
        `         runtime without the static part ${example.runtimeWithoutStatic}\n` +
        `         template ${example.template}`,
    );
  }
  console.log("\noutputs the run holds no value at:");
  const missing = ran.flatMap((result) =>
    (result.missing ?? []).map((entry) => ({ ...entry, module: result.module }))
  );
  for (
    const [cause, group] of count(
      missing,
      (entry) =>
        `${entry.stored ? "something stored" : "nothing stored"}, ${
          entry.afterPull
            ? "a value once read on its own"
            : "no value once read on its own"
        }, absent from segment ${
          entry.absentFrom === entry.path.split("/").length ? "last" : "above"
        }, runtime label ${
          entry.runtime === "C {} I {}" ? "empty" : "not empty"
        }, template ${
          entry.template === undefined
            ? "not evaluated"
            : entry.template.startsWith("C {}")
            ? "without a clause"
            : "with a clause"
        }`,
    )
  ) {
    const [example] = group;
    console.log(
      `  ${`${group.length}`.padStart(5)}  ${cause}\n` +
        `         ${example.module} ${example.path} (\`${example.root}\`)\n` +
        `         stored ${example.raw}`,
    );
  }
};

if (import.meta.main) {
  const [command, file, only] = Deno.args;
  if (command === "run" && file !== undefined) await run(file, only);
  else if (command === "report" && file !== undefined) await report(file);
  else {
    console.error("usage: corpus.ts run|report <results.jsonl> [module text]");
    Deno.exit(2);
  }
}
