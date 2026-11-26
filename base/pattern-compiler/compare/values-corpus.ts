/**
 * Runs the value comparison over the corpus: every module the crate emits
 * a plan for with no unsupported construct, each with the generated
 * scenario of `corpus.ts`, on today's runtime and on the executor of
 * `../exec/`.
 *
 * Run from the repository root, after `cargo build --release` in
 * `base/pattern-compiler`:
 *
 * `deno run -A --no-check base/pattern-compiler/compare/values-corpus.ts run <results.jsonl>`
 * `deno run -A --no-check base/pattern-compiler/compare/values-corpus.ts report <results.jsonl>`
 *
 * `run` appends one line per module to the results file and leaves out a
 * module the file already has, as `corpus.ts` does. With a third argument,
 * it runs the modules whose path contains it. Each line holds what today's
 * runtime computed, so that
 *
 * `deno run -A --no-check base/pattern-compiler/compare/values-corpus.ts again <results.jsonl> <new.jsonl>`
 *
 * runs the executor alone on the crate's current output and compares it
 * with the values the earlier run read. A line that `stubbed` wrote holds
 * the clock of its stubs, and `again` runs it with the same stubs.
 *
 * `run` leaves out the modules that need `wish` or request an effect.
 * `stubbed <results.jsonl>` runs those, with the answers of `stubs.ts` in
 * place of the network on both sides, and `alone <results.jsonl>` runs
 * them on the executor with no run of today's runtime beside it, so it
 * compares no value. `report` reads the file of either.
 */
import type { Artifact } from "../exec/executor.ts";
import {
  artifactsOf,
  type CorpusModule,
  corpusModules,
  eventOrder,
  mainPattern,
  NEEDS,
  runModule,
} from "./corpus.ts";
import { generateEvent, generateInputs } from "./generate.ts";
import { scenarioAudience } from "./harness.ts";
import type { EventOutcome } from "./harness.ts";
import { stubCompletion, stubFetch } from "./stubs.ts";
import {
  argumentOf,
  compareValues,
  ExecutorRun,
  inFileForm,
  outOfFileForm,
  readingValues,
  type Stubs,
  type ValueComparison,
  type Values,
} from "./values.ts";

type EmittedModule = Omit<CorpusModule, "patterns"> & {
  patterns: (CorpusModule["patterns"][number] & Artifact)[];
};

/** The plans and the value code of the accepted corpus modules. */
const corpusArtifacts = (): Promise<EmittedModule[]> =>
  corpusModules() as Promise<EmittedModule[]>;

/** The value comparison of one module, as the results file holds it. */
export type ModuleValues = {
  module: string;
  pattern?: string;
  /** Why today's runtime did not run the module, where it did not. */
  skipped?: string;
  /** The module was run on the executor alone, with stubbed answers. */
  alone?: true;
  comparison?: ValueComparison;
  /** The events today's runtime committed, of those sent. */
  events?: { sent: number; committed: number };
  /** What today's runtime was given and what it computed. */
  runtime?: {
    argument: Record<string, unknown>;
    events: { binding: number; event: unknown }[];
    outcomes: Pick<EventOutcome, "outcome" | "elements">[];
    values: Values;
    /**
     * What the clock of the stubs held, where the run was answered from
     * the table of `stubs.ts` in place of the network.
     */
    stubs?: { now: number };
  };
};

/** The stubs of a run: the table of `stubs.ts`, and the clock at `now`. */
const stubsAt = (now: number): Stubs => ({ completion: stubCompletion, now });

/** The stubs of a run that begins now. */
const stubsNow = (): Stubs => stubsAt(Date.now());

/** Whether the main pattern of a module needs `wish` or an effect. */
const needsStubs = async (module: EmittedModule): Promise<boolean> =>
  ((await mainPattern(module))?.pattern.plan.operations ?? []).some((
    operation,
  ) => NEEDS[operation.kind ?? ""] !== undefined);

/**
 * Runs one module on the executor with stubbed answers and no run of
 * today's runtime: each event is sent where the executor's result holds
 * its stream, at the last element of each enclosing collection.
 */
const runAlone = async (
  module: EmittedModule,
  artifacts: (id: string) => Artifact | undefined,
): Promise<ModuleValues> => {
  const chosen = await mainPattern(module);
  if (chosen === undefined) {
    return { module: module.module, skipped: "exports no pattern" };
  }
  const artifact = chosen.pattern;
  const { plan, schemas } = artifact;
  const inputs = generateInputs(plan, schemas, await scenarioAudience());
  const argument = argumentOf({ argument: {}, inputs });
  const executor = new ExecutorRun(artifact, argument, artifacts, stubsNow());
  executor.start(undefined);
  const events = eventOrder(plan, "outside first").map((binding) => ({
    binding,
    event: generateEvent(plan, schemas, binding),
  }));
  const outcomes = events.map(({ binding, event }, index) => {
    const [held] = executor.held(binding);
    if (held === undefined) {
      return {
        outcome: "not sent" as const,
        reason: "a binding whose stream the executor's result does not hold",
      };
    }
    executor.committed(index, binding, event, held.elements);
    return { outcome: "committed" as const };
  });
  return {
    module: module.module,
    pattern: artifact.name,
    alone: true,
    comparison: executor.compare(events, outcomes, { events: [] }),
    events: {
      sent: outcomes.filter(({ outcome }) => outcome === "committed").length,
      committed: outcomes.filter(({ outcome }) => outcome === "committed")
        .length,
    },
  };
};

const runOne = async (
  module: EmittedModule,
  artifacts: (id: string) => Artifact | undefined,
  stubbed = false,
): Promise<ModuleValues> => {
  const chosen = await mainPattern(module);
  if (chosen === undefined) {
    return { module: module.module, skipped: "exports no pattern" };
  }
  const artifact = chosen.pattern;
  const { plan, schemas } = artifact;
  const { probe, values } = readingValues(plan);
  const inputs = generateInputs(plan, schemas, await scenarioAudience());
  const argument = argumentOf({ argument: {}, inputs });
  // The executor runs beside today's run, which finds each stream by
  // where the executor stored it (ruling Z43).
  const stubs = stubbed ? stubsNow() : undefined;
  const executor = new ExecutorRun(artifact, argument, artifacts, stubs);
  const restoreFetch = stubbed ? stubFetch() : undefined;
  let result: Awaited<ReturnType<typeof runModule>>;
  try {
    result = await runModule(
      module,
      "outside first",
      probe,
      executor,
      undefined,
      stubbed,
    );
  } finally {
    restoreFetch?.();
  }
  if (result.skipped !== undefined) {
    return {
      module: module.module,
      pattern: artifact.name,
      skipped: result.skipped,
    };
  }
  const events = eventOrder(plan, "outside first").map((binding) => ({
    binding,
    event: generateEvent(plan, schemas, binding),
  }));
  const outcomes = (result.outcomes ?? []).map((
    { outcome, elements, reason },
  ) => ({
    outcome,
    ...(elements === undefined ? {} : { elements }),
    ...(outcome === "not sent" && reason !== undefined ? { reason } : {}),
  }));
  return {
    module: module.module,
    pattern: artifact.name,
    comparison: executor.compare(events, outcomes, values),
    events: {
      sent: outcomes.filter(({ outcome }) => outcome !== "not sent").length,
      committed: outcomes.filter(({ outcome }) => outcome === "committed")
        .length,
    },
    // The values are written so that `again` reads what this run
    // compared.
    runtime: {
      argument,
      events,
      outcomes,
      values: inFileForm(values) as Values,
      ...(stubs === undefined ? {} : { stubs: { now: stubs.now } }),
    },
  };
};

/**
 * The line of an earlier run with the comparison of `artifact`, run on
 * the executor now, with the values that the earlier run read from
 * today's runtime. A line of a run with stubs is run with the same
 * table and with the clock that the line holds, so a request that was
 * answered in the earlier run is answered here.
 */
export const replayed = (
  earlier: ModuleValues & { runtime: NonNullable<ModuleValues["runtime"]> },
  artifact: Artifact,
  artifacts?: (id: string) => Artifact | undefined,
): ModuleValues => {
  const { argument, events, outcomes, stubs } = earlier.runtime;
  const values = outOfFileForm(earlier.runtime.values) as Values;
  return {
    ...earlier,
    comparison: compareValues(
      artifact,
      argument,
      events,
      outcomes,
      values,
      artifacts,
      stubs === undefined ? undefined : stubsAt(stubs.now),
    ),
  };
};

/**
 * Compares the crate's current output for each module of an earlier run
 * with the values that run read from today's runtime.
 */
const again = async (file: string, to: string) => {
  const modules = new Map(
    (await corpusArtifacts()).map((module) => [module.module, module]),
  );
  const artifacts = artifactsOf(modules.values());
  const lines: string[] = [];
  for (const earlier of await readResults(file)) {
    const module = modules.get(earlier.module);
    const artifact = module?.patterns.find((pattern) =>
      pattern.name === earlier.pattern
    );
    const { runtime } = earlier;
    lines.push(JSON.stringify(
      runtime === undefined || artifact === undefined
        ? earlier
        : replayed({ ...earlier, runtime }, artifact, artifacts),
    ));
  }
  await Deno.writeTextFile(to, lines.map((line) => `${line}\n`).join(""));
};

const readResults = async (file: string): Promise<ModuleValues[]> => {
  let text = "";
  try {
    text = await Deno.readTextFile(file);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const finished: ModuleValues[] = [];
  let started: string | undefined;
  for (const line of text.split("\n").filter((line) => line.length > 0)) {
    const entry = JSON.parse(line) as ModuleValues & { started?: string };
    if (entry.started !== undefined) {
      started = entry.started;
      continue;
    }
    started = undefined;
    finished.push(entry);
  }
  if (started !== undefined) {
    finished.push({ module: started, skipped: "the run ended the process" });
  }
  return finished;
};

const run = async (
  file: string,
  only: string | undefined,
  mode: "all" | "stubbed" | "alone" = "all",
) => {
  const emitted = await corpusArtifacts();
  const artifacts = artifactsOf(emitted);
  const accepted = emitted.filter((module) =>
    module.patterns.length > 0 &&
    module.patterns.every((pattern) => pattern.unsupported.length === 0) &&
    (only === undefined || module.module.includes(only))
  );
  const modules: EmittedModule[] = [];
  for (const module of accepted) {
    if (mode === "all" || await needsStubs(module)) modules.push(module);
  }
  const earlier = await readResults(file);
  const done = new Set(earlier.map((result) => result.module));
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
    const result = mode === "alone"
      ? await runAlone(module, artifacts)
      : await runOne(module, artifacts, mode === "stubbed");
    await Deno.writeTextFile(file, `${JSON.stringify(result)}\n`, {
      append: true,
    });
  }
};

const count = <T>(items: T[], key: (item: T) => string) => {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
};

const report = async (file: string, verbose: boolean) => {
  const results = await readResults(file);
  const ran = results.filter((result) => result.comparison !== undefined);
  const executed = ran.filter((result) =>
    result.comparison?.notExecuted === undefined
  );
  const alone = results.some((result) => result.alone);
  console.log(`modules: ${results.length}`);
  console.log(
    alone
      ? `  run on the executor alone, with no value compared: ${ran.length}`
      : `  run by today's runtime: ${ran.length}`,
  );
  for (
    const [reason, times] of count(
      results.filter((result) => result.skipped !== undefined),
      (result) => (result.skipped ?? "").replace(/:.*/s, ""),
    )
  ) {
    console.log(`  not run by today's runtime, ${reason}: ${times}`);
  }
  console.log(`  executed: ${executed.length}`);
  console.log(`  not executed: ${ran.length - executed.length}`);
  for (
    const [category, times] of count(
      ran.filter((result) => result.comparison?.notExecuted !== undefined),
      (result) => result.comparison?.notExecuted?.category ?? "",
    )
  ) {
    console.log(`    ${category}: ${times}`);
    if (!verbose) continue;
    for (const result of ran) {
      if (result.comparison?.notExecuted?.category !== category) continue;
      console.log(
        `      ${result.module}: ${result.comparison.notExecuted.detail}`,
      );
    }
  }
  const whole = executed.filter((result) =>
    result.comparison?.differences.length === 0 &&
    result.comparison.failedEvents.length === 0
  );
  console.log(
    `  executed with every value equal and every event handled: ${whole.length}`,
  );
  const compared = executed.reduce(
    (sum, result) => sum + (result.comparison?.compared ?? 0),
    0,
  );
  const equal = executed.reduce(
    (sum, result) => sum + (result.comparison?.equal ?? 0),
    0,
  );
  console.log(`values compared: ${compared}`);
  console.log(`  equal: ${equal}`);
  console.log(`  different: ${compared - equal}`);
  const differences = executed.flatMap((result) =>
    (result.comparison?.differences ?? []).map((difference) => ({
      module: result.module,
      ...difference,
    }))
  );
  console.log(
    `  modules with a difference: ${
      new Set(differences.map(({ module }) => module)).size
    }`,
  );
  if (verbose) {
    for (const difference of differences) {
      console.log(
        `    ${difference.module} ${difference.point} ${difference.value} ` +
          `/${difference.path}: runtime ${difference.runtime}, ` +
          `executor ${difference.executor}`,
      );
    }
  }
  const failed = executed.flatMap((result) =>
    (result.comparison?.failedEvents ?? []).map((event) => ({
      module: result.module,
      event,
    }))
  );
  const sent = executed.reduce(
    (sum, result) => sum + (result.events?.committed ?? 0),
    0,
  );
  console.log(`events today's runtime committed, of executed modules: ${sent}`);
  console.log(`  not handled by the executor: ${failed.length}`);
  for (
    const [reason, times] of count(
      failed,
      ({ event }) =>
        event.replace(/^[^:]*: /, "").replace(/`[^`]*`/g, "`…`").slice(0, 70),
    )
  ) {
    console.log(`    ${reason}: ${times}`);
  }
  if (verbose) {
    for (const { module, event } of failed) {
      console.log(`    ${module}: ${event}`);
    }
  }
  const total = (name: keyof NonNullable<ValueComparison["counts"]>) =>
    executed.reduce(
      (sum, result) => sum + (result.comparison?.counts?.[name] ?? 0),
      0,
    );
  console.log("what the executor counted, over the executed modules:");
  for (
    const name of [
      "evaluations",
      "elementEvaluations",
      "assemblies",
      "slotsNotListed",
      "readsWithoutSlot",
      "outputsWithoutEdge",
      "writesCovered",
      "writesNotCovered",
      "pendingOperations",
      "staleByOwnWrite",
      "failures",
    ] as const
  ) {
    console.log(`  ${name}: ${total(name)}`);
  }
  const written = new Map<
    string,
    { transactions: number; documents: number; bytes: number }
  >();
  for (const result of executed) {
    for (
      const [cause, sum] of Object.entries(result.comparison?.written ?? {})
    ) {
      const total = written.get(cause) ??
        { transactions: 0, documents: 0, bytes: 0 };
      total.transactions += sum.transactions;
      total.documents += sum.documents;
      total.bytes += sum.bytes;
      written.set(cause, total);
    }
  }
  console.log("what the executor's transactions wrote, by cause:");
  for (const [cause, { transactions, documents, bytes }] of written) {
    console.log(
      `  ${cause}: ${transactions} transactions, ${documents} documents, ` +
        `${bytes} bytes`,
    );
  }
  if (verbose) {
    const largest = executed.map((result) => ({
      module: result.module,
      bytes: Object.values(result.comparison?.written ?? {}).reduce(
        (sum, { bytes }) => sum + bytes,
        0,
      ),
      transactions: Object.values(result.comparison?.written ?? {}).reduce(
        (sum, { transactions }) => sum + transactions,
        0,
      ),
    })).sort((a, b) => b.bytes - a.bytes).slice(0, 10);
    console.log("  the modules whose transactions wrote the most bytes:");
    for (const { module, bytes, transactions } of largest) {
      console.log(`    ${module}: ${bytes} bytes in ${transactions}`);
    }
  }
  const failures = executed.flatMap((result) =>
    (result.comparison?.failures ?? []).map((failure) => ({
      module: result.module,
      failure,
    }))
  );
  console.log(
    `cones that took an error state, each once per module: ${failures.length}`,
  );
  if (verbose) {
    for (const { module, failure } of failures) {
      console.log(`    ${module}: ${failure}`);
    }
  }
  const requests = new Map<string, number>();
  for (const result of executed) {
    for (
      const [builtin, times] of Object.entries(
        result.comparison?.requests ?? {},
      )
    ) {
      requests.set(builtin, (requests.get(builtin) ?? 0) + times);
    }
  }
  if (executed.some((result) => result.comparison?.requests !== undefined)) {
    console.log("requests the executor made and the stubs answered:");
    for (const [builtin, times] of requests) {
      console.log(`  ${builtin}: ${times}`);
    }
    console.log(
      `  with no completion at the end: ${
        executed.reduce(
          (sum, result) => sum + (result.comparison?.outstanding ?? 0),
          0,
        )
      }`,
    );
  }
  console.log(
    `positions of the stored results that hold the link to a stream: ${
      executed.reduce(
        (sum, result) => sum + (result.comparison?.storedStreams ?? 0),
        0,
      )
    }`,
  );
  const documents = new Map<string, number>();
  for (const result of executed) {
    for (
      const [kind, times] of Object.entries(result.comparison?.documents ?? {})
    ) {
      documents.set(kind, (documents.get(kind) ?? 0) + times);
    }
  }
  console.log("documents the executor stored, over the executed modules:");
  for (const [kind, times] of documents) console.log(`  ${kind}: ${times}`);
  const mine = [...documents.values()].reduce((sum, times) => sum + times, 0);
  const theirs = executed.reduce(
    (sum, result) => sum + (result.comparison?.runtimeDocuments ?? 0),
    0,
  );
  console.log(`  in all: ${mine}`);
  console.log(
    `documents today's runtime stored for the same modules, the cells of ` +
      `the scenario's inputs included: ${theirs}`,
  );
  if (verbose) {
    for (const result of executed) {
      const own = Object.values(result.comparison?.documents ?? {}).reduce(
        (sum, times) => sum + times,
        0,
      );
      console.log(
        `    ${result.module}: executor ${own}, runtime ${
          result.comparison?.runtimeDocuments ?? "?"
        }`,
      );
    }
  }
};

if (import.meta.main) {
  const [command, file, option] = Deno.args;
  if (command === "run" && file !== undefined) {
    await run(file, option);
  } else if (
    (command === "stubbed" || command === "alone") && file !== undefined
  ) {
    await run(file, option, command);
  } else if (
    command === "again" && file !== undefined && option !== undefined
  ) {
    await again(file, option);
  } else if (command === "report" && file !== undefined) {
    await report(file, option === "--verbose");
  } else {
    console.error(
      "usage: values-corpus.ts run|stubbed|alone <results.jsonl> [text] | " +
        "again <results.jsonl> <new.jsonl> | report <results.jsonl> [--verbose]",
    );
    Deno.exit(2);
  }
  Deno.exit(0);
}
