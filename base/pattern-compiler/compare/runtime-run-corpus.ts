/**
 * Runs the corpus through `Runtime.run` with the experimental option
 * `compiledPatterns` on and a pattern compiler given to the runtime
 * (`runCompiledPatterns`): each module that exports a pattern is resolved
 * to its program, compiled with `PatternManager.compilePattern`, and run.
 * The run says whether the pattern ran as a compiled piece or on today's
 * path, and why.
 *
 * - A compiled piece is sent the generated events of `corpus.ts`, and its
 *   values are compared with those of the executor with its documents in
 *   memory, as `runner-corpus.ts` does.
 * - A pattern that ran on today's path is run again in a runtime with the
 *   option off, and what the two result cells hold after the start is
 *   compared. No event is sent to it.
 *
 * Run from the repository root, after `cargo build --release` in
 * `base/pattern-compiler`:
 *
 * `deno run -A --no-check base/pattern-compiler/compare/runtime-run-corpus.ts run <results.jsonl> [part of a module path]`
 * `deno run -A --no-check base/pattern-compiler/compare/runtime-run-corpus.ts report <results.jsonl>`
 *
 * `run` appends one line per module and leaves out a module the file
 * already has.
 */
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";

import { PatternCompiler } from "../../../runtime/runner/src/compiled/compile.deno.ts";
import type { CompiledPiece } from "../../../runtime/runner/src/compiled/piece.ts";
import { runCompiledPatterns } from "../../../runtime/runner/src/compiled/run.ts";
import { resolveLocalProgram } from "../../../runtime/runner/src/harness/local-program.deno.ts";
import type { RuntimeProgram } from "../../../runtime/runner/src/harness/types.ts";
import { Runtime } from "../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../runtime/runner/src/storage/cache.deno.ts";
import type { Artifact } from "../exec/executor.ts";
import {
  artifactsOf,
  type CorpusModule,
  corpusModules,
  eventOrder,
  mainPattern,
  sourceOf,
} from "./corpus.ts";
import { generateEvent, generateInputs } from "./generate.ts";
import { scenarioAudience } from "./harness.ts";
import { argumentOf, categoryOf, ExecutorRun, normalize } from "./values.ts";
import { hasWish, homeStubs, memoryHome, seedHome } from "./wish-home.ts";

type EmittedModule = Omit<CorpusModule, "patterns"> & {
  patterns: Artifact[];
};

/** What became of one module. */
type Outcome = {
  module: string;
  pattern?: string;
  /** Why the module was not run. */
  skipped?: string;
  /** Why today's compile or the start failed, where one did. */
  failure?: { category: string; detail: string };
  /** Whether the pattern ran as a compiled piece. */
  compiled?: boolean;
  /** Why it ran on today's path: the first line the compiler gave. */
  fellBack?: string;
  /** Why the commit of the start was refused, where it was. */
  startRefused?: string;
  /** For a compiled piece: the events, and what became of them. */
  events?: { sent: number; handled: number };
  /**
   * For a compiled piece, whether it holds the values of the executor in
   * memory; for a pattern on today's path, whether the result holds what
   * it holds in a runtime with the option off.
   */
  equal?: boolean;
};

const text = (value: unknown): string =>
  JSON.stringify(
    value,
    (_name, member) =>
      typeof member === "object" && member !== null && !Array.isArray(member)
        ? Object.fromEntries(
          Object.entries(member).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
        )
        : member,
  ) ?? "undefined";

const repository = fromFileUrl(new URL("../../../", import.meta.url));

/**
 * Compiles `program` in a runtime of its own and runs its pattern with
 * `Runtime.run`, with a compiler where `compiler` is given. Returns the
 * runtime, the result cell, and the piece or the reason of the fallback.
 */
const started = async (
  program: RuntimeProgram,
  argument: unknown,
  now: number,
  compiler: PatternCompiler | undefined,
) => {
  const signer = await Identity.fromPassphrase("pattern-compiler-compare");
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcFlowLabels: "persist",
    servingPosture: true,
    ...(compiler === undefined
      ? {}
      : { experimental: { compiledPatterns: true } }),
  });
  let piece: CompiledPiece | undefined;
  let fellBack: string | undefined;
  // The home a `wish` resolves in, for the runtime's own `wish` on both
  // paths.
  await seedHome(runtime, space);
  if (compiler !== undefined) {
    runCompiledPatterns(runtime, {
      compile: (given) => compiler.compile(given),
      // The runtime of the run has no serving loop, which is what names
      // the principal a run acts for.
      piece: { now, actsFor: space },
      started: (made) => piece = made,
      fellBack: (_program, reason) => fellBack = reason,
    });
  }
  const close = async () => {
    await runtime.dispose();
    await storageManager.close();
  };
  try {
    const pattern = await runtime.patternManager.compilePattern(program, {
      space,
    });
    const result = runtime.getCell<unknown>(space, "corpus by Runtime.run");
    const tx = runtime.edit();
    runtime.run(tx, pattern, argument, result.withTx(tx));
    const { error } = await tx.commit().settled;
    await runtime.scheduler.idleWithPendingCommits();
    return {
      runtime,
      space,
      result,
      piece,
      fellBack,
      close,
      // Why the commit of the start was refused, where it was.
      refused: error === undefined
        ? undefined
        : `${error.name}: ${error.message}`.split("\n")[0].slice(0, 160),
    };
  } catch (error) {
    await close();
    throw error;
  }
};

const runOne = async (
  module: EmittedModule,
  artifacts: (id: string) => Artifact | undefined,
  compiler: PatternCompiler,
): Promise<Outcome> => {
  const chosen = await mainPattern(module);
  if (chosen === undefined) {
    return { module: module.module, skipped: "exports no pattern" };
  }
  const artifact = chosen.pattern;
  const base = { module: module.module, pattern: artifact.name };
  const { plan, schemas } = artifact;
  const inputs = generateInputs(plan, schemas, await scenarioAudience());
  const argument = argumentOf({ argument: {}, inputs });
  const now = Date.now();
  let program: RuntimeProgram;
  let on: Awaited<ReturnType<typeof started>>;
  try {
    const resolving = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({
        as: await Identity.fromPassphrase("pattern-compiler-compare"),
      }),
    });
    try {
      program = await resolveLocalProgram(
        (resolver) => resolving.harness.resolve(resolver),
        {
          main: sourceOf(module.module),
          root: repository,
          ...(chosen.isDefault ? {} : { mainExport: artifact.name }),
        },
      );
    } finally {
      await resolving.dispose();
    }
    on = await started(program, argument, now, compiler);
  } catch (error) {
    return { ...base, failure: categoryOf(error) };
  }
  try {
    const { runtime, space, piece, fellBack } = on;
    if (piece === undefined) {
      // What the result holds, or why the start did not commit.
      const held = async (run: typeof on) =>
        run.refused ?? text(normalize(await run.result.pull()));
      const here = await held(on);
      const off = await started(program, argument, now, undefined);
      try {
        return {
          ...base,
          compiled: false,
          fellBack: (fellBack ?? "the compiler was not asked").split("\n")
            .find((line) => /error|requests|no value code/.test(line))
            ?.slice(0, 200) ?? fellBack?.split("\n")[0].slice(0, 200),
          ...(on.refused === undefined ? {} : { startRefused: on.refused }),
          equal: here === await held(off),
        };
      } finally {
        await off.close();
      }
    }
    if (on.refused !== undefined) {
      return { ...base, compiled: true, startRefused: on.refused };
    }
    // The executor in memory answers a `wish` from the table over the same
    // home, and answers no effect.
    const stubs = hasWish(plan) ? homeStubs(await memoryHome()) : undefined;
    const alone = new ExecutorRun(artifact, argument, artifacts, {
      completion: () => undefined,
      now,
      ...(stubs === undefined ? {} : { home: stubs }),
    } as never);
    alone.start(undefined);
    const events = eventOrder(plan, "outside first").map((binding) => ({
      binding,
      event: generateEvent(plan, schemas, binding),
    }));
    events.forEach(({ binding, event }, index) => {
      const [held] = alone.held(binding);
      if (held !== undefined) {
        alone.committed(index, binding, event, held.elements);
      }
    });
    let handled = 0;
    for (const { binding, event } of events) {
      const stream = piece.instance.streams().find((held) =>
        held.binding === binding && held.instance === undefined &&
        held.elements !== undefined
      );
      const entity = stream === undefined
        ? undefined
        : piece.transactions.entityOfStream({
          binding: stream.binding,
          keys: stream.keys,
        });
      if (entity === undefined) continue;
      const before = piece.counts;
      runtime.scheduler.queueEvent(
        { space, id: entity, path: [], scope: "space" },
        piece.transactions.encode(event),
      );
      await runtime.scheduler.idleWithPendingCommits();
      const after = piece.counts;
      if (
        after.events > before.events &&
        after.eventsRefused === before.eventsRefused
      ) handled += 1;
    }
    return {
      ...base,
      compiled: true,
      events: { sent: events.length, handled },
      equal: text(normalize(piece.instance.result())) ===
        text(normalize(alone.result())),
    };
  } catch (error) {
    return {
      ...base,
      compiled: on.piece !== undefined,
      failure: categoryOf(error),
    };
  } finally {
    await on.close();
  }
};

const read = async (file: string): Promise<Outcome[]> => {
  try {
    return (await Deno.readTextFile(file)).split("\n").filter((line) =>
      line !== ""
    ).map((line) => JSON.parse(line));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
};

const run = async (file: string, part: string | undefined) => {
  const modules = await corpusModules() as EmittedModule[];
  const artifacts = artifactsOf(modules as never) as (
    id: string,
  ) => Artifact | undefined;
  const done = new Set((await read(file)).map(({ module }) => module));
  const compiler = new PatternCompiler();
  // A fetch effect of a compiled piece is answered by the runtime's fetch
  // built-in, and the addresses of the corpus are generated: no request
  // leaves the run.
  globalThis.fetch = () =>
    Promise.reject(new Error("The corpus run makes no request."));
  // What the runtime logs while a module runs is not the harness's output.
  const { warn, error, log } = console;
  for (const module of modules) {
    if (done.has(module.module)) continue;
    if (part !== undefined && !module.module.includes(part)) continue;
    console.warn = console.error = console.log = () => {};
    let outcome: Outcome;
    try {
      outcome = await runOne(module, artifacts, compiler);
    } finally {
      Object.assign(console, { warn, error, log });
    }
    await Deno.writeTextFile(file, `${JSON.stringify(outcome)}\n`, {
      append: true,
    });
  }
};

const report = async (file: string) => {
  const outcomes = await read(file);
  const count = (of: (outcome: Outcome) => string | undefined) => {
    const counts = new Map<string, number>();
    for (const outcome of outcomes) {
      const key = of(outcome);
      if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].sort(([, a], [, b]) => b - a);
  };
  const where = (test: (outcome: Outcome) => boolean) =>
    outcomes.filter(test).length;
  console.log(`modules: ${outcomes.length}`);
  for (const [why, n] of count(({ skipped }) => skipped)) {
    console.log(`  not run, ${n}: ${why}`);
  }
  for (
    const [why, n] of count(({ failure, compiled }) =>
      failure === undefined
        ? undefined
        : `${compiled === true ? "compiled, " : ""}${failure.category}`
    )
  ) console.log(`  failed, ${n}: ${why}`);
  const ran = (outcome: Outcome) => outcome.failure === undefined;
  console.log(
    `ran as a compiled piece, and the commit of the start was refused: ${
      where((one) => one.compiled === true && one.startRefused !== undefined)
    }`,
  );
  console.log(
    `ran on today's path, and the commit of the start was refused: ${
      where((one) => one.compiled === false && one.startRefused !== undefined)
    }`,
  );
  console.log(
    `ran as a compiled piece: ${
      where((one) =>
        ran(one) && one.compiled === true && one.startRefused === undefined
      )
    }`,
  );
  console.log(
    `  every event handled: ${
      where((one) =>
        ran(one) && one.compiled === true &&
        one.events?.handled === one.events?.sent
      )
    }`,
  );
  console.log(
    `  equal to the executor in memory: ${
      where((one) => ran(one) && one.compiled === true && one.equal === true)
    }`,
  );
  console.log(
    `ran on today's path: ${
      where((one) => ran(one) && one.compiled === false)
    }`,
  );
  console.log(
    `  holds what the result holds with the option off: ${
      where((one) => ran(one) && one.compiled === false && one.equal === true)
    }`,
  );
  for (
    const [why, n] of count(({ fellBack, failure }) =>
      failure === undefined
        ? fellBack?.replace(/^[^ ]+:\d+:\d+: /, "").replace(/`[^`]*`/g, "`…`")
          .slice(0, 110)
        : undefined
    )
  ) console.log(`  ${n}: ${why}`);
};

if (import.meta.main) {
  const [command, file, part] = Deno.args.filter((one) =>
    !one.startsWith("--")
  );
  if (command === "run" && file !== undefined) await run(file, part);
  else if (command === "report" && file !== undefined) await report(file);
  else {
    console.error(
      "usage: runtime-run-corpus.ts run <results.jsonl> [part of a module path] | report <results.jsonl>",
    );
    Deno.exit(2);
  }
}
