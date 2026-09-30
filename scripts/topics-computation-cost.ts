/**
 * Measures the Topics board's mention pivot, each topic's backlink lookup, and
 * a topic's comment and link aggregates over the headless Topics fixture,
 * across topic counts, mention graphs, thread lengths, and demand workloads.
 * The "Topics computation cost probe" section of
 * `docs/development/BENCHMARKS.md` documents the matrix, the options, and the
 * output.
 *
 * Each measured case runs in a child process of its own, so a case that
 * exhausts the heap ends that process rather than the run: this process records
 * the limit, skips the larger sizes of that case's series, and carries on. Any
 * other failure ends the run. Output is JSON lines on stdout; progress, and
 * everything a child prints, goes to stderr.
 *
 * Given `--derive-limits`, it instead runs the read-budget cases five times
 * each, writes the read-budget limits module to stdout, and runs each case
 * again under every regression variant its limits are assigned to, as the
 * "Topics read budget" section of `docs/development/BENCHMARKS.md` describes.
 */

import { parseArgs } from "@std/cli/parse-args";
import { fromFileUrl } from "@std/path";
// The heap limit a process runs under is exposed only through `node:v8`.
// deno-lint-ignore no-external-import
import { getHeapStatistics } from "node:v8";

import {
  BOARD_NOT_MEASURED,
  caseNamed,
  caseRecord,
  measureCasePhases,
  type PhaseRecord,
  type ProbeCase,
  probeCases,
} from "../packages/patterns/integration/topics-cost-cases.ts";
import {
  buildTopicsFixture,
  DEFAULT_TOPICS_FIXTURE_MODE,
  TOPICS_FIXTURE_MODES,
  type TopicsFixtureMode,
} from "../packages/patterns/integration/topics-headless-fixture.ts";
import {
  assignedLimitsNotExceeded,
  GATED_MEASURES,
  type GatedMeasure,
  gatedMeasuresOf,
  limitFor,
  limitsModuleSource,
  type ReadBudgetLimits,
  TOPICS_READ_BUDGET_GROUPS,
  variantsAssignedTo,
} from "../packages/patterns/integration/topics-read-budget.ts";
import {
  READ_BUDGET_VARIANTS,
  type ReadBudgetVariantName,
} from "../packages/patterns/integration/topics-read-budget-variants.ts";

/** The repository root, where a child process finds the workspace config. */
const REPOSITORY_ROOT = fromFileUrl(new URL("..", import.meta.url));

//
// The run
//

/** What the command line selects for a run. */
interface RunOptions {
  /**
   * The experimental posture the runtimes of every measured case are given,
   * and the mode every record of the run is labeled with. A `board` case
   * opens no runtime, and its sample carries this mode as the run's.
   */
  readonly mode: TopicsFixtureMode;

  /** How many rounds of every selected case to run. */
  readonly repeat: number;

  /** Whether only the small cases run. */
  readonly small: boolean;

  /** Selects the cases whose `id` it matches, when present. */
  readonly filter?: RegExp;

  /** The heap size, in megabytes, each child is started with, when present. */
  readonly maxOldSpaceSize?: number;
}

/** Matches the line V8 writes to stderr when a process exhausts its heap. */
const HEAP_EXHAUSTED = /Fatal JavaScript out of memory|heap out of memory/i;

/** What running one case in a child process came to. */
type CaseOutcome =
  /** The case completed and wrote its sample. */
  | { readonly kind: "sample"; readonly sample: Record<string, unknown> }
  /** The case's process exhausted its heap before the case completed. */
  | {
    readonly kind: "limit";

    /** The signal that ended the process, when one did. */
    readonly signal: Deno.Signal | null;

    /** The process's exit code. */
    readonly exitCode: number;

    /** The line of the process's stderr that reports the exhausted heap. */
    readonly message: string;

    /** The heap limit the child ran under, when it recorded one. */
    readonly heapSizeLimitBytes: number | null;

    /** Wall-clock milliseconds from starting the child to its end. */
    readonly elapsedMs: number;
  };

/**
 * Runs every case `options` selects, in rounds, under the mode it names,
 * writing the environment, each sample, each limit, and a completion record as
 * JSON lines. A `board` case starts no process: its sample records the run's
 * mode, that it is not measured, and why.
 *
 * @throws Error when no case is selected, or when a case fails other than by
 * exhausting its process's heap.
 */
async function runProbe(options: RunOptions): Promise<void> {
  const cases = probeCases().filter((probeCase) =>
    (!options.small || probeCase.small) &&
    (options.filter?.test(probeCase.id) ?? true)
  );
  if (cases.length === 0) throw new Error("No case matches the arguments.");
  const v8Flags = childV8Flags(options.maxOldSpaceSize);
  emit({
    kind: "environment",
    ...await gitState(),
    deno: Deno.version,
    platform: {
      os: Deno.build.os,
      arch: Deno.build.arch,
      target: Deno.build.target,
    },
    processors: navigator.hardwareConcurrency,
    mode: options.mode,
    experimental: TOPICS_FIXTURE_MODES[options.mode],
    arguments: Deno.args,
    childV8Flags: v8Flags,
    repeat: options.repeat,
    cases: cases.map((probeCase) => probeCase.id),
  });

  // Per series, the smallest size whose process exhausted its heap, and every
  // size with a sample.
  const limits = new Map<string, number>();
  const sampled = new Map<string, Set<number>>();
  let samples = 0;
  for (let round = 1; round <= options.repeat; round++) {
    for (const probeCase of cases) {
      const { id, series, size } = probeCase;
      if (probeCase.workload === "board") {
        emit({
          kind: "sample",
          round,
          mode: options.mode,
          ...caseRecord(probeCase, buildTopicsFixture(probeCase.options)),
          measured: false,
          reason: BOARD_NOT_MEASURED,
        });
        samples++;
        continue;
      }
      if (size >= (limits.get(series) ?? Infinity)) continue;
      console.error(`round ${round}: ${id}`);
      const outcome = await runCase(probeCase, v8Flags, options.mode);
      if (outcome.kind === "sample") {
        emit({ kind: "sample", round, ...outcome.sample });
        samples++;
        sampled.set(series, (sampled.get(series) ?? new Set()).add(size));
        continue;
      }
      limits.set(series, size);
      const smaller = [...sampled.get(series) ?? []].filter((built) =>
        built < size
      );
      emit({
        kind: "limit",
        round,
        mode: options.mode,
        case: id,
        series,
        size,
        largestBuilt: smaller.length === 0 ? null : Math.max(...smaller),
        heapSizeLimitBytes: outcome.heapSizeLimitBytes,
        elapsedMs: outcome.elapsedMs,
        signal: outcome.signal,
        exitCode: outcome.exitCode,
        message: outcome.message,
        skipped: cases
          .filter((other) => other.series === series && other.size > size)
          .map((other) => other.id),
      });
    }
  }
  emit({
    kind: "complete",
    mode: options.mode,
    samples,
    limitedSeries: [...limits.keys()],
  });
}

/**
 * Returns the V8 flags a child process starts with, with its heap set to
 * `maxOldSpaceSize` megabytes when that is given.
 */
function childV8Flags(maxOldSpaceSize?: number): string[] {
  return [
    "--expose-gc",
    ...(maxOldSpaceSize === undefined
      ? []
      : [`--max-old-space-size=${maxOldSpaceSize}`]),
  ];
}

/** Writes `record` to stdout as one JSON line. */
function emit(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}

/**
 * Returns the checked-out revision, and whether the working tree differs from
 * it.
 *
 * @throws Error when `git` fails.
 */
async function gitState(): Promise<{ revision: string; dirty: boolean }> {
  const git = async (...args: string[]) => {
    const { success, stdout } = await new Deno.Command("git", {
      args,
      cwd: REPOSITORY_ROOT,
      stdout: "piped",
      stderr: "inherit",
    }).output();
    if (!success) throw new Error(`\`git ${args.join(" ")}\` failed.`);
    return new TextDecoder().decode(stdout).trim();
  };
  return {
    revision: await git("rev-parse", "HEAD"),
    dirty: await git("status", "--porcelain") !== "",
  };
}

/**
 * Runs `probeCase` in a child process started with `v8Flags`, under the
 * posture `mode` names and the regression variant `variant` when one is named,
 * forwarding everything the child prints to stderr, and returns its sample, or
 * the limit its process reached by exhausting its heap.
 *
 * @throws Error when the child fails other than by exhausting its heap, or
 * exits successfully without writing its sample.
 */
async function runCase(
  probeCase: ProbeCase,
  v8Flags: readonly string[],
  mode: TopicsFixtureMode,
  variant?: ReadBudgetVariantName,
): Promise<CaseOutcome> {
  const sampleFile = await Deno.makeTempFile({
    prefix: "topics-computation-cost-",
    suffix: ".json",
  });
  try {
    const started = performance.now();
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--frozen",
        `--v8-flags=${v8Flags.join(",")}`,
        fromFileUrl(import.meta.url),
        `--case=${probeCase.id}`,
        `--mode=${mode}`,
        `--sample-file=${sampleFile}`,
        ...(variant === undefined ? [] : [`--variant=${variant}`]),
      ],
      cwd: REPOSITORY_ROOT,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const [status, , stderr] = await Promise.all([
      child.status,
      forwardToStderr(child.stdout),
      forwardToStderr(child.stderr),
    ]);
    const elapsedMs = performance.now() - started;
    const written = await Deno.readTextFile(sampleFile);
    if (!status.success) {
      const exhausted = stderr.split("\n").map((line) => line.trim())
        .find((line) => HEAP_EXHAUSTED.test(line));
      if (exhausted === undefined) {
        const ending = status.signal === null
          ? `exited with code ${status.code}`
          : `was ended by \`${status.signal}\``;
        throw new Error(
          `Case \`${probeCase.id}\` ${ending} without exhausting its heap.`,
        );
      }
      // The file holds the child's first record or a sample cut short, so the
      // limit is read out of its text rather than parsed as a whole.
      const heapLimit = /"heapSizeLimitBytes":(\d+)/.exec(written);
      return {
        kind: "limit",
        signal: status.signal,
        exitCode: status.code,
        message: exhausted,
        heapSizeLimitBytes: heapLimit === null ? null : Number(heapLimit[1]),
        elapsedMs,
      };
    }
    const sample: Record<string, unknown> = JSON.parse(written);
    if (sample.kind !== "sample") {
      throw new Error(`Case \`${probeCase.id}\` wrote no sample.`);
    }
    return { kind: "sample", sample };
  } finally {
    await Deno.remove(sampleFile);
  }
}

/**
 * Helper for {@link runCase}, which copies `stream` to stderr as it arrives,
 * and returns everything it carried as text.
 */
async function forwardToStderr(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    for (let written = 0; written < chunk.length;) {
      written += Deno.stderr.writeSync(chunk.subarray(written));
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

//
// One case, in a child process
//

/**
 * Measures `probeCase` under the posture `mode` names, and the regression
 * variant `variant` when one is named, and writes its sample to `sampleFile`:
 * the case, the posture its runtimes reported running under, the heap limit
 * the process ran under, and a record for each phase.
 *
 * @throws Error as {@link measureCasePhases} does.
 */
async function measureCase(
  probeCase: ProbeCase,
  sampleFile: string,
  mode: TopicsFixtureMode,
  variant?: ReadBudgetVariantName,
): Promise<void> {
  const heapSizeLimitBytes = getHeapStatistics().heap_size_limit;
  // Written before anything is measured, so that a limit record can name the
  // heap this process had even when the case never finishes. The sample
  // replaces it.
  await Deno.writeTextFile(sampleFile, JSON.stringify({ heapSizeLimitBytes }));
  const measured = await measureCasePhases(probeCase, {
    mode,
    progress: (line) => console.error(line),
    variant: variant === undefined
      ? undefined
      : READ_BUDGET_VARIANTS[variant](probeCase),
  });
  await Deno.writeTextFile(
    sampleFile,
    JSON.stringify({
      kind: "sample",
      mode: measured.mode,
      ...caseRecord(probeCase, measured.fixture),
      measured: true,
      heapSizeLimitBytes,
      phases: measured.phases,
    }),
  );
}

//
// Deriving the read-budget limits
//

/** How many rounds `--derive-limits` runs every read-budget case. */
const DERIVATION_ROUNDS = 5;

/** Why the read-budget limits are derived under the default mode alone. */
const LIMITS_TAKE_THE_DEFAULT_MODE =
  "A mode is not theirs to take: the limits go into one table that carries " +
  "no mode, and the counts they gate differ between modes — three of the " +
  "five are proxy accesses, which lazy materialization off has been measured " +
  "to leave at 0 — so a table derived under one mode would gate every other " +
  "mode by counts that mode does not produce.";

/**
 * Runs every case the read-budget groups name in {@link DERIVATION_ROUNDS}
 * rounds, each case in a process of its own started with `v8Flags`, writes the
 * read-budget limits module to stdout, and then, when every gated count
 * repeated across the rounds, runs {@link deriveControls} on the limits it
 * wrote. Each gated count of each measured phase gets
 * {@link limitFor} the largest value the rounds observed, or, where the rounds
 * observed different values, is written as ungated with those values.
 *
 * @throws Error when a case fails or exhausts its heap, and, once the module is
 * written, when any gated count differed between rounds or a variant left a
 * limit assigned to it unexceeded.
 */
async function deriveLimits(v8Flags: readonly string[]): Promise<void> {
  const ids = Object.values(TOPICS_READ_BUDGET_GROUPS).flat();
  // By case, then by phase, each gated count every round observed.
  const observed = new Map<string, Map<string, Record<GatedMeasure, number[]>>>(
    ids.map((id) => [id, new Map()]),
  );
  for (let round = 1; round <= DERIVATION_ROUNDS; round++) {
    for (const id of ids) {
      console.error(`derivation round ${round}: ${id}`);
      const outcome = await runCase(
        caseNamed(id),
        v8Flags,
        DEFAULT_TOPICS_FIXTURE_MODE,
      );
      if (outcome.kind === "limit") {
        throw new Error(
          `Case \`${id}\` exhausted its heap: ${outcome.message}`,
        );
      }
      const phases = observed.get(id)!;
      for (const record of outcome.sample.phases as PhaseRecord[]) {
        if (!record.measured) continue;
        const counts = gatedMeasuresOf(record);
        for (const measure of GATED_MEASURES) {
          if (!Number.isSafeInteger(counts[measure])) {
            throw new Error(
              `Case \`${id}\` recorded no \`${measure}\` count in its ` +
                `\`${record.phase}\` phase.`,
            );
          }
        }
        const values = phases.get(record.phase) ??
          Object.fromEntries(
            GATED_MEASURES.map((measure) => [measure, [] as number[]]),
          ) as Record<GatedMeasure, number[]>;
        for (const measure of GATED_MEASURES) {
          values[measure].push(counts[measure]);
        }
        phases.set(record.phase, values);
      }
    }
  }

  const limits: Record<
    string,
    Record<string, ReadBudgetLimits[string][string]>
  > = {};
  const differing: string[] = [];
  for (const [id, phases] of observed) {
    limits[id] = {};
    for (const [phase, values] of phases) {
      limits[id][phase] = Object.fromEntries(
        GATED_MEASURES.map((measure) => {
          const counts = values[measure];
          const repeated = counts.length === DERIVATION_ROUNDS &&
            counts.every((count) => count === counts[0]);
          if (!repeated) {
            differing.push(`${id}, ${phase}, ${measure}: ${counts.join(", ")}`);
          }
          return [
            measure,
            repeated ? limitFor(Math.max(...counts)) : { ungated: counts },
          ];
        }),
      ) as ReadBudgetLimits[string][string];
    }
  }
  console.log(limitsModuleSource(limits));
  if (differing.length > 0) {
    throw new Error(
      `These gated counts differed between rounds, and are written as ` +
        `ungated:\n${differing.join("\n")}`,
    );
  }
  await deriveControls(ids, limits, v8Flags);
}

/**
 * Runs each case of `ids` once under every regression variant its workload
 * assigns, each in a process of its own started with `v8Flags`, and checks the
 * run against the limits `limits` holds for the counts that variant is
 * assigned, and so shows every limit exceeded by a regression that grows the
 * count it gates.
 *
 * @throws Error when a case fails or exhausts its heap, and when a variant
 * leaves a limit assigned to it unexceeded, naming the workload, case, phase,
 * count, variant, observed value, and limit of each.
 */
async function deriveControls(
  ids: readonly string[],
  limits: ReadBudgetLimits,
  v8Flags: readonly string[],
): Promise<void> {
  const unexceeded: string[] = [];
  for (const id of ids) {
    const probeCase = caseNamed(id);
    for (const variant of variantsAssignedTo(probeCase)) {
      console.error(`control: ${id} under \`${variant}\``);
      const outcome = await runCase(
        probeCase,
        v8Flags,
        DEFAULT_TOPICS_FIXTURE_MODE,
        variant,
      );
      if (outcome.kind === "limit") {
        throw new Error(
          `Case \`${id}\` exhausted its heap under the \`${variant}\` ` +
            `variant: ${outcome.message}`,
        );
      }
      const phases = outcome.sample.phases as PhaseRecord[];
      for (
        const check of assignedLimitsNotExceeded(
          probeCase,
          variant,
          phases,
          limits,
        )
      ) {
        unexceeded.push(
          `${check.workload}, ${check.case}, ${check.phase}, ` +
            `${check.measure}: the \`${variant}\` variant observed ` +
            `${check.observed ?? "no count"}, which does not exceed its ` +
            `limit of ${check.limit}.`,
        );
      }
    }
  }
  if (unexceeded.length > 0) {
    throw new Error(
      `These limits are not exceeded by the variant they are assigned to, ` +
        `so they gate a count no regression grows:\n${unexceeded.join("\n")}`,
    );
  }
}

//
// Entry point
//

/**
 * Helper for {@link main}, which returns `value` as the name of a regression
 * variant, and `undefined` when it is `undefined`.
 *
 * @throws Error when `value` names no variant.
 */
function variantNamed(value?: string): ReadBudgetVariantName | undefined {
  if (value === undefined) return undefined;
  if (!Object.hasOwn(READ_BUDGET_VARIANTS, value)) {
    const names = Object.keys(READ_BUDGET_VARIANTS)
      .map((name) => `\`${name}\``)
      .join(", ");
    throw new Error(
      `No variant is named \`${value}\`. The variants are ${names}.`,
    );
  }
  return value as ReadBudgetVariantName;
}

/**
 * Helper for {@link main}, which returns `value` as the name of a measurement
 * mode, and the default mode when it is `undefined`.
 *
 * @throws Error when `value` names no mode.
 */
function modeNamed(value?: string): TopicsFixtureMode {
  if (value === undefined) return DEFAULT_TOPICS_FIXTURE_MODE;
  if (!Object.hasOwn(TOPICS_FIXTURE_MODES, value)) {
    const names = Object.keys(TOPICS_FIXTURE_MODES)
      .map((name) => `\`${name}\``)
      .join(", ");
    throw new Error(
      `No mode is named \`${value}\`. The modes are ${names}.`,
    );
  }
  return value as TopicsFixtureMode;
}

/**
 * Helper for {@link main}, which returns `value` as a positive integer.
 *
 * @throws RangeError when `value` is not one.
 */
function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError(`\`--${name}\` must be a positive integer: ${value}`);
  }
  return parsed;
}

/**
 * Runs the probe under the mode `--mode` names, or, given `--case`, measures
 * that one case as a child of a run, under the variant `--variant` names when
 * it is given, or, given `--derive-limits`, derives the read-budget limits.
 *
 * @throws Error for an argument the probe does not take.
 */
async function main(): Promise<void> {
  const booleanOptions = ["derive-limits", "small"] as const;
  const stringOptions = [
    "case",
    "filter",
    "max-old-space-size",
    "mode",
    "repeat",
    "sample-file",
    "variant",
  ] as const;
  const args = parseArgs(Deno.args, {
    boolean: booleanOptions,
    string: stringOptions,
    unknown: (arg) => {
      throw new Error(`Unknown argument: \`${arg}\``);
    },
  });
  const maxOldSpaceSize = args["max-old-space-size"] === undefined
    ? undefined
    : positiveInteger("max-old-space-size", args["max-old-space-size"]);
  if (args["derive-limits"]) {
    // Every option the probe takes, other than these two, selects or runs cases
    // some other way.
    const conflicting = [
      ...booleanOptions.filter((name) => args[name]),
      ...stringOptions.filter((name) => args[name] !== undefined),
    ].filter((name) =>
      name !== "derive-limits" && name !== "max-old-space-size"
    );
    if (conflicting.length > 0) {
      throw new Error(
        "`--derive-limits` takes no other option but " +
          "`--max-old-space-size`, and was given " +
          `${conflicting.map((name) => `\`--${name}\``).join(", ")}.` +
          (args.mode === undefined ? "" : ` ${LIMITS_TAKE_THE_DEFAULT_MODE}`),
      );
    }
    await deriveLimits(childV8Flags(maxOldSpaceSize));
    return;
  }
  if (args.case !== undefined) {
    if (args["sample-file"] === undefined) {
      throw new Error("`--case` needs `--sample-file`.");
    }
    await measureCase(
      caseNamed(args.case),
      args["sample-file"],
      modeNamed(args.mode),
      variantNamed(args.variant),
    );
    return;
  }
  if (args.variant !== undefined) {
    throw new Error("`--variant` needs `--case`.");
  }
  await runProbe({
    mode: modeNamed(args.mode),
    repeat: args.repeat === undefined
      ? 1
      : positiveInteger("repeat", args.repeat),
    small: args.small,
    filter: args.filter === undefined ? undefined : new RegExp(args.filter),
    maxOldSpaceSize,
  });
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error);
    Deno.exitCode = 1;
  });
}
