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
 * with the values the earlier run read.
 */
import { fromFileUrl } from "@std/path";

import type { Artifact } from "../exec/executor.ts";
import {
  type CorpusModule,
  eventOrder,
  mainPattern,
  runModule,
} from "./corpus.ts";
import { generateEvent, generateInputs } from "./generate.ts";
import { scenarioAudience } from "./harness.ts";
import type { EventOutcome } from "./harness.ts";
import {
  compareValues,
  readingValues,
  type ValueComparison,
  type Values,
} from "./values.ts";

const repository = fromFileUrl(new URL("../../../", import.meta.url));

type EmittedModule = CorpusModule & {
  patterns: (CorpusModule["patterns"][number] & Artifact)[];
};

/** The plans and the value code of the accepted corpus modules. */
const corpusArtifacts = async (): Promise<EmittedModule[]> => {
  const { success, stdout, stderr } = await new Deno.Command(
    `${repository}base/pattern-compiler/target/release/pattern-compiler`,
    { args: ["emit", "--corpus", "."], cwd: `${repository}patterns` },
  ).output();
  if (!success) throw new Error(new TextDecoder().decode(stderr));
  return new TextDecoder().decode(stdout).split("\n").filter((line) =>
    line.length > 0
  ).map((line) => JSON.parse(line));
};

/** The value comparison of one module, as the results file holds it. */
export type ModuleValues = {
  module: string;
  pattern?: string;
  /** Why today's runtime did not run the module, where it did not. */
  skipped?: string;
  comparison?: ValueComparison;
  /** The events today's runtime committed, of those sent. */
  events?: { sent: number; committed: number };
  /** What today's runtime was given and what it computed. */
  runtime?: {
    argument: Record<string, unknown>;
    events: { binding: number; event: unknown }[];
    outcomes: Pick<EventOutcome, "outcome" | "elements">[];
    values: Values;
  };
};

const runOne = async (module: EmittedModule): Promise<ModuleValues> => {
  const chosen = await mainPattern(module);
  if (chosen === undefined) {
    return { module: module.module, skipped: "exports no pattern" };
  }
  const artifact = chosen.pattern;
  const { plan, schemas } = artifact;
  const { probe, values } = readingValues(plan);
  const result = await runModule(module, "outside first", probe);
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
  const inputs = generateInputs(plan, schemas, await scenarioAudience());
  const argument = Object.fromEntries(
    Object.entries(inputs).map(([name, input]) => [name, input.value]),
  );
  const outcomes = (result.outcomes ?? []).map(({ outcome, elements }) => ({
    outcome,
    ...(elements === undefined ? {} : { elements }),
  }));
  return {
    module: module.module,
    pattern: artifact.name,
    comparison: compareValues(artifact, argument, events, outcomes, values),
    events: {
      sent: outcomes.filter(({ outcome }) => outcome !== "not sent").length,
      committed: outcomes.filter(({ outcome }) => outcome === "committed")
        .length,
    },
    runtime: { argument, events, outcomes, values },
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
  const lines: string[] = [];
  for (const earlier of await readResults(file)) {
    const module = modules.get(earlier.module);
    const artifact = module?.patterns.find((pattern) =>
      pattern.name === earlier.pattern
    );
    if (earlier.runtime === undefined || artifact === undefined) {
      lines.push(JSON.stringify(earlier));
      continue;
    }
    const { argument, events, outcomes, values } = earlier.runtime;
    lines.push(JSON.stringify({
      ...earlier,
      comparison: compareValues(artifact, argument, events, outcomes, values),
    }));
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

const run = async (file: string, only: string | undefined) => {
  const modules = (await corpusArtifacts()).filter((module) =>
    module.patterns.length > 0 &&
    module.patterns.every((pattern) => pattern.unsupported.length === 0) &&
    (only === undefined || module.module.includes(only))
  );
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
    const result = await runOne(module);
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
  console.log(`modules: ${results.length}`);
  console.log(`  run by today's runtime: ${ran.length}`);
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
    ] as const
  ) {
    console.log(`  ${name}: ${total(name)}`);
  }
  console.log(
    "where the stored result holds a stream, against `Binding.result`:",
  );
  for (
    const name of [
      "atListedPath",
      "atNoListedPath",
      "listedPathsHeld",
      "listedPathsNotHeld",
    ] as const
  ) {
    console.log(
      `  ${name}: ${
        executed.reduce(
          (sum, result) => sum + (result.comparison?.streams?.[name] ?? 0),
          0,
        )
      }`,
    );
  }
  const failing = executed.filter((result) =>
    (result.comparison?.failedEvaluations ?? 0) > 0
  );
  console.log(
    "evaluations that stored a stream's marker at a position no listed " +
      `path covers: ${
        executed.reduce(
          (sum, result) => sum + (result.comparison?.failedEvaluations ?? 0),
          0,
        )
      }, in ${failing.length} modules`,
  );
  if (verbose) {
    for (const result of failing) {
      for (const { name, path } of result.comparison?.misplaced ?? []) {
        console.log(`    ${result.module}: ${name} at /${path.join("/")}`);
      }
    }
  }
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
    command === "again" && file !== undefined && option !== undefined
  ) {
    await again(file, option);
  } else if (command === "report" && file !== undefined) {
    await report(file, option === "--verbose");
  } else {
    console.error(
      "usage: values-corpus.ts run <results.jsonl> [text] | " +
        "again <results.jsonl> <new.jsonl> | report <results.jsonl> [--verbose]",
    );
    Deno.exit(2);
  }
  Deno.exit(0);
}
