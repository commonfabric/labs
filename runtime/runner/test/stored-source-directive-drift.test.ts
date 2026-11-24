import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  Engine,
  Runtime,
  signer,
  StorageManager,
} from "./engine-test-support.ts";

// A `@ts-expect-error` that was valid when a pattern was AUTHORED becomes
// "unused" (TS2578) once the platform's vendored types improve (a `jsx.d.ts`
// that gains a property, say). A hard failure on recompiling the same stored
// bytes at load would stop every piece embedding them from loading. The split
// contract under test:
//
// - the STORED-source reload path (`compileResolvedToRecordGraph`, the only
//   compile of bytes nobody can re-author under a toolchain newer than the
//   one that accepted them) tolerates the stale directive;
// - AUTHORING compiles (`compilePattern` — cf check, deploy, corpus) stay
//   strict, because there the author is present and the fix is removal.

const space = signer.did();

// Valid TypeScript whose directive suppresses nothing — the exact shape a
// platform type-improvement leaves behind in stored source.
const DRIFTED_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "const add = (x: number, y: number): number => x + y;",
  "// @ts-expect-error -- suppressed an error under an older type env",
  "const total = add(1, 2);",
  "export default pattern<Record<string, never>, { total: number }>(() => {",
  "  return { total };",
  "});",
  "",
].join("\n");

describe("stored-source directive drift", () => {
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

  it("the stored-source reload path compiles despite the stale directive", async () => {
    const compiled = await engine.compileResolvedToRecordGraph(
      [{ name: "/main.tsx", contents: DRIFTED_SOURCE }],
      "/main.tsx",
      { fabricImports: { space } },
    );
    expect(compiled.entryIdentity).toBeDefined();
    expect(compiled.modules.length).toBeGreaterThan(0);
  });

  it("authoring compiles stay strict on the same source", async () => {
    await expect(
      runtime.patternManager.compilePattern(
        {
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: DRIFTED_SOURCE }],
        },
        { space },
      ),
    ).rejects.toThrow("Unused '@ts-expect-error' directive.");
  });
});
