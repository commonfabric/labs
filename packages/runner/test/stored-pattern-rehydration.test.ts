import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { Pattern } from "../src/builder/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { serializePatternGraph } from "../src/builder/to-encodable-form.ts";
import { resolveStoredPattern } from "../src/builtins/op-pattern-ref.ts";

/**
 * Stored pattern-VALUE rehydration (design §7, identity E4/E5): the JSON
 * boundary emits `{ $patternRef, argumentSchema, resultSchema }` and a stored
 * value rehydrates BY IDENTITY — synchronously from the session-lifetime
 * artifact index when the module evaluated in the reading session (every
 * authored case, by construction), or source-free from the space's persisted
 * compiled artifacts via the async net (llm-dialog's cold tool invocation).
 *
 * Patterns with NO entry ref (manually constructed / dynamic / bare-Engine
 * evaluation) still serialize their full graph, and a stored graph still
 * executes via `runtime.run` — that is a live writer path, not a vintage.
 */

const signer = await Identity.fromPassphrase("pre-e3-pattern-value-canary");
const space = signer.did();

const fixture = JSON.parse(
  Deno.readTextFileSync(
    new URL("./fixtures/pre-e3-serialized-pattern.json", import.meta.url),
  ),
) as {
  program: RuntimeProgram;
  serialized: Record<string, Record<string, unknown>>;
};

describe("stored pattern-value rehydration", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const setup = () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  };

  const runGraph = async (graph: Pattern, cause: string) => {
    let tx = runtime!.edit();
    const resultCell = runtime!.getCell<{ vs: number[] }>(
      space,
      cause,
      graph.resultSchema,
      tx,
    );
    const result = runtime!.run(
      tx,
      graph,
      { items: [{ v: 7 }, { v: 8 }, { v: 9 }] },
      resultCell,
    );
    runtime!.prepareTxForCommit(tx);
    await tx.commit().settled;
    tx = runtime!.edit();
    const cancelSink = result.sink(() => {});
    await runtime!.idle();
    const vs = await result.key("vs").pull();
    cancelSink();
    await tx.commit().settled;
    return vs;
  };

  it("a stored full graph (no-entry-ref writer) still executes via runtime.run", async () => {
    setup();
    // The internal graph serializer's output is the same shape a
    // no-entry-ref pattern serializes at the boundary; a stored graph must
    // run without its module ever evaluating in the reading session.
    const compiled = await runtime!.patternManager.compilePattern(
      fixture.program,
    );
    const graph = JSON.parse(
      JSON.stringify(serializePatternGraph(compiled as unknown as Pattern)),
    ) as Pattern;
    expect("$patternRef" in graph).toBe(false);
    expect(Array.isArray(graph.nodes)).toBe(true);

    const vs = await runGraph(graph, "stored-graph-run");
    expect(vs).toEqual([7, 8, 9]);
  });

  it("a refs-only value resolves to the live canonical once its module evaluated", async () => {
    setup();
    const stored = structuredClone(fixture.serialized.refsOnly);
    expect("nodes" in stored).toBe(false);

    // The module evaluates in this session (the by-construction case: any
    // piece whose pattern mentions this one loads it as part of its bundle).
    const compiled = await runtime!.patternManager.compilePattern(
      fixture.program,
    );
    const resolved = resolveStoredPattern(runtime!, stored);
    expect(resolved).toBe(compiled);

    const vs = await runGraph(resolved as Pattern, "refs-only-live-run");
    expect(vs).toEqual([7, 8, 9]);
  });

  it("a refs-only value loads by identity from storage when the module never evaluated (async net)", async () => {
    // Session 1 compiles WITH the space cache: compiled artifacts persist
    // in-space as part of the compilation step (awaited write-back). It stays
    // open while session 2 reads — the emulated storage tears down replica
    // state on dispose (same structure as resume-by-identity.test.ts).
    storageManager = StorageManager.emulate({ as: signer });
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx1 = rt1.edit();
      await rt1.patternManager.compilePattern(fixture.program, {
        space,
        tx: tx1,
      });
      await tx1.commit().settled;
      await rt1.storageManager.synced();

      // Session 2 never evaluates the module; the stored refs-only value's
      // sync resolution misses, and the async fallback (what llm-dialog does)
      // loads source-free by identity from the persisted compiled artifacts.
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const stored = structuredClone(
        fixture.serialized.refsOnly,
      ) as unknown as {
        $patternRef: { identity: string; symbol: string };
      };
      expect(resolveStoredPattern(runtime, stored)).toBeUndefined();

      const loaded = await runtime.patternManager.loadPatternByIdentity(
        stored.$patternRef.identity,
        stored.$patternRef.symbol,
        space,
      );
      expect(loaded).toBeDefined();

      const vs = await runGraph(loaded as Pattern, "refs-only-async-net");
      expect(vs).toEqual([7, 8, 9]);
    } finally {
      await rt1.dispose();
    }
  });
});
