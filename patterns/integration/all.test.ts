import { createTestSpace, env } from "@commonfabric/integration";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { PATTERN_CATEGORIES } from "../../tasks/package-layout.ts";
import { initializePiecesController } from "./pieces-controller.ts";

const { API_URL } = env;

/**
 * Every pattern whose entry is the file named for its directory, as a path
 * relative to `root`: `<category>/<pattern>/<pattern>.tsx`. A pattern entered
 * through some other file, such as `main.tsx`, is not among them.
 */
function selfNamedPatterns(root: string): string[] {
  const found: string[] = [];
  for (const category of PATTERN_CATEGORIES) {
    for (const dir of Deno.readDirSync(join(root, category))) {
      if (!dir.isDirectory) continue;
      const entryName = `${dir.name}.tsx`;
      const files = Deno.readDirSync(join(root, category, dir.name));
      for (const file of files) {
        if (file.isFile && file.name === entryName) {
          found.push(`${category}/${dir.name}/${entryName}`);
        }
      }
    }
  }
  return found.sort();
}

describe("Compile all patterns", () => {
  const skippedPatterns = [
    // Utility handlers, not a standalone pattern.
    "system/link-tool/link-tool.tsx",
    // The router library; the pattern built on it is `examples/router/main.tsx`.
    "examples/router/router.tsx",
  ];

  const patterns = selfNamedPatterns(join(import.meta.dirname!, ".."))
    .filter((name) => !skippedPatterns.includes(name));

  // A walk that finds nothing registers no test, and a describe with no tests
  // passes, so a layout this walk no longer matches would pass silently.
  if (patterns.length === 0) {
    throw new Error(
      "Found no pattern to compile: no `<category>/<pattern>/<pattern>.tsx` " +
        "under the patterns root.",
    );
  }

  for (const name of patterns) {
    it(`Executes: ${name}`, async () => {
      // Heap monitoring for bisection experiments (CT-1148)
      const heapBefore = Deno.memoryUsage().heapUsed;

      // Create a fresh PiecesController per test to prevent memory accumulation
      // The PatternManager caches compiled patterns indefinitely, so we need a
      // fresh Runtime (via PiecesController) each time to avoid OOM in CI
      const identity = await Identity.generate();
      const cc = await initializePiecesController({
        space: await createTestSpace(identity),
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
