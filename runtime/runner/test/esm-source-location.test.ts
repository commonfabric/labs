import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { getComposeBundleSourceMapCallsForTesting } from "@commonfabric/js-compiler/source-map";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Module, Pattern } from "../src/builder/types.ts";
import { resolvePolicyFacingImplementationIdentity } from "../src/cfc/implementation-identity.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";

// Regression boundary for the ESM loader's two independent source mechanisms:
// builder `fn.src` comes from the compiler sidecar, while source maps remain
// lazy and are composed only if an error stack asks for them.

const signer = await Identity.fromPassphrase("test operator");

const program: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { Cell, Default, handler, pattern } from 'commonfabric';",
      "const inc = handler<unknown, { count: Cell<number> }>(",
      "  (_event, { count }) => { count.set(count.get() + 1); },",
      ");",
      "export default pattern<{ count: number | Default<0> }>(({ count }) => {",
      "  return { count, inc: inc({ count }) };",
      "});",
    ].join("\n"),
  }],
};

function handlerModuleOf(compiled: Pattern): Module {
  const nodes = (compiled as Pattern & { nodes: { module: Module }[] }).nodes;
  const module = nodes
    .map((node) => node.module)
    .find((candidate) =>
      candidate?.type === "javascript" && candidate.wrapper === "handler" &&
      typeof candidate.implementation === "function"
    );
  if (!module) throw new Error("No verified handler node found.");
  return module;
}

describe("ESM loader source locations", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("serves sidecar-backed fn.src without composing an error source map", async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const before = getComposeBundleSourceMapCallsForTesting();
    const compiled = await runtime.patternManager.compilePattern(program);
    const module = handlerModuleOf(compiled);
    const implementation = module.implementation as
      & ((...args: unknown[]) => unknown)
      & { src?: string };

    expect(implementation.src).toMatch(
      /^cf:module\/[^/]+\/main\.tsx:3:2$/,
    );
    expect(getComposeBundleSourceMapCallsForTesting()).toBe(before);

    const identity = resolvePolicyFacingImplementationIdentity(module, {
      implementation,
    });
    expect(identity?.kind).toBe("verified");
  });
});
