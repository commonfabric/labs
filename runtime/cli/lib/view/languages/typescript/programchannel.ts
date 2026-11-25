/**
 * The channel between a semantic service and the worker that builds and holds
 * its TypeScript program. The service's queries are synchronous, because the
 * info card asks them while it builds. So the calling thread posts each query
 * on a message port and waits on a shared word until the worker has posted the
 * answer, then takes the answer off the port. The wait lasts as long as the
 * worker takes to answer: a few milliseconds once it has parsed the file asked
 * about and what that file imports, and otherwise as long as parsing them
 * takes.
 *
 * The calling thread waits only on a worker that has said, in the same word,
 * that it is serving. From then on the worker reports there any error that
 * would end it, including a failure to load TypeScript, which it loads only
 * after saying so. So a caller never waits on a worker that will not answer:
 * one whose module failed to load never says it is serving, and its queries
 * are answered elsewhere. Deno still prints that failure to standard error.
 * The worker loads its own copy of TypeScript.
 */

import {
  MessageChannel,
  type MessagePort as NodeMessagePort,
  receiveMessageOnPort,
} from "@node/worker_threads";

/** A definition site, in the coordinates of a file of the program. */
export interface DefinitionSite {
  readonly name: string;
  readonly fileName: string;
  readonly textSpan: { readonly start: number; readonly length: number };
}

/** The questions a built program answers, in the coordinates of its files. */
export interface ProgramQueries {
  /** The cleaned type string of the node at `offset` in `fileName`, or null. */
  typeAt(fileName: string, offset: number): string | null;

  /** Where the symbol at `offset` in `fileName` is defined. */
  definitionsAt(fileName: string, offset: number): readonly DefinitionSite[];
}

/** A program the thread that queries it builds. */
export interface LocalProgram extends ProgramQueries {
  /** Build the program now. */
  prewarm(): void;
}

/** A program a worker builds and queries. */
export interface WorkerProgram {
  /** The answer to `query`, or undefined when the worker is not serving. */
  ask(query: ProgramQuery): ProgramAnswer | undefined;

  /** End the worker. */
  dispose(): void;
}

export interface ProgramQuery {
  readonly question: keyof ProgramQueries;
  readonly fileName: string;
  readonly offset: number;
}

/** A worker's answer to a {@link ProgramQuery}. The field the query did not
 * ask about is empty. */
export interface ProgramAnswer {
  readonly type: string | null;
  readonly definitions: readonly DefinitionSite[];
}

/** The message that starts a worker serving the program `spec` describes.
 * The calling thread sends its port as Node's type, for receiveMessageOnPort;
 * the worker receives it as a web MessagePort. */
export interface ProgramWorkerMessage<Spec, Port = MessagePort> {
  readonly spec: Spec;

  /** The word that says how far the worker has got. */
  readonly state: Int32Array;

  /** The port queries arrive on and answers leave by. */
  readonly port: Port;
}

// The values of the state word, besides the 0 it starts at, which says the
// worker has not yet said it is serving.
const SERVING = 1;
const ANSWERED = 2;
const FAILED = 3;

/**
 * Starts the worker `startWorker` returns serving the program `spec`
 * describes. The worker builds the program at once. Returns undefined when
 * the worker cannot be started.
 */
export function workerProgram<Spec>(
  spec: Spec,
  startWorker: () => Worker,
): WorkerProgram | undefined {
  const state = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  let worker: Worker | undefined;
  try {
    worker = startWorker();
    const message: ProgramWorkerMessage<Spec, NodeMessagePort> = {
      spec,
      state,
      port: port2,
    };
    worker.postMessage(message, [port2]);
  } catch {
    worker?.terminate();
    port1.close();
    return undefined;
  }
  // Keep an error that ends the worker from ending this process too.
  worker.onerror = (event) => event.preventDefault();
  return {
    ask(query) {
      if (Atomics.load(state, 0) !== SERVING) return undefined;
      port1.postMessage(query);
      Atomics.wait(state, 0, SERVING);
      if (Atomics.compareExchange(state, 0, ANSWERED, SERVING) !== ANSWERED) {
        return undefined;
      }
      const answer: ProgramAnswer | undefined = receiveMessageOnPort(port1)
        ?.message;
      return answer;
    },
    dispose() {
      worker.terminate();
      port1.close();
    },
  };
}

/** Serve the program `load` gives for the message that started this worker:
 * say so, load and build the program, then answer each query that arrives.
 * Queries that arrive first wait for the program. */
export async function serveProgram<Spec>(
  { spec, state, port }: ProgramWorkerMessage<Spec>,
  load: (spec: Spec) => Promise<LocalProgram>,
): Promise<void> {
  const fail = (event: Event) => {
    event.preventDefault();
    signal(state, FAILED);
  };
  self.addEventListener("error", fail);
  self.addEventListener("unhandledrejection", fail);
  signal(state, SERVING);
  const program = await load(spec);
  port.onmessage = ({ data: query }: MessageEvent<ProgramQuery>) => {
    const { fileName, offset } = query;
    const answer: ProgramAnswer = query.question === "typeAt"
      ? { type: program.typeAt(fileName, offset), definitions: [] }
      : { type: null, definitions: program.definitionsAt(fileName, offset) };
    port.postMessage(answer);
    signal(state, ANSWERED);
  };
  program.prewarm();
}

function signal(state: Int32Array, value: number): void {
  Atomics.store(state, 0, value);
  Atomics.notify(state, 0);
}
