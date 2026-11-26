/**
 * Prints the table of run times of a set of corpus modules: the time
 * the crate takes to compile the module, the time today's compiler
 * takes, the time to the first settled result, and the time of one
 * event, for the executor of `../exec/` and for today's runtime.
 *
 * `deno run -A base/pattern-compiler/compare/times.ts <again.jsonl> <run.jsonl> <compile.jsonl> <crate-time.jsonl> [count]`
 *
 * - `again.jsonl` is the output of `values-corpus.ts again`: the
 *   executor alone, on the events that today's run committed
 *   (`Comparison.times`).
 * - `run.jsonl` and `compile.jsonl` are the outputs of `cost.ts run`
 *   and `cost.ts compile`: today's runtime on the scenario of the same
 *   generator, and today's compile.
 * - `crate-time.jsonl` is the output of the crate's `time` command.
 *
 * It prints `count` modules, 24 unless given, spread evenly over the
 * modules that have every figure, in the order of the bytes of their
 * source, with `system/home/home.tsx` and the modules whose path holds
 * `fabrichat` where they have every figure.
 */
const lines = async (file: string): Promise<Record<string, unknown>[]> =>
  (await Deno.readTextFile(file)).split("\n").filter((line) =>
    line.startsWith("{")
  ).map((line) => JSON.parse(line));

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const mean = (values: number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;

const round = (value: number): string =>
  value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value
    .toFixed(2);

if (import.meta.main) {
  const [againFile, runFile, compileFile, crateFile, wanted] = Deno.args;
  const byModule = <T>(rows: T[]) =>
    new Map(
      rows.map((row) => [(row as { module: string }).module, row] as const),
    );
  const again = byModule(await lines(againFile));
  const run = byModule(await lines(runFile));
  const compile = byModule(await lines(compileFile));
  const crate = byModule(await lines(crateFile));
  type Row = {
    module: string;
    source: number;
    crate: number;
    today: number;
    settle: [number, number];
    events: [number, number];
    count: [number, number];
  };
  const rows: Row[] = [];
  for (const [module, mine] of again) {
    const times = (mine.comparison as {
      times?: { settle: number; events: number[] };
    } | undefined)?.times;
    const theirs = (run.get(module) as {
      measured?: {
        settle: { milliseconds: number };
        events: { milliseconds: number; outcome?: string }[];
      };
    } | undefined)?.measured;
    const compiled = (compile.get(module) as {
      runs?: { compile: number }[];
    } | undefined)?.runs;
    const timed = crate.get(module) as {
      nanoseconds?: number[];
      sourceBytes?: number;
    } | undefined;
    if (
      times === undefined || theirs === undefined || compiled === undefined ||
      timed?.nanoseconds === undefined
    ) continue;
    const committed = theirs.events.filter(({ outcome }) =>
      outcome === "committed"
    ).map(({ milliseconds }) => milliseconds);
    rows.push({
      module,
      source: timed.sourceBytes ?? 0,
      crate: median(timed.nanoseconds) / 1e6,
      today: median(compiled.map(({ compile }) => compile)),
      settle: [times.settle, theirs.settle.milliseconds],
      events: [mean(times.events), mean(committed)],
      count: [times.events.length, committed.length],
    });
  }
  rows.sort((a, b) => a.source - b.source);
  const count = Number(wanted ?? 24);
  const chosen = new Set<Row>();
  for (let index = 0; index < count; index++) {
    chosen.add(rows[Math.round(index * (rows.length - 1) / (count - 1))]);
  }
  for (const row of rows) {
    if (/home\/home\.tsx$|fabrichat/i.test(row.module)) chosen.add(row);
  }
  console.log(
    "| Module | Source bytes | Compile, crate | Compile, today | Settle, executor | Settle, today | Per event, executor (events) | Per event, today (events) |",
  );
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of [...chosen].sort((a, b) => a.source - b.source)) {
    console.log(
      `| \`${row.module.replace(/^\//, "")}\` | ${row.source} | ${
        round(row.crate)
      } | ${round(row.today)} | ${round(row.settle[0])} | ${
        round(row.settle[1])
      } | ${row.count[0] === 0 ? "" : round(row.events[0])} (${
        row.count[0]
      }) | ${row.count[1] === 0 ? "" : round(row.events[1])} (${
        row.count[1]
      }) |`,
    );
  }
  const total = (of: (row: Row) => number) =>
    rows.reduce((sum, row) => sum + of(row), 0);
  console.log(
    `\nOver the ${rows.length} modules with every figure, in milliseconds: compile ${
      round(total((row) => row.crate))
    } by the crate and ${
      round(total((row) => row.today))
    } today; to the settled result ${
      round(total((row) => row.settle[0]))
    } by the executor and ${round(total((row) => row.settle[1]))} today; ${
      total((row) => row.count[0])
    } events in ${
      round(total((row) => row.events[0] * row.count[0]))
    } by the executor and ${total((row) => row.count[1])} events in ${
      round(total((row) => row.events[1] * row.count[1]))
    } today.`,
  );
}
