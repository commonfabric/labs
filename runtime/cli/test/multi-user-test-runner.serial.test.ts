/**
 * The multi-user orchestrator against participant workers whose replies the
 * test controls, and against a storage server that fails to close.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { resolve } from "@std/path";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import { describe, it } from "@commonfabric/test-support/test";
import {
  type MultiUserDescriptorMeta,
  ParticipantWorker,
  runMultiUserTestPattern,
} from "../lib/multi-user-test-runner.ts";
import type { StepMeta } from "../lib/multi-user-test-worker.ts";
import { runTests } from "../lib/test-runner.ts";
import { withWorkers } from "./multi-user-controlled-worker.ts";
import { captureStderr, withEnv } from "./utils.ts";

/** Each line `console.log` receives during `run`. */
async function logged(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  using _console = stub(console, "log", (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  await run();
  return lines;
}

const alice: MultiUserDescriptorMeta = {
  participants: [{ name: "alice", user: "alice" }],
};

describe(
  "multi-user-test-runner",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("fails a participant whose runtime resolved other flow labels than the run names", async () => {
      await withWorkers(
        (worker, request) => queueMicrotask(() => worker.answer(request)),
        async () => {
          const result = await runMultiUserTestPattern(
            "controlled.test.tsx",
            alice,
            {
              cfcFlowLabels: "persist",
            },
          );
          expect(result.error).toContain(
            'Participant "alice" resolved flow labels to off, expected persist',
          );
        },
      );
    });

    it("records a skipped assertion as skipped, and prints a skipped action when verbose", async () => {
      const steps: StepMeta[] = [
        { kind: "action", skip: true },
        { kind: "assertion", skip: true },
        { kind: "label", marker: "unused", skip: true },
        { kind: "assertion" },
      ];
      let result: Awaited<ReturnType<typeof runMultiUserTestPattern>>;
      const output = await logged(() =>
        withWorkers(
          (worker, request) =>
            queueMicrotask(() => worker.answer(request, steps)),
          async () => {
            result = await runMultiUserTestPattern(
              "controlled.test.tsx",
              alice,
              {
                verbose: true,
              },
            );
          },
        )
      );
      expect(result!.error).toBeUndefined();
      expect(result!.results.map(({ name, passed, skipped }) => ({
        name,
        passed,
        skipped,
      }))).toEqual([
        { name: "alice/assertion_1", passed: true, skipped: true },
        { name: "alice/assertion_2", passed: true, skipped: undefined },
      ]);
      expect(output).toContain("  [alice] ⊘ action_1 (skipped)");
    });

    it("prints no skipped action when not verbose", async () => {
      const output = await logged(() =>
        withWorkers(
          (worker, request) =>
            queueMicrotask(() =>
              worker.answer(request, [{ kind: "action", skip: true }])
            ),
          async () => {
            await runMultiUserTestPattern("controlled.test.tsx", alice);
          },
        )
      );
      expect(output.some((line) => line.includes("(skipped)"))).toBe(false);
    });

    it("fails the run, naming the marker and its announcer, when a wait for the marker fails", async () => {
      const steps = new Map<string, StepMeta[]>([
        ["cf-test:alice", [{ kind: "label", marker: "ready" }]],
        ["cf-test:bob", [{ kind: "await", marker: "ready" }]],
      ]);
      await withWorkers(
        (worker, request) =>
          queueMicrotask(() => {
            if (request.cmd === "awaitMarker") {
              worker.refuse(request, "replica gone");
            } else worker.answer(request, steps.get(worker.name));
          }),
        async () => {
          const result = await runMultiUserTestPattern("controlled.test.tsx", {
            participants: [
              { name: "alice", user: "alice" },
              { name: "bob", user: "bob" },
            ],
          });
          expect(result.error).toContain(
            '[bob] waiting for marker "ready" announced by alice: [bob] replica gone',
          );
        },
      );
    });

    describe("ParticipantWorker", () => {
      it("answers a worker's wait for the serving loop with the loop's failure", async () => {
        await withWorkers(() => {}, async (workers) => {
          const participant = new ParticipantWorker(
            "alice",
            () => {},
            () => Promise.reject(new Error("loop gone")),
          );
          const [worker] = workers;
          const answered = Promise.withResolvers<void>();
          const post = worker.postMessage.bind(worker);
          worker.postMessage = (message) => {
            post(message);
            answered.resolve();
          };
          worker.deliver({ quiescenceRequest: 7 });
          await answered.promise;
          expect(worker.posted).toEqual([
            { quiescenceAnswer: 7, error: "Error: loop gone" },
          ]);
          await participant.terminate();
        });
      });

      it("ignores a response to no request it made", async () => {
        await withWorkers(() => {}, async (workers) => {
          const participant = new ParticipantWorker(
            "alice",
            () => {},
            undefined,
          );
          const [worker] = workers;
          const pending = participant.call("health");
          worker.deliver({ id: 99, ok: "stray" });
          worker.deliver({ id: 1, ok: "answer" });
          expect(await pending).toBe("answer");
          await participant.terminate();
        });
      });
    });

    it("raises a storage server's failure to close after the run, on the arm without server execution", async () => {
      const close = StandaloneMemoryServer.prototype.close;
      using _close = stub(
        StandaloneMemoryServer.prototype,
        "close",
        async function () {
          await close.call(this);
          throw new Error("server close refused");
        },
      );
      const fixtures = resolve(
        import.meta.dirname!,
        "fixtures/multi-user-markers",
      );
      let outcome: Awaited<ReturnType<typeof runTests>> | undefined;
      const errors = await captureStderr(
        () =>
          withEnv("EXPERIMENTAL_SERVER_EXECUTION", "false", async () => {
            outcome = await runTests(
              resolve(fixtures, "marker-barrier.test.tsx"),
              { root: fixtures },
            );
          }),
      );
      expect(outcome?.failed).toBe(1);
      expect(
        errors.some((line) =>
          line.includes("[cf test] closing the storage server failed for") &&
          line.includes("server close refused")
        ),
      ).toBe(true);
    });
  },
);
