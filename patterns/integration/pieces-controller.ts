import { PieceController, PiecesController } from "@commonfabric/piece/ops";
import { createCompileByteCache } from "@commonfabric/test-support/compile-byte-cache";
import { patternCoverageCollector } from "@commonfabric/integration/pattern-coverage";

export { PieceController, PiecesController };

type InitializePiecesControllerOptions = Parameters<
  typeof PiecesController.initialize
>[0];

export const moduleByteCache = createCompileByteCache();

export function initializePiecesController(
  options: Omit<
    InitializePiecesControllerOptions,
    "moduleByteCache" | "patternCoverage"
  >,
): Promise<PiecesController> {
  return PiecesController.initialize({
    ...options,
    moduleByteCache,
    // Off unless the run collects coverage. When it does, this controller must
    // collect too: it authors the space's pieces, and a browser that collects
    // coverage reads a different cached variant than an uninstrumented
    // controller writes, so it would recompile every pattern for itself.
    patternCoverage: patternCoverageCollector(),
  });
}
