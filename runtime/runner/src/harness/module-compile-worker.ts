import { debugStr } from "@commonfabric/data-model";
import type { CompiledTypeScriptModule } from "@commonfabric/js-compiler";

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
   * Compiles `request` in the worker.
   *
   * @throws Error when this instance is closed.
   */
  compile(
    request: ModuleCompileRequest,
  ): Promise<Map<string, CompiledTypeScriptModule>> {
    if (this.#closed) {
      return Promise.reject(
        markPlaceCompileFailure(new Error("The compile worker is closed")),
      );
    }
    const generation = this.#generation ??= this.#start();
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<
      Map<string, CompiledTypeScriptModule>
    >();
    generation.pending.set(id, { request, resolve, reject });
    const message: CompileWorkerRequest = { id, request };
    if (generation.ready) {
      this.#post(generation, message);
    } else {
      generation.queued.push(message);
    }
    return promise;
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
   * Helper for `compile()` and `#settle()`, which sends `message` to the
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
  readonly pending: Map<number, {
    readonly request: ModuleCompileRequest;
    resolve(modules: Map<string, CompiledTypeScriptModule>): void;
    reject(error: Error): void;
  }>;
};
