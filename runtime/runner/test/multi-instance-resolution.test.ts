import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";

/**
 * PR D regression guard (docs/history/specs/content-addressed-action-
 * identity-implementation-plan.md): the pattern-scoped function registries
 * (`verifiedPatternFunctions` / `verifiedPatternLoadIds` / `associatePattern`)
 * were deleted. They existed to disambiguate equal `implementationRef`s across
 * separate loads of the same module; under content addressing that
 * disambiguation is unnecessary because the SES verifier forbids module-scope
 * mutable state, so any live instance of one module identity is interchangeable
 * (instance state flows through inputs, never closures).
 *
 * This pins that property end-to-end: two pieces compiled from BYTE-IDENTICAL
 * programs (two distinct loads) each run their handler correctly and keep their
 * own instance state isolated.
 */

const signer = await Identity.fromPassphrase("multi-instance-resolution");
const space = signer.did();

const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
import { handler, pattern, Default, Writable } from "commonfabric";
const bump = handler<{ by?: number }, { count: Writable<number> }>(
  (event, state) => { state.count.set(state.count.get() + (event.by ?? 1)); },
);
export default pattern<{ count: Default<number, 0> }>(() => {
  const count = new Writable<number>(0).for("count");
  return { count, bump: bump({ count }) };
});
`,
  }],
};

describe("multi-instance verified-function resolution", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("two loads of an identical program run and isolate per-instance state", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const runOne = async (cause: string) => {
      // A SEPARATE compile → distinct module-function instances sharing the
      // same content identity / implementationRef.
      const tx0 = runtime!.edit();
      const pattern = await runtime!.patternManager.compilePattern(PROGRAM, {
        space,
        tx: tx0,
      });
      const resultCell = runtime!.getCell<{ count: number }>(
        space,
        cause,
        undefined,
        tx0,
      );
      // deno-lint-ignore no-explicit-any
      const r = runtime!.run(tx0, pattern, {}, resultCell) as any;
      await tx0.commit().settled;
      await r.pull();
      return r;
    };

    const a = await runOne("instance-a");
    const b = await runOne("instance-b");

    // Drive each instance's handler a different number of times.
    a.key("bump").send({ by: 1 });
    a.key("bump").send({ by: 1 });
    a.key("bump").send({ by: 1 });
    b.key("bump").send({ by: 1 });
    await runtime.idle();

    // Each instance ran its handler (resolution succeeded across both loads)
    // and kept ISOLATED state — no cross-talk despite the shared
    // implementationRef / content identity.
    expect(a.key("count").get()).toBe(3);
    expect(b.key("count").get()).toBe(1);
  });
});
