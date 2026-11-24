/**
 * A fixed number of compile workers that a process's runtimes compile in
 * together, so the process holds that many compiler heaps however many
 * runtimes or serving workers it runs.
 */

import type { CompiledTypeScriptModule } from "@commonfabric/js-compiler";

import {
  COMPILE_WORKER_LOGGER_PREFIX,
  type CompileWorkerDiagnostics,
  ModuleCompileWorker,
} from "./module-compile-worker.ts";
import type { ModuleCompiler, ModuleCompileRequest } from "./module-compile.ts";

/**
 * Runs each compile on whichever of its {@link ModuleCompileWorker}s holds the
 * fewest, the first of them on a tie. Each worker starts at its first compile,
 * so a pool that is never asked to compile starts none, and a busy one starts
 * a second only once the first holds a compile. A worker that dies fails what
 * it held and starts afresh at its next compile, as a lone one does.
 */
export class ModuleCompilerPool implements ModuleCompiler {
  readonly #workers: readonly ModuleCompileWorker[];

  /** How many compiles each worker holds, by index into `#workers`. */
  readonly #held: number[];

  /**
   * Constructs a pool of `size` compile workers, each started by
   * `startWorker` when one is given.
   *
   * @throws RangeError when `size` is not a positive integer.
   */
  constructor(size: number, startWorker?: () => Worker) {
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError(
        `A compile pool holds one worker or more, not ${size}`,
      );
    }
    this.#workers = Array.from(
      { length: size },
      () => new ModuleCompileWorker(startWorker),
    );
    this.#held = this.#workers.map(() => 0);
  }

  /** How many compile workers the pool holds. */
  get size(): number {
    return this.#workers.length;
  }

  async compile(
    request: ModuleCompileRequest,
  ): Promise<Map<string, CompiledTypeScriptModule>> {
    let index = 0;
    for (let i = 1; i < this.#held.length; i++) {
      if (this.#held[i] < this.#held[index]) index = i;
    }
    this.#held[index] += 1;
    try {
      return await this.#workers[index].compile(request);
    } finally {
      this.#held[index] -= 1;
    }
  }

  /**
   * Each worker's loggers as `ModuleCompileWorker.diagnostics()` returns
   * them. The first worker's keep their names; each later one's prefix carries
   * its index, `compile-worker[1]:` and on, so that no two workers' loggers
   * share a name.
   */
  diagnostics(): CompileWorkerDiagnostics {
    const timingStats: Record<
      string,
      CompileWorkerDiagnostics["timingStats"][string]
    > = {};
    const loggerCounts: Record<
      string,
      CompileWorkerDiagnostics["loggerCounts"][string]
    > = {};
    this.#workers.forEach((worker, index) => {
      const rename = (name: string) =>
        index === 0
          ? name
          : `compile-worker[${index}]:${
            name.slice(COMPILE_WORKER_LOGGER_PREFIX.length)
          }`;
      const { timingStats: timings, loggerCounts: counts } = worker
        .diagnostics();
      for (const [name, value] of Object.entries(timings)) {
        timingStats[rename(name)] = value;
      }
      for (const [name, value] of Object.entries(counts)) {
        loggerCounts[rename(name)] = value;
      }
    });
    return { timingStats, loggerCounts };
  }

  /** Ends every worker, failing every compile they still held. */
  close(): void {
    for (const worker of this.#workers) worker.close();
  }
}
