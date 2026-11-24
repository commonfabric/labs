/**
 * What the program worker tests share: a one-file program, and the program
 * worker with hooks a test can observe.
 */

import type { MessagePort as NodeMessagePort } from "@node/worker_threads";

import type { ProgramWorkerMessage } from "../../../../../lib/view/languages/typescript/programchannel.ts";
import {
  PROGRAM_WORKER,
  type ProgramSpec,
} from "../../../../../lib/view/languages/typescript/semantics.ts";

export const TEXT = "const x: number = 1;\nconst y = x;\n";

export const SPEC: ProgramSpec = {
  sections: [{ name: "/m.ts", start: 0, end: TEXT.length, text: TEXT }],
  importMap: {},
  libDir: undefined,
  cwd: Deno.cwd(),
  root: Deno.cwd(),
  extraRoots: [],
};

/** Where the `x` that `y` reads is defined. */
export const X_DEFINITION = [{
  name: "x",
  fileName: "/m.ts",
  textSpan: { start: TEXT.indexOf("x"), length: 1 },
}];

/** A worker that loads, and never says it is serving. */
export const SILENT_WORKER = new URL("./silent-worker.ts", import.meta.url);

/** A program worker that says it is serving, then fails to load its
 * program. */
export const UNLOADABLE_PROGRAM_WORKER = new URL(
  "./unloadable-program-worker.ts",
  import.meta.url,
);

export type StartMessage = ProgramWorkerMessage<ProgramSpec, NodeMessagePort>;

/**
 * The worker of `url`, the program worker by default, sent `alter(message)`
 * in place of the message that starts it. It counts how often it is ended,
 * and says when it leaves its starting state and when it fails.
 */
export class ProgramWorker extends Worker {
  readonly #alter: (message: StartMessage) => unknown;
  readonly #errored = Promise.withResolvers<void>();
  #state: Int32Array = new Int32Array(new SharedArrayBuffer(4));
  #terminations = 0;

  constructor(
    { alter = (message) => message, url = PROGRAM_WORKER }: {
      alter?: (message: StartMessage) => unknown;
      url?: URL;
    } = {},
  ) {
    super(url, { type: "module" });
    this.#alter = alter;
    this.addEventListener("error", () => this.#errored.resolve());
  }

  /** Resolves once an error has ended the worker. */
  get errored(): Promise<void> {
    return this.#errored.promise;
  }

  get terminations(): number {
    return this.#terminations;
  }

  /** Resolves once the worker has said it is serving, or has failed. */
  async started(): Promise<void> {
    const wait = Atomics.waitAsync(this.#state, 0, 0);
    if (wait.async) await wait.value;
  }

  override postMessage(message: StartMessage): void {
    this.#state = message.state;
    super.postMessage(this.#alter(message), [message.port]);
  }

  override terminate(): void {
    this.#terminations++;
    super.terminate();
  }
}
