/**
 * A compile worker's entry: loaded in a Deno Worker, it runs the
 * type-check, transform and emit step of each compile its realm sends
 * (`ModuleCompileWorker`), one at a time, on the synchronous driver, since
 * nothing else shares this thread. It reads the TypeScript environment types
 * from this process's static assets. The protocol is
 * `compile-worker-protocol.ts`; nothing outside a worker imports this module.
 */

import { StaticCache } from "@commonfabric/static";

import {
  type CompileWorkerAnswer,
  decodeCompileWorkerRequest,
  encodeCompileFailure,
  encodeModules,
} from "./compile-worker-protocol.ts";
import { ensureCompilerStack } from "./deferred-compiler-stack.ts";
import { compileModulesHere } from "./module-compile.ts";

const post = (answer: CompileWorkerAnswer) => self.postMessage(answer);

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
  let answer: CompileWorkerAnswer;
  try {
    const modules = await compileModulesHere(ready, request, {
      interleave: false,
    });
    answer = { kind: "compiled", id, modules: encodeModules(modules) };
  } catch (error) {
    answer = { kind: "failed", id, failure: encodeCompileFailure(error) };
  }
  post(answer);
});

post({ kind: "ready" });
