/**
 * A stand-in for the participant workers the multi-user orchestrator starts,
 * whose replies the test gives, and a helper that puts it in place of `Worker`
 * for the length of a test body.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { isObjectOrArray } from "@commonfabric/js-values/types";
import type {
  ParticipantInitResult,
  StepMeta,
  WorkerQuiescenceAnswer,
  WorkerRequest,
} from "../lib/multi-user-test-worker.ts";

/** A worker whose replies the test gives, recording what it is sent. */
export class ControlledWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: (WorkerRequest | WorkerQuiescenceAnswer)[] = [];
  terminated = false;

  constructor(
    readonly name: string,
    readonly onRequest: (
      worker: ControlledWorker,
      request: WorkerRequest,
    ) => void,
  ) {}

  postMessage(message: WorkerRequest | WorkerQuiescenceAnswer): void {
    this.posted.push(message);
    if ("cmd" in message) this.onRequest(this, message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Delivers `data` as a message from the worker. */
  deliver(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  /** Answers `request` as an ordinary participant with `steps` would. */
  answer(
    request: WorkerRequest,
    steps: StepMeta[] = [{ kind: "assertion" }],
  ): void {
    let ok: unknown;
    switch (request.cmd) {
      case "init":
        ok = {
          steps,
          allowRuntimeErrors: false,
          expectRuntimeErrors: undefined,
          expectNonIdempotent: false,
          allowConsoleErrors: false,
          allowConsoleWarnings: false,
          cfcEnforcementMode: "enforce-strict",
          cfcFlowLabels: "off",
        } satisfies ParticipantInitResult;
        break;
      case "assertion":
        ok = { passed: true };
        break;
      case "health":
        ok = {
          runtimeErrors: [],
          nonIdempotent: [],
          consoleErrors: [],
          consoleWarnings: [],
        };
        break;
    }
    this.deliver({ id: request.id, ok });
  }

  /** Answers `request` with an error. */
  refuse(request: WorkerRequest, error: string): void {
    this.deliver({ id: request.id, error });
  }

  /** Reports a fatal worker error, as opposed to a failed request. */
  fail(): void {
    this.onerror?.(
      new ErrorEvent("error", { message: "worker crashed", cancelable: true }),
    );
  }
}

/** The name a `new Worker(specifier, options)` call gives its worker. */
function workerName(args: unknown[]): string {
  const options = args[1];
  return isObjectOrArray(options) && typeof options.name === "string"
    ? options.name
    : "";
}

/**
 * Runs `run` with `Worker` replaced by {@link ControlledWorker}s answering
 * through `onRequest`, calling `onCreate` as each is made, and expects every
 * one of them to have been terminated when `run` ends.
 */
export async function withWorkers(
  onRequest: ControlledWorker["onRequest"],
  run: (workers: ControlledWorker[]) => Promise<void>,
  onCreate?: () => void,
): Promise<void> {
  const workers: ControlledWorker[] = [];
  using _worker = stub(
    globalThis,
    "Worker",
    function (...args: unknown[]): ControlledWorker {
      const worker = new ControlledWorker(workerName(args), onRequest);
      workers.push(worker);
      onCreate?.();
      return worker;
    },
  );
  await run(workers);
  expect(workers.every((worker) => worker.terminated)).toBe(true);
}
