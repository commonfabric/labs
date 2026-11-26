/**
 * Prints the tables of the cost comparison from the files `cost.ts` and
 * `pattern-compiler time` write:
 *
 * `deno run -A --no-check base/pattern-compiler/compare/cost-report.ts <directory>`
 *
 * The directory holds `crate-time.jsonl`, `compile.jsonl`,
 * `processes.jsonl`, `run.jsonl` and `scale.jsonl`. A table whose file is
 * absent is left out.
 */
import type { Kind, Stored } from "./cost.ts";

/** The median of `values`, and `NaN` for none. */
export const median = (values: number[]): number => quantile(values, 0.5);

/**
 * The value at fraction `q` of the sorted `values`, interpolated between
 * the two nearest, and `NaN` for none.
 */
export const quantile = (values: number[], q: number): number => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const above = Math.ceil(position);
  return sorted[below] + (sorted[above] - sorted[below]) * (position - below);
};

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** A number with at most three significant digits below 100. */
export const show = (value: number): string =>
  Number.isNaN(value)
    ? "n/a"
    : Math.abs(value) >= 100
    ? Math.round(value).toLocaleString("en-US")
    : `${Number(value.toPrecision(3))}`;

const row = (cells: (string | number)[]) =>
  `| ${
    cells.map((cell) => typeof cell === "number" ? show(cell) : cell).join(
      " | ",
    )
  } |`;

const table = (head: string[], rows: (string | number)[][]) =>
  [row(head), row(head.map(() => "---")), ...rows.map(row)].join("\n");

/** Total, median, the tenth and ninetieth percentile, the least and most. */
const spread = (name: string, values: number[]) => [
  name,
  sum(values),
  median(values),
  quantile(values, 0.1),
  quantile(values, 0.9),
  quantile(values, 0),
  quantile(values, 1),
];
const SPREAD = ["", "total", "median", "p10", "p90", "least", "most"];

const lines = async <T>(file: string): Promise<T[] | undefined> => {
  try {
    return (await Deno.readTextFile(file)).split("\n").filter((line) =>
      line !== ""
    ).map((line) => JSON.parse(line));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return undefined;
  }
};

/** The five entries with the largest and the five with the smallest ratio. */
const extremes = <T>(
  entries: T[],
  ratio: (entry: T) => number,
  cells: (entry: T) => (string | number)[],
  head: string[],
) => {
  const sorted = entries.filter((entry) => Number.isFinite(ratio(entry)))
    .sort((a, b) => ratio(b) - ratio(a));
  return [
    "Largest:",
    "",
    table(head, sorted.slice(0, 5).map(cells)),
    "",
    "Smallest:",
    "",
    table(head, sorted.slice(-5).map(cells)),
  ].join("\n");
};

type CrateTime = {
  module: string;
  files: number;
  sourceBytes: number;
  nanoseconds: number[];
  planBytes: number;
};
type Phases = Record<string, { count: number; milliseconds: number }>;
type TodayCompile = {
  module: string;
  failed?: string;
  runs?: {
    files: number;
    resolve: number;
    compile: number;
    again: number;
    phases: Phases;
  }[];
};
type Processes = {
  module: string;
  crate: number[];
  today: number;
  failed?: boolean;
};

const phase = (phases: Phases, key: string) => phases[key]?.milliseconds ?? 0;

/** The phases of one compile by today's pipeline, in milliseconds. */
export const phasesOf = (
  run: { resolve: number; compile: number; phases: Phases },
) => {
  const program = phase(run.phases, "js-compiler/phase/createProgram");
  const check = phase(run.phases, "js-compiler/phase/typeCheckFile") +
    phase(run.phases, "js-compiler/phase/declCheckFile");
  const emit = phase(run.phases, "js-compiler/phase/emitFile");
  // `pattern-manager/compile-cache/evaluate` times the same evaluation.
  const evaluate = phase(run.phases, "engine/evaluateRecordGraph");
  const cache = phase(run.phases, "pattern-manager/compile-cache/read") +
    phase(run.phases, "pattern-manager/compile-cache/writeback");
  return {
    resolve: run.resolve,
    program,
    check,
    emit,
    evaluate,
    cache,
    rest: run.compile - program - check - emit - evaluate - cache,
  };
};

const compileTables = async (directory: string) => {
  const crate = await lines<CrateTime>(`${directory}/crate-time.jsonl`);
  const today = await lines<TodayCompile>(`${directory}/compile.jsonl`);
  if (crate === undefined || today === undefined) return;
  const joined = crate.flatMap((entry) => {
    const other = today.find((candidate) => candidate.module === entry.module);
    if (other?.runs === undefined) return [];
    const whole = (run: { resolve: number; compile: number }) =>
      run.resolve + run.compile;
    return [{
      module: entry.module,
      files: entry.files,
      crate: median(entry.nanoseconds) / 1e6,
      crateSpread: (quantile(entry.nanoseconds, 0.9) -
        quantile(entry.nanoseconds, 0.1)) / median(entry.nanoseconds),
      first: whole(other.runs[0]),
      later: median(other.runs.slice(1).map(whole)),
      again: median(other.runs.map((run) => run.again)),
      phases: phasesOf(other.runs.at(-1)!),
    }];
  });
  console.log(`## Compile time, in one process (${joined.length} modules)\n`);
  console.log(
    `Today's pipeline failed on ${
      today.filter((entry) => entry.failed !== undefined).length
    } modules, which are left out. Milliseconds.\n`,
  );
  console.log(table(SPREAD, [
    spread("crate, median of 20", joined.map((entry) => entry.crate)),
    spread("today, first compile of the module", joined.map((e) => e.first)),
    spread("today, median of the two later", joined.map((e) => e.later)),
    spread("today, again in the same runtime", joined.map((e) => e.again)),
    ...([
      "resolve",
      "program",
      "check",
      "emit",
      "evaluate",
      "cache",
      "rest",
    ] as const)
      .map((name) =>
        spread(
          `today, last compile: ${name}`,
          joined.map((entry) => entry.phases[name]),
        )
      ),
  ]));
  const ratio = (entry: typeof joined[number]) => entry.later / entry.crate;
  const withoutCheck = (entry: typeof joined[number]) =>
    (entry.later - entry.phases.check - entry.phases.evaluate) / entry.crate;
  console.log(
    `\nRatio of today's later compiles to the crate, per module: median ${
      show(median(joined.map(ratio)))
    }, p10 ${show(quantile(joined.map(ratio), 0.1))}, p90 ${
      show(quantile(joined.map(ratio), 0.9))
    }; of the totals ${
      show(sum(joined.map((e) => e.later)) / sum(joined.map((e) => e.crate)))
    }. Without today's type check and evaluation: median ${
      show(median(joined.map(withoutCheck)))
    }, of the totals ${
      show(
        sum(
          joined.map((e) => e.later - e.phases.check - e.phases.evaluate),
        ) / sum(joined.map((e) => e.crate)),
      )
    }. The crate's spread within a module (p90 less p10, over the median): median ${
      show(median(joined.map((entry) => entry.crateSpread)))
    }.\n`,
  );
  console.log(
    extremes(joined, ratio, (entry) => [
      entry.module,
      entry.files,
      entry.crate,
      entry.later,
      ratio(entry),
    ], ["module", "files", "crate", "today", "ratio"]),
  );
  const processes = await lines<Processes>(`${directory}/processes.jsonl`);
  if (processes === undefined) return;
  const ran = processes.filter((entry) =>
    entry.failed !== true && entry.crate.every((time) => !Number.isNaN(time))
  );
  console.log(`\n## Compile time, one process per module (${ran.length})\n`);
  console.log(table(SPREAD, [
    spread("crate, median of 5", ran.map((entry) => median(entry.crate))),
    spread("today, one run", ran.map((entry) => entry.today)),
  ]));
  const perProcess = (entry: Processes) => entry.today / median(entry.crate);
  console.log(
    `\nRatio per module: median ${show(median(ran.map(perProcess)))}, p10 ${
      show(quantile(ran.map(perProcess), 0.1))
    }, p90 ${show(quantile(ran.map(perProcess), 0.9))}.\n`,
  );
};

type Counters = {
  milliseconds: number;
  transactions: number;
  schedulerCommits: number;
  actions: number;
  bodies: number;
  preparations: number;
  reads: number;
  writes: number;
};
type Snapshot = {
  byKind: Record<Kind, Stored>;
  total: Stored;
  resultInlinedBytes: number;
  compileCache: Stored;
};
type Range = { min: number; max: number };
type Derived = {
  unknownSizes: number;
  settled: {
    records: Record<string, number>;
    coneInstances: number;
    streams: number;
    transactions: number;
    documents: {
      operationState: number;
      stateCells: Range;
      children: Range;
      rows: Range;
      total: Range;
    };
    labelEntries: Range & { shared: number };
  };
  events: {
    transactions: Range;
    coneEvaluations: Range;
    streamDocuments: number;
  };
  labelEnvelopeBytes: Range;
};
type RunResult = {
  module: string;
  skipped?: string;
  inputs?: number;
  length?: number;
  measured?: {
    settle: Counters;
    settled: Snapshot;
    events: (Counters & { outcome?: string })[];
    afterEvents?: Snapshot;
  };
  derived?: { known: Derived; assumed: Derived };
};

/** The kinds of document the compiled layout has no counterpart of per node. */
const OWNED: Kind[] = ["result", "argument", "internal", "computed"];

/** The documents of the instance and what it owns: no schema, no input. */
export const owned = (snapshot: Snapshot): Stored => {
  const parts = OWNED.map((kind) => snapshot.byKind[kind]);
  const total = { ...parts[0] };
  for (const key of Object.keys(total) as (keyof Stored)[]) {
    total[key] = sum(parts.map((part) => part[key]));
  }
  return total;
};

const runTables = async (directory: string) => {
  const results = await lines<RunResult>(`${directory}/run.jsonl`);
  if (results === undefined) return;
  const ran = results.filter((result) => result.measured !== undefined).map((
    result,
  ) => ({
    module: result.module,
    measured: result.measured!,
    derived: result.derived!,
    committed: result.measured!.events.filter((event) =>
      event.outcome === "committed"
    ),
  }));
  console.log(`\n## Run time (${ran.length} modules ran)\n`);
  const skipped = new Map<string, number>();
  for (const result of results) {
    if (result.skipped === undefined) continue;
    const reason = result.skipped.startsWith("the run fails")
      ? "the run fails"
      : result.skipped;
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  }
  console.log(
    `Not run: ${
      [...skipped].map(([reason, count]) => `${count} ${reason}`).join(", ")
    }.\n`,
  );
  console.log("To settle, per module:\n");
  console.log(table(SPREAD, [
    spread(
      "today, measured: milliseconds",
      ran.map((r) => r.measured.settle.milliseconds),
    ),
    spread(
      "today, measured: transactions committed",
      ran.map((r) => r.measured.settle.transactions),
    ),
    spread(
      "today, measured: commits the scheduler asked for",
      ran.map((r) => r.measured.settle.schedulerCommits),
    ),
    spread(
      "today, measured: runs of an action",
      ran.map((r) => r.measured.settle.actions),
    ),
    spread(
      "today, measured: calls of an authored body",
      ran.map((r) => r.measured.settle.bodies),
    ),
    spread(
      "today, measured: CFC preparations",
      ran.map((r) => r.measured.settle.preparations),
    ),
    spread(
      "today, measured: reads journaled",
      ran.map((r) => r.measured.settle.reads),
    ),
    spread(
      "compiled, derived: transactions",
      ran.map((r) => r.derived.known.settled.transactions),
    ),
    spread(
      "compiled, derived: cones",
      ran.map((r) => r.derived.known.settled.records.cones),
    ),
    spread(
      "compiled, derived: cone instances, sizes known",
      ran.map((r) => r.derived.known.settled.coneInstances),
    ),
    spread(
      "compiled, derived: cone instances, other sizes 2",
      ran.map((r) => r.derived.assumed.settled.coneInstances),
    ),
    spread(
      "compiled, derived: sandboxed bodies",
      ran.map((r) => r.derived.known.settled.records.bodies),
    ),
    spread(
      "compiled, derived: bindings",
      ran.map((r) => r.derived.known.settled.records.bindings),
    ),
    spread(
      "compiled, derived: effects",
      ran.map((r) => r.derived.known.settled.records.effects),
    ),
  ]));
  const transactions = (r: typeof ran[number]) =>
    r.measured.settle.transactions / r.derived.known.settled.transactions;
  const evaluations = (r: typeof ran[number]) =>
    r.measured.settle.actions / r.derived.assumed.settled.coneInstances;
  console.log(
    `\nRatio per module of transactions, today's to the derived: median ${
      show(median(ran.map(transactions)))
    }, p10 ${show(quantile(ran.map(transactions), 0.1))}, p90 ${
      show(quantile(ran.map(transactions), 0.9))
    }. Of today's runs of an action to the derived cone instances (other sizes 2), over the ${
      ran.filter((r) => r.derived.assumed.settled.coneInstances > 0).length
    } modules with a cone: median ${
      show(median(ran.map(evaluations).filter(Number.isFinite)))
    }, p10 ${
      show(quantile(ran.map(evaluations).filter(Number.isFinite), 0.1))
    }, p90 ${
      show(quantile(ran.map(evaluations).filter(Number.isFinite), 0.9))
    }.\n`,
  );
  console.log(
    extremes(ran, transactions, (r) => [
      r.module,
      r.measured.settle.milliseconds,
      r.measured.settle.transactions,
      r.measured.settle.actions,
      r.derived.known.settled.transactions,
      r.derived.assumed.settled.coneInstances,
      transactions(r),
    ], [
      "module",
      "ms today",
      "transactions today",
      "actions today",
      "transactions derived",
      "cone instances derived",
      "ratio of transactions",
    ]),
  );
  const events = ran.flatMap((r) => r.committed);
  const withEvents = ran.filter((r) => r.committed.length > 0);
  console.log(
    `\nPer committed event (${events.length} events of ${withEvents.length} modules):\n`,
  );
  console.log(table(SPREAD, [
    spread("today, measured: milliseconds", events.map((e) => e.milliseconds)),
    spread(
      "today, measured: transactions committed",
      events.map((e) => e.transactions),
    ),
    spread("today, measured: runs of an action", events.map((e) => e.actions)),
    spread("today, measured: reads journaled", events.map((e) => e.reads)),
  ]));
  const perEvent = (range: Range, r: typeof ran[number]) =>
    [range.min, range.max].map((bound) => bound / r.measured.events.length);
  console.log(
    `\nDerived per event, the mean over a module's events, then the median over the modules: transactions ${
      show(median(withEvents.map((r) =>
        perEvent(r.derived.assumed.events.transactions, r)[0]
      )))
    } to ${
      show(median(withEvents.map((r) =>
        perEvent(r.derived.assumed.events.transactions, r)[1]
      )))
    }; cone evaluations at most ${
      show(median(withEvents.map((r) =>
        perEvent(r.derived.assumed.events.coneEvaluations, r)[1]
      )))
    } (the mean over the modules ${
      show(
        sum(
          withEvents.map((r) => r.derived.assumed.events.coneEvaluations.max),
        ) / sum(withEvents.map((r) => r.measured.events.length)),
      )
    }). Today's mean per committed event: ${
      show(sum(events.map((e) => e.transactions)) / events.length)
    } transactions, ${
      show(sum(events.map((e) => e.actions)) / events.length)
    } runs of an action.\n`,
  );

  console.log(`\n## Storage after settle (${ran.length} modules)\n`);
  const kindsRows = ([
    "result",
    "argument",
    "internal",
    "computed",
    "schema",
    "other",
  ] as Kind[])
    .flatMap((kind) => [
      spread(
        `today, measured: ${kind} documents`,
        ran.map((r) => r.measured.settled.byKind[kind].documents),
      ),
    ]);
  const own = ran.map((r) => owned(r.measured.settled));
  console.log(table(SPREAD, [
    ...kindsRows,
    spread(
      "today: documents of the instance (the first four)",
      own.map((s) => s.documents),
    ),
    spread("today: bytes of their values", own.map((s) => s.valueBytes)),
    spread("today: bytes of their meta fields", own.map((s) => s.metaBytes)),
    spread("today: envelopes", own.map((s) => s.envelopes)),
    spread("today: label entries", own.map((s) => s.labelEntries)),
    spread(
      "today: envelope bytes, labels in place",
      own.map((s) => s.envelopeBytes),
    ),
    spread(
      "today: envelope bytes, labels by reference",
      own.map((s) => s.envelopeBytesByReference),
    ),
    spread(
      "today: compile cache documents",
      ran.map((r) => r.measured.settled.compileCache.documents),
    ),
    spread(
      "today: compile cache bytes",
      ran.map((r) => r.measured.settled.compileCache.valueBytes),
    ),
    spread(
      "today: bytes of the result with those documents inlined",
      ran.map((r) => r.measured.settled.resultInlinedBytes),
    ),
    spread(
      "compiled, derived: documents, least",
      ran.map((r) => r.derived.known.settled.documents.total.min),
    ),
    spread(
      "compiled, derived: documents, most (other sizes 2)",
      ran.map((r) => r.derived.assumed.settled.documents.total.max),
    ),
    spread(
      "compiled, derived: rows of the stream index",
      ran.map((r) => r.derived.assumed.settled.streams),
    ),
    spread(
      "compiled, derived: label entries, every label empty",
      ran.map((r) => r.derived.known.settled.labelEntries.min),
    ),
    spread(
      "compiled, derived: label entries, none empty, rows share",
      ran.map((r) => r.derived.assumed.settled.labelEntries.shared),
    ),
    spread(
      "compiled, derived: label entries, none empty, rows differ",
      ran.map((r) => r.derived.assumed.settled.labelEntries.max),
    ),
    spread(
      "compiled, derived: envelope bytes at 88 per entry, most",
      ran.map((r) => r.derived.assumed.labelEnvelopeBytes.max),
    ),
  ]));
  const documents = (r: typeof ran[number]) =>
    owned(r.measured.settled).documents /
    r.derived.assumed.settled.documents.total.max;
  const entries = (r: typeof ran[number]) =>
    owned(r.measured.settled).labelEntries /
    r.derived.assumed.settled.labelEntries.max;
  const bytes = (r: typeof ran[number]) =>
    (owned(r.measured.settled).valueBytes +
      owned(r.measured.settled).metaBytes) /
    r.measured.settled.resultInlinedBytes;
  const alone = ran.filter((r) =>
    r.derived.known.settled.records.children === 0
  );
  const ratios = (name: string, of: typeof ran, ratio: typeof documents) =>
    `${name}: median ${show(median(of.map(ratio)))}, p10 ${
      show(quantile(of.map(ratio), 0.1))
    }, p90 ${show(quantile(of.map(ratio), 0.9))}`;
  console.log(
    `\n${
      ratios(
        "Ratio per module of documents, today's to the most derived",
        ran,
        documents,
      )
    }; of the totals ${
      show(
        sum(own.map((s) => s.documents)) /
          sum(ran.map((r) => r.derived.assumed.settled.documents.total.max)),
      )
    }, and to the least derived ${
      show(
        sum(own.map((s) => s.documents)) /
          sum(ran.map((r) => r.derived.known.settled.documents.total.min)),
      )
    }. ${
      ratios(
        `Over the ${alone.length} modules whose plan has no child`,
        alone,
        documents,
      )
    }; of the totals ${
      show(
        sum(alone.map((r) => owned(r.measured.settled).documents)) /
          sum(alone.map((r) => r.derived.assumed.settled.documents.total.max)),
      )
    }. ${
      ratios(
        "Of the bytes of values and meta fields to the bytes of the inlined result",
        ran,
        bytes,
      )
    }; of the totals ${
      show(
        sum(own.map((s) => s.valueBytes + s.metaBytes)) /
          sum(ran.map((r) => r.measured.settled.resultInlinedBytes)),
      )
    }. ${
      ratios("Of label entries, today's to the most derived", ran, entries)
    }; of the totals ${
      show(
        sum(own.map((s) => s.labelEntries)) /
          sum(ran.map((r) => r.derived.assumed.settled.labelEntries.max)),
      )
    }. Modules where today stores fewer label entries than the most derived: ${
      ran.filter((r) => entries(r) < 1).length
    }; fewer than the one entry of the pattern's atom: ${
      ran.filter((r) => owned(r.measured.settled).labelEntries < 1).length
    }.\n`,
  );
  console.log(
    extremes(ran, documents, (r) => [
      r.module,
      owned(r.measured.settled).documents,
      owned(r.measured.settled).valueBytes,
      owned(r.measured.settled).labelEntries,
      `${r.derived.known.settled.documents.total.min} to ${r.derived.assumed.settled.documents.total.max}`,
      `${r.derived.known.settled.labelEntries.min} to ${r.derived.assumed.settled.labelEntries.max}`,
      r.derived.known.settled.records.children,
      documents(r),
    ], [
      "module",
      "documents today",
      "value bytes today",
      "entries today",
      "documents derived",
      "entries derived",
      "children in the plan",
      "ratio of documents",
    ]),
  );
  const after = ran.filter((r) => r.measured.afterEvents !== undefined);
  console.log(
    `\nAfter the events (${after.length} modules with an event), the growth from the settled state:\n`,
  );
  console.log(table(SPREAD, [
    spread(
      "today, measured: documents of the instance added",
      after.map((r) =>
        owned(r.measured.afterEvents!).documents -
        owned(r.measured.settled).documents
      ),
    ),
    spread(
      "today, measured: other documents added",
      after.map((r) =>
        r.measured.afterEvents!.byKind.other.documents -
        r.measured.settled.byKind.other.documents
      ),
    ),
    spread(
      "today, measured: label entries added",
      after.map((r) =>
        r.measured.afterEvents!.total.labelEntries -
        r.measured.settled.total.labelEntries
      ),
    ),
    spread(
      "compiled, derived: stream documents added",
      after.map((r) => r.derived.known.events.streamDocuments),
    ),
  ]));
};

type Scale = { module: string; runs: RunResult[] };

const scaleTables = async (directory: string) => {
  const results = await lines<Scale>(`${directory}/scale.jsonl`);
  if (results === undefined) return;
  const pairs = results.filter((result) =>
    result.runs.length === 2 &&
    result.runs.every((run) => run.measured !== undefined)
  ).map((result) => {
    const [small, large] = result.runs;
    const elements = large.length! - small.length!;
    const per = (of: (run: RunResult) => number) =>
      (of(large) - of(small)) / elements;
    const kind = (name: Kind) =>
      per((run) => run.measured!.settled.byKind[name].documents);
    const own = (key: keyof Stored) =>
      per((run) => owned(run.measured!.settled)[key]);
    return {
      module: result.module,
      result: kind("result"),
      argument: kind("argument"),
      internal: kind("internal"),
      computed: kind("computed"),
      other: kind("other"),
      documents: own("documents"),
      valueBytes: own("valueBytes"),
      metaBytes: own("metaBytes"),
      labelEntries: own("labelEntries"),
      envelopeBytes: own("envelopeBytes"),
      envelopeBytesByReference: own("envelopeBytesByReference"),
      milliseconds: per((run) => run.measured!.settle.milliseconds),
      transactions: per((run) => run.measured!.settle.transactions),
      actions: per((run) => run.measured!.settle.actions),
      derivedDocuments: per((run) =>
        run.derived!.known.settled.documents.total.max
      ),
      derivedEntriesLeast: per((run) =>
        run.derived!.known.settled.labelEntries.shared
      ),
      inlinedBytes: per((run) => run.measured!.settled.resultInlinedBytes),
      derivedEntries: per((run) => run.derived!.known.settled.labelEntries.max),
      derivedCones: per((run) => run.derived!.known.settled.coneInstances),
    };
  });
  console.log(
    `\n## Per element of an array of the argument (${pairs.length} modules with a \`map\` over one)\n`,
  );
  console.log(
    "Each figure is the difference between the settled runs at the two lengths, divided by the number of elements added to each array of the argument.\n",
  );
  const column = (name: string, key: keyof typeof pairs[number]) =>
    spread(name, pairs.map((pair) => pair[key] as number)).filter((_, index) =>
      index !== 1
    );
  console.log(table(SPREAD.filter((_, index) => index !== 1), [
    column("today, measured: result documents", "result"),
    column("today, measured: argument documents", "argument"),
    column("today, measured: internal documents", "internal"),
    column("today, measured: computed documents", "computed"),
    column("today, measured: documents of the instance", "documents"),
    column("today, measured: other documents (the element's record)", "other"),
    column("today, measured: bytes of values", "valueBytes"),
    column("today, measured: bytes of meta fields", "metaBytes"),
    column("today, measured: label entries", "labelEntries"),
    column("today, measured: envelope bytes, labels in place", "envelopeBytes"),
    column(
      "today, measured: envelope bytes, labels by reference",
      "envelopeBytesByReference",
    ),
    column("today, measured: milliseconds to settle", "milliseconds"),
    column("today, measured: transactions", "transactions"),
    column("today, measured: runs of an action", "actions"),
    column(
      "compiled, derived: documents, most (a part per row)",
      "derivedDocuments",
    ),
    column(
      "today, measured: bytes of the inlined result",
      "inlinedBytes",
    ),
    column(
      "compiled, derived: label entries, rows share",
      "derivedEntriesLeast",
    ),
    column("compiled, derived: label entries, rows differ", "derivedEntries"),
    column("compiled, derived: cone instances", "derivedCones"),
  ]));
};

if (import.meta.main) {
  const [directory] = Deno.args;
  if (directory === undefined) {
    console.error("usage: cost-report.ts <directory>");
    Deno.exit(2);
  }
  await compileTables(directory);
  await runTables(directory);
  await scaleTables(directory);
}
