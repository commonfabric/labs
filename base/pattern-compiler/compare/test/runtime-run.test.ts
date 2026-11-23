import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import { PatternCompiler } from "../../../../runtime/runner/src/compiled/compile.deno.ts";
import type { CompiledPiece } from "../../../../runtime/runner/src/compiled/piece.ts";
import { runCompiledPatterns } from "../../../../runtime/runner/src/compiled/run.ts";
import { compiledFailureOf } from "../../../../runtime/runner/src/compiled/setup.ts";
import type { RuntimeProgram } from "../../../../runtime/runner/src/harness/types.ts";
import { Runtime } from "../../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../../runtime/runner/src/storage/cache.deno.ts";

/** The program of `compare/fixtures/module-data.tsx`, changed by `change`. */
const programOf = async (
  change: (source: string) => string = (source) => source,
): Promise<RuntimeProgram> => ({
  main: "/module-data.tsx",
  files: [{
    name: "/module-data.tsx",
    contents: change(
      await Deno.readTextFile(
        new URL("../fixtures/module-data.tsx", import.meta.url),
      ),
    ),
  }],
});

/**
 * Names the helper of the fixture with a leading `$`, which the crate
 * refuses and today's compile accepts.
 */
const withReservedName = (source: string): string =>
  source.replaceAll("summaryOf", "$summaryOf");

type Session = {
  runtime: Runtime;
  /** The pieces the runtime started from a compiled pattern. */
  pieces: CompiledPiece[];
  /** How many pieces the runtime resumed from their basis. */
  resumed: number;
  /** What the compiler refused, by the main file of the program. */
  fellBack: string[];
};

// These cases run the release build of the crate, which
// `cargo build --release` in `base/pattern-compiler` makes.
describe("a pattern started from its source with `Runtime.run`", () => {
  let signer: Identity;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let sessions: Session[];

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("runtime run compiled");
    storageManager = StorageManager.emulate({ as: signer });
    sessions = [];
  });

  afterEach(async () => {
    for (const { runtime } of sessions) {
      await runtime.scheduler.idleWithPendingCommits();
      await runtime.dispose({ closeStorage: false });
    }
    await storageManager.close();
  });

  /** A runtime on the storage of the test, with a compiler where asked. */
  const open = (compiled: boolean): Session => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
      servingPosture: true,
      ...(compiled ? { experimental: { compiledPatterns: true } } : {}),
    });
    const session: Session = {
      runtime,
      pieces: [],
      resumed: 0,
      fellBack: [],
    };
    if (compiled) {
      const compiler = new PatternCompiler();
      runCompiledPatterns(runtime, {
        compile: (program) => compiler.compile(program),
        started: (piece) => session.pieces.push(piece),
        fellBack: (_program, reason) => session.fellBack.push(reason),
        resumed: () => session.resumed += 1,
      });
    }
    sessions.push(session);
    return session;
  };

  /**
   * Compiles `program` in the runtime of `session`, runs its pattern at
   * the result cell `name` with `Runtime.run`, sends one event, and
   * returns what the result holds.
   */
  const valuesAfterAnEvent = async (
    { runtime }: Session,
    program: RuntimeProgram,
    name: string,
  ) => {
    const space = signer.did();
    const pattern = await runtime.patternManager.compilePattern(program);
    const result = runtime.getCell<Record<string, unknown>>(space, name);
    const tx = runtime.edit();
    runtime.run(tx, pattern, {}, result.withTx(tx));
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await runtime.scheduler.idleWithPendingCommits();
    result.key("record").send({ glaze: "sugar" } as never);
    await runtime.scheduler.idleWithPendingCommits();
    return { last: await result.key("last").pull() };
  };

  it("holds the values of today's path where the crate accepts the program", async () => {
    const today = await valuesAfterAnEvent(
      open(false),
      await programOf(),
      "today",
    );
    const session = open(true);

    const compiled = await valuesAfterAnEvent(
      session,
      await programOf(),
      "compiled",
    );

    expect(compiled).toEqual(today);
    expect(compiled).toEqual({ last: "sugar donut,3,2,3,1" });
    expect(session.pieces).toHaveLength(1);
    expect(session.fellBack).toEqual([]);
  });

  it("runs on today's path, and says which construct refused it, where the crate refuses the program", async () => {
    const today = await valuesAfterAnEvent(
      open(false),
      await programOf(withReservedName),
      "today",
    );
    const session = open(true);

    const fallen = await valuesAfterAnEvent(
      session,
      await programOf(withReservedName),
      "fallen",
    );

    expect(fallen).toEqual(today);
    expect(fallen).toEqual({ last: "sugar donut,3,2,3,1" });
    expect(session.pieces).toHaveLength(0);
    expect(session.fellBack).toHaveLength(1);
    expect(session.fellBack[0]).toContain("`$summaryOf` begins with `$`");
  });

  it("is resumed by a second runtime from what the storage holds, and handles an event there", async () => {
    const space = signer.did();
    const first = open(true);
    await valuesAfterAnEvent(first, await programOf(), "kept");
    await first.runtime.scheduler.idleWithPendingCommits();
    await storageManager.synced();
    const second = open(true);
    const result = second.runtime.getCell<Record<string, unknown>>(
      space,
      "kept",
    );

    // What `start` resolves to says whether a graph of today's runner was
    // installed, which a compiled piece has none of.
    await second.runtime.start(result);
    result.key("record").send({ glaze: "plain" } as never);
    await second.runtime.scheduler.idleWithPendingCommits();

    expect(await result.key("last").pull()).toBe("plain donut,2,2,3,1");
    expect(second.resumed).toBe(1);
  });

  it("is refused, with the reason stored, where a second runtime's compiler no longer accepts the program", async () => {
    const space = signer.did();
    const first = open(true);
    await valuesAfterAnEvent(first, await programOf(), "kept");
    await storageManager.synced();
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
      servingPosture: true,
      experimental: { compiledPatterns: true },
    });
    const second: Session = {
      runtime,
      pieces: [],
      resumed: 0,
      fellBack: [],
    };
    sessions.push(second);
    runCompiledPatterns(runtime, {
      compile: () => Promise.reject(new Error("no longer in the subset")),
    });
    const result = runtime.getCell<Record<string, unknown>>(space, "kept");

    await expect(runtime.start(result)).rejects.toThrow(
      "Cannot start: no pattern identity",
    );
    await runtime.scheduler.idleWithPendingCommits();

    const failure = runtime.getCellFromLink<{ reason: string }>({
      space,
      id: compiledFailureOf(result.getAsNormalizedFullLink().id),
      path: [],
      scope: "space",
    } as never);
    expect((await failure.pull())?.reason).toBe("no longer in the subset");
    expect(await result.key("last").pull()).toBe("sugar donut,3,2,3,1");
  });
});
