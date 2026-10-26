import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { observeCacheWriteBacks } from "./support/telemetry-observers.ts";

/**
 * Open question 2 (docs/specs/content-addressed-action-identity.md) resolved:
 * the artifact index (`addressableByIdentity`) is SESSION-LIFETIME — a builder
 * artifact indexed by module evaluation stays synchronously resolvable for the
 * rest of the session, no matter how many other modules evaluate afterwards.
 *
 * This is what lets the op sentinel drop its embedded `$opFallback` graph and
 * the JSON boundary go refs-only: any pattern whose module evaluated in this
 * session (every authored op — its module is part of the running piece's
 * bundle by construction) resolves via `artifactFromIdentitySync`, eviction-
 * free. The module-namespace cache (`modulesByIdentity`) stays bounded: its
 * misses recover through the async storage-backed load.
 */

const signer = await Identity.fromPassphrase("artifact-index-pinning");

const program = (n: number): RuntimeProgram => ({
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        `export default pattern<{ items: { v: number }[] }>(({ items }) => {`,
        `  return { vs${n}: items.map((item) => item.v) };`,
        "});",
      ].join("\n"),
    },
  ],
});

describe("artifact index pinning (session-lifetime)", () => {
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

  it("an indexed artifact stays sync-resolvable past the module-cache bound", async () => {
    const pm = runtime.patternManager;
    // Shrink the bounded module-namespace cache so three compiles overflow it.
    // The ARTIFACT index must not be governed by this bound.
    pm.accessForTestingOnly.maxEvaluatedModuleCacheSize = 1;

    const first = await pm.compilePattern(program(1));
    const firstRef = pm.getArtifactEntryRef(first);
    expect(firstRef).toBeDefined();

    await pm.compilePattern(program(2));
    await pm.compilePattern(program(3));

    // The first pattern's module rolled out of the bounded namespace cache,
    // but its artifacts are pinned for the session: the sync resolution the
    // list builtins depend on still hits.
    const resolved = pm.artifactFromIdentitySync(
      firstRef!.identity,
      firstRef!.symbol,
    );
    expect(resolved).toBe(first);

    // The hoisted op of the first pattern resolves too (what a map node's
    // sentinel looks up mid-session).
    const op = pm.artifactFromIdentitySync(firstRef!.identity, "__cfPattern_1");
    expect(op).toBeDefined();
  });

  it("a cold compile persists the closure before the pattern exists", async () => {
    // The refs-only boundary contract: artifact persistence is PART OF the
    // compilation step, not a best-effort write racing session end. A cell
    // write can only contain a $patternRef after compilePattern returned, so
    // awaiting the cold write-back inside compilePattern guarantees every
    // persisted ref has a durable closure behind it.
    const pm = runtime.patternManager;
    const tx = runtime.edit();
    const writeBacks = observeCacheWriteBacks(runtime);
    await pm.compilePattern(program(7), { space: signer.did(), tx });
    expect(writeBacks.started()).toBeGreaterThan(0);
    expect(writeBacks.inFlight()).toBe(0);
    writeBacks.restore();
    await tx.commit().settled;
  });
});
