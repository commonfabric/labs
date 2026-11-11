/**
 * A compile worker's entry: loaded in a Deno Worker, it runs the
 * type-check, transform and emit step of each compile its realm sends
 * (`ModuleCompileWorker`), one at a time, on the synchronous driver, since
 * nothing else shares this thread. It reads the TypeScript environment types
 * from this process's static assets, and sends with each answer a snapshot
 * of this realm's loggers, which hold the compiler's phase timings. The
 * protocol is `compile-worker-protocol.ts`; nothing outside a worker imports
 * this module.
 */

import {
  getLoggerCountsByKey,
  getTimingStatsBreakdown,
} from "@commonfabric/logger";
import { StaticCache } from "@commonfabric/static";

import {
  type CompileWorkerAnswer,
  decodeCompileWorkerRequest,
  encodeCompileFailure,
  type EncodedCompileFailure,
  encodeModules,
  type WorkerDiagnostics,
} from "./compile-worker-protocol.ts";
import { ensureCompilerStack } from "./deferred-compiler-stack.ts";
import { compileModulesHere } from "./module-compile.ts";

const post = (answer: CompileWorkerAnswer) => self.postMessage(answer);

type EncodedModules = ReturnType<typeof encodeModules>;

const compiler = (async () => {
  const stack = await ensureCompilerStack();
  const environmentTypes = await stack.getTypeScriptEnvironmentTypes(
    StaticCache.fromFileSystem(),
  );
  return new stack.TypeScriptCompiler(environmentTypes);
})();

// Only the compile itself runs inside the `try`. A compiler that could not be
// built, a message that does not decode, or an answer that cannot be posted
// rejects outside it: the rejection is unhandled and ends the worker, which
// is a failure of this worker and not of the compile it was sent.
self.addEventListener("message", async (event: MessageEvent) => {
  const { id, request } = decodeCompileWorkerRequest(event.data);
  const ready = await compiler;
  let outcome:
    | { readonly kind: "compiled"; readonly modules: EncodedModules }
    | { readonly kind: "failed"; readonly failure: EncodedCompileFailure };
  try {
    const modules = await compileModulesHere(ready, request, {
      interleave: false,
    });
    outcome = { kind: "compiled", modules: encodeModules(modules) };
  } catch (error) {
    outcome = { kind: "failed", failure: encodeCompileFailure(error) };
  }
  post({ ...outcome, id, diagnostics: diagnostics() });
});

/** This realm's loggers as they stand, taken once a compile has ended. */
function diagnostics(): WorkerDiagnostics {
  return {
    timeOrigin: performance.timeOrigin,
    timingStats: getTimingStatsBreakdown(),
    loggerCounts: getLoggerCountsByKey(),
  };
}

post({ kind: "ready" });
