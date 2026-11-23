/**
 * Measures what evaluating value code in an SES compartment costs beside
 * `new Function`, and what compiling a pattern with the crate's binary
 * costs beside today's compile (milestone 5 of
 * `docs/plans/compiled-pattern-language-integration.md`).
 *
 * Run from the repository root, after `cargo build --release` in
 * `base/pattern-compiler`:
 *
 * `deno run -A --no-check base/pattern-compiler/compare/sandbox-cost.ts [evaluators] [calls] [executor] [compile] [--arm=<name>]`
 *
 * With no part named every part runs. Each part prints lines of JSON. A
 * part that is to run in a realm that is not locked down runs in a process
 * of its own, and so does an arm of `executor` with `--arm`.
 *
 * - `evaluators`: the time to make a compartment evaluator, the first one
 *   in the process, which locks the realm down, and one after it; and the
 *   time to make the function of one module's text with each evaluator.
 * - `calls`: the time of one call of a value function that each evaluator
 *   made of the same text, with a host that does no work.
 * - `executor`: the patterns of `fixtures/sandbox-cost.tsx` on the executor
 *   with its documents in memory, at 100, 1,000 and 10,000 rows of plain
 *   values in place: the load, and an edit of one title, with each
 *   evaluator; and for the `lift` that is handed the whole array, how
 *   often an edit has the store read a position whole and for how long,
 *   and the time of one read of the array, which copies it.
 * - `compile`: the crate's binary on a source without a cache directory and
 *   with one, and today's compile of the same source in a runtime of its
 *   own, the first of the process and a second of the same source.
 *
 * The arm `function` runs before the realm is locked down, and `function,
 * locked` after it: the lockdown freezes the intrinsics that the executor
 * uses too.
 */
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";

import {
  type CompiledPatternSource,
  PatternCompiler,
} from "../../../runtime/runner/src/compiled/compile.deno.ts";
import { compartmentEvaluator } from "../../../runtime/runner/src/compiled/value-code.ts";
import { resolveLocalProgram } from "../../../runtime/runner/src/harness/local-program.deno.ts";
import type { RuntimeProgram } from "../../../runtime/runner/src/harness/types.ts";
import { Runtime } from "../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../runtime/runner/src/storage/cache.deno.ts";
import {
  evaluateWithFunction,
  Instance,
  type ModuleEvaluator,
} from "../exec/executor.ts";
import { argumentOf, Ref } from "../exec/store.ts";

const repository = fromFileUrl(new URL("../../../", import.meta.url));
const ARGUMENT = argumentOf("result");

const median = (times: number[]): number => {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const round = (value: number, digits = 3) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/** The milliseconds `run` takes. */
const timed = (run: () => void): number => {
  const began = performance.now();
  run();
  return performance.now() - began;
};

const print = (line: Record<string, unknown>) =>
  console.log(JSON.stringify(line));

/** The program of a file of `compare/fixtures/`, with what it imports. */
const programOf = async (
  fixture: string,
  mainExport?: string,
): Promise<RuntimeProgram> => {
  const signer = await Identity.fromPassphrase("sandbox cost");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    return await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: `${repository}base/pattern-compiler/compare/fixtures/${fixture}`,
        root: repository,
        ...(mainExport === undefined ? {} : { mainExport }),
      },
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

/** A module text of the shape the crate emits, with one value function. */
const CALLED = {
  path: "sandbox-cost/called",
  source:
    '$rt.value(0, ($h) => (({ label: ($h.v($h.slot(1)) + ("!")), done: $h.slot(2) })));',
};

/** The value function of `CALLED` as `evaluate` makes it. */
const valueFunction = (evaluate: ModuleEvaluator) => {
  let made: ((host: unknown) => unknown) | undefined;
  evaluate(CALLED, ["$rt", "$exports"])(
    Object.freeze({
      value: (_index: number, run: (host: unknown) => unknown) => {
        made = run;
      },
    }),
    {},
  );
  return made!;
};

const evaluators = () => {
  const text = CALLED;
  const make = (evaluate: ModuleEvaluator) =>
    median(
      Array.from(
        { length: 200 },
        () => timed(() => evaluate(text, ["$rt", "$exports"])),
      ),
    );
  const before = make(evaluateWithFunction);
  let first: ModuleEvaluator | undefined;
  const lockdown = timed(() => {
    first = compartmentEvaluator();
  });
  const later = median(
    Array.from({ length: 50 }, () => timed(() => compartmentEvaluator())),
  );
  print({
    part: "evaluators",
    "first compartment evaluator, with the lockdown, ms": round(lockdown),
    "a later compartment evaluator, ms": round(later),
    "function of a module text, new Function, ms": round(before, 4),
    "function of a module text, new Function, locked, ms": round(
      make(evaluateWithFunction),
      4,
    ),
    "function of a module text, compartment, ms": round(make(first!), 4),
  });
};

const calls = () => {
  const host = Object.freeze({
    slot: (index: number) => index === 1 ? "title" : false,
    v: (value: unknown) => value,
  });
  const CALLS = 2_000_000;
  const perCall = (run: (host: unknown) => unknown): number => {
    for (let index = 0; index < 200_000; index++) run(host);
    const rounds = Array.from({ length: 7 }, () =>
      timed(() => {
        for (let index = 0; index < CALLS; index++) run(host);
      }));
    // In nanoseconds.
    return median(rounds) / CALLS * 1e6;
  };
  const plain = perCall(valueFunction(evaluateWithFunction));
  const compartment = valueFunction(compartmentEvaluator());
  print({
    part: "calls",
    calls: CALLS,
    rounds: 7,
    "new Function, ns per call": round(plain, 1),
    "new Function, locked, ns per call": round(
      perCall(valueFunction(evaluateWithFunction)),
      1,
    ),
    "compartment, ns per call": round(perCall(compartment), 1),
  });
};

const item = (index: number) => ({
  id: `i${index}`,
  title: `t${index}`,
  done: false,
});

const LENGTHS = [100, 1_000, 10_000];
const EDITS = 20;
const LOADS = 5;

const executorArm = (
  arm: string,
  compiled: Record<string, CompiledPatternSource>,
  evaluator: () => ModuleEvaluator,
) => {
  for (const [name, { main }] of Object.entries(compiled)) {
    for (const length of LENGTHS) {
      const start = () =>
        new Instance(
          main,
          { items: Array.from({ length }, (_, index) => item(index)) },
          { measure: "patches", evaluate: evaluator() },
        );
      const loads: number[] = [];
      let instance: Instance | undefined;
      for (let load = 0; load < LOADS; load++) {
        loads.push(timed(() => {
          instance = start();
          instance.result();
        }));
      }
      const loaded = instance!.counts.evaluations;
      // For the `lift` over the whole array: how often an edit has the
      // store read a position whole, and for how long.
      const whole = { reads: 0, ms: 0 };
      if (name === "Whole") {
        const { store } = instance!;
        const read = store.read.bind(store);
        let depth = 0;
        store.read = (...given: Parameters<typeof read>) => {
          const began = performance.now();
          depth += 1;
          try {
            return read(...given);
          } finally {
            depth -= 1;
            if (depth === 0) {
              whole.reads += 1;
              whole.ms += performance.now() - began;
            }
          }
        };
      }
      const edits: number[] = [];
      for (let turn = 0; turn < EDITS; turn++) {
        edits.push(
          timed(() =>
            instance!.writeArgument(
              ["items", `${turn}`, "title"],
              `edited ${turn}`,
            )
          ),
        );
      }
      const perEdit = { reads: whole.reads / EDITS, ms: whole.ms / EDITS };
      const reads = name !== "Whole" ? undefined : Array.from(
        { length: EDITS },
        () =>
          timed(() => instance!.store.read(new Ref(ARGUMENT, ["items"]), [])),
      );
      print({
        part: "executor",
        arm,
        pattern: name,
        length,
        "load, ms": round(median(loads)),
        "evaluations of the load": loaded,
        "load per evaluation, us": round(median(loads) / loaded * 1000, 2),
        "edit of one title, ms": round(median(edits), 4),
        "evaluations per edit": (instance!.counts.evaluations - loaded) /
          EDITS,
        ...(reads === undefined ? {} : {
          "store reads per edit": perEdit.reads,
          "in store reads per edit, ms": round(perEdit.ms, 4),
          "one read of the array, ms": round(median(reads), 4),
        }),
      });
    }
  }
};

const executor = async () => {
  const compiler = new PatternCompiler();
  const compiled: Record<string, CompiledPatternSource> = {};
  for (const name of ["PerRow", "BodyPerRow", "Whole"]) {
    compiled[name] = await compiler.compile(
      await programOf("sandbox-cost.tsx", name),
    );
  }
  // With `--arm=<name>` one arm runs, so that no arm before it has grown
  // the heap or locked the realm down.
  const only = Deno.args.find((argument) => argument.startsWith("--arm="))
    ?.slice("--arm=".length);
  const arm = (name: string, evaluator: () => () => ModuleEvaluator) => {
    if (only === undefined || only === name) {
      executorArm(name, compiled, evaluator());
    }
  };
  arm("function", () => () => evaluateWithFunction);
  arm("function, locked", () => {
    compartmentEvaluator();
    return () => evaluateWithFunction;
  });
  arm("compartment per instance", () => compartmentEvaluator);
  arm("compartment, one for all", () => {
    const shared = compartmentEvaluator();
    return () => shared;
  });
};

const compile = async () => {
  const cacheDir = await Deno.makeTempDir();
  try {
    for (
      const [fixture, mainExport] of [
        ["sandbox-cost.tsx", "PerRow"],
        ["runner-lists.tsx", "Plain"],
        ["handler.tsx", undefined],
      ] as const
    ) {
      const program = await programOf(fixture, mainExport);
      const RUNS = 9;
      const cold: number[] = [];
      const cached: number[] = [];
      for (let run = 0; run < RUNS; run++) {
        let began = performance.now();
        await new PatternCompiler().compile(program);
        cold.push(performance.now() - began);
        // The first compile with the cache directory fills it.
        await new PatternCompiler({ cacheDir }).compile(program);
        began = performance.now();
        const { cached: hit } = await new PatternCompiler({ cacheDir })
          .compile(program);
        if (!hit) throw new Error("The cache directory held no artifact.");
        cached.push(performance.now() - began);
      }
      // Today's compile, in a runtime of its own with no cache from before.
      const signer = await Identity.fromPassphrase("sandbox cost");
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      let first: number;
      let second: number;
      try {
        let began = performance.now();
        await runtime.patternManager.compilePattern(program, {
          space: signer.did(),
        });
        first = performance.now() - began;
        began = performance.now();
        await runtime.patternManager.compilePattern(program, {
          space: signer.did(),
        });
        second = performance.now() - began;
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
      print({
        part: "compile",
        source: fixture,
        files: program.files.length,
        bytes: program.files.reduce(
          (sum, { contents }) => sum + contents.length,
          0,
        ),
        runs: RUNS,
        "crate, a process per compile, ms": round(median(cold), 2),
        "crate, from the cache directory, ms": round(median(cached), 2),
        "today, first compile of the source in the runtime, ms": round(
          first,
          2,
        ),
        "today, second compile of the source in the runtime, ms": round(
          second,
          2,
        ),
      });
    }
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
};

if (import.meta.main) {
  const given = Deno.args.filter((argument) => !argument.startsWith("--"));
  const parts = given.length > 0
    ? given
    : ["evaluators", "calls", "executor", "compile"];
  // The parts that lock the realm down run after those that must not.
  if (parts.includes("evaluators")) evaluators();
  if (parts.includes("calls")) calls();
  if (parts.includes("executor")) await executor();
  if (parts.includes("compile")) await compile();
}
