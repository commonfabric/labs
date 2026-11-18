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

import type { Artifact } from "../exec/executor.ts";
import { nameText } from "../exec/store.ts";
import { generateEvent, generateInputs, type Schemas } from "./generate.ts";
import {
  type LabeledInput,
  type Plan,
  type Probe,
  type Row,
  type Run,
  runScenario,
  scenarioAudience,
  type StreamRecord,
  type WriteRow,
} from "./harness.ts";
import { showLabel } from "./scenarios.ts";
import { argumentOf, ExecutorRun } from "./values.ts";
import {
  type Category,
  categoryOf,
  namedTemplate,
  type Relation,
  type Template,
} from "./template.ts";

type CorpusPlan = Plan & {
  argumentSchema?: string;
  operations?: { kind?: string; name?: string }[];
};

export type CorpusModule = {
  module: string;
  patterns: {
    name: string;
    plan: CorpusPlan;
    schemas: Schemas;
    unsupported: unknown[];
    /** The value code of the plan, which the executor runs. */
    code?: Artifact["code"];
  }[];
};

/** Where a binding is made: the kinds of step its `within` has. */
export type Within = "site" | "element";

/** The kind of the steps of a `within`: `element` where it has one. */
export const withinOf = (steps: unknown[] | undefined): Within | undefined =>
  (steps ?? []).some((step) =>
      (step as { element?: number }).element !== undefined
    )
    ? "element"
    : (steps ?? []).length > 0
    ? "site"
    : undefined;

/** One compared path, as the results file holds it. */
export type ResultRow = {
  kind: "output" | "write";
  path: string;
  /**
   * For a write edge: the index of the handler's binding in the plan. The
   * name in `path` does not identify it, since two inline handlers of one
   * module can have one name.
   */
  binding?: number;
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
  /**
   * For a write edge: whether the row is looser by the stamp of a link the
   * body passes on alone (`WriteRow.looserByLinkStamp`).
   */
  looserByLinkStamp?: boolean;
  /**
   * For a write edge of a handler bound in an element body: `tighter`
   * where the row is tighter by the coordinator's join on the argument
   * document of an element's instance alone, which is expected (PL §3.1),
   * and `no atom` where it differs by that join in confidentiality and is
   * looser in integrity by the atom the template does not mint for a
   * label with no clause.
   */
  coordinatorJoin?: "tighter" | "no atom";
  /** For a write edge: the clauses the template lacks, where it lacks one. */
  lacks?: string;
  /**
   * For a write edge of a handler bound in an element body, `element`,
   * and of one bound in a pattern compiled in and in no element body,
   * `site` (the steps of `Binding.within`).
   */
  within?: Within;
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
  /** The write edges the run of a sent event did not make. */
  notMade?: string[];
  /**
   * What the run did not compare of the events and the write edges of the
   * handlers bound in each place (`none`, `site`, `element`), by reason.
   */
  notComparedOfHandlers?: Record<string, Record<string, number>>;
  /** The same, each with what was not compared. */
  notComparedOfHandlersList?: { what: string; reason: string; where: string }[];
  /**
   * Each binding of a handler: where it is bound, and the number of
   * write edges of its body.
   */
  handlers?: {
    name: string;
    within?: Within;
    writes: number;
  }[];
  decided?: Run["decided"];
  events?: number;
  /** What became of each event, with the event the generator made. */
  outcomes?: (Run["events"][number] & { event: string; within?: Within })[];
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

/**
 * The plans and the value code of the accepted corpus modules, from the
 * crate.
 */
export const corpusModules = async (): Promise<CorpusModule[]> => {
  const { success, stdout, stderr } = await new Deno.Command(
    `${repository}base/pattern-compiler/target/release/pattern-compiler`,
    { args: ["emit", "--corpus", "."], cwd: patterns },
  ).output();
  if (!success) throw new Error(new TextDecoder().decode(stderr));
  return new TextDecoder().decode(stdout).split("\n").filter((line) =>
    line.length > 0
  ).map((line) => JSON.parse(line));
};

/** The artifact of a pattern of the corpus, by its identity. */
export const artifactsOf = (modules: Iterable<CorpusModule>) => {
  const known = new Map<string, Artifact>();
  for (const module of modules) {
    for (const pattern of module.patterns) {
      const id = (pattern.plan as { patterns?: string[] }).patterns?.[0];
      if (id !== undefined && pattern.code !== undefined) {
        known.set(id, pattern as unknown as Artifact);
      }
    }
  }
  return (id: string) => known.get(id);
};

/**
 * The executor's side of a run of a pattern with generated inputs: the
 * record the harness finds each stream by (ruling Z43). Nothing for a
 * pattern with no value code.
 */
export const executorOf = (
  pattern: CorpusModule["patterns"][number],
  inputs: Record<string, LabeledInput>,
  artifacts?: (id: string) => Artifact | undefined,
): ExecutorRun | undefined =>
  pattern.code === undefined ? undefined : new ExecutorRun(
    pattern as unknown as Artifact,
    argumentOf({ argument: {}, inputs }),
    artifacts,
  );

// What a pattern needs that a test process with no server does not have,
// by the kind of the plan's operation.
export const NEEDS: Record<string, string> = {
  wish: "needs `wish`",
  effect: "requests an effect",
};

/** A row of the comparison as the results file holds it. */
export const resultRow = (
  kind: "output" | "write",
  row: Row | WriteRow,
  template: Template | undefined,
  within?: Within,
): ResultRow => {
  const evaluated = "reached" in row ? row.reached : row.template;
  return {
    kind,
    path: "handler" in row
      ? `${row.handler}#${row.write}/${row.path.join("/")}`
      : row.path.join("/"),
    ...("handler" in row ? { binding: row.binding } : {}),
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
      : {
        looserByLinkStamp: row.looserByLinkStamp,
        ...(row.byCoordinatorJoin
          ? { coordinatorJoin: "tighter" as const }
          : row.noAtomBesideCoordinatorJoin
          ? { coordinatorJoin: "no atom" as const }
          : {}),
        ...(row.lacking.length === 0 ? {} : {
          lacks: showLabel({ confidentiality: row.lacking, integrity: [] }),
        }),
        ...(within === undefined ? {} : { within }),
      }),
    bound: evaluated.bound,
  };
};

/**
 * The order the events of a run are sent in. `outside first` sends the
 * events of the handlers bound in no element body and no pattern compiled
 * in before the others, and `plan` sends every event in the order of the
 * plan's bindings.
 */
export type EventOrder = "outside first" | "plan";

/**
 * The bindings a run has an event for, in the order of the events: each
 * binding of a handler. The plan does not say whether the result holds
 * the stream of a binding (ruling Z43), and the harness sends no event
 * for one whose stream it does not find.
 */
export const eventOrder = (plan: Plan, order: EventOrder): number[] => {
  const sent = (plan.bindings ?? []).flatMap((binding, index) =>
    binding.handler?.body !== undefined
      ? [{ index, inside: (binding.within ?? []).length > 0 }]
      : []
  );
  const groups = order === "plan" ? [sent] : [
    sent.filter(({ inside }) => !inside),
    sent.filter(({ inside }) => inside),
  ];
  return groups.flat().map(({ index }) => index);
};

/**
 * The pattern of a module that a run of the corpus runs: the one the
 * module exports as its default, written in place or by name, and
 * otherwise the first one it exports by name.
 */
export const mainPattern = async <P extends { name: string }>(
  module: { module: string; patterns: P[] },
): Promise<{ pattern: P; isDefault: boolean } | undefined> => {
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
  return pattern === undefined
    ? undefined
    : { pattern, isDefault: pattern === main };
};

/**
 * Runs one module of the corpus with a generated scenario. `probe` is
 * called at each point of the run (`Scenario.probe`). `streams` is the
 * executor's record of where each stream is stored
 * (`Scenario.streams`): with none, the run makes one from the module's
 * value code, with `artifacts` for a pattern a function body
 * instantiates.
 */
export const runModule = async (
  module: CorpusModule,
  order: EventOrder = "outside first",
  probe?: Probe,
  streams?: StreamRecord,
  artifacts?: (id: string) => Artifact | undefined,
  /**
   * Whether the run has answers in place of the network (`stubs.ts`): a
   * module that needs `wish` or requests an effect is then run.
   */
  stubbed = false,
): Promise<ModuleResult> => {
  const chosen = await mainPattern(module);
  if (chosen === undefined) {
    return { module: module.module, skipped: "exports no pattern" };
  }
  const { pattern, isDefault } = chosen;
  const { plan, schemas, name } = pattern;
  const base = { module: module.module, pattern: name };
  for (const operation of stubbed ? [] : plan.operations ?? []) {
    const reason = NEEDS[operation.kind ?? ""];
    if (reason !== undefined) return { ...base, skipped: reason };
  }
  // One event for each handler, which is sent where the result holds its
  // stream. A handler bound in an element body gets its event at one
  // element of each enclosing collection, which the harness chooses. What a handler's run
  // finds stored is what the events before it left, so the rows of a run
  // are those of one order of the events (`EventOrder`).
  const events = eventOrder(plan, order).map((binding) => ({
    binding,
    event: generateEvent(plan, schemas, binding),
  }));
  const handlers = (plan.bindings ?? []).flatMap((binding) => {
    if (binding.handler?.body === undefined) return [];
    const within = withinOf(binding.within);
    return [{
      name: nameText(binding.name ?? ""),
      ...(within === undefined ? {} : { within }),
      writes: plan.bodies?.[binding.handler.body]?.writes?.length ?? 0,
    }];
  });
  const inputs = generateInputs(plan, schemas, await scenarioAudience());
  const record = streams ?? executorOf(pattern, inputs, artifacts);
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
        ...(isDefault ? {} : { export: name }),
      },
      plan,
      argument: {},
      inputs,
      events,
      ...(probe === undefined ? {} : { probe }),
      ...(record === undefined ? {} : { streams: record }),
    });
  } catch (error) {
    // With `COMPARE_TRACE` set, where the run failed.
    if (Deno.env.get("COMPARE_TRACE") !== undefined) {
      consoleError((error as Error)?.stack ?? error);
    }
    const message = `${(error as Error)?.message ?? error}`.split("\n")[0];
    return { ...base, skipped: `the run fails: ${message.slice(0, 100)}` };
  } finally {
    console.error = consoleError;
    console.warn = consoleWarn;
  }
  const notCompared: Record<string, number> = {};
  const notComparedOfHandlers: Record<string, Record<string, number>> = {};
  for (const { reason, binding } of run.skipped) {
    notCompared[reason] = (notCompared[reason] ?? 0) + 1;
    if (binding === undefined) continue;
    const where = withinOf(plan.bindings?.[binding]?.within) ?? "none";
    notComparedOfHandlers[where] ??= {};
    notComparedOfHandlers[where][reason] =
      (notComparedOfHandlers[where][reason] ?? 0) + 1;
  }
  return {
    ...base,
    rows: [
      ...run.rows.map((row) =>
        resultRow(
          "output",
          row,
          namedTemplate(plan.outputs[row.output].template, plan),
        )
      ),
      ...run.writes.map((row) =>
        resultRow(
          "write",
          row,
          namedTemplate(
            plan.bodies?.[plan.bindings?.[row.binding]?.handler?.body ?? -1]
              ?.writes?.[row.write]?.template,
            plan,
          ),
          withinOf(plan.bindings?.[row.binding]?.within),
        )
      ),
    ],
    notCompared,
    notComparedOfHandlers,
    notComparedOfHandlersList: run.skipped.flatMap(
      ({ what, reason, binding }) =>
        binding === undefined ? [] : [{
          what,
          reason,
          where: withinOf(plan.bindings?.[binding]?.within) ?? "none",
        }],
    ),
    handlers,
    notMade: run.skipped.filter(({ reason }) =>
      reason === "a write the event's run did not make"
    ).map(({ what }) => what),
    decided: run.decided,
    events: events.length,
    outcomes: run.events.map((outcome, index) => {
      const within = withinOf(plan.bindings?.[outcome.binding]?.within);
      return {
        ...outcome,
        event: JSON.stringify(events[index]?.event)?.slice(0, 300) ?? "",
        ...(within === undefined ? {} : { within }),
      };
    }),
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

const run = async (
  file: string,
  only: string | undefined,
  order: EventOrder,
) => {
  const emitted = await corpusModules();
  const artifacts = artifactsOf(emitted);
  const modules = emitted.filter((module) =>
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
    const result = await runModule(
      module,
      order,
      undefined,
      undefined,
      artifacts,
    );
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

/**
 * A shown label with each clause that the generator declared for an input
 * written as `input:<name>`, without the space it is joined with.
 */
const inputNames = (label: string): string =>
  label.replace(
    /\{"anyOf":\[(?:\{[^{}]*\},)?"input:(\w+)"(?:,\{[^{}]*\})?\]\}/g,
    "input:$1",
  );

const CATEGORIES = [
  "equal",
  "tighter",
  "atom names the pattern",
  "looser",
  "incomparable",
] as const;

type Counts = Record<Category, number>;

/** The rows of one kind, counted by category. */
export type Tally = {
  /** The rows whose label is not a bound. */
  compared: number;
  /** The rows whose label is a bound, which are counted in no category. */
  bounds: number;
  /**
   * For an output: the classification on the template's label without
   * the atom of a kept output, which is the test of the rule the row's
   * template follows (PL §3.1, "The atom of a kept output").
   */
  withoutAtom: Counts;
  /** The classification on the label the design stores. */
  withAtom: Counts;
  /** `withAtom` against the runtime's label without its static part. */
  withoutStatic: Counts;
  /**
   * For a write edge: the rows that are looser by the stamp of a link the
   * body passes on alone.
   */
  looserByLinkStamp?: number;
  /**
   * For a write edge: the rows that are tighter by the coordinator's join
   * on an element's argument document alone. They are counted as tighter
   * (PL §3.1).
   */
  byCoordinatorJoin?: number;
  /**
   * For a write edge: the rows that differ by that join and are looser in
   * integrity by the atom the template does not mint.
   */
  noAtomBesideCoordinatorJoin?: number;
};

/**
 * Counts the rows of `kind` by each classification. With `within`, the
 * write edges of the handlers bound there alone: in an element body, in a
 * pattern compiled in and in no element body, or in neither (`none`).
 */
export const tally = (
  rows: readonly ResultRow[],
  kind: "output" | "write",
  within?: Within | "none",
): Tally => {
  const of = rows.filter((row) =>
    row.kind === kind &&
    (within === undefined || (row.within ?? "none") === within)
  );
  const compared = of.filter((row) => !row.bound);
  const by = (category: (row: ResultRow) => Category | undefined): Counts => {
    const counts = Object.fromEntries(
      CATEGORIES.map((category) => [category, 0]),
    ) as Counts;
    for (const row of compared) {
      const found = category(row);
      if (found !== undefined) counts[found]++;
    }
    return counts;
  };
  return {
    compared: compared.length,
    bounds: of.length - compared.length,
    withoutAtom: by((row) => row.templateAlone ?? row.category),
    withAtom: by((row) => row.category),
    withoutStatic: by((row) => row.withoutStatic),
    ...(kind === "write"
      ? {
        looserByLinkStamp:
          compared.filter((row) => row.looserByLinkStamp).length,
        byCoordinatorJoin:
          compared.filter((row) => row.coordinatorJoin === "tighter").length,
        noAtomBesideCoordinatorJoin:
          compared.filter((row) => row.coordinatorJoin === "no atom").length,
      }
      : {}),
  };
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
    const counts = tally(rows, kind);
    console.log(
      `${
        kind === "output" ? "outputs" : "write edges"
      } compared: ${counts.compared}` +
        `, and ${counts.bounds} more whose label is a bound`,
    );
    // An output is classified twice (PL §3.1, "The atom of a kept
    // output"). A write edge gets no atom of the pattern.
    const columns: [string, Counts][] = kind === "output"
      ? [
        ["without the atom of a kept output", counts.withoutAtom],
        ["with it", counts.withAtom],
        ["with it, without the static part", counts.withoutStatic],
      ]
      : [
        ["", counts.withAtom],
        ["without the static part", counts.withoutStatic],
      ];
    for (const category of CATEGORIES) {
      console.log(
        `  ${category.padEnd(22)}` +
          columns.map(([title, column]) =>
            `   ${title} ${`${column[category]}`.padStart(6)}`
          ).join(""),
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
    if (kind === "write") {
      console.log(
        `  looser by the stamp of a link the body passes on: ${counts.looserByLinkStamp}`,
      );
      // The same by where the handler is bound.
      for (const within of ["none", "site", "element"] as const) {
        const part = tally(rows, kind, within);
        console.log(
          `  handlers bound in ${
            within === "none"
              ? "no element body and no pattern compiled in"
              : within === "site"
              ? "a pattern compiled in"
              : "an element body"
          }: ${part.compared} compared, and ${part.bounds} bounds: ` +
            CATEGORIES.map((category) =>
              `${category} ${part.withAtom[category]}`
            ).join(", ") +
            `; looser by the stamp of a passed link ${part.looserByLinkStamp}` +
            `; tighter by the coordinator's join on an element's argument document ${part.byCoordinatorJoin}` +
            `; looser by the atom a template with no clause does not mint, beside that join ${part.noAtomBesideCoordinatorJoin}`,
        );
      }
      // The tighter rows, by the clauses the template lacks.
      console.log(
        "  tighter write edges, by where the handler is bound and what the template lacks:",
      );
      for (
        const [cause, group] of count(
          of.filter((row) => row.category === "tighter"),
          (row) =>
            `${row.within ?? "none"}${
              row.coordinatorJoin === "tighter"
                ? ", by the coordinator's join"
                : ""
            }, C ${row.confidentiality}, I ${row.integrity}`,
        )
      ) {
        console.log(`    ${`${group.length}`.padStart(4)}  ${cause}`);
        for (const row of group) {
          console.log(
            `            ${row.module} ${row.path} (binding ${row.binding}) lacks ${
              row.lacks === undefined ? "no clause" : inputNames(row.lacks)
            }`,
          );
        }
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
  // The handlers by where they are bound: sent an event, and what became
  // of it.
  const handlers = ran.flatMap((result) => result.handlers ?? []);
  const sent = ran.flatMap((result) => result.outcomes ?? []);
  console.log("handlers, by where they are bound:");
  for (const within of ["none", "site", "element"] as const) {
    const of = handlers.filter((handler) =>
      (handler.within ?? "none") === within
    );
    const events = sent.filter((outcome) =>
      (outcome.within ?? "none") === within
    );
    const edges = (list: typeof of) =>
      list.reduce((sum, handler) => sum + handler.writes, 0);
    console.log(
      `  ${within}: ${of.length} bindings with ${edges(of)} write edges; ` +
        `events committed ${
          events.filter((outcome) => outcome.outcome === "committed").length
        }, refused ${
          events.filter((outcome) => outcome.outcome === "refused").length
        }, not sent ${
          events.filter((outcome) => outcome.outcome === "not sent").length
        }`,
    );
    const reasons = new Map<string, number>();
    for (const result of ran) {
      for (
        const [reason, number] of Object.entries(
          result.notComparedOfHandlers?.[within] ?? {},
        )
      ) {
        reasons.set(reason, (reasons.get(reason) ?? 0) + number);
      }
    }
    for (const [reason, number] of [...reasons].sort((a, b) => b[1] - a[1])) {
      console.log(`      not compared, ${reason}: ${number}`);
    }
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
  // What became of the events: the runtime's reason for each one whose
  // transaction was not committed, without the identifiers in it.
  const outcomes = ran.flatMap((result) =>
    (result.outcomes ?? []).map((outcome) => ({
      ...outcome,
      module: result.module,
    }))
  );
  const refused = outcomes.filter((outcome) => outcome.outcome === "refused");
  console.log(
    `events committed: ${
      outcomes.filter((outcome) => outcome.outcome === "committed").length
    }, refused: ${refused.length} in ${
      new Set(refused.map((outcome) => outcome.module)).size
    } modules`,
  );
  console.log("events refused, by the runtime's reason:");
  for (
    const [reason, group] of count(
      refused,
      (outcome) =>
        (outcome.aborted !== undefined
          ? `the handler threw: ${outcome.aborted}`
          : [
            ...new Set(
              (outcome.refusals ?? [{ reason: outcome.reason ?? "" }]).map((
                refusal,
              ) =>
                refusal.reason.replace(/ for \S+/, "").replace(/ at \/\S*/, "")
                  .slice(0, 90)
              ),
            ),
          ].join("; ")).slice(0, 200),
    )
  ) {
    const [example] = group;
    console.log(
      `  ${`${group.length}`.padStart(5)}  ${reason}\n` +
        `         ${example.module} ${example.handler} ${example.event}`,
    );
  }
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
  const planOrder = Deno.args.includes("--plan-order");
  const [command, file, only] = Deno.args.filter((argument) =>
    argument !== "--plan-order"
  );
  if (command === "run" && file !== undefined) {
    await run(file, only, planOrder ? "plan" : "outside first");
  } else if (command === "report" && file !== undefined) await report(file);
  else {
    console.error(
      "usage: corpus.ts run|report <results.jsonl> [module text] [--plan-order]",
    );
    Deno.exit(2);
  }
}
