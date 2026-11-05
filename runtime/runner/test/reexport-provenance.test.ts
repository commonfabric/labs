import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { resolvePolicyFacingImplementationIdentity } from "../src/cfc/implementation-identity.ts";
import {
  getDefiningModule,
  getVerifiedProvenance,
  recordDefiningModule,
} from "../src/harness/verified-provenance.ts";
import type { Module, Pattern } from "../src/builder/types.ts";
import type { HarnessedFunction } from "../src/harness/types.ts";

/**
 * Regression for the re-export provenance hazard (Codex review of PR C):
 *
 * A re-exporting module (`export { setName } from "./handlers"`) surfaces the
 * defining module's function under the RE-EXPORTER's identity. Provenance is
 * first-write-wins, so letting the re-exporter (potentially visited first)
 * stamp its own identity would give a genuinely-verified handler the wrong
 * authority. The defining module is recorded independently during evaluation;
 * the provenance walk accepts only that identity. Debug `fn.src` is not read.
 */

const signer = await Identity.fromPassphrase("reexport-provenance");

const PROGRAM = {
  main: "/main.tsx",
  files: [
    {
      name: "/handlers.tsx",
      contents: `/// <cts-enable />
import { handler, Writable } from "commonfabric";
export const setName = handler<{ name?: string }, { name: Writable<string> }>(
  (event, state) => { state.name.set(event.name ?? ""); },
);
`,
    },
    {
      // The entry re-exports the handler AND uses it, so the entry module is
      // evaluated/indexed and surfaces `setName` under its own identity.
      name: "/main.tsx",
      contents: `/// <cts-enable />
import { pattern, Writable } from "commonfabric";
import { setName } from "./handlers.tsx";
export { setName } from "./handlers.tsx";
export default pattern(() => {
  const name = new Writable<string>("").for("name");
  return { name, setName: setName({ name }) };
});
`,
    },
  ],
};

describe("re-export provenance", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("a re-exported handler still resolves as verified (defining identity wins)", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const pattern = await runtime.patternManager.compilePattern(
      PROGRAM,
    ) as Pattern;
    await runtime.idle();

    const node = pattern.nodes.find((n) =>
      (n.module as Module).type === "javascript" &&
      (n.module as Module).wrapper === "handler"
    );
    expect(node).toBeDefined();
    const module = node!.module as Module;
    const fn = module.implementation as HarnessedFunction;

    // Provenance identity is the DEFINING module (handlers.tsx), never the
    // re-exporting entry. `.src` is now lazy/debug-only, so the guard is
    // re-rooted onto the defining-module stamp (recorded at each module's
    // dependency-ordered evaluation): the defining module's stamp equals the
    // provenance identity that stuck. Under the bug (re-exporter visited first,
    // no guard) the re-exporter's identity would have stamped provenance instead,
    // so these would DIFFER.
    const provenance = getVerifiedProvenance(fn);
    expect(provenance).toBeDefined();
    expect(getDefiningModule(fn)).toBe(provenance!.identity);

    // CFC resolves it as verified — NOT unsupported. With the wrong (re-exporter)
    // identity, a `writeAuthorizedBy` claim naming the defining module would be
    // denied.
    const identity = resolvePolicyFacingImplementationIdentity(module, {
      implementation: fn,
    });
    expect(identity?.kind).toBe("verified");
  });
});

Deno.test("defining-module stamps: non-function values are ignored; first write wins", () => {
  // Non-functions never enter the WeakMap (mirrors recordVerifiedProvenance).
  recordDefiningModule({ not: "a function" }, "MODULE_X");
  expect(getDefiningModule({ not: "a function" })).toBe(undefined);
  expect(getDefiningModule("also not")).toBe(undefined);

  // First-write-wins: the defining (dependency-first) module's stamp sticks;
  // a later re-exporter's stamp is a no-op.
  const fn = () => {};
  recordDefiningModule(fn, "DEFINER");
  recordDefiningModule(fn, "REEXPORTER");
  expect(getDefiningModule(fn)).toBe("DEFINER");
});
