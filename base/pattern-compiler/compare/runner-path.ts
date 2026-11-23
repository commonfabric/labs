/**
 * Starts and drives a pattern on today's runtime and as a compiled piece
 * with the same calls of the runtime, and reports what each event costs
 * from the write that causes it until the runtime is settled (milestone 3
 * of `docs/plans/compiled-pattern-language-integration.md`).
 *
 * `deno run -A --no-check base/pattern-compiler/compare/runner-path.ts [--later=<n>] [--arms=compiled,today] [--case=<part of a name>] [--no-pull] [lengths]`
 *
 * Both arms run in a runtime of their own on emulated storage, with
 * `cfcFlowLabels` at `persist` and the input under a schema with one
 * clause. Today's piece is started with `Runtime.run`, the compiled piece
 * with `startCompiledPiece`, which needs the experimental option
 * `compiledPatterns` and the serving posture. Each change is a write to the
 * input by a writer outside the piece, made through a cell in a transaction
 * of the runtime. A change is timed from before the write until the
 * scheduler is idle with no commit pending. Today's piece computes what a
 * reader demands, so its step pulls the result first, which reads all of
 * it; the compiled piece derives without a reader, and a pull of its result
 * is timed apart unless `--no-pull` is given.
 *
 * The cases are those of `growth.ts` over the patterns of
 * `fixtures/runner-lists.tsx`: a `map` over an array of references, a `map` over
 * an array of plain values in place, and a `map` over the result of a
 * `filter` over plain values in place, which is the result of another
 * per-element construct.
 */
// deno-lint-ignore no-external-import -- The sampling profiler is reached through this Node builtin alone.
import inspector from "node:inspector";
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";

import {
  getTimingStatsBreakdown,
  resetAllTimingStats,
} from "../../logger/src/logger.ts";
import type { JSONSchema } from "../../../runtime/runner/src/builder/types.ts";
import {
  type Cell,
  type MemorySpace,
  recordRelevantSchemaWritePolicyInput,
} from "../../../runtime/runner/src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../../runtime/runner/src/compiled/piece.ts";
import { diffAndUpdate } from "../../../runtime/runner/src/data-updating.ts";
import { resolveLocalProgram } from "../../../runtime/runner/src/harness/local-program.deno.ts";
import { Runtime } from "../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../runtime/runner/src/storage/cache.deno.ts";
import type { Artifact } from "../exec/executor.ts";
import { inputClause } from "./generate.ts";
import { scenarioAudience } from "./harness.ts";

/** The two paths a pattern is run on. */
export type Arm = "compiled" | "today";

/** What one step of one arm cost. */
export type StepCost = {
  /** From before the write until the runtime is settled, in milliseconds. */
  ms: number;
  /**
   * For the compiled piece: the time of a pull of the result behind the
   * step, until the runtime is settled again. It is no part of `ms`.
   */
  pull?: number;
  /** The commits the storage applied. */
  commits: number;
  /** The entities those commits changed. */
  documents: number;
  /** The preparations of Contextual Flow Control, and their time. */
  preparations: number;
  prepareMs: number;
  /** Runs of an action or an event handler by the scheduler. */
  runs: number;
  /** For the compiled piece: write records given and recorded. */
  recordsGiven?: number;
  recordsRecorded?: number;
  /** For the compiled piece: evaluations of value functions. */
  evaluations?: number;
};

/** A timing counter of the runtime: how often it ran and for how long. */
const timed = (key: string): { count: number; ms: number } => {
  const [logger, ...rest] = key.split("/");
  const stats = getTimingStatsBreakdown()[logger]?.[rest.join("/")];
  return { count: stats?.count ?? 0, ms: stats?.totalTime ?? 0 };
};

/** The runs of the timing counters whose name begins with `name`. */
const count = (name: string): number => {
  let found = 0;
  for (const [logger, keys] of Object.entries(getTimingStatsBreakdown())) {
    for (const [key, stats] of Object.entries(keys)) {
      if (`${logger}/${key}`.startsWith(name)) found += stats.count;
    }
  }
  return found;
};

const round = (milliseconds: number) => Math.round(milliseconds * 100) / 100;

/** A value as JSON text with the members of each record in order. */
export const ordered = (value: unknown): string =>
  JSON.stringify(
    value,
    (_key, member) =>
      typeof member === "object" && member !== null && !Array.isArray(member)
        ? Object.fromEntries(
          Object.entries(member).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
        )
        : member,
  );

/**
 * One arm in a runtime of its own: what starts a piece in it, what makes
 * a change and measures it, and what reads the result.
 */
export type Running = {
  arm: Arm;
  runtime: Runtime;
  space: MemorySpace;
  /** The compiled piece, on the arm `compiled`. */
  piece?: CompiledPiece;
  /**
   * Makes `change` in a transaction of its own, commits it, waits until
   * the runtime is settled, and returns what that cost.
   */
  measure(
    change: (tx: ReturnType<Runtime["edit"]>) => void,
  ): Promise<StepCost>;
  /** The result as JSON text, with every link followed. */
  read(): string;
  /** The result as the runtime's own read gives it, as JSON text. */
  throughRuntime(): string;
  close(): Promise<void>;
};

/**
 * Starts one arm. `start` is given the runtime, the space and an open
 * transaction, makes the inputs and starts the piece in it, and returns
 * the result cell and, on the arm `compiled`, the piece.
 */
export const running = async (
  arm: Arm,
  /** Whether a pull of the compiled piece's result follows each step. */
  pulls: boolean,
  start: (
    runtime: Runtime,
    space: MemorySpace,
    tx: ReturnType<Runtime["edit"]>,
  ) => Promise<{ result: Cell<unknown>; piece?: CompiledPiece }> | {
    result: Cell<unknown>;
    piece?: CompiledPiece;
  },
): Promise<{ running: Running; load: StepCost }> => {
  // The identity whose space is the audience that every generated clause
  // names as an alternative (`scenarioAudience`).
  const signer = await Identity.fromPassphrase("pattern-compiler-compare");
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcFlowLabels: "persist",
    ...(arm === "compiled"
      ? { experimental: { compiledPatterns: true }, servingPosture: true }
      : {}),
  });
  const changed = new Set<string>();
  let commits = 0;
  storageManager.subscribe({
    next(notification) {
      if (notification.type !== "commit") return undefined;
      commits += 1;
      for (const { address } of notification.changes) changed.add(address.id);
      return undefined;
    },
  });
  let result: Cell<unknown> | undefined;
  let piece: CompiledPiece | undefined;
  const measure = async (
    change: (tx: ReturnType<Runtime["edit"]>) => void | Promise<void>,
  ): Promise<StepCost> => {
    resetAllTimingStats();
    changed.clear();
    commits = 0;
    const before = piece === undefined ? undefined : {
      ...piece.transactions.counts,
      evaluations: piece.instance.counts.evaluations,
    };
    const began = performance.now();
    const tx = runtime.edit();
    await change(tx);
    runtime.prepareTxForCommit(tx);
    const { error } = await tx.commit().settled;
    if (error !== undefined) throw error;
    // Today's piece computes what a reader demands, so its step pulls the
    // result, which reads all of it. The compiled piece derives without a
    // reader; a pull of its result is timed apart (`StepCost.pull`).
    if (arm === "today") await result?.pull();
    await runtime.settled();
    await runtime.scheduler.idleWithPendingCommits();
    const ms = performance.now() - began;
    const commitsOfStep = commits;
    const documentsOfStep = changed.size;
    const preparations = timed("extended-storage-transaction/prepareCfc");
    const runs = count("scheduler/scheduler/run/action") +
      count("scheduler/execute/event");
    let pull: number | undefined;
    if (arm === "compiled" && pulls) {
      const pulled = performance.now();
      await result?.pull();
      await runtime.settled();
      await runtime.scheduler.idleWithPendingCommits();
      pull = round(performance.now() - pulled);
    }
    if (piece !== undefined && piece.refusals.length > 0) {
      throw new Error(
        `The storage refused a commit of the piece: ${piece.refusals[0]}`,
      );
    }
    const after = piece?.transactions.counts;
    return {
      ms: round(ms),
      ...(pull === undefined ? {} : { pull }),
      commits: commitsOfStep,
      documents: documentsOfStep,
      preparations: preparations.count,
      prepareMs: round(preparations.ms),
      runs,
      ...(piece === undefined || before === undefined || after === undefined
        ? {}
        : {
          recordsGiven: after.recordsGiven - before.recordsGiven,
          recordsRecorded: after.recordsRecorded - before.recordsRecorded,
          evaluations: piece.instance.counts.evaluations - before.evaluations,
        }),
    };
  };
  const throughRuntime = () => {
    const tx = runtime.edit();
    try {
      return ordered(result!.withTx(tx).get());
    } finally {
      tx.abort();
    }
  };
  const load = await measure(async (tx) => {
    ({ result, piece } = await start(runtime, space, tx));
  });
  return {
    load,
    running: {
      arm,
      runtime,
      space,
      piece,
      measure,
      read: () => {
        // The executor follows a link whose path crosses an array by key,
        // which the runtime's read does not resolve, so the result of the
        // compiled piece is read as the executor holds it.
        if (piece !== undefined) return ordered(piece.instance.result());
        return throughRuntime();
      },
      throughRuntime,
      close: async () => {
        piece?.stop();
        await runtime.scheduler.idleWithPendingCommits();
        await runtime.dispose();
        await storageManager.close();
      },
    },
  };
};

//
// The fixtures of growth
//

const repository = fromFileUrl(new URL("../../../", import.meta.url));

const item = (index: number) => ({
  id: `i${index}`,
  title: `t${index}`,
  done: false,
});

type Case = { name: string; pattern: string; references: boolean };

const CASES: Case[] = [
  { name: "references", pattern: "Plain", references: true },
  { name: "plain values in place", pattern: "Plain", references: false },
  { name: "result of a filter", pattern: "Chained", references: false },
];

/** One measured change on both arms. */
export type Row = {
  case: string;
  length: number;
  operation: string;
  /** Whether the two arms read the same result after the change. */
  equal?: boolean;
  /**
   * Whether the runtime's own read of the compiled piece's result gives
   * what the executor holds.
   */
  followed?: boolean;
} & { [arm in Arm]?: StepCost & { later?: number } };

/**
 * Starts the pattern of `one` at `length` items on one arm and returns
 * what makes each change of `growth.ts`.
 */
const growthArm = async (
  arm: Arm,
  one: Case,
  length: number,
  pulls: boolean,
) => {
  const audience = await scenarioAudience();
  const ifc = { confidentiality: [inputClause("items", audience)] };
  const itemSchema = {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      done: { type: "boolean" },
    },
    ifc,
  } as JSONSchema;
  const schema = { type: "array", items: itemSchema, ifc } as JSONSchema;
  // The members of the input as the harness holds them: cells for an
  // array of references, records for an array of plain values in place.
  const held: unknown[] = [];
  let items: Cell<unknown[]> | undefined;
  let made = 0;
  const make = (
    runtime: Runtime,
    space: MemorySpace,
    tx: ReturnType<Runtime["edit"]>,
  ): unknown => {
    const index = made++;
    if (!one.references) return item(index);
    const cell = runtime.getCell(space, `item ${index}`, itemSchema, tx);
    cell.set(item(index));
    return cell;
  };
  const { running: run, load } = await running(
    arm,
    pulls,
    async (runtime, space, tx) => {
      for (let index = 0; index < length; index++) {
        held.push(make(runtime, space, tx));
      }
      items = runtime.getCell<unknown[]>(space, "items", schema, tx);
      if (one.references) items.set(held as never);
      else {
        const link = items.getAsNormalizedFullLink();
        recordRelevantSchemaWritePolicyInput(tx, link, schema);
        diffAndUpdate(runtime, tx, link, held as never);
      }
      const result = runtime.getCell<unknown>(space, `growth ${one.name}`);
      if (arm === "compiled") {
        const [{ patterns }] = JSON.parse(
          await Deno.readTextFile(
            new URL("./fixtures/runner-lists.emit.json", import.meta.url),
          ),
        ) as { patterns: Artifact[] }[];
        const artifact = patterns.find(({ name }) => name === one.pattern);
        if (artifact === undefined) throw new Error(`no ${one.pattern}`);
        const piece = startCompiledPiece(
          runtime,
          tx,
          artifact,
          { items },
          result.withTx(tx),
        );
        return { result, piece };
      }
      const program = await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        {
          main:
            `${repository}base/pattern-compiler/compare/fixtures/runner-lists.tsx`,
          root: repository,
          mainExport: one.pattern,
        },
      );
      const compiled = await runtime.patternManager.compilePattern(program, {
        space,
      });
      runtime.run(tx, compiled, { items }, result.withTx(tx));
      return { result };
    },
  );
  const { runtime, space } = run;
  const list = (tx: ReturnType<Runtime["edit"]>) => items!.withTx(tx);
  // An array of plain values in place is written at its positions, as a
  // writer that holds no cell of a member writes it: `Cell.set` of a record
  // in an array makes a document of the record.
  const write = (
    tx: ReturnType<Runtime["edit"]>,
    path: string[],
    value: unknown,
  ) => {
    const link = items!.getAsNormalizedFullLink();
    recordRelevantSchemaWritePolicyInput(tx, link, schema);
    diffAndUpdate(runtime, tx, { ...link, path }, value as never);
  };
  const setAll = (tx: ReturnType<Runtime["edit"]>) =>
    one.references ? list(tx).set(held as never) : write(tx, [], held);
  const operations: Record<
    string,
    (tx: ReturnType<Runtime["edit"]>, turn: number) => void
  > = {
    append: (tx) => {
      const added = make(runtime, space, tx);
      held.push(added);
      if (one.references) list(tx).push(added as never);
      else write(tx, [], held);
    },
    prepend: (tx) => {
      held.unshift(make(runtime, space, tx));
      setAll(tx);
    },
    "edit one field": (tx, turn) => {
      const at = turn % held.length;
      if (one.references) {
        (held[at] as Cell<{ title: string }>).withTx(tx).key("title").set(
          `edited ${turn}`,
        );
      } else {
        held[at] = { ...(held[at] as object), title: `edited ${turn}` };
        write(tx, [`${at}`, "title"], `edited ${turn}`);
      }
    },
    "remove first": (tx) => {
      held.shift();
      setAll(tx);
    },
    "remove last": (tx) => {
      held.pop();
      setAll(tx);
    },
  };
  return { run, load, operations };
};

/**
 * Starts the sampling profiler of the process and returns what stops it
 * and writes the profile to `file`.
 */
const startProfile = async (file: string): Promise<() => Promise<void>> => {
  const session = new inspector.Session();
  session.connect();
  const post = (method: string, params?: object) =>
    new Promise<unknown>((resolve, reject) =>
      session.post(
        method,
        params,
        (error: Error | null, result?: unknown) =>
          error === null ? resolve(result) : reject(error),
      )
    );
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: 200 });
  await post("Profiler.start");
  return async () => {
    const { profile } = await post("Profiler.stop") as { profile: unknown };
    await Deno.writeTextFile(file, JSON.stringify(profile));
  };
};

if (import.meta.main) {
  const flags = Deno.args.filter((argument) => argument.startsWith("--"));
  const given = Deno.args.filter((argument) => !argument.startsWith("--"));
  const lengths = given.length > 0 ? given.map(Number) : [100, 1_000];
  const flag = (name: string) =>
    flags.find((one) => one.startsWith(`--${name}=`))?.split("=")[1];
  const later = Number(flag("later") ?? 5);
  const arms = (flag("arms") ?? "compiled,today").split(",") as Arm[];
  // `--profile=<file>` with `--operation=<name>`: a CPU profile of the
  // later changes of that operation on the compiled piece.
  const profile = flag("profile");
  const profiled = flag("operation") ?? "edit one field";
  const cases = flag("case") === undefined
    ? CASES
    : CASES.filter(({ name }) => name.includes(flag("case")!));
  for (const one of cases) {
    for (const length of lengths) {
      const started = [];
      for (const arm of arms) {
        started.push({
          arm,
          ...(await growthArm(arm, one, length, !flags.includes("--no-pull"))),
        });
      }
      const row = (operation: string, costs: Row): void =>
        console.log(JSON.stringify({ ...costs, operation }));
      const read = () => started.map(({ run }) => run.read());
      const equal = () => {
        const [first, ...rest] = read();
        return rest.every((other) => other === first);
      };
      const base = { case: one.name, length, operation: "" };
      row("load", {
        ...base,
        ...Object.fromEntries(started.map(({ arm, load }) => [arm, load])),
        ...(started.length > 1 ? { equal: equal() } : {}),
      });
      for (const operation of Object.keys(started[0].operations)) {
        const costs: Row = { ...base };
        let turn = 0;
        for (const { arm, run, operations } of started) {
          turn = 0;
          const first = await run.measure((tx) =>
            operations[operation](tx, turn)
          );
          let sum = 0;
          const stopProfile = arm === "compiled" && profile !== undefined &&
              operation === profiled
            ? await startProfile(profile)
            : undefined;
          for (turn = 1; turn <= later; turn++) {
            sum += (await run.measure((tx) =>
              operations[operation](tx, turn)
            )).ms;
          }
          await stopProfile?.();
          costs[arm] = {
            ...first,
            ...(later > 0 ? { later: round(sum / later) } : {}),
          };
        }
        if (started.length > 1) costs.equal = equal();
        for (const { arm, run } of started) {
          if (arm === "compiled") {
            costs.followed = run.throughRuntime() === run.read();
          }
        }
        if (flags.includes("--values")) console.log(read().join("\n"));
        row(operation, costs);
      }
      for (const { run } of started) await run.close();
    }
  }
}
