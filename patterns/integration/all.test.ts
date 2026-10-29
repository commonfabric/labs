import { createTestSpace, env } from "@commonfabric/integration";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { initializePiecesController } from "./pieces-controller.ts";

const { API_URL } = env;

describe("Compile all patterns", () => {
  // This compilation smoke suite selects standalone patterns explicitly:
  // category directories also contain helpers and separate pattern test harnesses.
  const patterns = [
    "apps/annotation-manager/annotation-manager.tsx",
    "apps/annotation/annotation.tsx",
    "apps/bookmarks/bookmarks.tsx",
    "apps/cheeseboard/cheeseboard.tsx",
    "apps/deep-research/deep-research.tsx",
    "apps/image-analysis/image-analysis.tsx",
    "apps/self-improving-classifier/self-improving-classifier.tsx",
    "apps/shopping-list/shopping-list.tsx",
    "apps/store-mapper/store-mapper.tsx",
    "dev/cell-link/cell-link.tsx",
    "dev/nested-map-ifelse-test/nested-map-ifelse-test.tsx",
    "dev/render-test/render-test.tsx",
    "dev/self-reference-test/self-reference-test.tsx",
    "examples/aside/aside.tsx",
    "examples/compiler/compiler.tsx",
    "examples/form-demo/form-demo.tsx",
    "examples/group-chat-lobby/group-chat-lobby.tsx",
    "examples/group-chat-room/group-chat-room.tsx",
    "examples/image/image.tsx",
    "examples/link-preview/link-preview.tsx",
    "examples/map-demo/map-demo.tsx",
    "examples/mobile-app-demo/mobile-app-demo.tsx",
    "examples/pattern-index/pattern-index.tsx",
    "examples/profile-roster-live-demo/profile-roster-live-demo.tsx",
    "examples/text-swapper/text-swapper.tsx",
    "showcase/dice/dice.tsx",
    "system/chatbot/chatbot.tsx",
    "system/self/self.tsx",
  ];
  assert(patterns.length > 0, "The pattern compilation suite has no cases.");
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
