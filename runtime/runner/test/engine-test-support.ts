import { Identity } from "@commonfabric/identity";
import type { CompiledModuleGraph } from "../src/sandbox/module-record-compiler.ts";
import type { Engine as EngineHarness } from "../src/harness/engine.ts";
import type { RuntimeProgram as Program } from "../src/harness/types.ts";

export { InMemoryProgram } from "@commonfabric/js-compiler";
export { getVerifiedProvenance } from "../src/harness/verified-provenance.ts";
export { StorageManager } from "../src/storage/cache.deno.ts";
export { Runtime } from "../src/runtime.ts";
export { Engine } from "../src/harness/engine.ts";
export type { RuntimeProgram } from "../src/harness/types.ts";

export const signer = await Identity.fromPassphrase("test operator");

// All authored modules' compiled CommonJS bodies, joined — the ESM analog of
// the old single-bundle `jsScript.js` for transformer-output assertions.
export const joinedBodies = (graph: CompiledModuleGraph): string =>
  [...graph.compiledBodies.values()].join("\n");

/**
 * Compile `program`, then compile it again with `entryJs` standing in for the
 * entry module's compiled body.
 *
 * The SES body verifier runs on compiled bodies, so reaching it with a module
 * the transformer would never emit means supplying that body directly. The
 * engine treats caller-supplied bodies as untrusted — `trustedBodies` is never
 * honored for them — so the verifier still inspects what is handed over, which
 * is the threat the verifier exists for: bytes that did not come from our own
 * compiler.
 *
 * The first compile is what learns the identities the engine assigns, and the
 * whole closure is resupplied because a partial set is ignored.
 */
export async function compileWithEntryBody(
  engine: EngineHarness,
  program: Program,
  entryJs: string,
) {
  const compiled = await engine.compileToRecordGraph(program);
  const precompiledModules = new Map(
    compiled.modules.map((module) => [
      module.identity,
      module.identity === compiled.entryIdentity
        ? { js: entryJs }
        : { js: module.js },
    ]),
  );
  return await engine.compileToRecordGraph(program, { precompiledModules });
}

/**
 * {@link compileWithEntryBody} for the paths that also evaluate: the entry
 * module's compiled body is replaced the same way, so a guard that fires while
 * a module builds — rather than while it is verified — is reachable too.
 */
export async function evaluateWithEntryBody(
  engine: EngineHarness,
  program: Program,
  entryJs: string,
) {
  const compiled = await engine.compileToRecordGraph(program);
  const precompiledModules = new Map(
    compiled.modules.map((module) => [
      module.identity,
      module.identity === compiled.entryIdentity
        ? { js: entryJs }
        : { js: module.js },
    ]),
  );
  return await engine.compileAndEvaluateModules(program, {
    precompiledModules,
  });
}
