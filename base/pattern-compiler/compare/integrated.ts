/**
 * Measures what the runtime's storage transactions cost the executor of
 * `../exec/` (milestone 1 of
 * `docs/plans/compiled-pattern-language-integration.md`), on the scenario
 * of each module that a run of today's runtime recorded.
 *
 * Each module is run three ways, on the argument and the committed events
 * of that run:
 *
 * - `memory`: the executor alone, with its documents in memory, as the
 *   table of run times measures it (`values-corpus.ts again`).
 * - `plain`: the executor with its documents in the runtime's storage
 *   (`RuntimeTransactions`), one transaction of the runtime for each of
 *   the executor's, with the argument held in place.
 * - `labeled`: the same, with each input a cell of its own whose schema
 *   declares a clause, as today's harness writes an input, and the
 *   argument a link to each. A transaction that reads one is relevant to
 *   Contextual Flow Control, and its commit runs the preparation.
 *
 * The storage is the runtime's emulated storage, as in every run of today's
 * runtime this comparison makes. A figure of `plain` and `labeled` is from
 * the start of the executor's work to the settlement of every commit it
 * made. Today's figures are those of `cost.ts run` on the same scenario.
 *
 * ```sh
 * deno run -A --no-check base/pattern-compiler/compare/values-corpus.ts run values.jsonl
 * deno run -A --no-check base/pattern-compiler/compare/integrated.ts run values.jsonl integrated.jsonl
 * deno run -A --no-check base/pattern-compiler/compare/cost.ts run run.jsonl
 * deno run -A --no-check base/pattern-compiler/compare/integrated.ts report integrated.jsonl run.jsonl
 * ```
 *
 * Each command takes `--only=<text>`, which keeps the modules whose path
 * holds the text.
 */
import { Identity } from "@commonfabric/identity";

import {
  getTimingStatsBreakdown,
  resetAllTimingStats,
} from "../../logger/src/logger.ts";
import type { JSONSchema } from "../../../runtime/runner/src/builder/types.ts";
import { Runtime } from "../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../runtime/runner/src/storage/cache.deno.ts";
import { type Artifact, Instance } from "../exec/executor.ts";
import { identifierOf, isLink, nameText } from "../exec/store.ts";
import { artifactsOf, corpusModules, mainPattern } from "./corpus.ts";
import { generateInputs } from "./generate.ts";
import { scenarioAudience } from "./harness.ts";
import { drawing, eventSeed, restoreRandom, seedRandom } from "./random.ts";
import { RuntimeTransactions } from "./runtime-transactions.ts";
import { compareValues, outOfFileForm, type Values } from "./values.ts";

/** The timing counters of the runtime a figure counts, by their key. */
const COUNTED = {
  commits: "storage.v2.transaction/commit/commitNative",
  preparations: "extended-storage-transaction/prepareCfc",
} as const;

type Counted = Record<keyof typeof COUNTED, number>;

/** One figure: the wall time, and what the runtime counted in it. */
type Figure = Counted & {
  /** Milliseconds from the start of the work to its last commit. */
  local: number;
  /** Milliseconds from the start of the work to every commit settled. */
  settled: number;
  /** Positions read through a transaction of the runtime. */
  reads: number;
  /** Writes staged in a transaction of the runtime. */
  writes: number;
  /** Commits the storage refused, each with its reason. */
  refused: string[];
};

/** A run of a module one way. */
type Arm = { settle: Figure; events: Figure[] };

/** The results of one module, as the results file holds them. */
type ModuleTimes = {
  module: string;
  pattern?: string;
  skipped?: string;
  /** The executor in memory: milliseconds to settle and per event. */
  memory?: { settle: number; events: number[] };
  plain?: Arm;
  labeled?: Arm;
  /**
   * Whether each run with the runtime's storage computed the values of the
   * run in memory, after it settled and after each event, and whether the
   * storage holds the executor's documents at the end.
   */
  agrees?: { plain: string[]; labeled: string[] };
  /** The values compared with today's run, and how many are equal. */
  today?: { compared: number; equal: number };
};

const counted = (): Counted => {
  const breakdown = getTimingStatsBreakdown();
  const count = (key: string) => {
    const [logger, ...rest] = key.split("/");
    return breakdown[logger]?.[rest.join("/")]?.count ?? 0;
  };
  return {
    commits: count(COUNTED.commits),
    preparations: count(COUNTED.preparations),
  };
};

/** What an instance shows of its values: the result and its state cells. */
const snapshot = (instance: Instance): string =>
  JSON.stringify({
    result: instance.result(),
    state: Object.fromEntries(
      instance.stateCells().filter(({ keys }) => keys.length === 0).map((
        { name, value },
      ) => [nameText(name), value]),
    ),
  });

/** A value with the schema of each link left out. */
const withoutSchemas = (value: unknown): unknown => {
  if (isLink(value)) {
    return { $link: { doc: value.$link.doc, path: value.$link.path } };
  }
  if (Array.isArray(value)) return value.map(withoutSchemas);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([name, member]) => [
        name,
        withoutSchemas(member),
      ]),
    );
  }
  return value;
};

const signer = () => Identity.fromPassphrase("pattern-compiler-compare");

/** The committed events of a run, each with the elements it was sent at. */
type Sent = { index: number; binding: number; event: unknown; at: number[] };

const committedEvents = (
  runtime: NonNullable<RecordedModule["runtime"]>,
): Sent[] =>
  runtime.events.flatMap(({ binding, event }, index) => {
    const outcome = runtime.outcomes[index];
    if (outcome?.outcome !== "committed") return [];
    return [{
      index,
      binding,
      event,
      at: (outcome.elements ?? []).map(({ key }) => Number(key)),
    }];
  });

/** A module of a results file of `values-corpus.ts run`. */
type RecordedModule = {
  module: string;
  pattern?: string;
  runtime?: {
    argument: Record<string, unknown>;
    events: { binding: number; event: unknown }[];
    outcomes: {
      outcome: string;
      elements?: { key: string | number }[];
    }[];
    values: unknown;
  };
};

/** The options every run of an instance of a module takes. */
const instanceOptions = (
  module: string,
  space: string,
  artifacts: (id: string) => Artifact | undefined,
) => ({
  space,
  id: identifierOf({ integrated: module }),
  secret: "the secret of the comparison",
  artifacts,
  measure: "patches" as const,
});

/** Runs a module in memory. */
const inMemory = (
  artifact: Artifact,
  argument: Record<string, unknown>,
  events: Sent[],
  options: ReturnType<typeof instanceOptions>,
) => {
  const began = performance.now();
  const instance = new Instance(artifact, argument, options);
  const settle = performance.now() - began;
  const snapshots = [snapshot(instance)];
  const times: number[] = [];
  for (const { index, binding, event, at } of events) {
    seedRandom(eventSeed(index));
    try {
      const started = performance.now();
      drawing(() => instance.send(binding, event, at));
      times.push(performance.now() - started);
    } finally {
      restoreRandom();
    }
    snapshots.push(snapshot(instance));
  }
  return { times: { settle, events: times }, snapshots };
};

/**
 * Runs a module with its documents in the runtime's storage, and returns
 * the figures and what differs from the run in memory.
 */
const inStorage = async (
  artifact: Artifact,
  argument: Record<string, unknown>,
  events: Sent[],
  options: ReturnType<typeof instanceOptions>,
  memory: string[],
  labeled: boolean,
): Promise<{ arm: Arm; differs: string[] }> => {
  const identity = await signer();
  const space = identity.did();
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcFlowLabels: "persist",
  });
  const differs: string[] = [];
  try {
    // The inputs as cells of their own, each under a schema with a clause.
    let given = argument;
    const documents: { id: string; kind: string; value: unknown }[] = [];
    if (labeled) {
      const inputs = generateInputs(
        artifact.plan as Parameters<typeof generateInputs>[0],
        artifact.schemas as Parameters<typeof generateInputs>[1],
        await scenarioAudience(),
      );
      const tx = runtime.edit();
      given = { ...argument };
      for (const [name, input] of Object.entries(inputs)) {
        if (!(name in argument)) continue;
        const cell = runtime.getCell(
          space,
          { compareInput: name },
          input.schema as JSONSchema,
          tx,
        );
        cell.set(argument[name] as never);
        const id = cell.getAsNormalizedFullLink().id;
        documents.push({ id, kind: "input", value: argument[name] });
        given[name] = { $link: { doc: id, path: [] } };
      }
      const { error } = await tx.commit().settled;
      if (error !== undefined) throw error;
    }
    const hooks = new RuntimeTransactions(runtime, space);
    const measure = async (work: () => void): Promise<Figure> => {
      const before = hooks.counts;
      const began = performance.now();
      work();
      const local = performance.now() - began;
      const refused = await hooks.settled();
      const settled = performance.now() - began;
      const after = hooks.counts;
      return {
        local,
        settled,
        ...counted(),
        reads: after.reads - before.reads,
        writes: after.writes - before.writes,
        refused,
      };
    };
    resetAllTimingStats();
    let instance: Instance | undefined;
    const settle = await measure(() => {
      instance = new Instance(artifact, given, {
        ...options,
        transactions: hooks,
        documents,
      });
    });
    if (instance === undefined) throw new Error("no instance");
    const compare = (point: string, expected: string | undefined) => {
      if (snapshot(instance!) !== expected) differs.push(`values ${point}`);
    };
    compare("settled", memory[0]);
    const figures: Figure[] = [];
    for (const [position, { index, binding, event, at }] of events.entries()) {
      seedRandom(eventSeed(index));
      try {
        figures.push(
          await measure(() =>
            drawing(() => instance!.send(binding, event, at))
          ),
        );
      } finally {
        restoreRandom();
      }
      compare(`after event ${index}`, memory[position + 1]);
    }
    const stored = hooks.stored();
    for (const [doc, held] of instance.store.docs) {
      if (documents.some(({ id }) => id === doc)) continue;
      if (
        JSON.stringify(withoutSchemas(stored.get(doc))) !==
          JSON.stringify(withoutSchemas(held.value))
      ) {
        differs.push(`stored ${held.kind}`);
      }
    }
    return { arm: { settle, events: figures }, differs };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

const lines = async (file: string): Promise<Record<string, unknown>[]> => {
  try {
    return (await Deno.readTextFile(file)).split("\n").filter((line) =>
      line.startsWith("{")
    ).map((line) => JSON.parse(line));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
};

const run = async (from: string, to: string, only: string | undefined) => {
  const recorded = (await lines(from)) as RecordedModule[];
  const finished = new Set(
    (await lines(to)).map((line) => line.module as string),
  );
  const emitted = await corpusModules();
  const byModule = new Map(emitted.map((module) => [module.module, module]));
  const artifacts = artifactsOf(emitted);
  const space = (await signer()).did();
  for (const earlier of recorded) {
    if (finished.has(earlier.module)) continue;
    if (only !== undefined && !earlier.module.includes(only)) continue;
    if (earlier.runtime === undefined) continue;
    const module = byModule.get(earlier.module);
    const chosen = module === undefined ? undefined : await mainPattern(module);
    const artifact = chosen?.pattern as Artifact | undefined;
    const result: ModuleTimes = {
      module: earlier.module,
      pattern: earlier.pattern,
    };
    if (artifact === undefined || artifact.code.unsupported.length > 0) {
      result.skipped = "no value code";
    } else {
      console.error(earlier.module);
      const events = committedEvents(earlier.runtime);
      const options = instanceOptions(earlier.module, space, artifacts);
      const { argument } = earlier.runtime;
      try {
        const memory = inMemory(artifact, argument, events, options);
        result.memory = memory.times;
        const plain = await inStorage(
          artifact,
          argument,
          events,
          options,
          memory.snapshots,
          false,
        );
        const labeled = await inStorage(
          artifact,
          argument,
          events,
          options,
          memory.snapshots,
          true,
        );
        result.plain = plain.arm;
        result.labeled = labeled.arm;
        result.agrees = { plain: plain.differs, labeled: labeled.differs };
        const comparison = compareValues(
          artifact,
          argument,
          earlier.runtime.events,
          earlier.runtime.outcomes as Parameters<typeof compareValues>[3],
          outOfFileForm(earlier.runtime.values) as Values,
          artifacts,
        );
        result.today = {
          compared: comparison.compared,
          equal: comparison.equal,
        };
      } catch (error) {
        result.skipped = `${(error as Error)?.message ?? error}`.split("\n")[0];
      }
    }
    await Deno.writeTextFile(to, `${JSON.stringify(result)}\n`, {
      append: true,
    });
  }
};

const sum = (values: number[]) =>
  values.reduce((total, value) => total + value, 0);

const round = (value: number): string =>
  value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value
    .toFixed(2);

/** Prints the totals over the modules with every figure, and each module. */
const report = async (file: string, todayFile: string, only?: string) => {
  const today = new Map(
    (await lines(todayFile)).map((line) => [line.module as string, line]),
  );
  type Today = {
    settle?: {
      milliseconds: number;
      transactions: number;
      preparations: number;
    };
    events?: {
      milliseconds: number;
      transactions: number;
      preparations: number;
      outcome?: string;
    }[];
  };
  const rows = ((await lines(file)) as ModuleTimes[]).filter((row) =>
    row.plain !== undefined && row.labeled !== undefined &&
    (only === undefined || row.module.includes(only))
  );
  const header = [
    "Module",
    "Settle: memory",
    "plain",
    "labeled",
    "today",
    "Event: memory",
    "plain",
    "labeled",
    "today",
    "Commits per event: labeled / today",
    "Preparations per event: labeled / today",
  ];
  console.log(`| ${header.join(" | ")} |`);
  console.log(`| ${header.map(() => "---").join(" | ")} |`);
  const totals = {
    memory: [0, 0],
    plain: [0, 0],
    labeled: [0, 0],
    today: [0, 0],
    events: 0,
    modules: 0,
    commits: [0, 0],
    preparations: [0, 0],
    settleCommits: [0, 0],
    settlePreparations: [0, 0],
    disagree: [] as string[],
    refused: 0,
  };
  for (const row of rows) {
    const theirs = today.get(row.module)?.measured as Today | undefined;
    const todayEvents = (theirs?.events ?? []).filter(({ outcome }) =>
      outcome === "committed"
    );
    if (theirs?.settle === undefined) continue;
    const memoryEvents = row.memory!.events;
    const plainEvents = row.plain!.events.map(({ settled }) => settled);
    const labeledEvents = row.labeled!.events.map(({ settled }) => settled);
    const todayTimes = todayEvents.map(({ milliseconds }) => milliseconds);
    const mean = (values: number[]) =>
      values.length === 0 ? "" : round(sum(values) / values.length);
    const labeledCommits = sum(
      row.labeled!.events.map(({ commits }) => commits),
    );
    const labeledPreparations = sum(
      row.labeled!.events.map(({ preparations }) => preparations),
    );
    const todayCommits = sum(
      todayEvents.map(({ transactions }) => transactions),
    );
    const todayPreparations = sum(
      todayEvents.map(({ preparations }) => preparations),
    );
    console.log(
      `| \`${row.module}\` | ${round(row.memory!.settle)} | ${
        round(row.plain!.settle.settled)
      } | ${round(row.labeled!.settle.settled)} | ${
        round(theirs.settle.milliseconds)
      } | ${mean(memoryEvents)} | ${mean(plainEvents)} | ${
        mean(labeledEvents)
      } | ${mean(todayTimes)} | ${
        row.labeled!.events.length === 0
          ? ""
          : `${labeledCommits} / ${todayCommits}`
      } | ${
        row.labeled!.events.length === 0
          ? ""
          : `${labeledPreparations} / ${todayPreparations}`
      } |`,
    );
    totals.modules += 1;
    totals.memory[0] += row.memory!.settle;
    totals.plain[0] += row.plain!.settle.settled;
    totals.labeled[0] += row.labeled!.settle.settled;
    totals.today[0] += theirs.settle.milliseconds;
    totals.settleCommits[0] += row.labeled!.settle.commits;
    totals.settleCommits[1] += theirs.settle.transactions;
    totals.settlePreparations[0] += row.labeled!.settle.preparations;
    totals.settlePreparations[1] += theirs.settle.preparations;
    // Per event only where both sides handled the same number of events.
    if (todayEvents.length === row.labeled!.events.length) {
      totals.events += todayEvents.length;
      totals.memory[1] += sum(memoryEvents);
      totals.plain[1] += sum(plainEvents);
      totals.labeled[1] += sum(labeledEvents);
      totals.today[1] += sum(todayTimes);
      totals.commits[0] += labeledCommits;
      totals.commits[1] += todayCommits;
      totals.preparations[0] += labeledPreparations;
      totals.preparations[1] += todayPreparations;
    }
    const disagree = [...row.agrees!.plain, ...row.agrees!.labeled];
    if (disagree.length > 0) {
      totals.disagree.push(`${row.module}: ${disagree.join(", ")}`);
    }
    totals.refused += [row.labeled!.settle, ...row.labeled!.events].reduce(
      (count, figure) => count + figure.refused.length,
      0,
    );
  }
  console.log();
  console.log(
    `Over ${totals.modules} modules, to the settled result: memory ${
      round(totals.memory[0])
    } ms, plain ${round(totals.plain[0])} ms, labeled ${
      round(totals.labeled[0])
    } ms, today ${round(totals.today[0])} ms; commits labeled ${
      totals.settleCommits[0]
    }, today ${totals.settleCommits[1]}; CFC preparations labeled ${
      totals.settlePreparations[0]
    }, today ${totals.settlePreparations[1]}.`,
  );
  console.log(
    `${totals.events} events: memory ${round(totals.memory[1])} ms, plain ${
      round(totals.plain[1])
    } ms, labeled ${round(totals.labeled[1])} ms, today ${
      round(totals.today[1])
    } ms; commits labeled ${totals.commits[0]}, today ${
      totals.commits[1]
    }; CFC preparations labeled ${totals.preparations[0]}, today ${
      totals.preparations[1]
    }.`,
  );
  console.log(
    `Commits the storage refused in the labeled runs: ${totals.refused}`,
  );
  console.log(
    `Modules where a run in storage differs from the run in memory: ${totals.disagree.length}`,
  );
  for (const line of totals.disagree) console.log(`- ${line}`);
};

if (import.meta.main) {
  const [command, ...rest] = Deno.args;
  const only = rest.find((argument) => argument.startsWith("--only="))
    ?.slice("--only=".length);
  const operands = rest.filter((argument) => !argument.startsWith("--"));
  if (command === "run" && operands.length === 2) {
    await run(operands[0], operands[1], only);
  } else if (command === "report" && operands.length === 2) {
    await report(operands[0], operands[1], only);
  } else {
    console.error(
      "usage: integrated.ts run <values.jsonl> <out.jsonl> | report <out.jsonl> <run.jsonl>, each with --only=<text>",
    );
    Deno.exit(2);
  }
  Deno.exit(0);
}
