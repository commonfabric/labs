import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

// Timing side-channel structural barrier.
//
// The defense against high-resolution timing attacks (Spectre-class) rests on
// a pattern being unable to construct a counter that advances during its own
// synchronous computation. That requires three things to remain true inside a
// pattern compartment:
//   1. No parallel-execution / shared-memory counter primitive
//      (SharedArrayBuffer, Atomics, Worker, MessageChannel).
//   2. No host high-resolution clock or timer scheduling
//      (performance, setTimeout, setInterval, queueMicrotask,
//       requestAnimationFrame).
//   3. No usable ambient wall clock or entropy via the Date/Math intrinsics
//      (SES secure mode tames Date.now()/new Date()/Math.random()).
//
// These hold today via SES lockdown and the narrow compartment global
// allow-list. This suite pins them so a future SES upgrade or a widened global
// surface fails loudly rather than silently re-opening a fine clock.

const signer = await Identity.fromPassphrase("test operator");

describe("timing side-channel structural barrier", () => {
  let runtime: Runtime;
  let engine: Engine;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    engine = runtime.harness as Engine;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  async function probe(body: string): Promise<unknown> {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "export default function probe() {",
            "  const host = globalThis as Record<string, unknown>;",
            body,
            "}",
          ].join("\n"),
        },
      ],
    };
    const { main } = await engine.compileAndEvaluateModules(program);
    return main?.default();
  }

  it("denies parallel-execution and shared-memory counter primitives", async () => {
    const result = await probe(
      [
        "  return {",
        '    hasSharedArrayBuffer: typeof host.SharedArrayBuffer !== "undefined",',
        '    hasAtomics: typeof host.Atomics !== "undefined",',
        '    hasWorker: typeof host.Worker !== "undefined",',
        '    hasSharedWorker: typeof host.SharedWorker !== "undefined",',
        '    hasMessageChannel: typeof host.MessageChannel !== "undefined",',
        '    hasMessagePort: typeof host.MessagePort !== "undefined",',
        "  };",
      ].join("\n"),
    );

    expect(result).toEqual({
      hasSharedArrayBuffer: false,
      hasAtomics: false,
      hasWorker: false,
      hasSharedWorker: false,
      hasMessageChannel: false,
      hasMessagePort: false,
    });
  });

  it("denies host clocks and timer scheduling", async () => {
    const result = await probe(
      [
        "  return {",
        '    hasPerformance: typeof host.performance !== "undefined",',
        '    hasSetTimeout: typeof host.setTimeout !== "undefined",',
        '    hasSetInterval: typeof host.setInterval !== "undefined",',
        '    hasQueueMicrotask: typeof host.queueMicrotask !== "undefined",',
        "    hasRequestAnimationFrame:",
        '      typeof host.requestAnimationFrame !== "undefined",',
        "  };",
      ].join("\n"),
    );

    expect(result).toEqual({
      hasPerformance: false,
      hasSetTimeout: false,
      hasSetInterval: false,
      hasQueueMicrotask: false,
      hasRequestAnimationFrame: false,
    });
  });

  it("tames Date and Math intrinsics so neither yields a usable clock", async () => {
    // Robust to the exact taming: SES secure mode throws on these, but an older
    // taming returns a non-finite value. Either way the property we require is
    // that a pattern cannot read a usable wall clock or entropy. A "finite"
    // result from any of these is a regression that re-opens a fine clock.
    const result = await probe(
      [
        "  const out: Record<string, string> = {};",
        "  try {",
        '    out.dateNow = Number.isFinite(Date.now()) ? "finite" : "non-finite";',
        "  } catch {",
        '    out.dateNow = "throws";',
        "  }",
        "  try {",
        "    out.dateConstructor =",
        '      Number.isFinite(new Date().getTime()) ? "finite" : "non-finite";',
        "  } catch {",
        '    out.dateConstructor = "throws";',
        "  }",
        "  try {",
        "    out.mathRandom =",
        '      Number.isFinite(Math.random()) ? "finite" : "non-finite";',
        "  } catch {",
        '    out.mathRandom = "throws";',
        "  }",
        "  return out;",
      ].join("\n"),
    );

    const r = result as Record<string, string>;
    expect(r.dateNow).not.toBe("finite");
    expect(r.dateConstructor).not.toBe("finite");
    expect(r.mathRandom).not.toBe("finite");
  });
});
