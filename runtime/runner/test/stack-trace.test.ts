import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { SESRuntime } from "../src/sandbox/mod.ts";

const signer = await Identity.fromPassphrase("test operator");

/**
 * Tests that verify stack traces from compiled pattern code are correctly
 * source-mapped back to original TypeScript source locations.
 *
 * These tests exercise the production path: the Engine compiles a program to
 * per-module ESM records (running the full CF transformer pipeline), evaluates
 * them in the SES compartment, and registers per-module source maps so errors
 * map back to authored TS coordinates.
 *
 * Source files use explicit \n-separated strings (no template indentation)
 * so that line numbers are predictable and match source map output exactly.
 *
 * Two coordinate conventions to be aware of:
 * - The engine injects the CF helper import as a new first line of every
 *   module, so mapped line numbers are AUTHORED LINE + 1 (see the
 *   `// mapped line N` comments).
 * - Mapped frames carry the load-prefixed module path
 *   (`/<programHash>/main.tsx`), so assertions match on the authored
 *   `<file>:<line>:` suffix rather than a full path.
 *
 * NOTE: there is deliberately no top-level-error case here. An arbitrary
 * top-level call (`export default fail();`) is rejected by the SES module-scope
 * policy, so it cannot reach evaluation. Module-evaluation-time error mapping is
 * covered by stack-trace-patterns.test.ts ("mapWithPattern synthetic pattern
 * callsite"), which throws inside an allowed trusted-builder call. Nor is there a
 * separate transformer-on/off split: the Engine's module path ALWAYS runs the
 * CommonFabricTransformerPipeline, so every test below covers it.
 */

function makeProgram(files: Record<string, string>): RuntimeProgram {
  const main = Object.keys(files)[0];
  return {
    main,
    files: Object.entries(files).map(([name, contents]) => ({
      name,
      contents,
    })),
  };
}

describe("Stack trace source mapping", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Compile + evaluate through the production ESM record path. */
  const evaluate = (files: Record<string, string>) =>
    runtime.harness.compileAndEvaluateModules(makeProgram(files));

  /**
   * Invoke a compartment function through the harness so a thrown error's
   * stack is materialized and source-mapped (the scheduler invokes actions
   * through this same seam).
   */
  const invokeMapped = <T>(fn: () => T): T => runtime.harness.invoke(fn) as T;

  it("maps deferred function error to exact source line", async () => {
    // Authored line 3 = throw new Error('negative input') → mapped line 4.
    const { main } = await evaluate({
      "/main.tsx": [
        "export function riskyOperation(val: number): number {",
        "  if (val < 0) {",
        "    throw new Error('negative input');",
        "  }",
        "  return val * 2;",
        "}",
      ].join("\n"),
    });
    const riskyOperation = main!.riskyOperation as (val: number) => number;

    expect(invokeMapped(() => riskyOperation(5))).toBe(10);

    let thrown: Error | undefined;
    try {
      invokeMapped(() => riskyOperation(-1));
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    const lines = (thrown!.stack ?? "").split("\n");

    expect(lines[0]).toBe("Error: negative input");
    expect(lines[1]).toMatch(/at riskyOperation \(.*\/main\.tsx:4:\d+\)$/);
    // The mapped frame is a TS coordinate, not a raw compiled one.
    expect(lines[1]).not.toMatch(/:esm:|\.js:\d+/);
  });

  it("preserves relative and absolute runner internal stack frames by default", () => {
    const runtime = new SESRuntime({ lockdown: true });
    const stack = [
      "Error: boom",
      "    at eval (main.tsx:6:12)",
      "  at runtime/runner/src/sandbox/ses-runtime.ts:100:15",
      "    at SESInternals.exec (runtime/runner/src/sandbox/ses-runtime.ts:45:22)",
      "    at /home/runner/work/labs/labs/runtime/runner/src/harness/engine.ts:244:45",
      "  at callback (ext:deno_web/02_timers.js:42:7)",
    ].join("\n");

    expect(runtime.parseStack(stack).split("\n")).toEqual([
      "Error: boom",
      "    at eval (main.tsx:6:12)",
      "  at runtime/runner/src/sandbox/ses-runtime.ts:100:15",
      "    at SESInternals.exec (runtime/runner/src/sandbox/ses-runtime.ts:45:22)",
      "    at /home/runner/work/labs/labs/runtime/runner/src/harness/engine.ts:244:45",
      "  at callback (ext:deno_web/02_timers.js:42:7)",
    ]);
  });

  it("can sanitize relative and absolute runner internal stack frames", () => {
    const runtime = new SESRuntime({
      lockdown: true,
      hideInternalStackFrames: true,
    });
    const stack = [
      "Error: boom",
      "    at eval (main.tsx:6:12)",
      "  at runtime/runner/src/sandbox/ses-runtime.ts:100:15",
      "    at SESInternals.exec (runtime/runner/src/sandbox/ses-runtime.ts:45:22)",
      "    at /home/runner/work/labs/labs/runtime/runner/src/harness/engine.ts:244:45",
      "  at callback (ext:deno_web/02_timers.js:42:7)",
    ].join("\n");

    expect(runtime.parseStack(stack).split("\n")).toEqual([
      "Error: boom",
      "    at eval (main.tsx:6:12)",
      "    at <CF_INTERNAL>",
      "    at <CF_INTERNAL>",
      "    at <CF_INTERNAL>",
      "  at callback (ext:deno_web/02_timers.js:42:7)",
    ]);
  });

  it("maps multi-file error with exact line numbers through call chain", async () => {
    // validator.ts authored line 3 = throw → mapped 4;
    // processor.ts authored line 3 = validate() call → mapped 4.
    const { main } = await evaluate({
      "/main.tsx": [
        "import { processData } from './processor.ts';",
        "export default processData;",
      ].join("\n"),
      "/processor.ts": [
        "import { validate } from './validator.ts';",
        "export function processData(input: string): string {",
        "  validate(input);",
        "  return input.toUpperCase();",
        "}",
      ].join("\n"),
      "/validator.ts": [
        "export function validate(input: string): void {",
        "  if (!input || input.length === 0) {",
        "    throw new Error('validation failed: empty input');",
        "  }",
        "}",
      ].join("\n"),
    });
    const processData = main!.default as (input: string) => string;

    let thrown: Error | undefined;
    try {
      invokeMapped(() => processData(""));
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    const lines = (thrown!.stack ?? "").split("\n");

    expect(lines[0]).toBe("Error: validation failed: empty input");
    expect(lines[1]).toMatch(/at validate \(.*\/validator\.ts:4:\d+\)$/);
    expect(lines[2]).toMatch(/at processData \(.*\/processor\.ts:4:\d+\)$/);
  });

  it("preserves function name with exact source location", async () => {
    // Authored line 2 = throw new Error('zero!') → mapped line 3.
    const { main } = await evaluate({
      "/main.tsx": [
        "export function myNamedFunction(x: number): number {",
        "  if (x === 0) throw new Error('zero!');",
        "  return 1 / x;",
        "}",
      ].join("\n"),
    });
    const fn = main!.myNamedFunction as (x: number) => number;

    let thrown: Error | undefined;
    try {
      invokeMapped(() => fn(0));
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    const lines = (thrown!.stack ?? "").split("\n");

    expect(lines[0]).toBe("Error: zero!");
    expect(lines[1]).toMatch(/at myNamedFunction \(.*\/main\.tsx:3:\d+\)$/);
  });

  it("maps async error to exact source line", async () => {
    // Authored line 3 = throw new Error('async error') → mapped line 4.
    const { main } = await evaluate({
      "/main.tsx": [
        "export async function asyncBoom(): Promise<never> {",
        "  await Promise.resolve();",
        "  throw new Error('async error');",
        "}",
      ].join("\n"),
    });
    const asyncBoom = main!.asyncBoom as () => Promise<never>;

    let thrown: Error | undefined;
    try {
      await invokeMapped(() => asyncBoom());
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    const lines = (thrown!.stack ?? "").split("\n");

    expect(lines[0]).toBe("Error: async error");
    expect(lines[1]).toMatch(/at asyncBoom \(.*\/main\.tsx:4:\d+\)$/);
  });

  it("returns stack unchanged when no source map is loaded", () => {
    const runtime = new SESRuntime({ lockdown: true });

    const stack = `Error: something broke
    at someFunction (unknown-file.js:10:5)
    at Object.eval (another-file.js:20:10)`;

    const result = runtime.parseStack(stack);
    expect(result).toBe(stack);
  });
});
