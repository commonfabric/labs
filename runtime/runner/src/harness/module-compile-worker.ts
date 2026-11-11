/**
 * The realm side of a compile worker: `ModuleCompileWorker`, which runs a
 * runtime's compiles in a Worker of this process (`compile-worker.ts`), and
 * the prefix it puts on the worker realm's logger names when it reports their
 * timing statistics.
 */

import { debugStr } from "@commonfabric/data-model";
import type { CompiledTypeScriptModule } from "@commonfabric/js-compiler";
import type { TimingStatsBreakdown } from "@commonfabric/logger";

import { markPlaceCompileFailure } from "./compile-failure.ts";
import {
  type CompileWorkerAnswer,
  type CompileWorkerRequest,
  decodeCompileFailure,
  decodeCompileWorkerAnswer,
  decodeModules,
} from "./compile-worker-protocol.ts";
import type { ModuleCompiler, ModuleCompileRequest } from "./module-compile.ts";

/**
 * Runs compiles in a Worker of this process (`compile-worker.ts`), so that
 * the type-check, transform and emit step, and the heap it takes, are off
 * the thread of the realm that asked. The worker starts at the first compile
 * and serves compiles one at a time, in the order they were asked for.
 *
 * A worker that dies, from an uncaught error or a message it cannot clone,
 * fails every compile it held with an error marked as a failure of the place
 * the compile ran (`markPlaceCompileFailure()`), and the next compile starts a
 * fresh one. {@link ModuleCompileWorker.close} ends the worker and fails what
 * it held the same way.
 *
 * The compiler's own phase timings accumulate in the worker's realm, so
 * {@link ModuleCompileWorker.timingStats} reads them from there for the
 * realm that reports on its loggers.
 */
export class ModuleCompileWorker implements ModuleCompiler {
  readonly #workerModule: URL;
  #generation: WorkerGeneration | undefined;
  #nextId = 0;
  #closed = false;

  /**
   * Constructs an instance whose worker runs `workerModule`, by default this
   * package's `compile-worker.ts`.
   */
  constructor(
    workerModule: URL = new URL("./compile-worker.ts", import.meta.url),
  ) {
    this.#workerModule = workerModule;
  }

  /**
   * Compiles `request` in the worker. The returned promise rejects, as a
   * failure of the place the compile was to run, when this instance is
   * closed or its worker cannot be started.
   */
  compile(
    request: ModuleCompileRequest,
  ): Promise<Map<string, CompiledTypeScriptModule>> {
    if (this.#closed) {
      return Promise.reject(
        markPlaceCompileFailure(new Error("The compile worker is closed")),
      );
    }
    let generation: WorkerGeneration;
    try {
      generation = this.#generation ??= this.#start();
    } catch (error) {
      return Promise.reject(
        markPlaceCompileFailure(
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
    }
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<
      Map<string, CompiledTypeScriptModule>
    >();
    generation.pending.set(id, { kind: "compile", request, resolve, reject });
    this.#send(generation, { kind: "compile", id, request });
    return promise;
  }

  /**
   * The worker realm's timing statistics, each logger's name prefixed with
   * {@link COMPILE_WORKER_LOGGER_PREFIX} so they can sit beside this realm's
   * own. Before the first compile no worker runs, and there are none.
   *
   * @throws Error, as a rejection, when this instance is closed or the worker
   * dies before it answers.
   */
  timingStats(): Promise<TimingStatsBreakdown> {
    if (this.#closed) {
      return Promise.reject(new Error("The compile worker is closed"));
    }
    const generation = this.#generation;
    if (generation === undefined) return Promise.resolve({});
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<
      TimingStatsBreakdown
    >();
    generation.pending.set(id, { kind: "diagnostics", resolve, reject });
    this.#send(generation, { kind: "diagnostics", id });
    return promise.then((stats) =>
      Object.fromEntries(
        Object.entries(stats).map((
          [name, byKey],
        ) => [`${COMPILE_WORKER_LOGGER_PREFIX}${name}`, byKey]),
      )
    );
  }

  /** Ends the worker, failing every compile it still held. */
  close(): void {
    this.#closed = true;
    const generation = this.#generation;
    if (generation !== undefined) {
      this.#end(generation, new Error("The compile worker was closed"));
    }
  }

  /** Helper for `compile()`, which starts a worker. */
  #start(): WorkerGeneration {
    const worker = new Worker(this.#workerModule, { type: "module" });
    const generation: WorkerGeneration = {
      worker,
      ready: false,
      queued: [],
      pending: new Map(),
    };
    worker.addEventListener("message", (event: MessageEvent) => {
      this.#receive(generation, event.data);
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      // Handled here, so the error does not also end this realm.
      event.preventDefault();
      this.#end(
        generation,
        new Error(debugStr`The compile worker failed: $quote${event.message}`),
      );
    });
    worker.addEventListener("messageerror", () => {
      this.#end(
        generation,
        new Error("The compile worker sent a message that could not be read"),
      );
    });
    return generation;
  }

  /**
   * Helper for `#start()`, which handles one message from the worker. A
   * message that does not decode is a fault of this protocol, not of a
   * compile, so it ends the worker as a death does rather than escaping the
   * listener, where it would end this realm and leave the compiles unsettled.
   */
  #receive(generation: WorkerGeneration, data: unknown): void {
    try {
      this.#settle(generation, decodeCompileWorkerAnswer(data));
    } catch (error) {
      this.#end(
        generation,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /** Helper for `#receive()`, which acts on one decoded answer. */
  #settle(generation: WorkerGeneration, answer: CompileWorkerAnswer): void {
    if (answer.kind === "ready") {
      generation.ready = true;
      for (const message of generation.queued.splice(0)) {
        this.#post(generation, message);
      }
      return;
    }
    const waiting = generation.pending.get(answer.id);
    if (waiting === undefined) {
      throw new Error(
        `The compile worker answered request ${answer.id}, which it does not hold`,
      );
    }
    // Decoded before the request leaves `pending`, so a decode failure still
    // reaches it through `#end()`.
    if (answer.kind === "diagnostics") {
      if (waiting.kind !== "diagnostics") {
        throw new Error(
          `The compile worker answered compile ${answer.id} with diagnostics`,
        );
      }
      generation.pending.delete(answer.id);
      waiting.resolve(answer.timingStats);
      return;
    }
    if (waiting.kind !== "compile") {
      throw new Error(
        `The compile worker answered request ${answer.id} for diagnostics with a compile`,
      );
    }
    if (answer.kind === "compiled") {
      const modules = decodeModules(answer.modules);
      generation.pending.delete(answer.id);
      waiting.resolve(modules);
    } else {
      const error = decodeCompileFailure(answer.failure, waiting.request);
      generation.pending.delete(answer.id);
      waiting.reject(error);
    }
  }

  /**
   * Helper for `compile()` and `timingStats()`, which sends `message` now or,
   * before the worker is ready, once it is.
   */
  #send(generation: WorkerGeneration, message: CompileWorkerRequest): void {
    if (generation.ready) {
      this.#post(generation, message);
    } else {
      generation.queued.push(message);
    }
  }

  /**
   * Helper for `#send()` and `#settle()`, which sends `message` to the
   * worker. A request that cannot be cloned fails alone, as a failure of the
   * place it was to run, since no compile of its bytes was attempted.
   */
  #post(generation: WorkerGeneration, message: CompileWorkerRequest): void {
    try {
      generation.worker.postMessage(message);
    } catch (error) {
      const waiting = generation.pending.get(message.id);
      generation.pending.delete(message.id);
      waiting?.reject(
        markPlaceCompileFailure(
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
    }
  }

  /**
   * Helper for `close()` and `#start()`, which ends `generation`'s worker and
   * fails what it held with `cause`.
   */
  #end(generation: WorkerGeneration, cause: Error): void {
    if (this.#generation === generation) this.#generation = undefined;
    generation.worker.terminate();
    markPlaceCompileFailure(cause);
    for (const waiting of generation.pending.values()) waiting.reject(cause);
    generation.pending.clear();
    generation.queued.length = 0;
  }
}

/** One worker a {@link ModuleCompileWorker} started, and what it holds. */
type WorkerGeneration = {
  readonly worker: Worker;

  /** Whether the worker has posted `ready`, so a request can be sent to it. */
  ready: boolean;

  /** Requests asked for before the worker was ready, in order. */
  readonly queued: CompileWorkerRequest[];

  /** Requests the worker has not answered, by id. */
  readonly pending: Map<number, PendingRequest>;
};

/** A request a worker has not answered, and how to settle it. */
type PendingRequest =
  | {
    readonly kind: "compile";
    readonly request: ModuleCompileRequest;
    resolve(modules: Map<string, CompiledTypeScriptModule>): void;
    reject(error: Error): void;
  }
  | {
    readonly kind: "diagnostics";
    resolve(stats: TimingStatsBreakdown): void;
    reject(error: Error): void;
  };

/**
 * What {@link ModuleCompileWorker.timingStats} puts ahead of each of the
 * worker realm's logger names.
 */
export const COMPILE_WORKER_LOGGER_PREFIX = "compile-worker:";
