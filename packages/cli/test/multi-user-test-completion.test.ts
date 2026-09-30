import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { runMultiUserTestPattern } from "../lib/multi-user-test-runner.ts";
import type {
  ParticipantInitResult,
  WorkerRequest,
  WorkerResponse,
} from "../lib/multi-user-test-worker.ts";

/** Control worker replies while exercising the real orchestrator. */
class ControlledWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;

  constructor(
    readonly name: string,
    readonly onRequest: (
      worker: ControlledWorker,
      request: WorkerRequest,
    ) => void,
  ) {}

  postMessage(request: WorkerRequest): void {
    this.onRequest(this, request);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Deliver the response for a successful, ordinary participant. */
  answer(request: WorkerRequest): void {
    let ok: unknown;
    switch (request.cmd) {
      case "init":
        ok = {
          steps: [
            { kind: "action" },
            { kind: "render" },
            { kind: "settle" },
            { kind: "assertion" },
          ],
          allowRuntimeErrors: false,
          expectNonIdempotent: false,
          allowConsoleErrors: false,
          allowConsoleWarnings: false,
          cfcEnforcementMode: "enforce-explicit",
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
    this.onmessage?.(
      new MessageEvent("message", {
        data: { id: request.id, ok },
      }),
    );
  }

  /** Report a fatal worker error, as opposed to a failed individual request. */
  fail(): void {
    this.onerror?.(
      new ErrorEvent("error", {
        message: "worker crashed",
        cancelable: true,
      }),
    );
  }
}

/** Replace only the worker transport; storage and orchestration remain real. */
async function withWorkers(
  onRequest: ControlledWorker["onRequest"],
  run: (workers: ControlledWorker[]) => Promise<void>,
  onCreate?: () => void,
): Promise<void> {
  const workers: ControlledWorker[] = [];
  using _worker = stub(
    globalThis,
    "Worker",
    function (...args: unknown[]) {
      const options = args[1] as WorkerOptions;
      const worker = new ControlledWorker(options.name!, onRequest);
      workers.push(worker);
      onCreate?.();
      return worker;
    },
  );
  await run(workers);
  expect(workers.every((worker) => worker.terminated)).toBe(true);
}

const meta = { participants: [{ name: "alice", user: "alice" }] };

describe("multi-user-test completion", () => {
  for (
    const command of [
      "init",
      "action",
      "render",
      "settleStep",
      "assertion",
      "health",
      "dispose",
    ]
  ) {
    it(`waits for the ${command} response after three minutes have elapsed`, async () => {
      using resources = new DisposableStack();
      let time: FakeTime;
      const held = Promise.withResolvers<{
        worker: ControlledWorker;
        request: WorkerRequest;
      }>();
      await withWorkers((worker, request) => {
        if (request.cmd === command) held.resolve({ worker, request });
        else queueMicrotask(() => worker.answer(request));
      }, async () => {
        let completed = false;
        const running = runMultiUserTestPattern("controlled.test.tsx", meta)
          .finally(() => completed = true);
        void running.catch(() => {});
        const { worker, request } = await Promise.race([
          held.promise,
          running.then((result) => {
            throw new Error(result.error ?? "Run completed before the request");
          }),
        ]);
        try {
          await time.tickAsync(180_001);
          expect(completed).toBe(false);
        } finally {
          resources.dispose();
          worker.answer(request);
          await running.catch(() => {});
        }
        const result = await running;
        expect(result.error).toBeUndefined();
        expect(result.results.map(({ passed }) => passed)).toEqual([true]);
      }, () => time = resources.use(new FakeTime()));
    });
  }

  it("reports a worker that fails during initialization", async () => {
    await withWorkers((worker) => worker.fail(), async () => {
      const result = await runMultiUserTestPattern("controlled.test.tsx", meta);
      expect(result.error).toContain("[alice] worker error: worker crashed");
    });
  });

  for (const command of ["action", "dispose"]) {
    it(`fails the run when a worker crashes during ${command}`, async () => {
      await withWorkers((worker, request) => {
        if (request.cmd === command) worker.fail();
        else queueMicrotask(() => worker.answer(request));
      }, async () => {
        await expect(runMultiUserTestPattern("controlled.test.tsx", meta))
          .rejects.toThrow("[alice] worker error: worker crashed");
      });
    });
  }

  for (const failedStep of ["action", "assertion"]) {
    it(`reports a failed ${failedStep} alongside a later cleanup failure`, async () => {
      const errors: string[] = [];
      using _error = stub(console, "error", (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      });
      await withWorkers((worker, request) => {
        if (request.cmd === failedStep || request.cmd === "dispose") {
          worker.onmessage?.(
            new MessageEvent("message", {
              data: { id: request.id, error: `${request.cmd} failed` },
            }),
          );
        } else {
          queueMicrotask(() => worker.answer(request));
        }
      }, async () => {
        await expect(runMultiUserTestPattern("controlled.test.tsx", meta))
          .rejects.toThrow("dispose failed");
      });
      expect(errors.some((error) => error.includes(`${failedStep} failed`)))
        .toBe(true);
      expect(errors.some((error) => error.includes("dispose failed"))).toBe(
        true,
      );
    });
  }

  it("reports runtime health failures alongside a later cleanup failure", async () => {
    const errors: string[] = [];
    using _error = stub(console, "error", (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    const health = {
      runtimeErrors: ["runtime failed"],
      nonIdempotent: ["replay disagreed"],
      consoleErrors: ["console error"],
      consoleWarnings: ["console warning"],
    };
    await withWorkers((worker, request) => {
      if (request.cmd === "health") {
        worker.onmessage?.(
          new MessageEvent("message", {
            data: { id: request.id, ok: health },
          }),
        );
      } else if (request.cmd === "dispose") {
        worker.onmessage?.(
          new MessageEvent("message", {
            data: { id: request.id, error: "dispose failed" },
          }),
        );
      } else {
        queueMicrotask(() => worker.answer(request));
      }
    }, async () => {
      await expect(runMultiUserTestPattern("controlled.test.tsx", meta))
        .rejects.toThrow("dispose failed");
    });
    for (const failure of Object.values(health).flat()) {
      expect(errors.some((error) => error.includes(failure))).toBe(true);
    }
  });

  for (const command of ["init", "action"]) {
    it(`fails a pending ${command} when another participant crashes`, async () => {
      // Bob never replies to the held request. Alice's error must end the run
      // without relying on Bob to resume or on a wall-clock deadline.

      let alice: ControlledWorker;
      await withWorkers((worker, request) => {
        if (worker.name === "cf-test:alice") alice = worker;
        if (worker.name === "cf-test:bob" && request.cmd === command) {
          alice.fail();
        } else {
          queueMicrotask(() => worker.answer(request));
        }
      }, async () => {
        await expect(runMultiUserTestPattern("controlled.test.tsx", {
          participants: [...meta.participants, { name: "bob", user: "bob" }],
        })).rejects.toThrow("[alice] worker error: worker crashed");
      });
    });
  }
});
