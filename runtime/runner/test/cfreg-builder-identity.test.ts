import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  createHoistRegistrar,
  type HoistRegistrationSink,
} from "../src/sandbox/module-record-compiler.ts";

describe("createHoistRegistrar", () => {
  // Unit coverage for the per-module `__cfReg` registrar: run-once,
  // closed-window, and transactional (commit-only-on-success) semantics — the
  // integrity guarantees that let the verifier stay simple.

  it("stages entries and commits them to the sink", () => {
    const sink: HoistRegistrationSink = new Map();
    const { register, commit } = createHoistRegistrar("idA", sink);
    const a = {}, b = {};
    register({ __cfPattern_1: a, __cfLift_1: b });
    // Not visible until commit.
    expect(sink.has("idA")).toBe(false);
    commit();
    expect([...sink.get("idA")!.entries()]).toEqual([
      ["__cfPattern_1", a],
      ["__cfLift_1", b],
    ]);
  });

  it("throws on a second __cfReg call (run-once trap)", () => {
    const { register } = createHoistRegistrar("idB", new Map());
    register({ __cfPattern_1: {} });
    expect(() => register({ __cfPattern_2: {} })).toThrow(
      /at most once/,
    );
  });

  it("throws when called after the window closes (commit)", () => {
    const { register, commit } = createHoistRegistrar("idC", new Map());
    commit();
    expect(() => register({ __cfPattern_1: {} })).toThrow(
      /after module evaluation completed/,
    );
  });

  it("commits nothing when the module never registered", () => {
    const sink: HoistRegistrationSink = new Map();
    const { commit } = createHoistRegistrar("idD", sink);
    commit();
    expect(sink.size).toBe(0);
  });

  it("rejects a non-object registration argument", () => {
    const { register } = createHoistRegistrar("idE", new Map());
    expect(() => register(null as never)).toThrow(/object/);
  });
});

describe("hoisted builder artifacts are addressable by {identity, symbol}", () => {
  // End-to-end: under the ESM loader, the hoisted builder artifacts a module
  // produces are registered via `__cfReg` and become addressable by their
  // content-addressed `{ identity, symbol }` reference — with no module exports
  // and no source re-parsing. This source hoists a pattern (the `.map` op) AND
  // a lift (a reactive computation), proving the mechanism generalizes beyond
  // patterns; handlers travel the identical branded node-factory path.

  const PROGRAM: RuntimeProgram = {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: `import { Cell, pattern, UI } from "commonfabric";
interface State {
  items: Array<{ price: number }>;
  discount: number;
  selectedIndex: Cell<number>;
}
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items.map((item, index) => (
          <div>
            <span>{item.price * state.discount}</span>
            <button type="button" onClick={() => state.selectedIndex.set(index)}>
              Select
            </button>
          </div>
        ))}
      </div>
    ),
  };
});
`,
    }],
  };

  it("registers pattern and lift hoists and resolves them", async () => {
    const signer = await Identity.fromPassphrase("cfreg-builder-identity");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const compiled = await runtime.patternManager.compilePattern(PROGRAM);
      const pm = runtime.patternManager;
      const entryRef = pm.getArtifactEntryRef(compiled);
      expect(entryRef).toBeDefined();
      const { identity } = entryRef!;

      // Reach into the reverse index to enumerate what this module registered.
      const hoists = pm.accessForTestingOnly.addressableByIdentity.get(
        identity,
      );
      const symbols = [...(hoists?.keys() ?? [])];

      // A pattern (map op) and a non-pattern artifact (lift) were both hoisted
      // and registered — the generalization beyond patterns.
      expect(symbols.some((s) => s.startsWith("__cfPattern_"))).toBe(true);
      expect(symbols.some((s) => s.startsWith("__cfLift_"))).toBe(true);

      for (const symbol of symbols) {
        // Reverse: { identity, symbol } resolves synchronously to a live value.
        const value = pm.artifactFromIdentitySync(identity, symbol);
        expect(value).toBeDefined();
        // Forward: that live value reports the same { identity, symbol }.
        expect(pm.getArtifactEntryRef(value as never)).toEqual({
          identity,
          symbol,
        });
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("registers an authored non-exported top-level builder const", async () => {
    // A module-scope `const helper = lift(...)` is not a module export, so it
    // can only be reached via `__cfReg` (keyed by its binding name). An exported
    // artifact, by contrast, stays addressable through the module namespace.
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "import { pattern, lift } from 'commonfabric';",
          "const helper = lift((x: number) => x + 1);",
          "export const named = pattern<{ n: number }>(({ n }) => ({ n }));",
          "export default pattern<{ items: number[] }>(({ items }) =>",
          "  ({ vs: items.map((x) => helper(x)) }));",
        ].join("\n"),
      }],
    };
    const signer = await Identity.fromPassphrase("cfreg-authored-const");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const compiled = await runtime.patternManager.compilePattern(program);
      const pm = runtime.patternManager;
      const { identity } = pm.getArtifactEntryRef(compiled)!;
      // Non-exported const → reachable only via __cfReg.
      expect(pm.artifactFromIdentitySync(identity, "helper")).toBeDefined();
      // Exported pattern → reachable via the module namespace.
      expect(pm.artifactFromIdentitySync(identity, "named")).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("returns undefined for an unknown reference (caller falls back)", async () => {
    const signer = await Identity.fromPassphrase("cfreg-builder-identity-miss");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      expect(
        runtime.patternManager.artifactFromIdentitySync(
          "cf-module-does-not-exist",
          "__cfPattern_1",
        ),
      ).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
