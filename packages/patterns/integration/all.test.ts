import { env } from "@commonfabric/integration";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { initializePiecesController } from "./pieces-controller.ts";

const { API_URL } = env;

describe("Compile all patterns", () => {
  const skippedPatterns = [
    "system/link-tool.tsx", // Utility handlers, not a standalone pattern
  ];

  const patterns = [...Deno.readDirSync(join(import.meta.dirname!, ".."))]
    .filter((file) => file.name.endsWith(".tsx"))
    .map((file) => file.name)
    // `.test.tsx` files are pattern tests, not authored patterns: they wrap a
    // pattern in a test harness and are compiled and executed by the separate
    // pattern unit-test job (`cf test`). Compiling them here too repeats that
    // work — and recompiles the real pattern they import — on the pattern
    // integration critical path. Match the pattern-source definition in
    // tasks/cfcheck.ts, which already excludes `.test.tsx`/`.test.ts`.
    .filter((name) => !name.endsWith(".test.tsx") && !name.endsWith(".test.ts"))
    .filter((name) => !skippedPatterns.includes(name))
    .sort();
  for (const name of patterns) {
    it(`Executes: ${name}`, async () => {
      // Heap monitoring for bisection experiments (CT-1148)
      const heapBefore = Deno.memoryUsage().heapUsed;

      // Create a fresh PiecesController per test to prevent memory accumulation
      // The PatternManager caches compiled patterns indefinitely, so we need a
      // fresh Runtime (via PiecesController) each time to avoid OOM in CI
      const identity = await Identity.generate();
      const cc = await initializePiecesController({
        space: `${name}-${crypto.randomUUID()}`,
        apiUrl: new URL(API_URL),
        identity: identity,
      });

      try {
        const sourcePath = join(import.meta.dirname!, "..", name);
        const rootPath = join(import.meta.dirname!, "..");
        const program = await resolveLocalProgram(
          (resolver) => cc.runtime.harness.resolve(resolver),
          { main: sourcePath, root: rootPath },
        );
        const piece = await cc!.create(program, { start: false });
        assert(piece.id, `Received piece ID ${piece.id} for ${name}.`);
      } finally {
        // Dispose the entire controller to free all memory including pattern cache
        await cc.dispose();

        // Log heap usage for analysis
        const heapAfter = Deno.memoryUsage().heapUsed;
        const deltaMB = Math.round((heapAfter - heapBefore) / 1024 / 1024);
        const totalMB = Math.round(heapAfter / 1024 / 1024);
        console.log(`[HEAP] ${name}: delta=${deltaMB}MB, total=${totalMB}MB`);
      }
    });
  }
});
