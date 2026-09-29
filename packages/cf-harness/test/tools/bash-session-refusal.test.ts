/**
 * What a run holds, and what its model is shown, after the sandbox runtime
 * refuses the session a bash call named.
 *
 * Every case goes the way a run goes: the engine invokes the bash tool, the
 * tool asks the runsc runtime, and the runtime drives `runsc` through a
 * process runner. Only the runner is a fake, so the refusals are the ones the
 * runtime makes and the records are the ones the engine keeps.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CfHarnessEngine } from "../../src/engine.ts";
import type {
  ProcessHandle,
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
  ProcessSpawnRequest,
} from "../../src/sandbox/process-runner.ts";
import {
  resolveRunscSandboxConfig,
  RunscSandboxRuntime,
} from "../../src/sandbox/runsc.ts";
import { BASH_SESSION_UNAVAILABLE_EXIT_CODE } from "../../src/tools/bash.ts";

const RUNSC_SUBCOMMANDS = ["run", "exec", "state", "delete", "kill"];

/**
 * A process runner that returns what `runsc` returns, with no sandbox behind
 * it: `state` reports a container running until it is deleted, a session's
 * `runsc run` child lives until a test ends it, and an exec returns
 * `execResult`.
 */
class FakeRunscRunner implements ProcessRunner {
  /** The containers started as sessions, in the order they were started. */
  readonly sessionContainerIds: string[] = [];

  /** The containers `runsc` reports as absent. */
  readonly absent = new Set<string>();

  /** The number of commands executed in a session. */
  execCount = 0;

  /** What an exec in a session returns. */
  execResult: ProcessRunResult = { stdout: "", stderr: "", exitCode: 0 };

  readonly #exits = new Map<string, (exitCode: number) => void>();

  run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    const argv = request.command === "/bin/sh"
      ? request.args.slice(5)
      : request.args;
    const subcommand = argv.find((arg) => RUNSC_SUBCOMMANDS.includes(arg));
    const containerId = argv[argv.length - 1];
    if (subcommand === "state") {
      return Promise.resolve(
        this.absent.has(containerId)
          ? { stdout: "", stderr: "does not exist", exitCode: 128 }
          : {
            stdout: `{"id": "${containerId}", "status": "running"}\n`,
            stderr: "",
            exitCode: 0,
          },
      );
    }
    if (subcommand === "delete") {
      this.absent.add(containerId);
    }
    if (subcommand === "exec") {
      this.execCount += 1;
      return Promise.resolve(this.execResult);
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  spawn(request: ProcessSpawnRequest): ProcessHandle {
    const containerId = request.args[request.args.length - 1];
    this.sessionContainerIds.push(containerId);
    const { promise: exited, resolve } = Promise.withResolvers<
      { exitCode: number }
    >();
    this.#exits.set(containerId, (exitCode) => resolve({ exitCode }));
    return {
      pid: 4242,
      exited,
      kill: () => resolve({ exitCode: 137 }),
    };
  }

  /**
   * Ends the most recently started session's container, as its init process
   * dying does, and returns once the runtime has been told.
   */
  async endLatestSession(): Promise<void> {
    const containerId = this.sessionContainerIds.at(-1)!;
    this.#exits.get(containerId)!(137);
    this.absent.add(containerId);
    // The runtime reads the exit in a continuation of `exited`.
    await Promise.resolve();
  }
}

describe("bash session refusals", () => {
  let scratchDir: string;
  let runner: FakeRunscRunner;
  let runtime: RunscSandboxRuntime;
  let engine: CfHarnessEngine;

  beforeEach(async () => {
    scratchDir = await Deno.makeTempDir({ prefix: "bash-session-refusal-" });
    runner = new FakeRunscRunner();
    runtime = new RunscSandboxRuntime(
      resolveRunscSandboxConfig({
        workspaceHostPath: "/tmp/workspace",
        rootfs: "/images/kitchensink",
        scratchDir,
        runId: "run-refusal",
        platform: "linux",
      }),
      runner,
    );
    engine = new CfHarnessEngine({
      runId: "run-refusal",
      sandboxRuntime: runtime,
      // A session is a thing of the modes that do not enforce.
      cfcEnforcementMode: "observe",
    });
  });

  afterEach(async () => {
    await runtime.close();
    await Deno.remove(scratchDir, { recursive: true }).catch(() => undefined);
  });

  /** The invocation records the run holds for one tool output. */
  const invocationRecordsFor = (outputId: string) =>
    (engine.getRunState().cfcInvocationContexts ?? []).filter((record) =>
      record.toolOutputId === outputId
    );

  describe("a refusal the runtime makes", () => {
    it("keeps the invocation record the call was handed to the runtime with", async () => {
      await engine.invokeBuiltinTool("bash", {
        command: "make",
        session: "build",
      });
      await runner.endLatestSession();

      const { output } = await engine.invokeBuiltinTool("bash", {
        command: "make test",
        cwd: "repo",
        session: "build",
      });

      expect(output.exitCode).toBe(BASH_SESSION_UNAVAILABLE_EXIT_CODE);
      expect(output.stderr).toContain("session");
      // Nothing was executed in the session that ended.
      expect(runner.execCount).toBe(1);
      const records = invocationRecordsFor(output.outputId);
      expect(records.length).toBe(1);
      expect(records[0].toolId).toBe("bash");
      expect(records[0].operation).toBe("shell");
      expect(records[0].cwd).toBe("/workspace/repo");
    });

    it("leaves the working directory where the call before it left it", async () => {
      // Three directories, so that the one expected is neither the run's
      // first nor the one the refused call asked for.

      await engine.invokeBuiltinTool("bash", {
        command: "make",
        cwd: "first",
        session: "build",
      });
      expect(engine.getRunState().currentDir).toBe("/workspace/first");
      await runner.endLatestSession();

      const { output } = await engine.invokeBuiltinTool("bash", {
        command: "make test",
        cwd: "second",
        session: "build",
      });

      expect(output.exitCode).toBe(BASH_SESSION_UNAVAILABLE_EXIT_CODE);
      expect(output.stderr).toContain("session");
      expect(output.cwd).toBe("/workspace/first");
      expect(engine.getRunState().currentDir).toBe("/workspace/first");

      // A relative `cwd` on the call after it resolves from there.
      const next = await engine.invokeBuiltinTool("bash", {
        command: "make test",
        cwd: "third",
        session: "build",
      });
      expect(next.output.exitCode).toBe(0);
      expect(next.output.cwd).toBe("/workspace/first/third");
    });
  });

  describe("a refusal the tool makes before it asks the runtime", () => {
    it("keeps no invocation record and leaves the working directory", async () => {
      await engine.invokeBuiltinTool("bash", { command: "true", cwd: "first" });

      const { output } = await engine.invokeBuiltinTool("bash", {
        command: "make",
        cwd: "second",
        session: "not a name",
      });

      expect(output.exitCode).toBe(BASH_SESSION_UNAVAILABLE_EXIT_CODE);
      expect(output.stderr).toContain("invalid `session` name");
      expect(invocationRecordsFor(output.outputId)).toEqual([]);
      expect(runner.sessionContainerIds).toEqual([]);
      expect(output.cwd).toBe("/workspace/first");
      expect(engine.getRunState().currentDir).toBe("/workspace/first");
    });
  });
});
